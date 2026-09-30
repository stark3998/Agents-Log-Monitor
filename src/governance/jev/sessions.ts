// src/governance/jev/sessions.ts
/**
 * Background Jev session scoring (shadow mode). Periodically picks sessions with new activity,
 * builds a compact, redacted `SessionDigest` from the monitor read model, asks Jev for a semantic
 * severity and stores a `session_score` shadow record next to the heuristic severity the dashboard
 * shows (`scoreSession()` via `listConversations`). Never changes any stored severity.
 *
 * - Selection: sessions whose last activity falls in [watermark, now] (watermark = previous run, or
 *   now âˆ’ interval on the first run) and that have not been scored since that activity (in-memory
 *   map, falling back to the latest stored `session_score` record after a restart). Capped per run.
 * - Work is enqueued on the bounded `shadowQueue`; the digest is built inside the queued task so
 *   ingest is never blocked, and the timer is unref'd.
 */
import { randomUUID } from 'crypto';
import { all } from '../../db';
import { detectorClass } from '../../analytics/detectors';
import { REDACTION_MODE, redactString } from '../../analytics/redact';
import { SEVERITY_RANK, type Severity } from '../../analytics/severity';
import { listConversations, type ConversationRow } from '../../queries';
import { govStore } from '../store';
import { jevConfig } from './config';
import { emitShadow } from './events';
import { assessSession, type SessionAssessment } from './judge';
import { shadowQueue } from './runtime';
import type { SessionDigest } from './state';
import type { JevShadowRecord, JevSignals } from './types';

/** Hook rows that duplicate a log row are excluded everywhere (same rule as the read model). */
const NOT_DUP = `NOT (e.capture_channel = 'hook' AND e.correlated_event_id IS NOT NULL)`;
const MAX_GOAL_CHARS = 500;
const MAX_DIGEST_ACTIONS = 40;
const MAX_ACTION_CHARS = 200;
const MAX_SUMMARY_CHARS = 160;
const MAX_DOMAINS = 50;
const MAX_RISK_HITS = 50;
const DEFAULT_RUN_LIMIT = 50;
/** Upper bound on candidate rows read per run (the per-run scoring cap is applied after filtering). */
const MAX_CANDIDATES = 2000;
const FIRST_RUN_DELAY_MS = 60_000;

