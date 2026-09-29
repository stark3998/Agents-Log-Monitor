import { describe, expect, it, vi } from 'vitest';
import { limits } from '../../src/governance/limits';
import type { ActionRequest, Lane, SessionIntent } from '../../src/governance/types';
import { extractFeatures } from '../../src/governance/features';

const lane: Lane = { id: 'l', version: 1, appliesTo: {}, purpose: 'p', dos: [], never: [], rules: {}, mode: 'enforce', failMode: { default: 'closed' }, approval: { channels: ['dashboard'], timeoutSec: 1 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' }, limits: { actionsPerMin: 100, maxSubagents: 1, maxDepth: 1, tokenBudget: 10, loopThreshold: 3, maxSessionMinutes: 1 } };
function intent(overrides: Partial<SessionIntent> = {}): SessionIntent { return { sessionId: `s-${Math.random()}`, agentId: 'a', trajectory: [], status: 'active', counters: { actions: 0, subagents: 0, tokens: 0 }, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides }; }
function req(sessionId: string, command = 'echo hi'): ActionRequest { return { requestId: Math.random().toString(), sessionId, checkpoint: 'pre_tool', agent: { surface: 'sdk', depth: 0 }, toolName: 'Bash', args: { command } }; }

describe('limits', () => {
  it('detects repeated action loops', async () => {
    const i = intent();
    const r = req(i.sessionId);
    const f = extractFeatures(r);
    expect(await limits.check(lane, i, r, f)).toBeNull();
    expect(await limits.check(lane, i, r, f)).toBeNull();
    const hit = await limits.check(lane, i, r, f);
    expect(hit?.limitId).toBe('loop-threshold');
  });

  it('enforces subagent, depth, token, and age limits', async () => {
    const subReq = { ...req('sub'), checkpoint: 'spawn' as const, toolName: 'Agent' };
    expect((await limits.check(lane, intent({ sessionId: 'sub', counters: { actions: 0, subagents: 1, tokens: 0 } }), subReq, extractFeatures(subReq)))?.limitId).toBe('max-subagents');
    const deep = req('deep'); deep.agent.depth = 2;
    expect((await limits.check(lane, intent({ sessionId: 'deep' }), deep, extractFeatures(deep)))?.limitId).toBe('max-depth');
    const tok = req('tok'); tok.tokens = { input: 11 };
    expect((await limits.check(lane, intent({ sessionId: 'tok' }), tok, extractFeatures(tok)))?.limitId).toBe('token-budget');
    const old = new Date(Date.now() - 120_000).toISOString();
    const ageReq = req('age', 'echo old');
    expect((await limits.check(lane, intent({ sessionId: 'age', startedAt: old }), ageReq, extractFeatures(ageReq)))?.limitId).toBe('max-session-minutes');
  });

  it('prunes idle in-memory session windows', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const sessionId = 'idle-prune';
      const first = req(sessionId, 'echo first');
      await limits.check(lane, intent({ sessionId }), first, extractFeatures(first));
      await limits.check(lane, intent({ sessionId }), first, extractFeatures(first));
      vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
      expect(await limits.check(lane, intent({ sessionId }), first, extractFeatures(first))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
