import { createRemoteJWKSet, jwtVerify } from 'jose';
import { Router } from 'express';
import { govBus } from '../events';
import { govStore } from '../store';
import type { Approval, Principal } from '../types';

const router = Router();
const botJwks = createRemoteJWKSet(new URL('https://login.botframework.com/v1/.well-known/keys'));

interface TeamsActivity {
  type?: string;
  name?: string;
  from?: { aadObjectId?: string; name?: string; id?: string };
  value?: { action?: { verb?: string; data?: { approvalId?: string } }; verb?: string; approvalId?: string };
}

function token(req: Parameters<Parameters<typeof router.post>[1]>[0]): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  return m?.[1];
}

async function validateBotJwt(auth: string | undefined): Promise<void> {
  const appId = process.env.TEAMS_BOT_APP_ID;
  if (!appId) throw new Error('Teams bot is disabled');
  if (!auth) throw new Error('missing Bot Framework token');
  await jwtVerify(auth, botJwks, { issuer: 'https://api.botframework.com', audience: appId });
}

function principalFor(activity: TeamsActivity): Principal {
  const aadObjectId = activity.from?.aadObjectId;
  if (!aadObjectId) throw new Error('Teams user AAD object id is required');
  const allowed = (process.env.TEAMS_APPROVER_OBJECT_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(aadObjectId)) throw new Error('Teams user is not in TEAMS_APPROVER_OBJECT_IDS');
  return { id: aadObjectId, name: activity.from?.name ?? aadObjectId, kind: 'user', roles: ['Approver', 'Viewer'] };
}

async function resolveApproval(approvalId: string, decision: 'approved' | 'denied', p: Principal): Promise<Approval | undefined> {
  const mod = await import('../approvals').catch(() => null) as { approvals?: { resolve: typeof fallbackResolve } } | null;
  if (mod?.approvals?.resolve) return mod.approvals.resolve(approvalId, decision, p.id, `Resolved in Teams by ${p.name ?? p.id}`);
  return fallbackResolve(approvalId, decision, p.id, `Resolved in Teams by ${p.name ?? p.id}`);
}

async function fallbackResolve(approvalId: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined> {
  const next = await govStore().updateApproval(approvalId, {
    state: decision,
    resolvedAt: new Date().toISOString(),
    resolvedBy: by,
    resolutionNote: note,
  });
  if (next) govBus.emit('approval.resolved', next);
  return next;
}

function updatedCard(a: Approval | undefined): Record<string, unknown> {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: a ? `Approval ${a.state}` : 'Approval not found', weight: 'Bolder', wrap: true },
      ...(a ? [{ type: 'TextBlock', text: a.summary, wrap: true }] : []),
    ],
  };
}

function invoke(card: Record<string, unknown>, statusCode = 200): Record<string, unknown> {
  return { type: 'invokeResponse', value: { statusCode, type: 'application/vnd.microsoft.card.adaptive', value: card } };
}

router.post('/api/gov/teams/messages', async (req, res) => {
  try {
    await validateBotJwt(token(req));
    const activity = req.body as TeamsActivity;
    const principal = principalFor(activity);
    const verb = activity.value?.action?.verb ?? activity.value?.verb;
    const approvalId = activity.value?.action?.data?.approvalId ?? activity.value?.approvalId;
    if (verb !== 'approve' && verb !== 'deny') { res.status(400).json(invoke(updatedCard(undefined), 400)); return; }
    if (!approvalId) { res.status(400).json(invoke(updatedCard(undefined), 400)); return; }
    const approval = await resolveApproval(approvalId, verb === 'approve' ? 'approved' : 'denied', principal);
    res.json(invoke(updatedCard(approval)));
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
});

export { router };
export default router;
