/** Read-side queries backing the dashboard API. */
import { all, get } from './db';
import { agentFor, AUTONOMY_LABELS } from './analytics/identity';
import { detectorClass } from './analytics/detectors';
import { scoreSession, Severity } from './analytics/severity';

export interface Range { from: string; to: string }

// Hook rows that duplicate a log row are excluded from every count.
const NOT_DUP = `NOT (e.capture_channel = 'hook' AND e.correlated_event_id IS NOT NULL)`;
const LIVE_MS = 5 * 60_000;

export function parseRange(q: Record<string, unknown>): Range {
  const now = Date.now();
  const toMs = q.to ? Date.parse(String(q.to)) : now;
  const fromMs = q.from ? Date.parse(String(q.from)) : toMs - 7 * 86_400_000;
  return {
    from: new Date(Number.isFinite(fromMs) ? fromMs : now - 7 * 86_400_000).toISOString(),
    to: new Date(Number.isFinite(toMs) ? toMs : now).toISOString(),
  };
}

export function previousRange(r: Range): Range {
  const span = Date.parse(r.to) - Date.parse(r.from);
  return { from: new Date(Date.parse(r.from) - span).toISOString(), to: r.from };
}

// ── Conversations ────────────────────────────────────────────────────────

export interface DetectorSummary { key: string; label: string; count: number; cls: string }

export interface ConversationRow {
  id: string;
  agentKey: string;
  agentName: string;
  agentKind: string;
  title: string | null;
  projectPath: string | null;
  user: string | null;
  endpoint: string | null;
  model: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  live: boolean;
  prompts: number;
  actions: number;
  builtin: number;
  mcp: number;
  riskyActions: number;
  severity: Severity;
  severityReasons: string[];
  autonomyLevel: number | null;
  autonomyLabel: string | null;
  detectors: DetectorSummary[];
  domains: number;
  mcpServers: number;
  domainKeys: string[];
  mcpKeys: string[];
  enforcement: { blocked: number; denied: number; warned: number; prompted: number };
  channels: string[];
}

interface SessionRow {
  id: string; agent_key: string | null; source: string; title: string | null; project_path: string | null;
  user: string | null; endpoint: string | null; model: string | null; started_at: string | null;
  last_activity_at: string | null; ended_at: string | null; autonomy_level: number | null;
}

function sessionWhere(r: Range, agents?: string[]): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = [r.from, r.to];
  let sql = `COALESCE(s.last_activity_at, s.started_at) >= ? AND s.started_at <= ?`;
  if (agents?.length) {
    sql += ` AND COALESCE(s.agent_key, s.source) IN (${agents.map(() => '?').join(',')})`;
    params.push(...agents);
  }
  return { sql, params };
}

