import { Router } from 'express';
import YAML from 'yaml';
import { govConfig } from '../config';
import { hasRole, requireRole } from '../auth';
import { govStore } from '../store';
import { registry } from '../registry';
import { approvals } from '../approvals';
import { govBus } from '../events';
import type { Incident, Lane, LaneRecord, LaneStatus, Principal, RegisteredAgent, SessionIntent } from '../types';
import { parseLaneYaml, validateLane, validateLaneYaml } from '../lanes/loader';
import { simulateLane } from '../lanes/simulate';
import { intentTracker } from '../intent';
import { activePolicies } from '../policies';

const router = Router();

function arr<T>(v: T | T[] | undefined): T[] | undefined { return v == null ? undefined : Array.isArray(v) ? v : [v]; }
function nowIso(): string { return new Date().toISOString(); }
const laneStatuses: LaneStatus[] = ['active', 'draft', 'proposed', 'archived'];

function isUserPolicyAdmin(principal: Principal | undefined): boolean {
  return !!principal && principal.kind === 'user' && hasRole(principal, 'PolicyAdmin');
}

function protectsMonitorLane(lane: Lane): boolean {
  return lane.id === 'monitor-guardian' || (lane.appliesTo?.surfaces ?? []).includes('monitor');
}

router.get('/me', (req, res) => res.json(req.principal));

/** Public (unauthenticated) sign-in bootstrap settings for the dashboard. Contains no secrets. */
export function authBootstrap(): { mode: 'entra' | 'local'; clientId?: string; tenantId?: string; audience?: string } {
  const a = govConfig.auth;
  if (govConfig.mode !== 'cloud' || !a.audience || !a.tenantId) return { mode: 'local' };
  return { mode: 'entra', clientId: a.spaClientId || a.audience, tenantId: a.tenantId, audience: a.audience };
}

router.get('/config', requireRole('Viewer'), (_req, res) => {
  res.json({
    mode: govConfig.mode,
    enforcementEnabled: govConfig.enforcementEnabled,
    lanesDir: govConfig.lanesDir || 'lanes',
    judge: { enabled: govConfig.foundry.enabled, fast: govConfig.foundry.fastDeployment, escalation: govConfig.foundry.escalationDeployment },
    shields: { enabled: govConfig.contentSafety.enabled },
    intelligence: { enabled: !!govConfig.intelligence.url },
    auth: authBootstrap(),
  });
});

router.get('/overview', requireRole('Viewer'), async (req, res) => {
  const from = req.query.from as string | undefined;
  const to = req.query.to as string | undefined;
  const page = await govStore().queryDecisions({ since: from, until: to, limit: 20_000 });
  const decisions = { allow: 0, deny: 0, ask: 0, escalate: 0, wouldDeny: 0 };
  const buckets = new Map<string, { t: string; allow: number; deny: number; wouldDeny: number }>();
  const judgeMs: number[] = [];
  for (const d of page.items) {
    decisions[d.verdict]++;
    if (d.wouldDeny) decisions.wouldDeny++;
    if (d.judge?.length) judgeMs.push(...d.judge.map(j => j.latencyMs));
    const t = d.createdAt.slice(0, 13) + ':00:00.000Z';
    const b = buckets.get(t) ?? { t, allow: 0, deny: 0, wouldDeny: 0 };
    if (d.verdict === 'allow') b.allow++;
    if (d.verdict === 'deny') b.deny++;
    if (d.wouldDeny) b.wouldDeny++;
    buckets.set(t, b);
  }
  const approvalsList = await govStore().listApprovals({ state: ['pending'] });
  const incidents = await govStore().listIncidents({ state: ['open', 'investigating', 'contained'] });
  const agentList = await govStore().listAgents();
  judgeMs.sort((a, b) => a - b);
  res.json({
    decisions,
    pendingApprovals: approvalsList.length,
    openIncidents: incidents.length,
    agents: { active: agentList.filter(a => a.status === 'active').length, paused: agentList.filter(a => a.status === 'paused').length, quarantined: agentList.filter(a => a.status === 'quarantined').length },
    judge: { calls: judgeMs.length, p95Ms: judgeMs.length ? judgeMs[Math.floor((judgeMs.length - 1) * 0.95)] : 0 },
    trend: fillTrend(buckets, from ?? page.items[page.items.length - 1]?.createdAt, to),
  });
});

