import type { LimitHit, Limits } from '../contracts';
import type { ActionFeatures } from '../features';
import type { ActionRequest, Lane, SessionIntent } from '../types';
import { RedisLimitsBackend } from './redis';

const LOOP_WINDOW_MS = 10 * 60_000;

/**
 * Cluster-wide limits for the cloud control plane: rate and loop windows live in Redis so every
 * replica sees the same counts. Counter-based limits (subagents, tokens, depth, session age) come
 * from the persisted SessionIntent and need no shared state.
 */
export class RedisLimits implements Limits {
  constructor(private readonly backend = new RedisLimitsBackend()) {}

  async check(lane: Lane, intent: SessionIntent, req: ActionRequest, f: ActionFeatures): Promise<LimitHit | null> {
    const cfg = lane.limits ?? {};
    if (cfg.actionsPerMin) {
      const w = await this.backend.checkSlidingWindow(`rate:${req.sessionId}`, cfg.actionsPerMin, 60_000);
      if (!w.allowed) return { limitId: 'actions-per-min', reason: `Action rate exceeded (${w.count}/${cfg.actionsPerMin} per minute)` };
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
    if (cfg.loopThreshold) {
      const rows = await this.backend.recordLoopSignature(req.sessionId, f.signature, LOOP_WINDOW_MS);
      const tail = rows.slice(-cfg.loopThreshold);
      if (tail.length >= cfg.loopThreshold && tail.every(r => r.signature === f.signature)) {
        return { limitId: 'loop-threshold', reason: `Repeated same action ${cfg.loopThreshold} times` };
      }
    }
    if (cfg.maxSessionMinutes) {
      const started = Date.parse(intent.startedAt);
      if (Number.isFinite(started) && Date.now() - started > cfg.maxSessionMinutes * 60_000) {
        return { limitId: 'max-session-minutes', reason: `Session age exceeds ${cfg.maxSessionMinutes} minutes` };
      }
    }
    return null;
  }
}