export function listConversations(r: Range | null, opts: { agents?: string[]; ids?: string[]; limit?: number } = {}): ConversationRow[] {
  let where: { sql: string; params: (string | number)[] };
  if (opts.ids) {
    if (!opts.ids.length) return [];
    where = { sql: `s.id IN (${opts.ids.map(() => '?').join(',')})`, params: [...opts.ids] };
  } else {
    where = sessionWhere(r!, opts.agents);
  }
  const limit = Math.min(opts.limit ?? 2000, 5000);
  const sessions = all<SessionRow>(
    `SELECT s.* FROM sessions s WHERE ${where.sql} ORDER BY COALESCE(s.last_activity_at, s.started_at) DESC LIMIT ${limit}`,
    where.params,
  );
  if (!sessions.length) return [];
  const idList = sessions.map(s => s.id);
  const ph = idList.map(() => '?').join(',');

  const stats = new Map<string, Record<string, number>>();
  for (const row of all<Record<string, number | string>>(
    `SELECT e.session_id AS sid,
       SUM(CASE WHEN e.event_type = 'prompt' THEN 1 ELSE 0 END) AS prompts,
       SUM(CASE WHEN e.event_type = 'tool_call' THEN 1 ELSE 0 END) AS actions,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.mcp_server IS NULL THEN 1 ELSE 0 END) AS builtin,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.mcp_server IS NOT NULL THEN 1 ELSE 0 END) AS mcp,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.risk_level = 'critical' THEN 1 ELSE 0 END) AS crit,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.risk_level = 'high' THEN 1 ELSE 0 END) AS high,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.risk_level = 'medium' THEN 1 ELSE 0 END) AS medium,
       SUM(CASE WHEN e.capture_channel = 'log' THEN 1 ELSE 0 END) AS ch_log,
       SUM(CASE WHEN e.capture_channel = 'hook' THEN 1 ELSE 0 END) AS ch_hook,
       SUM(CASE WHEN e.capture_channel = 'poll' THEN 1 ELSE 0 END) AS ch_poll
     FROM events e WHERE e.session_id IN (${ph}) AND ${NOT_DUP} GROUP BY e.session_id`,
    idList,
  )) stats.set(String(row.sid), row as Record<string, number>);

  const fAgg = new Map<string, { kind: string; key: string; label: string; c: number }[]>();
  for (const row of all<{ sid: string; kind: string; key: string; label: string; c: number }>(
    `SELECT f.session_id AS sid, f.kind, f.key, MAX(f.label) AS label, COUNT(*) AS c
     FROM findings f JOIN events e ON e.id = f.event_id
     WHERE f.session_id IN (${ph}) AND ${NOT_DUP}
     GROUP BY f.session_id, f.kind, f.key`,
    idList,
  )) {
    const arr = fAgg.get(row.sid) ?? [];
    arr.push(row);
    fAgg.set(row.sid, arr);
  }

  const now = Date.now();
  return sessions.map(s => {
    const st = stats.get(s.id) ?? {};
    const fs = fAgg.get(s.id) ?? [];
    const agent = agentFor(s.agent_key ?? s.source);
    const detectors: DetectorSummary[] = fs.filter(f => f.kind === 'detector')
      .map(f => ({ key: f.key, label: f.label, count: f.c, cls: detectorClass(f.key) }))
      .sort((a, b) => (a.cls === b.cls ? b.count - a.count : a.cls === 'secret' ? -1 : 1));
    const policy = (k: string) => fs.filter(f => f.kind === 'policy' && f.key === k).reduce((n, f) => n + f.c, 0);
    const enforcement = { blocked: policy('blocked'), denied: policy('denied'), warned: policy('warned'), prompted: policy('prompted') };
    const domains = fs.filter(f => f.kind === 'domain').length;
    const sev = scoreSession({
      criticalActions: st.crit ?? 0, highActions: st.high ?? 0, mediumActions: st.medium ?? 0,
      secretDetections: detectors.filter(d => d.cls === 'secret').reduce((n, d) => n + d.count, 0),
      piiDetections: detectors.filter(d => d.cls === 'pii').reduce((n, d) => n + d.count, 0),
      externalDomains: domains,
      policyBlocks: enforcement.blocked + enforcement.denied,
    });
    const last = s.last_activity_at ?? s.started_at;
    const channels = (['log', 'hook', 'poll'] as const).filter(c => (st[`ch_${c}`] ?? 0) > 0);
    return {
      id: s.id,
      agentKey: agent.key, agentName: agent.name, agentKind: agent.kind,
      title: s.title, projectPath: s.project_path, user: s.user, endpoint: s.endpoint, model: s.model,
      startedAt: s.started_at, lastActivityAt: last, endedAt: s.ended_at,
      live: !!last && now - Date.parse(last) < LIVE_MS,
      prompts: st.prompts ?? 0, actions: st.actions ?? 0, builtin: st.builtin ?? 0, mcp: st.mcp ?? 0,
      riskyActions: (st.crit ?? 0) + (st.high ?? 0),
      severity: sev.severity, severityReasons: sev.reasons,
      autonomyLevel: s.autonomy_level, autonomyLabel: s.autonomy_level ? AUTONOMY_LABELS[s.autonomy_level] ?? null : null,
      detectors,
      domains,
      mcpServers: fs.filter(f => f.kind === 'mcp').length,
      domainKeys: fs.filter(f => f.kind === 'domain').sort((a, b) => b.c - a.c).slice(0, 50).map(f => f.key),
      mcpKeys: fs.filter(f => f.kind === 'mcp').map(f => f.key),
      enforcement,
      channels,
    };
  });
}

