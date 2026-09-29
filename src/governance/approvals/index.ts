import crypto from 'crypto';
import type { ApprovalRequest, Approvals as ApprovalsContract } from '../contracts';
import type { Approval } from '../types';
import { govBus } from '../events';
import { govStore } from '../store';
import { redactString } from '../../analytics/redact';

interface Waiter { resolve: (a: Approval) => void; timer: NodeJS.Timeout; poller: NodeJS.Timeout }
const FINAL = new Set(['approved', 'denied', 'expired', 'cancelled']);
function nowIso(): string { return new Date().toISOString(); }
function expiredApproval(base: Approval, note = 'approval timed out'): Approval {
  return { ...base, state: 'expired', resolvedAt: nowIso(), resolutionNote: note };
}
function approvalId(r: ApprovalRequest): string {
  return `appr-${crypto.createHash('sha1').update(`${r.req.sessionId}|${r.req.requestId}|${r.agent.id}`).digest('hex').slice(0, 20)}`;
}

class DefaultApprovals implements ApprovalsContract {
  private waiters = new Map<string, Waiter[]>();

  async request(r: ApprovalRequest): Promise<Approval> {
    const id = approvalId(r);
    const existing = await govStore().getApproval(id);
    if (existing) return existing;
    const requestedAt = nowIso();
    const approval: Approval = {
      id, requestId: r.req.requestId, sessionId: r.req.sessionId, agentId: r.agent.id, laneId: r.lane.id,
      toolName: r.req.toolName, summary: redactString(r.summary), reason: redactString(r.reason), channels: r.channels,
      state: 'pending', requestedAt, expiresAt: new Date(Date.now() + r.timeoutSec * 1000).toISOString(),
    };
    const saved = await govStore().createApproval(approval).catch(async err => {
      const cur = await govStore().getApproval(id);
      if (cur) return cur;
      throw err;
    });
    govBus.emit('approval.requested', saved);
    return saved;
  }

  async wait(id: string, timeoutMs: number): Promise<Approval> {
    const existing = await govStore().getApproval(id);
    if (!existing) throw new Error(`approval ${id} not found`);
    if (FINAL.has(existing.state)) return existing;
    return new Promise<Approval>(resolve => {
      let settled = false;
      const finish = (a: Approval) => {
        if (settled) return;
        settled = true;
        const list = this.waiters.get(id) ?? [];
        for (const w of list) { clearTimeout(w.timer); clearInterval(w.poller); }
        this.waiters.delete(id);
        resolve(a);
      };
      const poller = setInterval(async () => {
        try {
          const cur = await govStore().getApproval(id);
          if (cur && FINAL.has(cur.state)) finish(cur);
        } catch {
          // The timeout path below will fail closed with a synthetic expiration if storage stays down.
        }
      }, 1000);
      const timer = setTimeout(async () => {
        try {
          const cur = await govStore().getApproval(id);
          if (!cur) { finish(expiredApproval(existing, 'approval timed out; approval store unreachable')); return; }
          if (FINAL.has(cur.state)) { finish(cur); return; }
          if (cur.state === 'pending') {
            const expired = await govStore().updateApproval(id, { state: 'expired', resolvedAt: nowIso(), resolutionNote: 'approval timed out' });
            if (expired) { govBus.emit('approval.resolved', expired); finish(expired); return; }
          }
          const winner = await govStore().getApproval(id).catch(() => undefined);
          finish(winner ?? expiredApproval(cur));
        } catch {
          finish(expiredApproval(existing, 'approval timed out; approval store unreachable'));
        }
      }, Math.max(1, timeoutMs));
      const waiter = { resolve: finish, timer, poller };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), waiter]);
    });
  }

  async resolve(id: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined> {
    const cur = await govStore().getApproval(id);
    if (!cur) return undefined;
    if (FINAL.has(cur.state)) return cur;
    const next = await govStore().updateApproval(id, { state: decision, resolvedAt: nowIso(), resolvedBy: by, resolutionNote: note });
    if (next) {
      if (next.state === decision) govBus.emit('approval.resolved', next);
      const list = this.waiters.get(id) ?? [];
      for (const w of list) w.resolve(next);
    }
    return next;
  }
}

let current: ApprovalsContract = new DefaultApprovals();
export function setApprovals(next: ApprovalsContract): void { current = next; }
export const approvals: ApprovalsContract = {
  request: (...args) => current.request(...args),
  wait: (...args) => current.wait(...args),
  resolve: (...args) => current.resolve(...args),
};
export default approvals;
