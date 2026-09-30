import { Router } from 'express';
import YAML from 'yaml';
import { listClassifiers, getClassifierConfig } from '../../analytics/classifiers/config';
import { listPresets } from '../../policies/presets';
import { hasRole, requireRole } from '../auth';
import { saveClassifierConfig, patchClassifier, testClassifiers } from '../classifiers';
import { govBus } from '../events';
import { simulateLane, simulatePolicy } from '../lanes/simulate';
import { parseLaneYaml, validateLane } from '../lanes/loader';
import { activePolicies, invalidatePolicyCache, mergePolicies } from '../policies';
import { validatePolicy, validatePolicyYaml } from '../policies/schema';
import { govStore } from '../store';
import type { LaneStatus, Policy, PolicyRecord, Principal } from '../types';

const router = Router();
const statuses: LaneStatus[] = ['active', 'draft', 'proposed', 'archived'];
function nowIso(): string { return new Date().toISOString(); }

function parseBodyPolicy(body: { yaml?: string; policy?: unknown }): { ok: boolean; policy?: Policy; errors: string[] } {
  return body?.yaml ? validatePolicyYaml(body.yaml) : validatePolicy(body?.policy);
}

/** Policies that can constrain the monitor's own agents need a human PolicyAdmin (as monitor lanes do). */
async function affectsMonitor(p: Policy): Promise<boolean> {
  const surfaces = p.scope?.surfaces ?? ['*'];
  if (p.global && (surfaces.includes('*') || surfaces.includes('monitor'))) return true;
  const lanes = await govStore().listLanes(['active']);
  return lanes.some(l => (l.lane.id === 'monitor-guardian' || (l.lane.appliesTo?.surfaces ?? []).includes('monitor')) && (l.lane.policies ?? []).includes(p.id));
}

/** Humans only (Entra users or the local console admin) â€” never agent or device principals. */
function isHumanPolicyAdmin(principal: Principal | undefined): boolean {
  return !!principal && (principal.kind === 'user' || principal.kind === 'local') && hasRole(principal, 'PolicyAdmin');
}

// â”€â”€ Presets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/presets', requireRole('Viewer'), (_req, res) => res.json(listPresets()));

// â”€â”€ Policies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/policies', requireRole('Viewer'), async (req, res) => {
  const status = req.query.status ? [String(req.query.status) as LaneStatus] : undefined;
  res.json(await govStore().listPolicies(status));
});

router.get('/policies/effective', requireRole('Viewer'), async (req, res) => {
  const laneId = String(req.query.laneId ?? '');
  const rec = laneId ? await govStore().getLane(laneId) : undefined;
  if (!rec) { res.status(404).json({ error: 'lane not found' }); return; }
  const all = await activePolicies();
  const attached = new Set(rec.lane.policies ?? []);
  const applied = all.filter(p => p.global || attached.has(p.id));
  const missing = [...attached].filter(id => !all.some(p => p.id === id));
  res.json({ lane: mergePolicies(rec.lane, applied), policies: applied.map(p => ({ id: p.id, version: p.version, global: p.global, scope: p.scope, mode: p.mode })), missing });
});

router.post('/policies/validate', requireRole('Viewer'), (req, res) => res.json(parseBodyPolicy(req.body)));

router.post('/policies/simulate', requireRole('Viewer'), async (req, res) => {
  const v = parseBodyPolicy(req.body);
  if (!v.ok || !v.policy) { res.status(400).json({ error: 'invalid policy', errors: v.errors }); return; }
  res.json(await simulatePolicy(v.policy, { from: req.body?.from, to: req.body?.to, agentId: req.body?.agentId, limit: req.body?.limit }));
});

router.get('/policies/:id', requireRole('Viewer'), async (req, res) => {
  const rec = await govStore().getPolicy(req.params.id, req.query.version ? Number(req.query.version) : undefined)
    ?? (req.query.version ? undefined : (await govStore().listPolicyVersions(req.params.id))[0]);
  if (!rec) { res.status(404).json({ error: 'not found' }); return; }
  res.json(rec);
});

router.get('/policies/:id/versions', requireRole('Viewer'), async (req, res) => res.json(await govStore().listPolicyVersions(req.params.id)));