// ── Overview ─────────────────────────────────────────────────────────────

function bucketLen(r: Range): number {
  return Date.parse(r.to) - Date.parse(r.from) <= 2 * 86_400_000 ? 13 : 10;   // hour vs day buckets (ISO prefix)
}

export function bucketKeys(r: Range): string[] {
  const len = bucketLen(r);
  const step = len === 13 ? 3_600_000 : 86_400_000;
  const keys: string[] = [];
  let t = Date.parse(r.from);
  const end = Date.parse(r.to);
  t -= t % step;
  while (t <= end && keys.length < 400) { keys.push(new Date(t).toISOString().slice(0, len)); t += step; }
  return keys;
}

function kpiCounts(r: Range) {
  const inRange = `e.created_at >= ? AND e.created_at <= ?`;
  const p = [r.from, r.to];
  const activeAgents = get<{ c: number }>(
    `SELECT COUNT(DISTINCT COALESCE(s.agent_key, s.source)) AS c FROM sessions s WHERE ${sessionWhere(r).sql}`, p)?.c ?? 0;
  const totalSessions = get<{ c: number }>(`SELECT COUNT(*) AS c FROM sessions s WHERE ${sessionWhere(r).sql}`, p)?.c ?? 0;
  const sensitiveSessions = get<{ c: number }>(
    `SELECT COUNT(DISTINCT f.session_id) AS c FROM findings f JOIN events e ON e.id = f.event_id
     WHERE f.kind = 'detector' AND ${inRange} AND ${NOT_DUP}`, p)?.c ?? 0;
  const riskyActions = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events e WHERE e.event_type = 'tool_call' AND e.risk_level IN ('high','critical') AND ${inRange} AND ${NOT_DUP}`, p)?.c ?? 0;
  const blockedWarned = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM findings f JOIN events e ON e.id = f.event_id
     WHERE f.kind = 'policy' AND f.key IN ('blocked','denied','warned') AND ${inRange} AND ${NOT_DUP}`, p)?.c ?? 0;
  const actions = get<{ c: number }>(
    `SELECT COUNT(*) AS c FROM events e WHERE e.event_type = 'tool_call' AND ${inRange} AND ${NOT_DUP}`, p)?.c ?? 0;
  return { activeAgents, totalSessions, sensitiveSessions, riskyActions, blockedWarned, actions };
}

function series(r: Range, sql: string): number[] {
  const len = bucketLen(r);
  const keys = bucketKeys(r);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const out = new Array(keys.length).fill(0);
  for (const row of all<{ b: string; c: number }>(sql.replace(/\{B\}/g, `substr(e.created_at, 1, ${len})`), [r.from, r.to])) {
    const i = idx.get(row.b);
    if (i != null) out[i] = row.c;
  }
  return out;
}

