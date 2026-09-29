import fs from 'fs';
import os from 'os';
import path from 'path';
import { PollableCollector, NormalizedEvent } from './types';
import { getPollerState, setPollerState } from '../store';
import { get } from '../db';

/**
 * GitHub Copilot CLI — pull collector that tails the per-session event logs written by the CLI:
 *   $COPILOT_HOME/session-state/<sessionId>/events.jsonl   (default COPILOT_HOME = ~/.copilot)
 * Each line is `{ type, data, id, timestamp, parentId, agentId? }`.
 */

const COLLECTOR_ID = 'copilot-cli';
const MAX_STRING = 4000;
const MAX_RESULT = 3000;
const MAX_TEXT = 20_000;
const MAX_SCAN = 256 * 1024;
const POLL_BUDGET_BYTES = 2 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

// Event types that carry no monitoring value (or are huge) — skipped before JSON.parse.
const SKIP_TYPES = new Set([
  'hook.start', 'hook.end', 'session.binary_asset', 'assistant.turn_start', 'assistant.turn_end',
  'session.usage_checkpoint', 'system.message', 'subagent.configured', 'subagent.selected', 'subagent.deselected',
  'session.compaction_start', 'session.compaction_complete', 'session.info', 'session.plan_changed',
  'session.auto_mode_resolved', 'session.task_complete', 'external_tool.requested', 'external_tool.completed',
  'skill.context_delivered_ref', 'skill.invoked_ref',
]);
const TYPE_PREFIX_RE = /^\{\s*"type"\s*:\s*"([^"]+)"/;

export interface CopilotCliOptions {
  home?: string;
  importDays?: number;
  pollIntervalMs?: number;
}

interface RawLine {
  type: string;
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  agentId?: string;
}

interface FileState {
  sessionId: string;
  toolNames: Map<string, string>;
  permissions: Map<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Deep-copy JSON with long strings clipped so stored payloads stay small. */
export function slim(v: unknown, maxStr = MAX_STRING, depth = 0): unknown {
  if (typeof v === 'string') return clip(v, maxStr);
  if (v == null || typeof v !== 'object') return v;
  if (depth > 6) return '[…]';
  if (Array.isArray(v)) return v.slice(0, 50).map(x => slim(x, maxStr, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = slim(x, maxStr, depth + 1);
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

function resultText(result: unknown): string {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const r = result as Record<string, unknown>;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content.map(c => (c && typeof c === 'object' && typeof (c as Record<string, unknown>).text === 'string') ? (c as Record<string, string>).text : '').join('\n');
  }
  return stringify(result);
}

// ── Line mapping (pure; exported for tests) ──────────────────────────────

export function mapLine(raw: RawLine, st: FileState, lookupToolName?: (toolCallId: string) => string | undefined): NormalizedEvent[] {
  const d = raw.data ?? {};
  const ts = raw.timestamp ?? new Date().toISOString();
  const base = {
    sessionId: st.sessionId,
    agentId: raw.agentId ?? 'main',
    externalId: `${COLLECTOR_ID}:${st.sessionId}:${raw.id ?? ts + raw.type}`,
    occurredAt: ts,
    captureChannel: 'log' as const,
  };
  const ctx = (d.context ?? {}) as Record<string, unknown>;

  switch (raw.type) {
    case 'session.start':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'SessionStart', model: str(d.selectedModel) || undefined,
        cwd: str(ctx.cwd) || undefined,
        payload: { cwd: ctx.cwd, repository: ctx.repository, branch: ctx.branch, copilotVersion: d.copilotVersion, detail: str(d.selectedModel) || null } }];

    case 'session.resume':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'SessionResume', cwd: str(ctx.cwd) || undefined,
        payload: { cwd: ctx.cwd, repository: ctx.repository, branch: ctx.branch, detail: str(ctx.branch) || null } }];

