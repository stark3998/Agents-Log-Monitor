import { run, get, all, insert, getPollerState, setPollerState } from './db';
export { getPollerState, setPollerState };
import { NormalizedEvent } from './collectors/types';
import { watchTranscript } from './transcript-watcher';
import { agentFor, localIdentity, LOCAL_COLLECTORS, autonomyFromPermissionMode } from './analytics/identity';
import { Analysis, ANALYSIS_VERSION, FindingDraft } from './analytics/analyze';
import { canonicalToolName } from './analytics/classify';
import { REDACTION_MODE, redactString } from './analytics/redact';

function payloadObj(e: NormalizedEvent): Record<string, unknown> {
  return (e.payload && typeof e.payload === 'object') ? e.payload as Record<string, unknown> : {};
}

export function eventCwd(e: NormalizedEvent): string | null {
  if (e.cwd) return e.cwd;
  const cwd = payloadObj(e).cwd;
  return typeof cwd === 'string' ? cwd : null;
}

function promptText(e: NormalizedEvent): string | null {
  const p = payloadObj(e);
  const t = p.prompt ?? p.message ?? p.user_message;
  if (typeof t !== 'string') return null;
  const clean = redactString(t).replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, 300) : null;
}

// In-memory caches for the ingest hot path (a Copilot CLI backfill can be 100k+ events).
const knownSessions = new Map<string, { cwd: string | null; model: string | null }>();
const knownAgents = new Set<string>();
const hookSessions = new Set<string>();
let hookSessionsLoaded = false;

export function sessionCwdCached(sessionId: string): string | null | undefined {
  return knownSessions.get(sessionId)?.cwd;
}