type TrendBucket = { t: string; allow: number; deny: number; wouldDeny: number };

/** Continuous series over [from, to]: hourly for ranges ≤ 48h, daily otherwise (hourly counts re-aggregated). */
function fillTrend(hourly: Map<string, TrendBucket>, from?: string, to?: string): TrendBucket[] {
  const end = to ? Date.parse(to) : Date.now();
  const start = from ? Date.parse(from) : end - 24 * 3600_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [...hourly.values()].sort((a, b) => a.t.localeCompare(b.t));
  const daily = end - start > 48 * 3600_000;
  const step = daily ? 24 * 3600_000 : 3600_000;
  const keyOf = (ms: number) => new Date(ms).toISOString().slice(0, daily ? 10 : 13) + (daily ? 'T00:00:00.000Z' : ':00:00.000Z');
  const out = new Map<string, TrendBucket>();
  for (let ms = Date.parse(keyOf(start)); ms <= end; ms += step) {
    const t = keyOf(ms);
    out.set(t, { t, allow: 0, deny: 0, wouldDeny: 0 });
  }
  for (const b of hourly.values()) {
    const t = keyOf(Date.parse(b.t));
    const o = out.get(t) ?? { t, allow: 0, deny: 0, wouldDeny: 0 };
    o.allow += b.allow; o.deny += b.deny; o.wouldDeny += b.wouldDeny;
    out.set(t, o);
  }
  return [...out.values()].sort((a, b) => a.t.localeCompare(b.t));
}

router.get('/decisions', requireRole('Viewer'), async (req, res) => {
  const q = req.query;
  const page = await govStore().queryDecisions({
    sessionId: q.sessionId as string | undefined, agentId: q.agentId as string | undefined, laneId: q.laneId as string | undefined,
    verdict: arr(q.verdict as never) as never, wouldDeny: q.wouldDeny == null ? undefined : q.wouldDeny === 'true', text: q.text as string | undefined,
    since: q.since as string | undefined, until: q.until as string | undefined, limit: q.limit ? Number(q.limit) : undefined, cursor: q.cursor as string | undefined,
  });
  res.json(page);
});
router.get('/decisions/:id', requireRole('Viewer'), async (req, res) => {
  const d = await govStore().getDecision(req.params.id);
  if (!d) { res.status(404).json({ error: 'not found' }); return; }
  res.json(d);
});

router.get('/approvals', requireRole('Viewer'), async (req, res) => res.json(await govStore().listApprovals({ state: arr(req.query.state as never) as never })));
router.post('/approvals/:id/approve', requireRole('Approver'), async (req, res) => res.json(await approvals.resolve(req.params.id, 'approved', req.principal?.id ?? 'unknown', req.body?.note)));
router.post('/approvals/:id/deny', requireRole('Approver'), async (req, res) => res.json(await approvals.resolve(req.params.id, 'denied', req.principal?.id ?? 'unknown', req.body?.note)));

