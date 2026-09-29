import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { govConfig } from '../../src/governance/config';
import { govBus } from '../../src/governance/events';
import { setGovernanceStore, type GovernanceStore } from '../../src/governance/store';
import type { Decision, LaneRecord } from '../../src/governance/types';
import { __resetAlertsForTests, __runAlertWorkerForTests, startAlerts } from '../../src/governance/alerts';

interface Row { id: string; item: unknown; attempts: number; claimed?: boolean }

class FakeStore {
  lanes = new Map<string, LaneRecord>();
  outbox: Row[] = [];
  acked: string[] = [];

  async getLane(id: string) { return this.lanes.get(id); }
  async enqueue(_box: 'alerts' | 'sync', item: unknown) {
    this.outbox.push({ id: `row-${this.outbox.length + 1}`, item, attempts: 0 });
  }
  async dequeue(_box: 'alerts' | 'sync', limit: number) {
    const rows = this.outbox.filter(r => !r.claimed).slice(0, limit);
    for (const r of rows) { r.claimed = true; r.attempts++; }
    return rows.map(r => ({ id: r.id, item: r.item, attempts: r.attempts }));
  }
  async ack(_box: 'alerts' | 'sync', ids: string[]) {
    this.acked.push(...ids);
    this.outbox = this.outbox.filter(r => !ids.includes(r.id));
  }
  async nack(_box: 'alerts' | 'sync', ids: string[]) {
    for (const r of this.outbox) if (ids.includes(r.id)) r.claimed = false;
  }
}

let store: FakeStore;
let fetchMock: ReturnType<typeof vi.fn>;

const lane = (alerts?: LaneRecord['lane']['alerts']): LaneRecord => ({
  lane: {
    id: 'lane-1',
    version: 1,
    appliesTo: {},
    purpose: 'test',
    dos: [],
    never: [],
    rules: {},
    mode: 'enforce',
    failMode: { default: 'closed' },
    approval: { channels: ['dashboard', 'teams'], timeoutSec: 60 },
    judge: { escalateBelow: 0.7, dataPolicy: 'redacted' },
    alerts,
  },
  status: 'active',
  updatedAt: new Date().toISOString(),
});

const decision = (patch: Partial<Decision> = {}): Decision => ({
  id: 'dec-1',
  requestId: 'req-1',
  sessionId: 'sess-1',
  agentId: 'agent-1',
  laneId: 'lane-1',
  laneVersion: 1,
  mode: 'enforce',
  checkpoint: 'pre_tool',
  toolName: 'powershell',
  category: 'EXEC',
  verdict: 'deny',
  effectiveVerdict: 'deny',
  wouldDeny: false,
  stage: 'rules_deny',
  reason: 'blocked secret TOKEN=super-secret-value',
  ruleIds: ['rule-1'],
  riskLevel: 'high',
  judge: undefined,
  tainted: false,
  latencyMs: 1,
  createdAt: new Date().toISOString(),
  ...patch,
});

async function flushEvents() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  __resetAlertsForTests();
  store = new FakeStore();
  store.lanes.set('lane-1', lane());
  setGovernanceStore(store as unknown as GovernanceStore);
  govConfig.alerts.teamsWebhookUrl = '';
  govConfig.alerts.webhookUrls = ['https://hooks.contoso.test/agentgov'];
  govConfig.alerts.webhookSecret = 'webhook-secret';
  govConfig.alerts.acsConnectionEndpoint = '';
  govConfig.alerts.emailFrom = '';
  govConfig.alerts.emailTo = [];
  govConfig.alerts.dashboardUrl = 'https://gov.contoso.test';
  fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  startAlerts();
});

describe('governance alerts', () => {
  it('routes high-severity decisions to HMAC-signed webhooks', async () => {
    govBus.emit('decision', decision());
    await flushEvents();
    await __runAlertWorkerForTests();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.contoso.test/agentgov');
    expect(init.method).toBe('POST');
    const body = String(init.body);
    const expected = crypto.createHmac('sha256', 'webhook-secret').update(body).digest('hex');
    expect((init.headers as Record<string, string>)['X-AgentGov-Signature']).toBe(`sha256=${expected}`);
    expect(JSON.parse(body)).toMatchObject({ type: 'decision', severity: 'high' });
  });

  it('honors lane alert overrides and posts Teams adaptive cards with links', async () => {
    store.lanes.set('lane-1', lane({ high: ['teams'] }));
    govConfig.alerts.teamsWebhookUrl = 'https://teams.contoso.test/webhook';
    govBus.emit('decision', decision({ sessionId: 'sess/card' }));
    await flushEvents();
    await __runAlertWorkerForTests();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://teams.contoso.test/webhook');
    const body = JSON.parse(String(init.body));
    expect(body.type).toBe('message');
    const card = body.attachments[0].content;
    expect(card.type).toBe('AdaptiveCard');
    expect(JSON.stringify(card)).toContain('https://gov.contoso.test/conversations?c=sess%2Fcard');
    expect(JSON.stringify(card)).not.toContain('super-secret-value');
  });

  it('throttles duplicate agent/rule alerts within five minutes', async () => {
    govBus.emit('decision', decision({ id: 'dec-a' }));
    govBus.emit('decision', decision({ id: 'dec-b' }));
    await flushEvents();
    expect(store.outbox).toHaveLength(1);
  });

  it('builds approval cards with approve and deny deep links', async () => {
    store.lanes.set('lane-1', lane({ high: ['teams'] }));
    govConfig.alerts.teamsWebhookUrl = 'https://teams.contoso.test/webhook';
    govBus.emit('approval.requested', {
      id: 'appr-1',
      requestId: 'req-1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      laneId: 'lane-1',
      toolName: 'Bash',
      summary: 'run deploy',
      reason: 'needs approval',
      channels: ['teams'],
      state: 'pending',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await flushEvents();
    await __runAlertWorkerForTests();

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    const actions = body.attachments[0].content.actions;
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'Action.OpenUrl', title: 'Approve', url: 'https://gov.contoso.test/approvals?id=appr-1&action=approve' }),
      expect.objectContaining({ type: 'Action.OpenUrl', title: 'Deny', url: 'https://gov.contoso.test/approvals?id=appr-1&action=deny' }),
    ]));
  });

  it('drops failed outbox deliveries after the retry limit', async () => {
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await store.enqueue('alerts', {
      channel: 'webhook',
      payload: {
        kind: 'decision',
        severity: 'high',
        title: 'retry',
        channels: ['webhook'],
        data: { decisionId: 'dec-retry' },
        dedupeKey: 'retry',
        count: 1,
        createdAt: new Date().toISOString(),
      },
    });
    store.outbox[0].attempts = 7;
    await __runAlertWorkerForTests();
    expect(store.outbox).toHaveLength(0);
    expect(store.acked).toEqual(['row-1']);
  });
});
