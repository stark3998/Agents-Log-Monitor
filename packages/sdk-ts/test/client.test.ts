import { describe, expect, it, vi } from 'vitest';
import { GovernanceClient, GovernanceDeniedError, type Decision } from '../src/index.js';
import { wrapOpenAITool } from '../src/openai-agents.js';
import { wrapStructuredTool } from '../src/langchain.js';
import { wrapMcpClient } from '../src/mcp.js';

function decision(verdict: Decision['verdict'], extra: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    requestId: 'r1',
    sessionId: 's1',
    agentId: 'a1',
    laneId: 'l1',
    laneVersion: 1,
    mode: 'enforce',
    checkpoint: 'pre_tool',
    toolName: 'tool',
    verdict,
    effectiveVerdict: verdict,
    wouldDeny: verdict === 'deny',
    stage: 'rules_allow',
    reason: verdict,
    ruleIds: [],
    riskLevel: null,
    tainted: false,
    latencyMs: 1,
    createdAt: new Date().toISOString(),
    ...extra
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, statusText: status < 400 ? 'OK' : 'Error', headers: { 'content-type': 'application/json' } });
}

describe('GovernanceClient', () => {
  it('allows decisions and sends auth', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://pdp/v1/decide');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
      return json(decision('allow'));
    });
    const client = new GovernanceClient({ baseUrl: 'https://pdp/', token: 't', agent: { surface: 'sdk' }, fetch: fetch as any });
    await expect(client.check({ sessionId: 's1', toolName: 'tool' })).resolves.toMatchObject({ verdict: 'allow' });
  });

  it('returns deny decisions', async () => {
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, fetch: (async () => json(decision('deny'))) as any });
    await expect(client.check({ sessionId: 's1', toolName: 'tool' })).resolves.toMatchObject({ verdict: 'deny', reason: 'deny' });
  });

  it('polls approvals for escalation', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/decide')
      ? json(decision('escalate', { approvalId: 'ap1', stage: 'judge_escalation' }))
      : json({ id: 'ap1', state: 'approved', requestId: 'r1', sessionId: 's1', agentId: 'a1', laneId: 'l1', summary: '', reason: '', channels: [], requestedAt: '', expiresAt: '', resolvedBy: 'human' }));
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, approvalPollIntervalMs: 1, fetch: fetch as any });
    await expect(client.check({ sessionId: 's1', toolName: 'tool' })).resolves.toMatchObject({ verdict: 'allow', stage: 'human', approver: 'human' });
  });

  it('synthesizes fail-open by category', async () => {
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, failMode: { default: 'closed', READ: 'open' }, fetch: (async () => { throw new Error('offline'); }) as any });
    await expect(client.check({ sessionId: 's1', toolName: 'read', category: 'READ' })).resolves.toMatchObject({ verdict: 'allow', stage: 'fail_mode' });
  });

  it('synthesizes fail-closed by default', async () => {
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, failMode: 'closed', fetch: (async () => { throw new Error('offline'); }) as any });
    await expect(client.check({ sessionId: 's1', toolName: 'write', category: 'WRITE' })).resolves.toMatchObject({ verdict: 'deny', stage: 'fail_mode' });
  });

  it('guard throws on deny', async () => {
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, fetch: (async () => json(decision('deny'))) as any });
    const guarded = client.guard('danger', async () => 'ok');
    await expect(guarded({ x: 1 }, { sessionId: 's1' } as any)).rejects.toBeInstanceOf(GovernanceDeniedError);
  });

  it('adapter deny paths block execution', async () => {
    const client = new GovernanceClient({ baseUrl: 'https://pdp', agent: { surface: 'sdk' }, fetch: (async () => json(decision('deny'))) as any });
    const openai = wrapOpenAITool(client, { name: 'refund', execute: async () => 'executed' }, { sessionId: 's1' });
    await expect(openai.execute!({})).resolves.toContain('Governance denied');

    const lang = wrapStructuredTool(client, { name: 'refund', invoke: async () => 'executed' }, { sessionId: 's1' });
    await expect(lang.invoke({})).rejects.toBeInstanceOf(GovernanceDeniedError);

    const mcp = wrapMcpClient(client, { callTool: async () => 'executed' }, { sessionId: 's1' });
    await expect(mcp.callTool('refund', {})).rejects.toBeInstanceOf(GovernanceDeniedError);
  });
});
