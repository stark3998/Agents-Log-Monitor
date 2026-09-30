import { Collector, NormalizedEvent } from './types';

/**
 * GitHub Copilot CLI — optional push channel. The forwarder script (scripts/copilot-hook-forward.*)
 * POSTs each hook payload to /hooks/<surface> (the governance hook router), which normalizes it with this
 * collector. Accepts both the VS Code compatible (PascalCase event, snake_case fields) and the native
 * camelCase payload formats.
 */

type Raw = Record<string, unknown>;

function s(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function toIso(ts: unknown): string {
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts).toISOString();
  if (typeof ts === 'string') {
    const d = new Date(ts);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function inferEvent(p: Raw): string {
  const named = s(p.hook_event_name) ?? s(p.hookEventName) ?? s(p.hookType);
  if (named) return named;
  // camelCase payloads carry no event name — infer from shape.
  if (p.toolResult !== undefined) return 'PostToolUse';
  if (p.error !== undefined && p.toolName !== undefined) return 'PostToolUseFailure';
  if (p.toolName !== undefined) return 'PreToolUse';
  if (p.prompt !== undefined) return 'UserPromptSubmit';
  if (p.reason !== undefined) return 'SessionEnd';
  if (p.source !== undefined) return 'SessionStart';
  if (p.stopReason !== undefined) return 'Stop';
  return 'unknown';
}

function clip(v: string, n: number): string {
  return v.length > n ? v.slice(0, n) + '…' : v;
}

export const copilotCliHooksCollector: Collector = {
  id: 'copilot-cli-hooks',
  displayName: 'GitHub Copilot CLI (hooks)',

  normalize(raw: unknown): NormalizedEvent[] {
    const p = (raw ?? {}) as Raw;
    const name = inferEvent(p);
    const n = name.toLowerCase();
    const sessionId = s(p.session_id) ?? s(p.sessionId) ?? 'unknown-session';
    const cwd = s(p.cwd);
    const toolName = s(p.tool_name) ?? s(p.toolName);
    const toolInput = p.tool_input ?? p.toolArgs;
    const tr = (p.tool_result ?? p.toolResult) as Raw | string | undefined;
    const resultText = typeof tr === 'string' ? tr : (s(tr?.text_result_for_llm) ?? s(tr?.textResultForLlm) ?? (tr ? JSON.stringify(tr) : ''));
    const base = {
      sessionId,
      agentId: 'main',
      occurredAt: toIso(p.timestamp),
      captureChannel: 'hook' as const,
      rawEventName: name,
      cwd,
    };

    if (n === 'pretooluse') {
      return [{ ...base, eventType: 'tool_call', toolName, status: 'pending', payload: { cwd, tool_input: toolInput } }];
    }
    if (n === 'posttooluse' || n === 'posttoolusefailure') {
      const failed = n === 'posttoolusefailure' || p.error !== undefined;
      return [{
        ...base, eventType: 'tool_result', toolName, status: failed ? 'error' : 'success',
        errorText: s(p.error), scanText: resultText,
        payload: { cwd, tool_input: toolInput, tool_result: clip(resultText, 3000) },
      }];
    }
    if (n === 'userpromptsubmit' || n === 'userpromptsubmitted') {
      return [{ ...base, eventType: 'prompt', payload: { cwd, prompt: s(p.prompt) ?? '' } }];
    }
    if (n === 'erroroccurred' || n === 'notification') {
      const msg = s(p.message) ?? s((p.error as Raw | undefined)?.message) ?? s(p.error) ?? JSON.stringify(p).slice(0, 500);
      return [{ ...base, eventType: 'notification', payload: { cwd, message: msg } }];
    }
    return [{ ...base, eventType: 'lifecycle', payload: { cwd, reason: p.reason, source: p.source, detail: s(p.reason) ?? s(p.source) ?? null } }];
  },
};
