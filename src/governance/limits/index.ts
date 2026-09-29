import type { ActionFeatures } from '../features';
import type { LimitHit, Limits as LimitsContract } from '../contracts';
import type { ActionRequest, Lane, SessionIntent } from '../types';

interface SessionWindow { times: number[]; signatures: string[]; lastSeen: number }

const SESSION_IDLE_TTL_MS = 10 * 60_000;
const MAX_SESSION_WINDOWS = 10_000;

class InMemoryLimits implements LimitsContract {
  private windows = new Map<string, SessionWindow>();

  private prune(now: number): void {
    for (const [sessionId, w] of this.windows) {
      if (now - w.lastSeen > SESSION_IDLE_TTL_MS) this.windows.delete(sessionId);
    }
    while (this.windows.size >= MAX_SESSION_WINDOWS) {
      let oldestId: string | undefined;
      let oldest = Infinity;
      for (const [sessionId, w] of this.windows) {
        if (w.lastSeen < oldest) { oldest = w.lastSeen; oldestId = sessionId; }
      }
      if (!oldestId) break;
      this.windows.delete(oldestId);
    }
  }

  async check(lane: Lane, intent: SessionIntent, req: ActionRequest, f: ActionFeatures): Promise<LimitHit | null> {
    const cfg = lane.limits ?? {};
    const now = Date.now();
    this.prune(now);
    const w = this.windows.get(req.sessionId) ?? { times: [], signatures: [], lastSeen: now };
    w.times = w.times.filter(t => now - t < 60_000);
    w.times.push(now);
    w.signatures.push(f.signature);
    w.lastSeen = now;
    if (w.signatures.length > 20) w.signatures.splice(0, w.signatures.length - 20);
    this.windows.delete(req.sessionId);
    this.windows.set(req.sessionId, w);

    if (cfg.actionsPerMin && w.times.length > cfg.actionsPerMin) {
      return { limitId: 'actions-per-min', reason: `Action rate exceeded (${w.times.length}/${cfg.actionsPerMin} per minute)` };
    }
    if (cfg.maxDepth != null && (req.agent.depth ?? 0) > cfg.maxDepth) {
      return { limitId: 'max-depth', reason: `Agent depth ${req.agent.depth ?? 0} exceeds ${cfg.maxDepth}` };
    }
    const subagents = intent.counters.subagents + (req.checkpoint === 'spawn' || f.category === 'AGENT' ? 1 : 0);
    if (cfg.maxSubagents != null && subagents > cfg.maxSubagents) {
      return { limitId: 'max-subagents', reason: `Subagent count ${subagents} exceeds ${cfg.maxSubagents}` };
    }
    const tokens = intent.counters.tokens + (req.tokens?.input ?? 0) + (req.tokens?.output ?? 0);
    if (cfg.tokenBudget != null && tokens > cfg.tokenBudget) {
      return { limitId: 'token-budget', reason: `Token budget exceeded (${tokens}/${cfg.tokenBudget})` };
    }
    if (cfg.loopThreshold && w.signatures.length >= cfg.loopThreshold) {
      const tail = w.signatures.slice(-cfg.loopThreshold);
      if (tail.every(s => s === f.signature)) return { limitId: 'loop-threshold', reason: `Repeated same action ${cfg.loopThreshold} times` };
    }
    if (cfg.maxSessionMinutes) {
      const started = Date.parse(intent.startedAt);
      if (Number.isFinite(started) && now - started > cfg.maxSessionMinutes * 60_000) {
        return { limitId: 'max-session-minutes', reason: `Session age exceeds ${cfg.maxSessionMinutes} minutes` };
      }
    }
    return null;
  }
}

let current: LimitsContract = new InMemoryLimits();
export function setLimits(next: LimitsContract): void { current = next; }
export const limits: LimitsContract = { check: (...args) => current.check(...args) };
export default limits;