export function overview(r: Range) {
  const cur = kpiCounts(r);
  const prev = kpiCounts(previousRange(r));
  const inRange = `e.created_at >= ? AND e.created_at <= ?`;
  const join = `FROM events e JOIN sessions s ON s.id = e.session_id`;
  const sp = {
    activeAgents: series(r, `SELECT {B} AS b, COUNT(DISTINCT COALESCE(s.agent_key, s.source)) AS c ${join} WHERE ${inRange} GROUP BY b`),
    totalSessions: series(r, `SELECT {B} AS b, COUNT(DISTINCT e.session_id) AS c FROM events e WHERE ${inRange} GROUP BY b`),
    sensitiveSessions: series(r, `SELECT {B} AS b, COUNT(DISTINCT f.session_id) AS c FROM findings f JOIN events e ON e.id = f.event_id WHERE f.kind = 'detector' AND ${inRange} AND ${NOT_DUP} GROUP BY b`),
    riskyActions: series(r, `SELECT {B} AS b, COUNT(*) AS c FROM events e WHERE e.event_type = 'tool_call' AND e.risk_level IN ('high','critical') AND ${inRange} AND ${NOT_DUP} GROUP BY b`),
    blockedWarned: series(r, `SELECT {B} AS b, COUNT(*) AS c FROM findings f JOIN events e ON e.id = f.event_id WHERE f.kind = 'policy' AND f.key IN ('blocked','denied','warned') AND ${inRange} AND ${NOT_DUP} GROUP BY b`),
  };

  // Actions per agent per bucket for the activity trend chart.
  const len = bucketLen(r);
  const keys = bucketKeys(r);
  const idx = new Map(keys.map((k, i) => [k, i]));
  const byAgent = new Map<string, number[]>();
  for (const row of all<{ a: string; b: string; c: number }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a, substr(e.created_at, 1, ${len}) AS b, COUNT(*) AS c ${join}
     WHERE e.event_type = 'tool_call' AND ${inRange} AND ${NOT_DUP} GROUP BY a, b`, [r.from, r.to])) {
    const arr = byAgent.get(row.a) ?? new Array(keys.length).fill(0);
    const i = idx.get(row.b);
    if (i != null) arr[i] = row.c;
    byAgent.set(row.a, arr);
  }

  const kpi = (k: keyof typeof sp) => ({ value: cur[k], previous: prev[k], series: sp[k] });
  return {
    range: r,
    bucket: len === 13 ? 'hour' : 'day',
    buckets: keys,
    kpis: {
      activeAgents: kpi('activeAgents'),
      totalSessions: kpi('totalSessions'),
      sensitiveSessions: kpi('sensitiveSessions'),
      riskyActions: kpi('riskyActions'),
      blockedWarned: kpi('blockedWarned'),
    },
    totalActions: cur.actions,
    trend: [...byAgent.entries()].map(([key, data]) => ({ agentKey: key, agentName: agentFor(key).name, data })),
  };
}

// ── Agents & connections ─────────────────────────────────────────────────

export function topAgents(r: Range) {
  const inRange = `e.created_at >= ? AND e.created_at <= ?`;
  const p = [r.from, r.to];
  const rows = new Map<string, Record<string, number>>();
  const bump = (k: string, field: string, v: number) => {
    const row = rows.get(k) ?? {};
    row[field] = v;
    rows.set(k, row);
  };
  for (const x of all<{ a: string; c: number; u: number; ep: number }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a, COUNT(*) AS c, COUNT(DISTINCT s.user) AS u, COUNT(DISTINCT s.endpoint) AS ep
     FROM sessions s WHERE ${sessionWhere(r).sql} GROUP BY a`, p)) {
    bump(x.a, 'sessions', x.c); bump(x.a, 'users', x.u); bump(x.a, 'endpoints', x.ep);
  }
  for (const x of all<{ a: string; actions: number; risky: number }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a,
       SUM(CASE WHEN e.event_type = 'tool_call' THEN 1 ELSE 0 END) AS actions,
       SUM(CASE WHEN e.event_type = 'tool_call' AND e.risk_level IN ('high','critical') THEN 1 ELSE 0 END) AS risky
     FROM events e JOIN sessions s ON s.id = e.session_id WHERE ${inRange} AND ${NOT_DUP} GROUP BY a`, p)) {
    bump(x.a, 'actions', x.actions); bump(x.a, 'risky', x.risky);
  }
  for (const x of all<{ a: string; kind: string; c: number }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a, f.kind, COUNT(DISTINCT f.key) AS c
     FROM findings f JOIN events e ON e.id = f.event_id JOIN sessions s ON s.id = f.session_id
     WHERE f.kind IN ('detector','mcp','domain') AND ${inRange} AND ${NOT_DUP} GROUP BY a, f.kind`, p)) {
    bump(x.a, x.kind === 'detector' ? 'detectors' : x.kind === 'mcp' ? 'mcps' : 'domains', x.c);
  }
  for (const x of all<{ a: string; c: number }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a, COUNT(DISTINCT s.endpoint) AS c
     FROM findings f JOIN events e ON e.id = f.event_id JOIN sessions s ON s.id = f.session_id
     WHERE f.kind = 'policy' AND f.key IN ('blocked','denied','warned') AND ${inRange} AND ${NOT_DUP} GROUP BY a`, p)) {
    bump(x.a, 'enforcedEndpoints', x.c);
  }
  return [...rows.entries()].map(([key, v]) => {
    const a = agentFor(key);
    return {
      agentKey: a.key, agentName: a.name, agentKind: a.kind,
      actions: v.actions ?? 0, sessions: v.sessions ?? 0, riskyActions: v.risky ?? 0,
      detectors: v.detectors ?? 0, mcps: v.mcps ?? 0, domains: v.domains ?? 0,
      enforcedEndpoints: v.enforcedEndpoints ?? 0, users: v.users ?? 0, endpoints: v.endpoints ?? 0,
    };
  }).sort((a, b) => b.actions - a.actions || b.sessions - a.sessions);
}

export function connections(r: Range, topN = 12) {
  const rows = all<{ a: string; kind: string; key: string; c: number; last: string }>(
    `SELECT COALESCE(s.agent_key, s.source) AS a, f.kind, f.key, COUNT(*) AS c, MAX(f.created_at) AS last
     FROM findings f JOIN events e ON e.id = f.event_id JOIN sessions s ON s.id = f.session_id
     WHERE f.kind IN ('mcp','domain') AND e.created_at >= ? AND e.created_at <= ? AND ${NOT_DUP}
     GROUP BY a, f.kind, f.key`, [r.from, r.to]);
  const agents = new Set<string>();
  const build = (kind: string) => {
    const totals = new Map<string, number>();
    const cells: Record<string, Record<string, { count: number; last: string }>> = {};
    for (const x of rows.filter(y => y.kind === kind)) {
      agents.add(x.a);
      totals.set(x.key, (totals.get(x.key) ?? 0) + x.c);
      (cells[x.a] ??= {})[x.key] = { count: x.c, last: x.last };
    }
    const columns = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([key, total]) => ({ key, total }));
    return { columns: columns.slice(0, topN), totalColumns: columns.length, cells };
  };
  const mcp = build('mcp');
  const domains = build('domain');
  return {
    agents: [...agents].map(k => { const a = agentFor(k); return { agentKey: a.key, agentName: a.name }; }),
    mcp, domains,
  };
}

// ── Enforcements ─────────────────────────────────────────────────────────

export function enforcements(r: Range, limit = 2000) {
  return all<Record<string, unknown>>(
    `SELECT f.id, f.event_id AS eventId, f.key AS outcome, f.label, f.severity, e.created_at AS t, e.tool_name AS tool,
       e.capture_channel AS channel, e.session_id AS sessionId, s.title, COALESCE(s.agent_key, s.source) AS agentKey,
       s.user, s.endpoint
     FROM findings f JOIN events e ON e.id = f.event_id JOIN sessions s ON s.id = f.session_id
     WHERE f.kind = 'policy' AND e.created_at >= ? AND e.created_at <= ? AND ${NOT_DUP}
     ORDER BY e.created_at DESC LIMIT ?`, [r.from, r.to, limit],
  ).map(x => ({ ...x, agentName: agentFor(String(x.agentKey)).name }));
}