    case 'session.shutdown': {
      const td = (d.tokenDetails ?? {}) as Record<string, { tokenCount?: number }>;
      const cc = (d.codeChanges ?? {}) as Record<string, unknown>;
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'SessionEnd', model: str(d.currentModel) || undefined,
        inputTokens: td.input?.tokenCount, outputTokens: td.output?.tokenCount, cacheReadInputTokens: td.cache_read?.tokenCount,
        payload: { reason: d.shutdownType, linesAdded: cc.linesAdded, linesRemoved: cc.linesRemoved,
          filesModified: Array.isArray(cc.filesModified) ? cc.filesModified.length : undefined, totalApiDurationMs: d.totalApiDurationMs } }];
    }

    case 'session.model_change':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'ModelChange', model: str(d.newModel) || undefined,
        payload: { detail: str(d.newModel) } }];

    case 'session.mode_changed': {
      const mode = str(d.newMode);
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'ModeChange',
        autonomyLevel: mode === 'autopilot' ? 3 : 1,
        payload: { detail: `${str(d.previousMode) || '?'} → ${mode}`, newMode: mode } }];
    }

    case 'session.permissions_changed': {
      const on = d.allowAllPermissions === true;
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'PermissionsChange', autonomyLevel: on ? 3 : undefined,
        payload: { detail: `Allow all permissions ${on ? 'on' : 'off'}`, allowAllPermissions: on } }];
    }

    case 'abort':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'Abort', payload: { detail: str(d.reason) } }];

    case 'user.message': {
      const content = str(d.content);
      if (!content.trim()) return [];
      return [{ ...base, eventType: 'prompt', rawEventName: 'UserPromptSubmit',
        scanText: clip(content, MAX_SCAN),
        payload: { prompt: clip(content, MAX_TEXT), attachments: Array.isArray(d.attachments) ? d.attachments.length : 0 } }];
    }

    case 'assistant.message': {
      const out: NormalizedEvent[] = [];
      const model = str(d.model) || undefined;
      const reasoning = str(d.reasoningText);
      if (reasoning.trim()) {
        out.push({ ...base, externalId: base.externalId + ':r', eventType: 'thinking', rawEventName: 'Thinking', model,
          payload: { thinking: clip(reasoning, MAX_TEXT) } });
      }
      const content = str(d.content);
      if (content.trim()) {
        out.push({ ...base, eventType: 'assistant_text', rawEventName: 'AssistantText', model,
          payload: { text: clip(content, MAX_TEXT) } });
      }
      return out;
    }

    case 'tool.execution_start': {
      const toolCallId = str(d.toolCallId);
      const toolName = str(d.toolName) || 'unknown';
      if (toolCallId) st.toolNames.set(toolCallId, toolName);
      return [{ ...base, eventType: 'tool_call', rawEventName: 'PreToolUse', toolName, toolUseId: toolCallId || undefined,
        status: 'pending', model: str(d.model) || undefined,
        scanText: clip(stringify(d.arguments), MAX_SCAN),
        payload: {
          tool_input: slim(d.arguments),
          mcpServerName: str(d.mcpServerName) || undefined,
          mcpToolName: str(d.mcpToolName) || undefined,
          toolTitle: str(d.toolTitle) || undefined,
          parentToolCallId: str(d.parentToolCallId) || undefined,
        } }];
    }

    case 'tool.execution_complete': {
      const toolCallId = str(d.toolCallId);
      const toolName = st.toolNames.get(toolCallId) ?? (toolCallId && lookupToolName ? lookupToolName(toolCallId) : undefined) ?? 'unknown';
      st.toolNames.delete(toolCallId);
      const err = d.error as Record<string, unknown> | string | undefined;
      const errorText = typeof err === 'string' ? err : (err && typeof err.message === 'string' ? err.message : undefined);
      const text = resultText(d.result);
      const shell = (d.shellExecution ?? {}) as Record<string, unknown>;
      return [{ ...base, eventType: 'tool_result', rawEventName: 'PostToolUse', toolName, toolUseId: toolCallId || undefined,
        status: d.success === false ? 'error' : 'success', errorText,
        scanText: clip(text, MAX_SCAN),
        payload: { tool_result: clip(text, MAX_RESULT), exitCode: shell.exitCode } }];
    }

    case 'subagent.started':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'SubagentStart', parentAgentId: 'main',
        agentType: str(d.agentType) || str(d.agentName) || undefined, model: str(d.model) || undefined,
        payload: { agentDisplayName: d.agentDisplayName, agentName: d.agentName, agentDescription: d.agentDescription, toolCallId: d.toolCallId } }];

    case 'subagent.completed':
    case 'subagent.failed':
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'SubagentStop',
        status: raw.type === 'subagent.failed' || d.cancelled === true ? 'error' : 'success',
        payload: { agentDisplayName: d.agentDisplayName, agentName: d.agentName, totalToolCalls: d.totalToolCalls,
          totalTokens: d.totalTokens, durationMs: d.durationMs, cancelled: d.cancelled === true } }];

    case 'permission.requested': {
      const pr = (d.permissionRequest ?? {}) as Record<string, unknown>;
      const what = [str(pr.kind), str(pr.path) || str(pr.command) || str(pr.url) || str(pr.intention)].filter(Boolean).join(' · ');
      st.permissions.set(str(d.requestId), what);
      const policy = { outcome: 'prompted' as const, label: clip(`Permission requested: ${what || 'tool use'}`, 200) };
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'PermissionRequest', policy,
        payload: { _policy: policy, kind: pr.kind, detail: clip(what, 300), toolCallId: pr.toolCallId } }];
    }

    case 'permission.completed': {
      const res = (d.result ?? {}) as Record<string, unknown>;
      const kind = str(res.kind);
      const what = st.permissions.get(str(d.requestId)) ?? '';
      st.permissions.delete(str(d.requestId));
      const denied = /denied|reject|block/i.test(kind);
      const policy = denied
        ? { outcome: 'denied' as const, label: clip(`Denied${/user/i.test(kind) ? ' by user' : ''}: ${what || 'tool use'}`, 200) }
        : { outcome: 'approved' as const, label: clip(`Approved: ${what || 'tool use'}`, 200) };
      return [{ ...base, eventType: 'lifecycle', rawEventName: 'PermissionResult', policy,
        payload: { _policy: policy, result: kind, detail: clip(what, 300), toolCallId: d.toolCallId } }];
    }

    case 'session.error':
    case 'error':
      return [{ ...base, eventType: 'notification', rawEventName: 'Error',
        payload: { message: clip(str(d.message) || stringify(d), 1000) } }];

    default:
      return [];
  }
}

