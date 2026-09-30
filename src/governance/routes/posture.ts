import crypto from 'crypto';
import { Router } from 'express';
import { hasRole, requireRole } from '../auth';
import { decide } from '../pdp';
import { govStore } from '../store';
import {
  fixFinding, getPostureConfig, ingestPostureReport, localEndpointId, PostureOwnershipError, runLocalScan, savePostureConfig,
  suppressFinding, unsuppressFinding,
} from '../posture';
import { parsePostureReport } from '../posture/schema';
import type { PostureFindingState, Principal, Severity } from '../types';

const router = Router();
const states: PostureFindingState[] = ['open', 'resolved', 'suppressed'];
const severities: Severity[] = ['info', 'low', 'medium', 'high', 'critical'];

function list<T extends string>(v: unknown, allowed: readonly T[]): T[] | undefined {
  if (v == null) return undefined;
  const items = (Array.isArray(v) ? v : String(v).split(',')).map(String).filter((x): x is T => (allowed as readonly string[]).includes(x));
  return items.length ? items : undefined;
}

/** Records the admin action in the hash-chained audit log; returns a denial reason if governance blocks it. */
async function auditAdmin(principal: Principal | undefined, toolName: string, args: unknown): Promise<string | null> {
  const d = await decide({
    requestId: crypto.randomUUID(), sessionId: `admin:${principal?.id ?? 'unknown'}`, checkpoint: 'admin',
    agent: { surface: 'monitor', externalId: principal?.id ?? 'unknown', name: principal?.name ?? principal?.id },
    toolName, args,
  }, { blocking: true, supportsAsk: false });
  return d.verdict === 'deny' ? (d.reason || 'governance policy denied this admin action') : null;
}

router.get('/posture/checks', requireRole('Viewer'), async (_req, res) => {
  const { POSTURE_CHECKS } = await import('../../posture');
  const cfg = await getPostureConfig();
  res.json({
    items: POSTURE_CHECKS.map(c => ({
      ...c,
      enabled: cfg.checks[c.id]?.enabled !== false,
      effectiveSeverity: cfg.checks[c.id]?.severity ?? c.severity,
      scope: cfg.checks[c.id]?.scope,
    })),
    config: cfg,
  });
});

router.put('/posture/config', requireRole('PolicyAdmin'), async (req, res) => {
  const r = await savePostureConfig(req.body, req.principal?.id);
  if (!r.ok) { res.status(400).json({ error: 'invalid posture config', errors: r.errors }); return; }
  res.json(r.config);
});

router.get('/posture/summary', requireRole('Viewer'), async (_req, res) => {
  const findings = await govStore().listPostureFindings({ state: ['open'], limit: 20000 });
  const endpoints = await govStore().listPostureEndpoints();
  const bySeverity: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    byCheck[f.checkId] = (byCheck[f.checkId] ?? 0) + 1;
  }
  res.json({ open: findings.length, endpoints: endpoints.length, lastScanAt: endpoints[0]?.lastScanAt, bySeverity, byCategory, byCheck });
});

router.get('/posture/findings', requireRole('Viewer'), async (req, res) => {
  res.json(await govStore().listPostureFindings({
    state: list(req.query.state, states), severity: list(req.query.severity, severities),
    endpointId: req.query.endpointId ? String(req.query.endpointId) : undefined,
    checkId: req.query.checkId ? String(req.query.checkId) : undefined,
    level: req.query.level === 'fleet' || req.query.level === 'endpoint' ? req.query.level : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  }));
});

router.get('/posture/findings/:id', requireRole('Viewer'), async (req, res) => {
  const f = await govStore().getPostureFinding(req.params.id);
  if (!f) { res.status(404).json({ error: 'not found' }); return; }
  const { POSTURE_CHECKS } = await import('../../posture');
  res.json({ ...f, check: POSTURE_CHECKS.find(c => c.id === f.checkId) });
});

router.post('/posture/findings/:id/suppress', requireRole('PolicyAdmin'), async (req, res) => {
  const reason = String(req.body?.reason ?? '').trim();
  if (!reason) { res.status(400).json({ error: 'reason is required' }); return; }
  const until = req.body?.until ? new Date(String(req.body.until)) : undefined;
  if (until && Number.isNaN(until.getTime())) { res.status(400).json({ error: 'invalid until' }); return; }
  const f = await suppressFinding(req.params.id, req.principal?.id ?? 'unknown', reason, until?.toISOString());
  if (!f) { res.status(404).json({ error: 'not found' }); return; }
  res.json(f);
});

router.post('/posture/findings/:id/unsuppress', requireRole('PolicyAdmin'), async (req, res) => {
  const f = await unsuppressFinding(req.params.id);
  if (!f) { res.status(404).json({ error: 'not found' }); return; }
  res.json(f);
});

router.post('/posture/findings/:id/fix', requireRole('PolicyAdmin'), async (req, res) => {
  const principal = req.principal;
  if (!principal || (principal.kind !== 'user' && principal.kind !== 'local')) {
    res.status(403).json({ error: 'automatic fixes require a human PolicyAdmin' });
    return;
  }
  const denied = await auditAdmin(principal, 'posture_fix', { findingId: req.params.id });
  if (denied) { res.status(403).json({ error: denied }); return; }
  const r = await fixFinding(req.params.id);
  res.status(r.status).json(r.body);
});

router.get('/posture/endpoints', requireRole('Viewer'), async (_req, res) => {
  const items = await govStore().listPostureEndpoints();
  const local = await localEndpointId().catch(() => undefined);
  res.json(items.map(({ inventory, ...e }) => ({
    ...e,
    isLocal: e.id === local,
    agents: (inventory.agents ?? []).map(a => ({ id: a.id, name: a.name, version: a.version })),
    mcpServerCount: Array.isArray(inventory.mcpServers) ? inventory.mcpServers.length : 0,
    extensionCount: Array.isArray(inventory.extensions) ? inventory.extensions.length : 0,
  })));
});

router.get('/posture/endpoints/:id', requireRole('Viewer'), async (req, res) => {
  const e = await govStore().getPostureEndpoint(req.params.id);
  if (!e) { res.status(404).json({ error: 'not found' }); return; }
  res.json({ ...e, isLocal: e.id === await localEndpointId().catch(() => undefined) });
});

router.post('/posture/scan', requireRole('PolicyAdmin'), async (req, res) => {
  const denied = await auditAdmin(req.principal, 'posture_scan', {});
  if (denied) { res.status(403).json({ error: denied }); return; }
  res.json(await runLocalScan());
});

router.post('/posture/reports', async (req, res) => {
  const principal = req.principal;
  if (!principal || !(principal.kind === 'device' || hasRole(principal, 'Agent') || hasRole(principal, 'PolicyAdmin'))) {
    res.status(403).json({ error: 'requires device principal, Agent or PolicyAdmin role' });
    return;
  }
  const { report, errors } = parsePostureReport(req.body);
  if (!report) { res.status(400).json({ error: 'invalid posture report', errors }); return; }
  const source = principal.kind === 'device' ? 'device' : 'cli';
  // Non-admin reporters are bound to the endpoints they first report for (trust on first use).
  const owner = hasRole(principal, 'PolicyAdmin') && principal.kind !== 'device' ? undefined : principal.id;
  try {
    res.json(await ingestPostureReport(report, source, owner));
  } catch (err) {
    if (err instanceof PostureOwnershipError) { res.status(403).json({ error: err.message }); return; }
    throw err;
  }
});

export default router;
