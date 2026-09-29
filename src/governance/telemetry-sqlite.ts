import { all } from '../db';
import type { ActionRecord, ActionSearch, SessionSummary, TelemetryReader } from './telemetry';
import { setTelemetryReader } from './telemetry';

const TEXT_LIMIT = 2000;
const MAX_LIMIT = 500;
const RISK_RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function clipText(value: unknown): string | null {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

function limitOf(limit: number | undefined, fallback = 100): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_LIMIT);
}

function parsePayload(payload: string | null): Record<string, unknown> {
  if (!payload) return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function actionInput(payload: Record<string, unknown>): unknown {
  return payload.tool_input ?? payload.input ?? payload.args ?? payload;
}

function actionResult(row: EventRow, payload: Record<string, unknown>, includePayloadResult = true): string | null {
  if (row.error_text) return clipText(row.error_text);
  if (!includePayloadResult) return null;
  return clipText(payload.result ?? payload.output ?? payload.text ?? payload.message);
}

interface EventRow {
  id: number;
  session_id: string;
  agent_id: string;
  event_type: string;
  tool_name: string | null;
  status: string | null;
  error_text: string | null;
  payload: string | null;
  created_at: string;
  category: string | null;
  mcp_server: string | null;
  risk_level: string | null;
  capture_channel: string | null;
  correlated_event_id: number | null;
}

interface FindingRow {
  event_id: number;
  kind: string;
  key: string;
  label: string | null;
  severity: string | null;
}

export class SqliteTelemetryReader implements TelemetryReader {
  async listSessions(q: { since?: string; until?: string; agent?: string; limit?: number }): Promise<SessionSummary[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.since) { where.push('COALESCE(s.last_activity_at, s.started_at) >= ?'); params.push(q.since); }
    if (q.until) { where.push('s.started_at <= ?'); params.push(q.until); }
    if (q.agent) { where.push('COALESCE(s.agent_key, s.source) = ?'); params.push(q.agent); }
    const rows = all<{
      id: string; source: string; agent_key: string | null; title: string | null; user: string | null;
      endpoint: string | null; project_path: string | null; started_at: string | null; last_activity_at: string | null;
      risky_actions: number; tool_calls: number;
    }>(
      `SELECT s.id, s.source, s.agent_key, s.title, s.user, s.endpoint, s.project_path, s.started_at, s.last_activity_at,
        COALESCE(SUM(CASE WHEN e.event_type = 'tool_call' AND e.risk_level IN ('high','critical') THEN 1 ELSE 0 END), 0) AS risky_actions,
        COALESCE(SUM(CASE WHEN e.event_type = 'tool_call' THEN 1 ELSE 0 END), 0) AS tool_calls
       FROM sessions s
       LEFT JOIN events e ON e.session_id = s.id
        AND NOT (e.capture_channel = 'hook' AND e.correlated_event_id IS NOT NULL)
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       GROUP BY s.id
       ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC
       LIMIT ?`,
      [...params, limitOf(q.limit, 100)],
    );
    return rows.map(r => ({
      id: r.id,
      agent: r.agent_key ?? r.source,
      surface: r.source,
      title: r.title,
      user: r.user,
      endpoint: r.endpoint,
      projectPath: r.project_path,
      startedAt: r.started_at,
      lastActivityAt: r.last_activity_at,
      severity: r.risky_actions > 0 ? 'high' : null,
      riskyActions: Number(r.risky_actions ?? 0),
      toolCalls: Number(r.tool_calls ?? 0),
    }));
  }

  async getSessionTimeline(sessionId: string, opts: { limit?: number; includeResults?: boolean } = {}): Promise<ActionRecord[]> {
    const rows = all<EventRow>(
      `SELECT * FROM events
       WHERE session_id = ? AND NOT (capture_channel = 'hook' AND correlated_event_id IS NOT NULL)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [sessionId, limitOf(opts.limit, 100)],
    ).reverse();
    return this.records(rows, opts.includeResults !== false);
  }

  async searchActions(q: ActionSearch): Promise<ActionRecord[]> {
    const where = [`NOT (e.capture_channel = 'hook' AND e.correlated_event_id IS NOT NULL)`];
    const params: (string | number)[] = [];
    if (q.sessionId) { where.push('e.session_id = ?'); params.push(q.sessionId); }
    if (q.agent) { where.push('e.agent_id = ?'); params.push(q.agent); }
    if (q.toolName) { where.push('e.tool_name = ?'); params.push(q.toolName); }
    if (q.category) { where.push('e.category = ?'); params.push(q.category); }
    if (q.since) { where.push('e.created_at >= ?'); params.push(q.since); }
    if (q.until) { where.push('e.created_at < ?'); params.push(q.until); }
    if (q.text) {
      where.push(`(e.tool_name LIKE ? OR e.error_text LIKE ? OR e.payload LIKE ? OR EXISTS (
        SELECT 1 FROM findings f WHERE f.event_id = e.id AND (f.label LIKE ? OR f.key LIKE ?)
      ))`);
      const like = `%${q.text}%`;
      params.push(like, like, like, like, like);
    }
    const rows = all<EventRow>(
      `SELECT e.* FROM events e
       WHERE ${where.join(' AND ')}
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT ?`,
      [...params, limitOf(q.limit, 100)],
    ).filter(r => !q.riskAtLeast || (RISK_RANK[r.risk_level ?? ''] ?? 0) >= RISK_RANK[q.riskAtLeast]);
    return this.records(rows, true);
  }

  private async records(rows: EventRow[], includeResults: boolean): Promise<ActionRecord[]> {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const ph = ids.map(() => '?').join(',');
    const findings = all<FindingRow>(
      `SELECT event_id, kind, key, label, severity FROM findings WHERE event_id IN (${ph}) ORDER BY id`,
      ids,
    );
    const byEvent = new Map<number, FindingRow[]>();
    for (const f of findings) {
      const arr = byEvent.get(f.event_id) ?? [];
      arr.push(f);
      byEvent.set(f.event_id, arr);
    }
    return rows.map(row => {
      const payload = parsePayload(row.payload);
      return {
        eventId: row.id,
        sessionId: row.session_id,
        agentId: row.agent_id,
        surface: row.capture_channel ?? 'log',
        occurredAt: row.created_at,
        eventType: row.event_type,
        toolName: row.tool_name,
        category: row.category,
        mcpServer: row.mcp_server,
        riskLevel: row.risk_level,
        status: row.status,
        input: row.event_type === 'tool_call' ? actionInput(payload) : undefined,
        result: actionResult(row, payload, includeResults),
        findings: (byEvent.get(row.id) ?? []).map(f => ({
          kind: f.kind,
          key: f.key,
          label: f.label ?? f.key,
          severity: f.severity,
        })),
      };
    });
  }
}

export function initSqliteTelemetry(): void {
  setTelemetryReader(new SqliteTelemetryReader());
}