router.get('/agents', requireRole('Viewer'), async (_req, res) => {
  const agents = await govStore().listAgents();
  const decisions = await govStore().queryDecisions({ limit: 20_000 });
  res.json(agents.map(a => {
    const ds = decisions.items.filter(d => d.agentId === a.id);
    return { ...a, laneId: a.laneId ?? '', stats: { decisions: ds.length, denies: ds.filter(d => d.effectiveVerdict === 'deny').length, lastSeenAt: a.lastSeenAt } };
  }));
});
router.patch('/agents/:id', requireRole('PolicyAdmin'), async (req, res) => {
  const a = await govStore().getAgent(req.params.id);
  if (!a) { res.status(404).json({ error: 'not found' }); return; }
  const patch = req.body as Partial<RegisteredAgent>;
  const next = await govStore().upsertAgent({ ...a, owner: patch.owner ?? a.owner, purpose: patch.purpose ?? a.purpose, laneId: patch.laneId ?? a.laneId, name: patch.name ?? a.name });
  govBus.emit('agent.updated', next);
  res.json(next);
});
for (const status of ['pause', 'resume', 'quarantine'] as const) {
  router.post(`/agents/:id/${status}`, requireRole('PolicyAdmin'), async (req, res) => {
    const mapped = status === 'pause' ? 'paused' : status === 'resume' ? 'active' : 'quarantined';
    const a = await registry.setStatus(req.params.id, mapped, req.body?.reason ?? status, req.principal?.id ?? 'api');
    if (!a) { res.status(404).json({ error: 'not found' }); return; }
    res.json(a);
  });
}

for (const action of ['pause', 'resume', 'quarantine'] as const) {
  router.post(`/sessions/:id/${action}`, requireRole('PolicyAdmin'), async (req, res) => {
    // Sessions seen only through telemetry have no intent yet; create one so the kill switch applies.
    const existing = await govStore().getSessionIntent(req.params.id)
      ?? await intentTracker.get(req.params.id, String(req.body?.agentId ?? 'unknown'));
    const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'quarantined';
    const next: SessionIntent = { ...existing, status, updatedAt: nowIso() };
    await govStore().saveSessionIntent(next);
    govBus.emit('session.updated', next);
    res.json(next);
  });
}
router.get('/sessions/:id/intent', requireRole('Viewer'), async (req, res) => {
  // Sessions seen only through telemetry have no intent; that's a normal state, not a missing resource.
  res.json((await govStore().getSessionIntent(req.params.id)) ?? null);
});

router.get('/lanes', requireRole('Viewer'), async (req, res) => res.json(await govStore().listLanes(req.query.status ? [req.query.status as never] : undefined)));
router.get('/lanes/:id', requireRole('Viewer'), async (req, res) => {
  const rec = await govStore().getLane(req.params.id, req.query.version ? Number(req.query.version) : undefined);
  if (!rec) { res.status(404).json({ error: 'not found' }); return; }
  res.json(rec);
});
router.get('/lanes/:id/versions', requireRole('Viewer'), async (req, res) => res.json(await govStore().listLaneVersions(req.params.id)));
router.post('/lanes/validate', requireRole('Viewer'), (req, res) => {
  res.json(req.body?.yaml ? validateLaneYaml(req.body.yaml) : validateLane(req.body?.lane));
});
router.post('/lanes/simulate', requireRole('Viewer'), async (req, res) => {
  const lane = req.body?.yaml ? parseLaneYaml(req.body.yaml) : validateLane(req.body?.lane).lane;
  if (!lane) { res.status(400).json({ error: 'invalid lane' }); return; }
  res.json(await simulateLane(lane, { ...req.body, policies: await activePolicies() }));
});
router.post('/lanes', async (req, res) => {
  const principal = req.principal;
  if (!principal) { res.status(401).json({ error: 'unauthenticated' }); return; }
  const policyAdmin = hasRole(principal, 'PolicyAdmin');
  if (!policyAdmin && !hasRole(principal, 'Viewer')) { res.status(403).json({ error: 'requires role: Viewer' }); return; }

  const lane = req.body?.yaml ? parseLaneYaml(req.body.yaml) : validateLane(req.body?.lane).lane;
  if (!lane) { res.status(400).json({ error: 'invalid lane' }); return; }
  if (protectsMonitorLane(lane) && !isUserPolicyAdmin(principal)) {
    res.status(403).json({ error: 'monitor Guardian lanes require a user PolicyAdmin' });
    return;
  }
  const requestedStatus = req.body?.status == null ? undefined : String(req.body.status) as LaneStatus;
  if (requestedStatus && !laneStatuses.includes(requestedStatus)) { res.status(400).json({ error: 'invalid lane status' }); return; }
  if (!policyAdmin && requestedStatus && requestedStatus !== 'proposed') {
    res.status(403).json({ error: 'non-admin lane changes must be proposed' });
    return;
  }
  if (requestedStatus === 'active' && !policyAdmin) {
    res.status(403).json({ error: 'active lane changes require PolicyAdmin' });
    return;
  }
  const versions = await govStore().listLaneVersions(lane.id);
  lane.version = versions.length ? Math.max(...versions.map(v => v.lane.version)) + 1 : lane.version;
  const status = policyAdmin ? (requestedStatus ?? 'draft') : 'proposed';
  const rec: LaneRecord = { lane, status, yaml: req.body?.yaml ?? YAML.stringify(lane), updatedAt: nowIso(), updatedBy: principal.id };
  const saved = await govStore().saveLane(rec);
  govBus.emit('lane.updated', saved);
  res.status(201).json(saved);
});
router.post('/lanes/:id/versions/:v/activate', requireRole('PolicyAdmin'), async (req, res) => {
  await govStore().setLaneStatus(req.params.id, Number(req.params.v), 'active', req.principal?.id);
  res.json(await govStore().getLane(req.params.id, Number(req.params.v)));
});
router.post('/lanes/:id/versions/:v/archive', requireRole('PolicyAdmin'), async (req, res) => {
  await govStore().setLaneStatus(req.params.id, Number(req.params.v), 'archived', req.principal?.id);
  res.json(await govStore().getLane(req.params.id, Number(req.params.v)));
});