// ── File tailing ─────────────────────────────────────────────────────────

interface ReadResult { lines: string[]; newOffset: number; more: boolean }

export function readLines(file: string, offset: number, budget: number): ReadResult {
  const size = fs.statSync(file).size;
  if (size <= offset) return { lines: [], newOffset: size < offset ? 0 : offset, more: false };
  const fd = fs.openSync(file, 'r');
  try {
    let len = Math.min(budget, size - offset);
    for (;;) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) {
        if (offset + len >= size) return { lines: [], newOffset: offset, more: false };  // partial line still being written
        if (len >= MAX_LINE_BYTES) {                                                    // pathological line: skip it
          const skip = buf.length;
          return { lines: [], newOffset: offset + skip, more: true };
        }
        len = Math.min(len * 4, size - offset, MAX_LINE_BYTES);
        continue;
      }
      const text = buf.subarray(0, lastNl).toString('utf8');
      const newOffset = offset + lastNl + 1;
      return { lines: text.split('\n'), newOffset, more: newOffset < size };
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function createCopilotCliCollector(opts: CopilotCliOptions = {}): PollableCollector {
  const home = opts.home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  const stateDir = path.join(home, 'session-state');
  const importDays = opts.importDays ?? 7;
  const files = new Map<string, FileState>();
  let backlog = false;

  const lookupToolName = (toolCallId: string) =>
    get<{ tool_name: string }>(`SELECT tool_name FROM events WHERE tool_use_id = ? AND event_type = 'tool_call' LIMIT 1`, [toolCallId])?.tool_name;

  function discover(): { sessionId: string; file: string; mtimeMs: number }[] {
    let dirs: fs.Dirent[] = [];
    try { dirs = fs.readdirSync(stateDir, { withFileTypes: true }); } catch { return []; }
    const out: { sessionId: string; file: string; mtimeMs: number }[] = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const file = path.join(stateDir, d.name, 'events.jsonl');
      try { out.push({ sessionId: d.name, file, mtimeMs: fs.statSync(file).mtimeMs }); } catch { /* no log yet */ }
    }
    // Oldest first so the import fills the timeline chronologically.
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  return {
    id: COLLECTOR_ID,
    displayName: 'GitHub Copilot CLI',
    pollIntervalMs: opts.pollIntervalMs ?? 2000,

    normalize(raw: unknown): NormalizedEvent[] {
      const r = raw as RawLine & { sessionId?: string };
      const sessionId = r.sessionId || str(r.data?.sessionId) || 'unknown-session';
      return mapLine(r, { sessionId, toolNames: new Map(), permissions: new Map() }, lookupToolName);
    },

    hasBacklog: () => backlog,

    async poll(): Promise<NormalizedEvent[]> {
      const cutoff = Date.now() - importDays * 86_400_000;
      let budget = POLL_BUDGET_BYTES;
      const events: NormalizedEvent[] = [];
      backlog = false;

      for (const f of discover()) {
        const key = `offset:${f.sessionId}`;
        const stored = getPollerState(COLLECTOR_ID, key, '');
        if (!stored && f.mtimeMs < cutoff) continue;      // outside the initial import window
        const offset = Number(stored || 0);
        if (budget <= 0) { backlog = true; break; }

        let st = files.get(f.file);
        if (!st) { st = { sessionId: f.sessionId, toolNames: new Map(), permissions: new Map() }; files.set(f.file, st); }

        let res: ReadResult;
        try { res = readLines(f.file, offset, budget); } catch { continue; }
        if (res.newOffset === offset && !res.lines.length) continue;
        budget -= res.newOffset - offset;

        for (const line of res.lines) {
          if (!line.trim()) continue;
          const t = TYPE_PREFIX_RE.exec(line)?.[1];
          if (t && SKIP_TYPES.has(t)) continue;
          let obj: RawLine;
          try { obj = JSON.parse(line); } catch { continue; }
          if (!obj || SKIP_TYPES.has(obj.type)) continue;
          try { events.push(...mapLine(obj, st, lookupToolName)); } catch { /* skip malformed event */ }
        }
        setPollerState(COLLECTOR_ID, key, String(res.newOffset));
        if (res.more) backlog = true;
      }
      return events;
    },
  };
}

export function copilotCliAvailable(home?: string): boolean {
  const h = home ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  return fs.existsSync(path.join(h, 'session-state'));
}
