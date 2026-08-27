import { run, get, insert, getPollerState, setPollerState } from './db';
export { getPollerState, setPollerState };
import { NormalizedEvent } from './collectors/types';
import { watchTranscript } from './transcript-watcher';

export function upsertSession(e: NormalizedEvent, source: string) {
  const existing = get('SELECT id FROM sessions WHERE id = ?', [e.sessionId]);
  const payload = e.payload as Record<string, unknown>;
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null;
  const transcriptPath = e.transcriptPath ?? null;

  if (!existing) {
    run(
      'INSERT INTO sessions (id, source, project_path, transcript_path, started_at) VALUES (?, ?, ?, ?, ?)',
      [e.sessionId, source, cwd, transcriptPath, e.occurredAt],
    );
  }

  if (e.model) {
    run('UPDATE sessions SET model = ? WHERE id = ? AND model IS NULL', [e.model, e.sessionId]);
  }

  if (transcriptPath) {
    run('UPDATE sessions SET transcript_path = ? WHERE id = ? AND transcript_path IS NULL',
      [transcriptPath, e.sessionId]);
    watchTranscript(e.sessionId, transcriptPath);
  }

  if (e.rawEventName === 'SessionEnd' || e.rawEventName === 'Stop') {
    run('UPDATE sessions SET ended_at = ? WHERE id = ?', [e.occurredAt, e.sessionId]);
  }
}

export function upsertAgent(e: NormalizedEvent) {
  const existing = get('SELECT id FROM agents WHERE id = ?', [e.agentId]);
  if (!existing) {
    run(
      'INSERT INTO agents (id, session_id, parent_agent_id, agent_type, started_at, status) VALUES (?, ?, ?, ?, ?, ?)',
      [e.agentId, e.sessionId, e.parentAgentId ?? null, e.agentType ?? null, e.occurredAt, 'running'],
    );
  }

  if (e.rawEventName === 'SubagentStop') {
    run(
      'UPDATE agents SET ended_at = ?, status = ? WHERE id = ?',
      [e.occurredAt, e.status === 'error' ? 'failed' : 'completed', e.agentId],
    );
  }
}

export function insertEvent(e: NormalizedEvent): number {
  // Dedup polling sources — if an externalId is already in the DB, skip insert.
  if (e.externalId) {
    const existing = get<{ id: number }>('SELECT id FROM events WHERE external_id = ?', [e.externalId]);
    if (existing) return 0;
  }

  let parentEventId = e.parentEventId ?? null;
  let durationMs    = e.durationMs    ?? null;

  // For PostToolUse: find the matching PreToolUse by tool_use_id and compute duration
  if (e.rawEventName === 'PostToolUse' && e.toolUseId) {
    const pre = get<{ id: number; created_at: string }>(
      `SELECT id, created_at FROM events
       WHERE tool_use_id = ? AND raw_event_name = 'PreToolUse'
       ORDER BY created_at DESC LIMIT 1`,
      [e.toolUseId],
    );
    if (pre) {
      parentEventId = pre.id;
      durationMs = Math.round(
        new Date(e.occurredAt).getTime() - new Date(pre.created_at).getTime(),
      );
    }
  }

  return insert(
    `INSERT INTO events
       (session_id, agent_id, parent_event_id, event_type, raw_event_name,
        tool_name, tool_use_id, external_id, status, duration_ms,
        input_tokens, output_tokens, cache_read_input_tokens,
        error_text, model, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
}