router.post('/policies', async (req, res) => {
  const principal = req.principal;
  if (!principal) { res.status(401).json({ error: 'unauthenticated' }); return; }
  const policyAdmin = hasRole(principal, 'PolicyAdmin');
  if (!policyAdmin && !hasRole(principal, 'Viewer')) { res.status(403).json({ error: 'requires role: Viewer' }); return; }
  const v = parseBodyPolicy(req.body);
  if (!v.ok || !v.policy) { res.status(400).json({ error: 'invalid policy', errors: v.errors }); return; }
  const policy = v.policy;
  const requested = req.body?.status == null ? undefined : String(req.body.status) as LaneStatus;
  if (requested && !statuses.includes(requested)) { res.status(400).json({ error: 'invalid policy status' }); return; }
  if (!policyAdmin && requested && requested !== 'proposed') { res.status(403).json({ error: 'non-admin policy changes must be proposed' }); return; }
  const status: LaneStatus = policyAdmin ? (requested ?? 'draft') : 'proposed';
  if (status === 'active' && await affectsMonitor(policy) && !isHumanPolicyAdmin(principal)) {
    res.status(403).json({ error: 'policies that apply to the monitor\'s own agents require a human PolicyAdmin' });
    return;
  }
  const versions = await govStore().listPolicyVersions(policy.id);
  policy.version = versions.length ? Math.max(...versions.map(x => x.policy.version)) + 1 : policy.version;
  policy.meta = { ...policy.meta, source: policy.meta?.source ?? 'ui', createdBy: policy.meta?.createdBy ?? principal.id };
  const rec: PolicyRecord = { policy, status, yaml: req.body?.yaml ?? YAML.stringify(policy), updatedAt: nowIso(), updatedBy: principal.id };
  const saved = await govStore().savePolicy(rec);
  invalidatePolicyCache();
  govBus.emit('policy.updated', saved);
  res.status(201).json(saved);
});

for (const action of ['activate', 'archive'] as const) {
  router.post(`/policies/:id/versions/:v/${action}`, requireRole('PolicyAdmin'), async (req, res) => {
    const rec = await govStore().getPolicy(req.params.id, Number(req.params.v));
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    if (action === 'activate' && await affectsMonitor(rec.policy) && !isHumanPolicyAdmin(req.principal)) {
      res.status(403).json({ error: 'policies that apply to the monitor\'s own agents require a human PolicyAdmin' });
      return;
    }
    await govStore().setPolicyStatus(req.params.id, Number(req.params.v), action === 'activate' ? 'active' : 'archived', req.principal?.id);
    const saved = await govStore().getPolicy(req.params.id, Number(req.params.v));
    invalidatePolicyCache();
    if (saved) govBus.emit('policy.updated', saved);
    res.json(saved);
  });
}

// Lane simulation including the policies that would apply to it.
router.post('/lanes/simulate-with-policies', requireRole('Viewer'), async (req, res) => {
  const lane = req.body?.yaml ? parseLaneYaml(req.body.yaml) : validateLane(req.body?.lane).lane;
  if (!lane) { res.status(400).json({ error: 'invalid lane' }); return; }
  res.json(await simulateLane(lane, { from: req.body?.from, to: req.body?.to, agentId: req.body?.agentId, limit: req.body?.limit, policies: await activePolicies() }));
});

// â”€â”€ Classifiers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

router.get('/classifiers', requireRole('Viewer'), (_req, res) => {
  res.json({ items: listClassifiers(), config: getClassifierConfig() });
});

router.put('/classifiers/config', requireRole('PolicyAdmin'), async (req, res) => {
  const r = await saveClassifierConfig(req.body, req.principal?.id);
  if (!r.ok) { res.status(400).json({ error: 'invalid classifier config', errors: r.errors }); return; }
  res.json({ items: listClassifiers(), config: r.config });
});

router.patch('/classifiers/:code', requireRole('PolicyAdmin'), async (req, res) => {
  const patch: { isActive?: boolean; enforceable?: boolean } = {};
  if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
  if (typeof req.body?.enforceable === 'boolean') patch.enforceable = req.body.enforceable;
  if (!listClassifiers().some(c => c.code === req.params.code)) { res.status(404).json({ error: 'unknown classifier' }); return; }
  const r = await patchClassifier(req.params.code, patch, req.principal?.id);
  if (!r.ok) { res.status(400).json({ error: 'invalid classifier config', errors: r.errors }); return; }
  res.json(listClassifiers().find(c => c.code === req.params.code));
});

router.post('/classifiers/test', requireRole('Viewer'), (req, res) => {
  // Ad-hoc patterns run synchronously on the server; only admins may submit them.
  if (req.body?.custom && !hasRole(req.principal!, 'PolicyAdmin')) { res.status(403).json({ error: 'testing a custom pattern requires PolicyAdmin' }); return; }
  const r = testClassifiers(String(req.body?.text ?? ''), Array.isArray(req.body?.codes) ? req.body.codes.map(String) : undefined, req.body?.custom);
  if (r.errors.length) { res.status(400).json({ error: 'invalid classifier', errors: r.errors }); return; }
  res.json(r);
});

export default router;
