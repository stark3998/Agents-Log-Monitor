import { redactString } from '../../analytics/redact';
import type { ActionFeatures } from '../features';
import type { IntentTracker as IntentContract } from '../contracts';
import type { SessionIntent } from '../types';
import { govBus } from '../events';
import { govStore } from '../store';
import { extractGoal } from '../judge';

function nowIso(): string { return new Date().toISOString(); }
function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) : s; }

const sessionChains = new Map<string, Promise<unknown>>();

function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionChains.get(sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(fn);
  const cleanup = run.finally(() => {
    if (sessionChains.get(sessionId) === cleanup) sessionChains.delete(sessionId);
  });
  sessionChains.set(sessionId, cleanup);
  return run;
}

async function latestOr(intent: SessionIntent): Promise<SessionIntent> {
  return (await govStore().getSessionIntent(intent.sessionId)) ?? intent;
}

class DefaultIntentTracker implements IntentContract {
  async get(sessionId: string, agentId: string): Promise<SessionIntent> {
    const existing = await govStore().getSessionIntent(sessionId);
    if (existing) return existing;
    const now = nowIso();
    const intent: SessionIntent = {
      sessionId, agentId, trajectory: [], status: 'active', counters: { actions: 0, subagents: 0, tokens: 0 }, startedAt: now, updatedAt: now,
    };
    await govStore().saveSessionIntent(intent);
    return intent;
  }

  async recordGoal(intent: SessionIntent, text: string, source: SessionIntent['goalSource'] = 'heuristic'): Promise<SessionIntent> {
    const next = await withSessionLock(intent.sessionId, async () => {
      const cur = await latestOr(intent);
      const merged: SessionIntent = { ...cur, goal: cur.goal ?? clip(text.trim().replace(/\s+/g, ' '), 300), goalSource: cur.goalSource ?? source, updatedAt: nowIso() };
      await govStore().saveSessionIntent(merged);
      govBus.emit('session.updated', merged);
      return merged;
    });
    void extractGoal(text, next.goal).then(async goal => {
      if (!goal) return;
      await withSessionLock(intent.sessionId, async () => {
        const cur = await govStore().getSessionIntent(intent.sessionId);
        if (!cur) return;
        const upgraded: SessionIntent = { ...cur, goal, goalSource: 'llm', updatedAt: nowIso() };
        await govStore().saveSessionIntent(upgraded);
        govBus.emit('session.updated', upgraded);
      });
    }).catch(() => undefined);
    return next;
  }

  async recordAction(intent: SessionIntent, f: ActionFeatures, _verdict: string): Promise<SessionIntent> {
    const target = f.command || f.paths[0] || f.hosts[0] || '';
    const line = redactString(`${f.category} ${f.toolName || f.canonicalTool || 'action'}${target ? ' ' + target : ''}`.replace(/\s+/g, ' '));
    return withSessionLock(intent.sessionId, async () => {
      const cur = await latestOr(intent);
      const countsForTtl = f.checkpoint === 'pre_tool' || f.checkpoint === 'spawn';
      const trajectory = countsForTtl ? [...cur.trajectory, clip(line, 300)].slice(-30) : cur.trajectory;
      const decrementedTaint = cur.taint && countsForTtl ? { ...cur.taint, remainingActions: cur.taint.remainingActions - 1 } : cur.taint;
      const tokenDelta = Math.max(0, intent.counters.tokens - cur.counters.tokens);
      const next: SessionIntent = {
        ...cur,
        trajectory,
        taint: decrementedTaint && decrementedTaint.remainingActions > 0 ? decrementedTaint : null,
        counters: {
          actions: cur.counters.actions + (countsForTtl ? 1 : 0),
          subagents: cur.counters.subagents + (countsForTtl && f.category === 'AGENT' ? 1 : 0),
          tokens: cur.counters.tokens + tokenDelta,
        },
        updatedAt: nowIso(),
      };
      await govStore().saveSessionIntent(next);
      govBus.emit('session.updated', next);
      return next;
    });
  }

  async taint(intent: SessionIntent, reason: string, source: string, ttlActions: number): Promise<SessionIntent> {
    return withSessionLock(intent.sessionId, async () => {
      const cur = await latestOr(intent);
      const next: SessionIntent = { ...cur, taint: { reason: redactString(reason), source, remainingActions: ttlActions, at: nowIso() }, updatedAt: nowIso() };
      await govStore().saveSessionIntent(next);
      govBus.emit('session.updated', next);
      return next;
    });
  }

  digest(intent: SessionIntent, maxLines = 30): string {
    return intent.trajectory.slice(-maxLines).join('\n');
  }
}

let current: IntentContract = new DefaultIntentTracker();
export function setIntentTracker(next: IntentContract): void { current = next; }
export const intentTracker: IntentContract = {
  get: (...args) => current.get(...args),
  recordGoal: (...args) => current.recordGoal(...args),
  recordAction: (...args) => current.recordAction(...args),
  taint: (...args) => current.taint(...args),
  digest: (...args) => current.digest(...args),
};
export default intentTracker;