const RISK_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Secrets are always masked before anything leaves the process, even when storage redaction is off. */
const EXPORT_REDACTION = REDACTION_MODE === 'all' ? 'all' : 'secrets';

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}â€¦` : s;
}

function clean(s: unknown, max: number): string {
  const text = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s);
  return clip(redactString(text.replace(/\s+/g, ' ').trim(), EXPORT_REDACTION), max);
}

function parse(p: string | null): Record<string, unknown> {
  if (!p) return {};
  try {
    const o: unknown = JSON.parse(p);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Short, redacted description of a tool input: the most telling scalar field only, never the payload. */
function actionSummary(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return clean(String(input), MAX_SUMMARY_CHARS);
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'url', 'query', 'pattern', 'description', 'prompt']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return clean(v, MAX_SUMMARY_CHARS);
  }
  return '';
}

interface ActionRow {
  id: number;
  event_type: string;
  tool_name: string | null;
  mcp_server: string | null;
  risk_level: string | null;
  payload: string | null;
  created_at: string;
}

interface ActionLine { id: number; t: string; weight: number; line: string }

/** Up to `MAX_DIGEST_ACTIONS` action lines, oldest first; risky/policy actions are kept preferentially. */
function digestActions(sessionId: string): { lines: string[]; total: number } {
  const policy = new Map<number, string>();
  for (const f of all<{ event_id: number; key: string }>(
    `SELECT f.event_id, f.key FROM findings f JOIN events e ON e.id = f.event_id
     WHERE f.session_id = ? AND f.kind = 'policy' AND ${NOT_DUP}`,
    [sessionId],
  )) {
    if (!policy.has(f.event_id) || f.key === 'blocked' || f.key === 'denied') policy.set(f.event_id, f.key);
  }

  const rows = all<ActionRow>(
    `SELECT e.id, e.event_type, e.tool_name, e.mcp_server, e.risk_level, e.payload, e.created_at FROM events e
     WHERE e.session_id = ? AND e.event_type = 'tool_call' AND ${NOT_DUP}
     ORDER BY e.created_at, e.id`,
    [sessionId],
  );
  const items: ActionLine[] = rows.map(r => {
    const tool = clean(r.tool_name ?? '(unknown)', 80);
    const mcp = r.mcp_server ? ` [mcp:${clean(r.mcp_server, 60)}]` : '';
    const summary = actionSummary(parse(r.payload).tool_input);
    const risk = r.risk_level && r.risk_level !== 'low' ? `[${r.risk_level}] ` : '';
    const pol = policy.get(r.id);
    const outcome = pol ? ` (${pol})` : '';
    return {
      id: r.id, t: r.created_at,
      weight: (RISK_WEIGHT[r.risk_level ?? ''] ?? 0) + (pol === 'blocked' || pol === 'denied' ? 3 : pol ? 1 : 0),
      line: clip(`${risk}${tool}${mcp}${summary ? `: ${summary}` : ''}${outcome}`, MAX_ACTION_CHARS),
    };
  });

  // Policy outcomes recorded on non-call rows (tool results, notifications) are facts worth keeping too.
  const callIds = new Set(rows.map(r => r.id));
  const extra = [...policy.entries()].filter(([id]) => !callIds.has(id));
  if (extra.length) {
    const meta = all<{ id: number; tool_name: string | null; created_at: string }>(
      `SELECT id, tool_name, created_at FROM events WHERE id IN (${extra.map(() => '?').join(',')})`,
      extra.map(([id]) => id),
    );
    const byId = new Map(meta.map(m => [m.id, m]));
    for (const [id, key] of extra) {
      const m = byId.get(id);
      if (!m) continue;
      items.push({ id, t: m.created_at, weight: key === 'blocked' || key === 'denied' ? 3 : 1, line: clip(`POLICY ${key}${m.tool_name ? `: ${clean(m.tool_name, 80)}` : ''}`, MAX_ACTION_CHARS) });
    }
  }

  const chrono = (a: ActionLine, b: ActionLine) => (a.t === b.t ? a.id - b.id : a.t < b.t ? -1 : 1);
  let kept = items;
  if (items.length > MAX_DIGEST_ACTIONS) {
    // Highest weight first; ties broken by recency so the tail of the session is represented.
    kept = [...items].sort((a, b) => b.weight - a.weight || chrono(b, a)).slice(0, MAX_DIGEST_ACTIONS);
  }
  return { lines: kept.sort(chrono).map(i => i.line), total: items.length };
}

function firstPrompt(sessionId: string): string | undefined {
  const row = all<{ payload: string | null }>(
    `SELECT e.payload FROM events e WHERE e.session_id = ? AND e.event_type = 'prompt' AND ${NOT_DUP}
     ORDER BY e.created_at, e.id LIMIT 1`,
    [sessionId],
  )[0];
  if (!row) return undefined;
  const p = parse(row.payload);
  const text = p.prompt ?? p.message ?? p.user_message;
  return typeof text === 'string' && text.trim() ? clean(text, MAX_GOAL_CHARS) : undefined;
}

function riskHits(sessionId: string): string[] {
  return all<{ key: string }>(
    `SELECT f.key, COUNT(*) AS c FROM findings f JOIN events e ON e.id = f.event_id
     WHERE f.session_id = ? AND f.kind = 'risk' AND ${NOT_DUP}
     GROUP BY f.key ORDER BY c DESC, f.key LIMIT ${MAX_RISK_HITS}`,
    [sessionId],
  ).map(r => clean(r.key, 100));
}

function riskCounts(sessionId: string): { critical: number; high: number; medium: number } {
  const out = { critical: 0, high: 0, medium: 0 };
  for (const r of all<{ risk_level: string; c: number }>(
    `SELECT e.risk_level, COUNT(*) AS c FROM events e
     WHERE e.session_id = ? AND e.event_type = 'tool_call' AND e.risk_level IN ('critical','high','medium') AND ${NOT_DUP}
     GROUP BY e.risk_level`,
    [sessionId],
  )) out[r.risk_level as keyof typeof out] = Number(r.c);
  return out;
}

/** Deterministic counts (computed in code, handed to Jev as facts). */
function findingCounts(sessionId: string, c: ConversationRow): Record<string, number> {
  const byClass = { secret: 0, pii: 0, other: 0 };
  for (const d of c.detectors) byClass[detectorClass(d.key)] += d.count;
  const risk = riskCounts(sessionId);
  return {
    secrets: byClass.secret,
    personal_data: byClass.pii,
    other_detections: byClass.other,
    critical_risk_actions: risk.critical,
    high_risk_actions: risk.high,
    medium_risk_actions: risk.medium,
    policy_blocked: c.enforcement.blocked,
    policy_denied: c.enforcement.denied,
    policy_warned: c.enforcement.warned,
    policy_prompted: c.enforcement.prompted,
    external_domains: c.domains,
    mcp_servers: c.mcpServers,
    prompts: c.prompts,
    tool_calls: c.actions,
  };
}

interface SessionSnapshot {
  digest: SessionDigest;
  heuristic: Severity;
  lastActivityAt: string | null;
}

function snapshot(sessionId: string, goal?: string): SessionSnapshot | undefined {
  const conv = listConversations(null, { ids: [sessionId] })[0];
  if (!conv) return undefined;
  const actions = digestActions(sessionId);
  const digest: SessionDigest = {
    sessionId,
    agent: clean(conv.agentName, 200),
    actions: actions.lines,
    findings: findingCounts(sessionId, conv),
    domains: conv.domainKeys.slice(0, MAX_DOMAINS).map(d => clean(d, 200)),
    mcpServers: conv.mcpKeys.map(m => clean(m, 200)),
    riskHits: riskHits(sessionId),
  };
  const g = goal?.trim() ? clean(goal, MAX_GOAL_CHARS) : firstPrompt(sessionId);
  if (g) digest.goal = g;
  return { digest, heuristic: conv.severity, lastActivityAt: conv.lastActivityAt };
}

/**
 * Build the Jev session digest for `sessionId` from the monitor read model, or undefined when the
 * session does not exist. Contains only redacted summaries and code-computed counts â€” never raw
 * payloads. `goal` (e.g. the governance `SessionIntent.goal`) overrides the first user prompt.
 */
export function buildSessionDigest(sessionId: string, opts: { goal?: string } = {}): SessionDigest | undefined {
  return snapshot(sessionId, opts.goal)?.digest;
}

// â”€â”€ Scheduler state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** sessionId â†’ last-activity timestamp covered by the latest score. */
const scored = new Map<string, string>();
const inFlight = new Set<string>();
let watermark: string | null = null;
let running = false;
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;

export interface SessionScoringRunResult {
  /** Sessions with activity in the window. */
  candidates: number;
  /** Sessions skipped because they were already scored since their last activity (or in flight). */
  skipped: number;
  /** Sessions handed to the shadow queue. */
  enqueued: number;
  /** Sessions rejected by a full shadow queue. */
  dropped: number;
  /** Records written (success or error). */
  written: number;
  /** Candidates left for the next run because of the per-run cap. */
  deferred: number;
}

const EMPTY: SessionScoringRunResult = { candidates: 0, skipped: 0, enqueued: 0, dropped: 0, written: 0, deferred: 0 };

async function intentGoal(sessionId: string): Promise<string | undefined> {
  try {
    return (await govStore().getSessionIntent(sessionId))?.goal || undefined;
  } catch {
    return undefined;
  }
}

/** Latest stored score time per session since `since` (restart fallback for the in-memory map). */
async function storedScores(since: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res = await govStore().queryJevShadow({ kind: ['session_score'], since, limit: 1000, cursor });
    for (const r of res.items) if (r.sessionId && !out.has(r.sessionId)) out.set(r.sessionId, r.createdAt);
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return out;
}

function errorMessage(err: unknown): string {
  return clean(err instanceof Error ? err.message : String(err), 500) || 'unknown error';
}

function record(sessionId: string, heuristic: Severity, asOf: string, a: SessionAssessment | null, err: unknown, latencyMs: number): JevShadowRecord {
  const base = { id: randomUUID(), kind: 'session_score' as const, sessionId, createdAt: asOf, baseline: { provider: 'heuristic' as const, verdict: heuristic } };
  if (!a) {
    return { ...base, jev: { model: jevConfig.model, latencyMs, signals: {}, error: errorMessage(err) } };
  }
  const signals: JevSignals = { ...a.signals };
  for (const [k, v] of Object.entries(a.dimensions)) signals[k] = v;
  signals.intent = a.intent;
  signals.severity_delta = SEVERITY_RANK[a.severity] - SEVERITY_RANK[heuristic];
  return {
    ...base,
    jev: {
      model: a.model, verdict: a.severity, score: a.composite, confidence: a.confidence, latencyMs: a.latencyMs,
      inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens, signals,
    },
    agree: a.severity === heuristic,
  };
}

/** Score one session; always resolves (errors become records). Returns true when a record was written. */
async function scoreOneSession(sessionId: string, asOf: string): Promise<boolean> {
  const goal = await intentGoal(sessionId);
  const snap = snapshot(sessionId, goal);
  if (!snap) return false;
  const started = Date.now();
  let assessment: SessionAssessment | null = null;
  let failure: unknown = null;
  try {
    assessment = await assessSession(snap.digest);
  } catch (err) {
    failure = err;
  }
  // Stamped with the run's upper time bound (not completion time) so activity arriving while the
  // Jev call is in flight still triggers a rescore on the next run.
  const saved = await govStore().appendJevShadow(record(sessionId, snap.heuristic, asOf, assessment, failure, Date.now() - started));
  emitShadow(saved);
  if (snap.lastActivityAt) scored.set(sessionId, snap.lastActivityAt);
  return true;
}

/**
 * One scoring pass. Picks sessions active since the previous run (first run: last interval) that
 * have not been scored since their last activity, scores at most `limit` (default 50) through the
 * shadow queue and resolves once those tasks settle. No-op unless shadow session scoring is enabled.
 */
export async function runSessionScoringOnce(opts: { limit?: number; now?: Date } = {}): Promise<SessionScoringRunResult> {
  if (!jevConfig.shadow.enabled || !jevConfig.shadow.sessionScoring || running) return { ...EMPTY };
  running = true;
  try {
    const now = (opts.now ?? new Date()).toISOString();
    const nowMs = Date.parse(now);
    const fallbackSince = new Date(nowMs - jevConfig.shadow.sessionIntervalMs).toISOString();
    const since = watermark && watermark < fallbackSince ? watermark : fallbackSince;
    const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_RUN_LIMIT));

    // Entries older than the window can never suppress a rescore (activity â‰¥ since > entry).
    for (const [id, t] of scored) if (Date.parse(t) < Date.parse(since)) scored.delete(id);

    const rows = all<{ id: string; last: string }>(
      `SELECT s.id, COALESCE(s.last_activity_at, s.started_at) AS last FROM sessions s
       WHERE COALESCE(s.last_activity_at, s.started_at) >= ? AND COALESCE(s.last_activity_at, s.started_at) <= ?
       ORDER BY last DESC LIMIT ${MAX_CANDIDATES}`,
      [since, now],
    );
    const result: SessionScoringRunResult = { ...EMPTY, candidates: rows.length };
    let stored: Map<string, string> | null = null;
    const todo: string[] = [];
    for (const r of rows) {
      if (inFlight.has(r.id)) { result.skipped += 1; continue; }
      let at = scored.get(r.id);
      if (at === undefined) {
        stored ??= await storedScores(since).catch(() => new Map<string, string>());
        at = stored.get(r.id);
      }
      if (at !== undefined && Date.parse(at) >= Date.parse(r.last)) { result.skipped += 1; continue; }
      todo.push(r.id);
    }
    const batch = todo.slice(0, limit);
    result.deferred = todo.length - batch.length;

    const settled = await Promise.all(batch.map(id => new Promise<boolean>(resolve => {
      inFlight.add(id);
      const ok = shadowQueue.enqueue(async () => {
        try {
          resolve(await scoreOneSession(id, now));
        } catch (err) {
          resolve(false);
          throw err; // counted + logged by the queue
        } finally {
          inFlight.delete(id);
        }
      });
      if (ok) result.enqueued += 1;
      else { inFlight.delete(id); result.dropped += 1; resolve(false); }
    })));
    result.written = settled.filter(Boolean).length;

    // Only advance past this window when nothing was left behind (cap / full queue); otherwise keep
    // its start so the next run picks up the leftovers.
    watermark = !result.deferred && !result.dropped ? now : since;
    return result;
  } finally {
    running = false;
  }
}

function tick(): void {
  void runSessionScoringOnce().catch(err => console.warn('[jev] session scoring failed:', err instanceof Error ? err.message : String(err)));
}

/** True while the periodic scorer is scheduled. */
export function jevSessionScoringActive(): boolean {
  return timer !== null;
}

/**
 * Start periodic session scoring (every `JEV_SHADOW_SESSION_INTERVAL_MS`). No-op unless Jev shadow
 * mode and session scoring are enabled, or when already started. Timers are unref'd.
 */
export function startJevSessionScoring(): void {
  if (!jevConfig.shadow.enabled || !jevConfig.shadow.sessionScoring || timer) return;
  const interval = jevConfig.shadow.sessionIntervalMs;
  firstTimer = setTimeout(tick, Math.min(interval, FIRST_RUN_DELAY_MS));
  firstTimer.unref?.();
  timer = setInterval(tick, interval);
  timer.unref?.();
}

/** Stop the scorer and forget scheduler state (tests / graceful shutdown). */
export function stopJevSessionScoring(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  scored.clear();
  inFlight.clear();
  watermark = null;
}