export function upsertSession(e: NormalizedEvent, source: string) {
  const agent = agentFor(source);
  let known = knownSessions.get(e.sessionId);
  if (!known) {
    const row = get<{ project_path: string | null; model: string | null }>('SELECT project_path, model FROM sessions WHERE id = ?', [e.sessionId]);
    if (row) { known = { cwd: row.project_path, model: row.model }; knownSessions.set(e.sessionId, known); }
  }
  const cwd = eventCwd(e);
  const transcriptPath = e.transcriptPath ?? null;

  if (!known) {
    const ident = LOCAL_COLLECTORS.has(source) ? localIdentity() : { user: null, endpoint: null };
    run(
      `INSERT INTO sessions (id, source, agent_key, project_path, transcript_path, started_at, last_activity_at, user, endpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.sessionId, agent.key, agent.key, cwd, transcriptPath, e.occurredAt, e.occurredAt, ident.user, ident.endpoint],
    );
    known = { cwd, model: null };
    knownSessions.set(e.sessionId, known);
  } else {
    run(
      `UPDATE sessions SET
         last_activity_at = CASE WHEN last_activity_at IS NULL OR last_activity_at < ? THEN ? ELSE last_activity_at END,
         started_at = CASE WHEN started_at IS NULL OR started_at > ? THEN ? ELSE started_at END
       WHERE id = ?`,
      [e.occurredAt, e.occurredAt, e.occurredAt, e.occurredAt, e.sessionId],
    );
    if (cwd && !known.cwd) {
      run('UPDATE sessions SET project_path = ? WHERE id = ? AND project_path IS NULL', [cwd, e.sessionId]);
      known.cwd = cwd;
    }
  }

  if (e.model && !known.model) {
    run('UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL', [e.model, e.sessionId]);
    known.model = e.model;
  }

  if (e.eventType === 'prompt') {
    const title = promptText(e);
    if (title) run('UPDATE sessions SET title = ? WHERE id = ? AND title IS NULL', [title, e.sessionId]);
    run('UPDATE sessions SET ended_at = NULL WHERE id = ? AND ended_at IS NOT NULL AND ended_at < ?', [e.sessionId, e.occurredAt]);
  }

  const autonomy = e.autonomyLevel ?? autonomyFromPermissionMode(payloadObj(e).permission_mode);
  if (autonomy) {
    run('UPDATE sessions SET autonomy_level = ? WHERE id = ? AND (autonomy_level IS NULL OR autonomy_level < ?)',
      [autonomy, e.sessionId, autonomy]);
  }

  if (transcriptPath && source === 'claude-code') {
    run('UPDATE sessions SET transcript_path = ? WHERE id = ? AND transcript_path IS NULL',
      [transcriptPath, e.sessionId]);
    watchTranscript(e.sessionId, transcriptPath);
  }

  if (e.rawEventName === 'SessionEnd' || e.rawEventName === 'Stop') {
    run('UPDATE sessions SET ended_at = ? WHERE id = ? AND (ended_at IS NULL OR ended_at < ?)', [e.occurredAt, e.sessionId, e.occurredAt]);
  }
}

export function upsertAgent(e: NormalizedEvent) {
  const agentKey = `${e.sessionId}|${e.agentId}`;
  if (!knownAgents.has(agentKey)) {
    const existing = get('SELECT id FROM agents WHERE id = ?', [e.agentId]);
    if (!existing) {
      run(
        'INSERT INTO agents (id, session_id, parent_agent_id, agent_type, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
        [e.agentId, e.sessionId, e.parentAgentId ?? null, e.agentType ?? null, e.occurredAt, 'running'],
      );
    }
    knownAgents.add(agentKey);
  }
  if (e.agentType) {
    run('UPDATE agents SET agent_type = ? WHERE id = ? AND agent_type IS NULL', [e.agentType, e.agentId]);
  }

  if (e.rawEventName === 'SubagentStop') {
    run(
      'UPDATE agents SET ended_at = ?, status = ? WHERE id = ?',
      [e.occurredAt, e.status === 'error' ? 'failed' : 'completed', e.agentId],
    );
  }
}

export function isDuplicate(e: NormalizedEvent): boolean {
  if (!e.externalId) return false;
  return !!get<{ id: number }>('SELECT id FROM events WHERE external_id = ?', [e.externalId]);
}

export function insertEvent(e: NormalizedEvent, analysis?: Analysis, skipDupCheck = false): number {
  // Dedup polling sources — if an externalId is already in the DB, skip insert.
  if (!skipDupCheck && isDuplicate(e)) return 0;

  let parentEventId = e.parentEventId ?? null;
  let durationMs    = e.durationMs    ?? null;

  // For results: find the matching call by tool_use_id and compute duration
  if (e.eventType === 'tool_result' && e.toolUseId) {
    const pre = get<{ id: number; created_at: string }>(
      `SELECT id, created_at FROM events
       WHERE tool_use_id = ? AND +session_id = ? AND +event_type = 'tool_call'
       ORDER BY created_at DESC LIMIT 1`,
      [e.toolUseId, e.sessionId],
    );
    if (pre) {
      parentEventId = pre.id;
      if (durationMs == null) {
        durationMs = Math.max(0, Math.round(new Date(e.occurredAt).getTime() - new Date(pre.created_at).getTime()));
      }
    }
  }

  return insert(
    `INSERT INTO events
       (session_id, agent_id, parent_event_id, event_type, raw_event_name,
        tool_name, tool_use_id, external_id, status, duration_ms,
        input_tokens, output_tokens, cache_read_input_tokens,
        error_text, model, payload, created_at,
        capture_channel, category, mcp_server, risk_level, analysis_version, redaction)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.sessionId,
      e.agentId,
      parentEventId,
      e.eventType,
      e.rawEventName,
      e.toolName              ?? null,
      e.toolUseId             ?? null,
      e.externalId            ?? null,
      e.status                ?? null,
      durationMs,
      e.inputTokens           ?? null,
      e.outputTokens          ?? null,
      e.cacheReadInputTokens  ?? null,
      e.errorText             ?? null,
      e.model                 ?? null,
      JSON.stringify(e.payload),
      e.occurredAt,
      e.captureChannel        ?? 'hook',
      analysis?.category      ?? null,
      analysis?.mcpServer     ?? null,
      analysis?.riskLevel     ?? null,
      analysis ? ANALYSIS_VERSION : null,
      REDACTION_MODE,
    ],
  );
}

/**
 * A denied permission can surface twice: as the agent's explicit permission event and as the
 * failed tool result ("user denied permission"). Keep only the explicit one.
 * Returns the findings to store for this event (inferred denials dropped when already covered).
 */
export function reconcileDenials(eventId: number | null, sessionId: string, eventType: string, toolUseId: string | null | undefined,
  payload: unknown, findings: FindingDraft[]): FindingDraft[] {
  const p = (payload && typeof payload === 'object') ? payload as Record<string, unknown> : {};
  const explicit = findings.some(f => f.kind === 'policy' && f.key === 'denied' && !f.inferred);
  const callId = typeof p.toolCallId === 'string' ? p.toolCallId : null;
  if (explicit && callId) {
    run(
      `DELETE FROM findings WHERE kind = 'policy' AND key = 'denied'
         AND event_id IN (SELECT id FROM events WHERE +session_id = ? AND +event_type = 'tool_result' AND tool_use_id = ?${eventId != null ? ' AND id != ?' : ''})`,
      eventId != null ? [sessionId, callId, eventId] : [sessionId, callId],
    );
  }
  if (eventType === 'tool_result' && toolUseId && findings.some(f => f.inferred)) {
    const covered = get<{ x: number }>(
      `SELECT 1 AS x FROM findings f JOIN events e ON e.id = f.event_id
       WHERE e.session_id = ? AND f.kind = 'policy' AND f.key = 'denied' AND e.event_type != 'tool_result'
         AND json_extract(e.payload, '$.toolCallId') = ? LIMIT 1`,
      [sessionId, toolUseId],
    );
    if (covered) return findings.filter(f => !f.inferred);
  }
  return findings;
}

