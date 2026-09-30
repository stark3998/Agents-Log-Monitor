/**
 * Test-harness admin API (mounted under /api/gov by the admin router):
 *
 *   GET  /api/gov/simulation                 — simulation mode state                         (Viewer)
 *   PUT  /api/gov/simulation {enabled}       — turn simulation on/off                         (PolicyAdmin, not agents)
 *   GET  /api/gov/hooks/copilot              — Copilot CLI / VS Code hook install status       (Viewer)
 *   POST /api/gov/hooks/copilot/install      — {targets, failMode, simulate?} write hook files (PolicyAdmin, local mode)
 *   POST /api/gov/hooks/copilot/uninstall    — {targets?} remove this monitor's hook files     (PolicyAdmin, local mode)
 *
 * Every mutation is recorded in the hash-chained audit log as an `admin` checkpoint decision first,
 * and is refused if governance denies it.
 */
import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole } from '../auth';
import { govConfig } from '../config';
import { decide } from '../pdp';
import { HOOK_FAIL_MODES, HOOK_TARGETS, hooksStatus, installHooks, uninstallHooks, type HookTarget } from '../hooks/install';
import { setSimulation, simulationState } from '../simulation';
import type { Principal } from '../types';

const router = Router();

async function auditAdmin(principal: Principal | undefined, toolName: string, args: unknown): Promise<string | null> {
  const d = await decide({
    requestId: crypto.randomUUID(), sessionId: `admin:${principal?.id ?? 'unknown'}`, checkpoint: 'admin',
    agent: { surface: 'monitor', externalId: principal?.id ?? 'unknown', name: principal?.name ?? principal?.id },
    toolName, args,
  }, { blocking: true, supportsAsk: false });
  return d.verdict === 'deny' ? (d.reason || 'governance policy denied this admin action') : null;
}

/** Agent principals (hooks, MCP clients) may read but never flip the harness. */
function rejectAgents(req: Request, res: Response): boolean {
  if (req.principal?.kind === 'agent') {
    res.status(403).json({ error: 'agents cannot change the governance test harness' });
    return true;
  }
  return false;
}

function localOnly(res: Response): boolean {
  if (govConfig.mode !== 'local') {
    res.status(409).json({ error: 'hook installation is only available on a local monitor (install hooks on each endpoint instead)' });
    return true;
  }
  return false;
}

const simulationBody = z.object({ enabled: z.boolean() });
const targetsSchema = z.array(z.enum(HOOK_TARGETS as [HookTarget, ...HookTarget[]])).min(1).max(HOOK_TARGETS.length);
const installBody = z.object({
  targets: targetsSchema.default(['copilot-cli']),
  failMode: z.enum(HOOK_FAIL_MODES as [typeof HOOK_FAIL_MODES[number], ...typeof HOOK_FAIL_MODES[number][]]).default('open'),
  simulate: z.boolean().optional(),
});
const uninstallBody = z.object({ targets: targetsSchema.optional() });

router.get('/simulation', requireRole('Viewer'), (_req, res) => {
  res.json({ ...simulationState(), enforcementEnabled: govConfig.enforcementEnabled });
});

router.put('/simulation', requireRole('PolicyAdmin'), async (req, res) => {
  if (rejectAgents(req, res)) return;
  const body = simulationBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'body must be {"enabled": boolean}' }); return; }
  const denied = await auditAdmin(req.principal, 'governance_simulation', body.data);
  if (denied) { res.status(403).json({ error: denied }); return; }
  res.json({ ...(await setSimulation(body.data.enabled, req.principal?.id)), enforcementEnabled: govConfig.enforcementEnabled });
});

router.get('/hooks/copilot', requireRole('Viewer'), async (_req, res) => {
  res.json({ mode: govConfig.mode, available: govConfig.mode === 'local', simulation: simulationState(), ...(await hooksStatus()) });
});

router.post('/hooks/copilot/install', requireRole('PolicyAdmin'), async (req, res) => {
  if (rejectAgents(req, res) || localOnly(res)) return;
  const body = installBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: 'invalid body', issues: body.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })) }); return; }
  const denied = await auditAdmin(req.principal, 'copilot_hooks_install', body.data);
  if (denied) { res.status(403).json({ error: denied }); return; }
  // Turn simulation on before the hooks exist, so the very first governed call can't be blocked.
  if (body.data.simulate !== undefined) await setSimulation(body.data.simulate, req.principal?.id);
  try {
    const status = await installHooks(body.data.targets, { failMode: body.data.failMode });
    res.json({ mode: govConfig.mode, available: true, simulation: simulationState(), ...status });
  } catch (err) {
    res.status(500).json({ error: `could not write hook files: ${(err as Error).message}` });
  }
});

router.post('/hooks/copilot/uninstall', requireRole('PolicyAdmin'), async (req, res) => {
  if (rejectAgents(req, res) || localOnly(res)) return;
  const body = uninstallBody.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ error: 'invalid body' }); return; }
  const denied = await auditAdmin(req.principal, 'copilot_hooks_uninstall', body.data);
  if (denied) { res.status(403).json({ error: denied }); return; }
  try {
    const status = await uninstallHooks(body.data.targets ?? [...HOOK_TARGETS]);
    res.json({ mode: govConfig.mode, available: true, simulation: simulationState(), ...status });
  } catch (err) {
    res.status(500).json({ error: `could not remove hook files: ${(err as Error).message}` });
  }
});

export default router;
