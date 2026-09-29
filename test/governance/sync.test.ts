import express, { type Request, type Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Decision, Lane, LaneRecord } from '../../src/governance/types';

let cleanupFns: (() => Promise<void> | void)[] = [];

beforeEach(() => { cleanupFns = []; });
afterEach(async () => {
  for (const fn of cleanupFns.reverse()) await fn();
  vi.resetModules();
});

function lane(dataPolicy: 'redacted' | 'full' | 'metadata-only' = 'redacted'): Lane {
  return { id: 'cloud-lane', version: 1, appliesTo: { surfaces: ['*'] }, priority: 1, purpose: 'cloud', dos: [], never: [], rules: {}, mode: 'observe', failMode: { default: 'open' }, approval: { channels: ['dashboard'], timeoutSec: 30 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' }, sync: { dataPolicy } };
}
function decision(id = 'd1'): Decision {
  return { id, requestId: `r-${id}`, sessionId: 's1', agentId: 'agent-1', laneId: 'cloud-lane', laneVersion: 1, mode: 'observe', checkpoint: 'pre_tool', toolName: 'Read', verdict: 'allow', effectiveVerdict: 'allow', wouldDeny: false, stage: 'rules_allow', reason: 'ok', ruleIds: [], tainted: false, latencyMs: 1, createdAt: '2026-01-01T00:00:00Z' };
}

async function startControlPlane(handlers: { lanes?: LaneRecord[]; ingest?: (body: any, res: Response) => void; failIngest?: () => boolean; failStatus?: number }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/gov/lanes', (_req: Request, res: Response) => res.json(handlers.lanes ?? []));
  app.get('/api/gov/agents', (_req: Request, res: Response) => res.json([]));
  const ingests: any[] = [];
  app.post('/api/gov/sync/ingest', (req: Request, res: Response) => {
    if (handlers.failIngest?.()) { res.status(handlers.failStatus ?? 500).json({ error: 'offline' }); return; }
    res.on('finish', () => { if (res.statusCode < 400) ingests.push(req.body); });
    handlers.ingest?.(req.body, res);
    if (!res.headersSent) res.json({ ok: true });
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanupFns.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad addr');
  return { url: `http://127.0.0.1:${addr.port}`, ingests };
}

async function setup(url: string) {
  vi.resetModules();
  const dir = path.join(process.cwd(), 'test', 'artifacts');
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `sync-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.AGENT_MONITOR_DB = dbPath;
  process.env.GOVERNANCE_CONTROL_PLANE_URL = url;
  process.env.GOVERNANCE_DEVICE_TOKEN = 'dev-token';
  process.env.GOVERNANCE_SYNC_INTERVAL_MS = '5000';
  process.env.AGENT_MONITOR_MODE = 'local';
  const db = await import('../../src/db');
  await db.initDb();
  cleanupFns.push(() => { db.flushDb(); for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ } } });
  const { govConfig } = await import('../../src/governance/config');
  govConfig.cloud.controlPlaneUrl = url;
  govConfig.cloud.deviceToken = 'dev-token';
  govConfig.cloud.syncIntervalMs = 5000;
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { setGovernanceStore } = await import('../../src/governance/store');
  const store = new SqliteGovernanceStore();
  await store.init();
  setGovernanceStore(store);
  const sync = await import('../../src/governance/sync');
  return { db, store, sync };
}

async function startIngestRouter(principal: any) {
  vi.resetModules();
  const appended: any[] = [];
  const writtenEvents: any[] = [];
  vi.doMock('../../src/governance/store/cosmos-telemetry', () => ({
    CosmosTelemetrySink: class {
      async init() {}
      async writeEvents(events: any[]) { writtenEvents.push(...events); }
    },
  }));
  const { setGovernanceStore } = await import('../../src/governance/store');
  setGovernanceStore({
    kind: 'cosmos',
    init: async () => {},
    appendDecision: async (d: any) => { appended.push(d); return { ...d, seq: 1, prevHash: 'server-prev', hash: 'server-hash' }; },
    listLanes: async () => [],
  } as any);
  const { ingestRouter } = await import('../../src/governance/sync/ingest-router');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req: Request, _res: Response, next) => { req.principal = principal; next(); });
  app.use('/api/gov', ingestRouter);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanupFns.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('bad addr');
  return { url: `http://127.0.0.1:${addr.port}`, appended, writtenEvents };
}

describe('local-cloud governance sync', () => {
  it('pulls cloud lanes into the local store with cloud precedence', async () => {
    const rec: LaneRecord = { lane: lane(), status: 'active', updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'cloud' };
    const cp = await startControlPlane({ lanes: [rec] });
    const { store, sync } = await setup(cp.url);
    await sync.runLocalSyncOnce();
    expect((await store.getLane('cloud-lane'))?.updatedBy).toBe('cloud');
  });

  it('lists the latest active lane even when a newer draft exists locally', async () => {
    const cp = await startControlPlane({ lanes: [] });
    const { store } = await setup(cp.url);
    await store.saveLane({ lane: lane(), status: 'active', updatedAt: '2026-01-01T00:00:00Z' });
    await store.saveLane({ lane: { ...lane(), version: 2 }, status: 'draft', updatedAt: '2026-01-01T00:01:00Z' });
    await store.saveLane({ lane: { ...lane(), version: 3 }, status: 'proposed', updatedAt: '2026-01-01T00:02:00Z' });
    const active = await store.listLanes(['active']);
    expect(active.map(r => `${r.lane.id}:${r.lane.version}:${r.status}`)).toEqual(['cloud-lane:1:active']);
  });

  it('pushes decisions and acks drained outbox items', async () => {
    const cp = await startControlPlane({ lanes: [] });
    const { store, sync } = await setup(cp.url);
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-push') });
    await sync.drainSyncOutbox();
    expect(cp.ingests[0].items[0].decision.id).toBe('d-push');
    expect(await store.dequeue('sync', 10)).toHaveLength(0);
  });

  it('nacks on offline failure and retries the next drain', async () => {
    let fail = true;
    const cp = await startControlPlane({ lanes: [], failIngest: () => fail });
    const { store, sync } = await setup(cp.url);
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-retry') });
    await expect(sync.drainSyncOutbox()).rejects.toThrow(/500/);
    fail = false;
    await sync.drainSyncOutbox();
    expect(cp.ingests).toHaveLength(1);
    expect(cp.ingests[0].items[0].decision.id).toBe('d-retry');
  });

  it('splits failed sync batches and dead-letters isolated 4xx poison items', async () => {
    const cp = await startControlPlane({
      lanes: [],
      ingest: (body, res) => {
        if (body.items.some((i: any) => i.decision?.id === 'd-poison')) res.status(400).json({ error: 'bad item' });
      },
    });
    const { store, sync } = await setup(cp.url);
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-good-1') });
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-poison') });
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-good-2') });
    await sync.drainSyncOutbox();
    const pushed = cp.ingests.flatMap(b => b.items.map((i: any) => i.decision.id));
    expect(pushed).toEqual(expect.arrayContaining(['d-good-1', 'd-good-2']));
    expect(pushed).not.toContain('d-poison');
    expect(await store.dequeue('sync', 10)).toHaveLength(0);
  });

  it('dead-letters sync outbox items that reach the retry cap', async () => {
    const cp = await startControlPlane({ lanes: [], failIngest: () => true });
    const { db, store, sync } = await setup(cp.url);
    await store.enqueue('sync', { kind: 'decision', decision: decision('d-cap') });
    db.run('UPDATE gov_outbox SET attempts = 9');
    await sync.drainSyncOutbox();
    expect(await store.dequeue('sync', 10)).toHaveLength(0);
    expect(cp.ingests).toHaveLength(0);
  });

  it('applies metadata-only lane policy before mirroring telemetry', async () => {
    const cp = await startControlPlane({ lanes: [] });
    const { db, store, sync } = await setup(cp.url);
    await store.saveLane({ lane: lane('metadata-only'), status: 'active', updatedAt: '2026-01-01T00:00:00Z' });
    db.run('INSERT INTO events (session_id, agent_id, event_type, raw_event_name, tool_name, status, payload, created_at, capture_channel, category, risk_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['s-meta', 'agent-1', 'tool_call', 'PreToolUse', 'Write', 'success', JSON.stringify({ secret: 'already-redacted', keep: false }), '2026-01-01T00:00:00Z', 'hook', 'WRITE', 'medium']);
    await sync.pollLocalTelemetryOnce();
    await sync.drainSyncOutbox();
    const event = cp.ingests[0].items[0].event;
    expect(event.toolName).toBe('Write');
    expect(event.category).toBe('WRITE');
    expect(event.riskLevel).toBe('medium');
    expect(event.payload).toBeUndefined();
    expect(event.errorText).toBeUndefined();
  });

  it('ingest namespaces device decisions and stores client chain fields only as origin metadata', async () => {
    const principal = { id: 'device-1', name: 'device-1', kind: 'device', roles: [] };
    const ingest = await startIngestRouter(principal);
    const reported = { ...decision('d-client'), seq: 99, prevHash: 'client-prev', hash: 'client-hash', approvalId: 'appr-client', approver: 'mallory', createdAt: '2026-01-01T00:00:00Z' };
    const res = await fetch(`${ingest.url}/api/gov/sync/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'spoofed-device', decisions: [reported] }),
    });
    expect(res.status).toBe(200);
    expect(ingest.appended).toHaveLength(1);
    const saved = ingest.appended[0];
    expect(saved.id).toBe('device-1:d-client');
    expect(saved.requestId).toBe('device-1:r-d-client');
    expect(saved.agentId).toBe('agent-1');
    expect(saved.laneId).toBe('cloud-lane');
    expect(saved.approvalId).toBeUndefined();
    expect(saved.approver).toBeUndefined();
    expect(saved.seq).toBeUndefined();
    expect(saved.prevHash).toBeUndefined();
    expect(saved.hash).toBeUndefined();
    expect(saved.createdAt).toBe(saved.receivedAt);
    expect(saved.createdAt).not.toBe(reported.createdAt);
    expect(saved.origin).toMatchObject({
      deviceId: 'device-1',
      reported: true,
      originalHash: 'client-hash',
      originalSeq: 99,
      createdAt: reported.createdAt,
      id: 'd-client',
      requestId: 'r-d-client',
    });
  });

  it('ingest stamps mirrored events with the authenticated principal device id', async () => {
    const ingest = await startIngestRouter({ id: 'device-events', name: 'device-events', kind: 'device', roles: [] });
    const res = await fetch(`${ingest.url}/api/gov/sync/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'spoofed-device', events: [{ id: 1, sessionId: 's1', agentId: 'a1', eventType: 'tool_call', occurredAt: '2026-01-01T00:00:00Z' }] }),
    });
    expect(res.status).toBe(200);
    expect(ingest.writtenEvents).toHaveLength(1);
    expect(ingest.writtenEvents[0].originDeviceId).toBe('device-events');
  });

  it('ingest rejects non-device principals without Agent role', async () => {
    const ingest = await startIngestRouter({ id: 'viewer-1', name: 'viewer', kind: 'user', roles: ['Viewer'] });
    const res = await fetch(`${ingest.url}/api/gov/sync/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisions: [decision('d-rejected')] }),
    });
    expect(res.status).toBe(403);
    expect(ingest.appended).toHaveLength(0);
  });
});