router.get('/incidents', requireRole('Viewer'), async (req, res) => res.json(await govStore().listIncidents({ state: arr(req.query.state as never) as never })));
router.get('/incidents/:id', requireRole('Viewer'), async (req, res) => {
  const i = await govStore().getIncident(req.params.id);
  if (!i) { res.status(404).json({ error: 'not found' }); return; }
  res.json(i);
});
router.post('/incidents', requireRole('PolicyAdmin', 'Agent'), async (req, res) => {
  const at = nowIso();
  const i: Incident = { id: req.body?.id ?? `inc-${Date.now()}`, title: req.body?.title ?? 'Incident', severity: req.body?.severity ?? 'medium', state: req.body?.state ?? 'open', trigger: req.body?.trigger ?? 'manual', agentIds: req.body?.agentIds ?? [], sessionIds: req.body?.sessionIds ?? [], decisionIds: req.body?.decisionIds ?? [], summary: req.body?.summary, report: req.body?.report, recommendations: req.body?.recommendations, createdAt: at, updatedAt: at };
  const saved = await govStore().createIncident(i);
  govBus.emit('incident.created', saved);
  res.status(201).json(saved);
});
router.patch('/incidents/:id', requireRole('PolicyAdmin', 'Agent'), async (req, res) => {
  const saved = await govStore().updateIncident(req.params.id, req.body);
  if (!saved) { res.status(404).json({ error: 'not found' }); return; }
  govBus.emit('incident.updated', saved);
  res.json(saved);
});

router.get('/audit/verify', requireRole('Viewer'), async (req, res) => res.json(await govStore().verifyAuditChain(req.query.from ? Number(req.query.from) : undefined, req.query.limit ? Number(req.query.limit) : undefined)));
router.get('/audit/export', requireRole('Viewer'), async (req, res) => {
  const page = await govStore().queryDecisions({ since: req.query.from as string | undefined, until: req.query.to as string | undefined, limit: 20_000 });
  res.type('application/x-ndjson').send(page.items.map(d => JSON.stringify(d)).join('\n') + (page.items.length ? '\n' : ''));
});

export default router;
