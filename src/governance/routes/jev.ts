// src/governance/routes/jev.ts
/**
 * TypeSafe Jev shadow-mode API (mounted under the admin router at /api/gov/jev).
 *
 *   GET  /api/gov/jev/summary  — per-kind comparison summary for a window         (Viewer)
 *   GET  /api/gov/jev/shadow   — cursor-paged shadow records, newest first         (Viewer)
 *   POST /api/gov/jev/shadow   — append a guardian_triage (intelligence) or fleet_* (AgentMon Fleet)
 *                                record                                            (PolicyAdmin | Agent)
 *                                id/createdAt are server-assigned; judge/injection/session_score → 400
 *
 * Shadow records are non-authoritative benchmark data and are never part of the audit chain.
 */
import crypto from 'crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { govStore } from '../store';
import { JEV_FLEET_SHADOW_KINDS, JEV_SHADOW_KINDS } from '../jev/stats';
import { buildShadowSummary } from '../jev/summary';
import type { JevShadowInput, JevShadowKind, JevShadowRecord } from '../jev/types';

const router = Router();

const kindEnum = z.enum(JEV_SHADOW_KINDS);
const isoDate = z.string().max(40).refine(v => Number.isFinite(Date.parse(v)), 'must be an ISO-8601 timestamp');
const shortStr = (max = 256) => z.string().max(max);
const count = z.number().int().nonnegative().max(1e9);
const num = z.number().finite();

const baselineSchema = z.object({
  provider: z.enum(['foundry', 'rules', 'prompt-shields', 'guardian', 'heuristic', 'none']),
  model: shortStr().optional(),
  verdict: shortStr(64).optional(),
  score: num.optional(),
  confidence: num.optional(),
  latencyMs: z.number().nonnegative().max(3_600_000).optional(),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  stage: shortStr(64).optional(),
});

const jevSchema = z.object({
  model: shortStr(),
  verdict: shortStr(64).optional(),
  score: num.optional(),
  confidence: num.optional(),
  latencyMs: z.number().nonnegative().max(3_600_000),
  inputTokens: count.optional(),
  outputTokens: count.optional(),
  policy: shortStr(64).optional(),
  rationale: shortStr(4000).optional(),
  laneClause: shortStr(4000).optional(),
  signals: z.record(shortStr(128), z.union([num, shortStr(256)]))
    .refine(s => Object.keys(s).length <= 200, 'at most 200 signals'),
  error: shortStr(2000).optional(),
});

/**
 * Kinds writable via `POST /api/gov/jev/shadow`: the intelligence service's Guardian triage and the
 * Python AgentMon Fleet's comparisons (`fleet_*`) are produced out-of-process; judge / injection /
 * session_score records are written in-process by the monitor itself and are rejected here. The
 * route is reachable by `Agent`-role callers (the same role governed agents' hooks — and the Fleet's
 * FLEET_MONITOR_TOKEN principal — hold), so accepting in-process kinds would let an agent skew the
 * judge / injection / session promotion metrics.
 */
export const JEV_SHADOW_POSTABLE_KINDS = ['guardian_triage', ...JEV_FLEET_SHADOW_KINDS] as const satisfies readonly JevShadowKind[];

/**
 * Body schema for `POST /api/gov/jev/shadow` (JevShadowInput). `id` and `createdAt` are accepted for
 * backward compatibility but IGNORED — the server always assigns a fresh UUID and its own clock, so a
 * caller can neither overwrite an existing record nor back/forward-date one.
 */
export const jevShadowInputSchema = z.object({
  id: shortStr(128).optional(),
  createdAt: shortStr(64).optional(),
  kind: z.enum(JEV_SHADOW_POSTABLE_KINDS),
  decisionId: shortStr().optional(),
  requestId: shortStr().optional(),
  sessionId: shortStr().optional(),
  agentId: shortStr().optional(),
  laneId: shortStr().optional(),
  checkpoint: shortStr(64).optional(),
  toolName: shortStr().optional(),
  baseline: baselineSchema,
  jev: jevSchema,
  agree: z.boolean().optional(),
});

function list(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  const raw = Array.isArray(v) ? v.map(String) : [String(v)];
  const out = raw.flatMap(s => s.split(',')).map(s => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

const summaryQuery = z.object({
  since: isoDate.optional(),
  until: isoDate.optional(),
  kind: z.array(kindEnum).optional(),
});

const shadowQuery = summaryQuery.extend({
  sessionId: shortStr().optional(),
  laneId: shortStr().optional(),
  agree: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: shortStr(1024).optional(),
});

function str(v: unknown): string | undefined { return typeof v === 'string' && v !== '' ? v : undefined; }

function issues(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map(i => ({ path: i.path.join('.'), message: i.message }));
}

function parseSummaryQuery(req: Request) {
  return summaryQuery.safeParse({ since: str(req.query.since), until: str(req.query.until), kind: list(req.query.kind) });
}

router.get('/jev/summary', requireRole('Viewer'), async (req, res) => {
  const q = parseSummaryQuery(req);
  if (!q.success) { res.status(400).json({ error: 'invalid query', issues: issues(q.error) }); return; }
  res.json(await buildShadowSummary(govStore(), q.data));
});

router.get('/jev/shadow', requireRole('Viewer'), async (req, res) => {
  const q = shadowQuery.safeParse({
    since: str(req.query.since), until: str(req.query.until), kind: list(req.query.kind),
    sessionId: str(req.query.sessionId), laneId: str(req.query.laneId), agree: str(req.query.agree),
    limit: str(req.query.limit), cursor: str(req.query.cursor),
  });
  if (!q.success) { res.status(400).json({ error: 'invalid query', issues: issues(q.error) }); return; }
  const { agree, ...rest } = q.data;
  res.json(await govStore().queryJevShadow({ ...rest, agree: agree == null ? undefined : agree === 'true' }));
});

// Same roles the intelligence service uses to write incidents and the Fleet uses for
// /api/gov/fleet/alerts (PolicyAdmin | Agent). Hardened for Agent-role callers: guardian_triage +
// fleet_* only, server-assigned id + createdAt (append-only).
router.post('/jev/shadow', requireRole('PolicyAdmin', 'Agent'), async (req, res) => {
  const parsed = jevShadowInputSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid shadow record', issues: issues(parsed.error) }); return; }
  const input: JevShadowInput = parsed.data;
  // Spread first, then override: client-supplied id/createdAt never reach the store.
  const record: JevShadowRecord = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  res.status(201).json(await govStore().appendJevShadow(record));
});

export default router;
