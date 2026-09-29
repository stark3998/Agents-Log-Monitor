import { Router } from 'express';
import { decide, type DecideOptions } from '../pdp';
import { requireRole } from '../auth';
import type { ActionRequest, AgentIdentity } from '../types';
import { govStore } from '../store';
import { registry } from '../registry';
import laneEngine from '../lanes/engine';
import { intentTracker } from '../intent';

const router = Router();

function options(body: Record<string, unknown>): DecideOptions {
  const o = (body.options ?? {}) as Partial<DecideOptions>;
  return { blocking: o.blocking ?? true, supportsAsk: o.supportsAsk ?? false, deadlineMs: o.deadlineMs };
}

router.use(requireRole('Agent'));

router.post('/decide', async (req, res) => {
  try {
    const { options: _options, ...action } = req.body as ActionRequest & { options?: Partial<DecideOptions> };
    const d = await decide(action, options(req.body));
    res.json(d);
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.post('/goal', async (req, res) => {
  try {
    const body = req.body as { sessionId: string; agent: AgentIdentity; text: string; source?: string };
    const d = await decide({ requestId: `goal-${Date.now()}`, sessionId: body.sessionId, checkpoint: 'goal', agent: body.agent, text: body.text }, { blocking: true, supportsAsk: false, deadlineMs: 5000 });
    const intent = await govStore().getSessionIntent(body.sessionId);
    res.json({ ok: true, goal: intent?.goal, decisionId: d.id });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.post('/result', async (req, res) => {
  try {
    const body = req.body as { requestId: string; sessionId: string; agent: AgentIdentity; toolName?: string; result?: string };
    await decide({ requestId: body.requestId, sessionId: body.sessionId, checkpoint: 'tool_result', agent: body.agent, toolName: body.toolName, result: body.result }, { blocking: true, supportsAsk: false, deadlineMs: 5000 });
    const agent = await registry.identify(body.agent);
    const intent = await intentTracker.get(body.sessionId, agent.id);
    res.json({ tainted: !!intent.taint, reason: intent.taint?.reason });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

router.get('/approvals/:id', async (req, res) => {
  const a = await govStore().getApproval(req.params.id);
  if (!a) { res.status(404).json({ error: 'not found' }); return; }
  res.json(a);
});

router.get('/lanes/effective', async (req, res) => {
  try {
    const agent = await registry.identify({ surface: (req.query.surface as AgentIdentity['surface']) ?? 'unknown', externalId: req.query.externalId as string | undefined, name: req.query.name as string | undefined, user: req.query.user as string | undefined, cwd: req.query.cwd as string | undefined, repo: req.query.repo as string | undefined });
    const lane = await laneEngine.resolve(agent, { requestId: 'effective', sessionId: 'effective', checkpoint: 'pre_tool', agent: { surface: agent.surface, agentId: agent.id, externalId: agent.externalId } });
    res.json(lane);
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

export default router;