export function insertFindings(eventId: number, sessionId: string, createdAt: string, findings: FindingDraft[]): void {
  for (const f of findings) {
    run(
      `INSERT INTO findings (event_id, session_id, kind, key, label, severity, masked_sample, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, sessionId, f.kind, f.key, f.label, f.severity ?? null, f.maskedSample ?? null, createdAt],
    );
  }
}

const CORRELATION_WINDOW_MS = 15_000;

/** Stable identity of a tool call's main argument (command, path, url or prompt) for hook↔log matching. */
function inputKey(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const input = (p.tool_input && typeof p.tool_input === 'object') ? p.tool_input as Record<string, unknown> : null;
  const v = input?.command ?? input?.file_path ?? input?.path ?? input?.url ?? input?.pattern ?? p.prompt;
  return typeof v === 'string' && v ? v.trim().slice(0, 500) : null;
}

/**
 * Link a Copilot CLI hook event with its log twin (same session, type and canonical tool,
 * within ±15s) by setting `correlated_event_id` on the hook row. Works in both arrival orders.
 */
export function correlateChannels(eventId: number, e: NormalizedEvent): void {
  if (e.captureChannel !== 'hook' && e.captureChannel !== 'log') return;
  if (!['tool_call', 'tool_result', 'prompt'].includes(e.eventType)) return;
  if (!hookSessionsLoaded) {
    for (const r of all<{ s: string }>(`SELECT DISTINCT session_id AS s FROM events WHERE capture_channel = 'hook'`)) hookSessions.add(r.s);
    hookSessionsLoaded = true;
  }
  if (e.captureChannel === 'hook') hookSessions.add(e.sessionId);
  else if (!hookSessions.has(e.sessionId)) return;   // no hook twin can exist for this session
  const t = new Date(e.occurredAt).getTime();
  const lo = new Date(t - CORRELATION_WINDOW_MS).toISOString();
  const hi = new Date(t + CORRELATION_WINDOW_MS).toISOString();
  const canon = canonicalToolName(e.toolName);
  const other = e.captureChannel === 'hook' ? 'log' : 'hook';

  const mine = inputKey(e.payload);
  const candidates = all<{ id: number; tool_name: string | null; created_at: string; correlated_event_id: number | null; payload: string | null }>(
    `SELECT id, tool_name, created_at, correlated_event_id, payload FROM events
     WHERE session_id = ? AND event_type = ? AND capture_channel = ? AND created_at BETWEEN ? AND ?`,
    [e.sessionId, e.eventType, other, lo, hi],
  ).filter(c => {
    if (canonicalToolName(c.tool_name) !== canon) return false;
    if (!mine) return true;
    let theirs: string | null = null;
    try { theirs = inputKey(c.payload ? JSON.parse(c.payload) : null); } catch { /* unparsable */ }
    return !theirs || theirs === mine;   // when both sides carry a command/path it must match
  });
  if (!candidates.length) return;

  if (e.captureChannel === 'hook') {
    const taken = new Set(all<{ c: number }>(
      `SELECT correlated_event_id AS c FROM events WHERE session_id = ? AND capture_channel = 'hook' AND correlated_event_id IS NOT NULL AND created_at BETWEEN ? AND ?`,
      [e.sessionId, lo, hi],
    ).map(r => r.c));
    const best = candidates.filter(c => !taken.has(c.id))
      .sort((a, b) => Math.abs(new Date(a.created_at).getTime() - t) - Math.abs(new Date(b.created_at).getTime() - t))[0];
    if (best) run('UPDATE events SET correlated_event_id = ? WHERE id = ?', [best.id, eventId]);
  } else {
    const best = candidates.filter(c => c.correlated_event_id == null)
      .sort((a, b) => Math.abs(new Date(a.created_at).getTime() - t) - Math.abs(new Date(b.created_at).getTime() - t))[0];
    if (best) run('UPDATE events SET correlated_event_id = ? WHERE id = ?', [eventId, best.id]);
  }
}
