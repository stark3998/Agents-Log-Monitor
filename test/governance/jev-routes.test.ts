import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Principal } from '../../src/governance/types';
import type { JevShadowRecord } from '../../src/governance/jev/types';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `jev-routes-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

const viewer: Principal = { id: 'viewer', roles: ['Viewer'], kind: 'user' };
const intel: Principal = { id: 'intelligence-mi', roles: ['Agent'], kind: 'agent' };

type Db = typeof import('../../src/db');
let db: Db;
let server: http.Server;
let baseUrl: string;
let principal: Principal = viewer;
let store: import('../../src/governance/store/sqlite').SqliteGovernanceStore;

beforeAll(async () => {
  db = await import('../../src/db');
  await db.initDb();
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { setGovernanceStore } = await import('../../src/governance/store');
  store = new SqliteGovernanceStore();
  await store.init();
  setGovernanceStore(store);
  const adminRouter = (await import('../../src/governance/routes/admin')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.principal = principal; next(); });
  app.use('/api/gov', adminRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

/** A valid POST body — `guardian_triage` (intelligence) and `fleet_*` (AgentMon Fleet) are accepted over the API. */
function body(extra: Record<string, unknown> = {}) {
  return {
    kind: 'guardian_triage', sessionId: 'sess-1', agentId: 'agent-1', laneId: 'lane-1',
    baseline: { provider: 'guardian', model: 'gpt-4.1', verdict: 'low', latencyMs: 4500 },
    jev: { model: 'jev-1.13.0', verdict: 'high', latencyMs: 35, inputTokens: 700, signals: { q_destructive: 0.91 } },
    agree: false,
    ...extra,
  };
}

/** In-process record (judge / injection / ?) written straight to the store, as the monitor does. */
async function seed(id: string, createdAt: string, extra: Partial<JevShadowRecord> = {}): Promise<void> {
  await store.appendJevShadow({
    id, createdAt, kind: 'judge', decisionId: 'd-1', sessionId: 'sess-1', laneId: 'lane-1',
    baseline: { provider: 'foundry', model: 'gpt-4.1-mini', verdict: 'allow', latencyMs: 450, inputTokens: 800, outputTokens: 50 },
    jev: { model: 'jev-1.13.0', verdict: 'deny', latencyMs: 35, inputTokens: 700, signals: { q_destructive: 0.91 } },
    agree: false,
    ...extra,
  });
}

async function post(b: unknown, as: Principal) {
  principal = as;
  return fetch(`${baseUrl}/api/gov/jev/shadow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
}
async function getJson(p: string, as: Principal = viewer) {
  principal = as;
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: await res.json() as any };
}

describe('Jev shadow admin routes', () => {
  it('GET /jev/benchmarks is readable by Viewers and reports a missing results folder', async () => {
    const prev = process.env.JEV_EVAL_RESULTS_DIR;
    process.env.JEV_EVAL_RESULTS_DIR = path.join(dir, `no-results-${process.pid}`);
    try {
      const r = await getJson('/api/gov/jev/benchmarks?judge=../../etc');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ available: false, runs: [] });
    } finally {
      if (prev === undefined) delete process.env.JEV_EVAL_RESULTS_DIR; else process.env.JEV_EVAL_RESULTS_DIR = prev;
    }
  });
  it('POST requires PolicyAdmin or Agent', async () => {
    const res = await post(body(), viewer);
    expect(res.status).toBe(403);
  });

  it('POST validates the body', async () => {
    const res = await post({ ...body(), kind: 'nope', jev: { model: 'x' } }, intel);
    expect(res.status).toBe(400);
    const j = await res.json() as any;
    expect(j.error).toBe('invalid shadow record');
    expect(j.issues.map((i: any) => i.path)).toEqual(expect.arrayContaining(['kind', 'jev.latencyMs']));
  });

  it('POST rejects the in-process kinds (judge / injection / session_score)', async () => {
    for (const kind of ['judge', 'injection', 'session_score']) {
      const res = await post(body({ kind, sessionId: 'sess-forged' }), intel);
      expect(res.status).toBe(400);
      const j = await res.json() as any;
      expect(j.error).toBe('invalid shadow record');
      expect(j.issues.map((i: any) => i.path)).toContain('kind');
    }
    expect((await getJson('/api/gov/jev/shadow?sessionId=sess-forged')).json.items).toHaveLength(0);
  });

  it('POST accepts every fleet_* kind from the Fleet principal (Agent role, as for /fleet/alerts)', async () => {
    const fleet: Principal = { id: 'agentmon-fleet', roles: ['Agent'], kind: 'agent' };
    const cases: [string, string, string, number?][] = [
      ['fleet_realtime', 'block', 'allow', 82],
      ['fleet_intent', 'in_scope', 'out_of_scope'],
      ['fleet_alignment', 'aligned', 'misaligned'],
      ['fleet_evasion', 'same', 'different'],
      ['fleet_injection', 'clean', 'attack'],
      ['fleet_code', 'necessary', 'unnecessary', 71],
    ];
    for (const [kind, b, j, score] of cases) {
      const res = await post(body({
        kind, sessionId: 'sess-fleet', agentId: 'foundry:asst_1', toolName: 'run_script',
        baseline: { provider: 'rules', verdict: b, score, latencyMs: 3 },
        jev: { model: 'jev-1.13.0', verdict: j, score, latencyMs: 40, signals: { q_risk: 0.7 } },
        agree: false,
      }), fleet);
      expect(res.status, kind).toBe(201);
      expect((await res.json() as any).kind).toBe(kind);
    }
    const listed = await getJson('/api/gov/jev/shadow?sessionId=sess-fleet&kind=fleet_intent,fleet_code');
    expect(listed.status).toBe(200);
    expect(listed.json.items.map((r: any) => r.kind).sort()).toEqual(['fleet_code', 'fleet_intent']);

    const sum = await getJson('/api/gov/jev/summary?kind=fleet_realtime,fleet_intent,fleet_alignment,fleet_evasion,fleet_injection,fleet_code');
    expect(sum.status).toBe(200);
    const kinds = sum.json.kinds.map((k: any) => k.kind);
    expect(kinds).toEqual(['fleet_realtime', 'fleet_intent', 'fleet_alignment', 'fleet_evasion', 'fleet_injection', 'fleet_code']);
    const byKind = Object.fromEntries(sum.json.kinds.map((k: any) => [k.kind, k]));
    expect(byKind.fleet_realtime).toMatchObject({ jevStricter: 0, jevLooser: 1 });
    expect(byKind.fleet_intent).toMatchObject({ jevStricter: 1, jevLooser: 0 });
    expect(byKind.fleet_evasion).toMatchObject({ jevStricter: 0, jevLooser: 1 });
    expect(byKind.fleet_code).toMatchObject({ jevStricter: 1, jevLooser: 0 });
  });

  it('GET rejects an unknown kind filter', async () => {
    expect((await getJson('/api/gov/jev/shadow?kind=fleet_bogus')).status).toBe(400);
    expect((await getJson('/api/gov/jev/summary?kind=fleet_bogus')).status).toBe(400);
  });

  it('POST assigns id/createdAt and stores the record', async () => {
    const res = await post(body(), intel);
    expect(res.status).toBe(201);
    const saved = await res.json() as any;
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.kind).toBe('guardian_triage');
    expect(Number.isFinite(Date.parse(saved.createdAt))).toBe(true);
    expect(saved.jev.signals).toEqual({ q_destructive: 0.91 });
  });

  it('POST ignores a caller-supplied id and createdAt (server-assigned)', async () => {
    const before = Date.now();
    const res = await post(body({ id: 'client-id', createdAt: '2099-01-01T00:00:00Z', sessionId: 'sess-cid' }), intel);
    expect(res.status).toBe(201);
    const saved = await res.json() as any;
    expect(saved.id).not.toBe('client-id');
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    const at = Date.parse(saved.createdAt);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    const { json } = await getJson('/api/gov/jev/shadow?sessionId=sess-cid');
    expect(json.items.map((r: any) => r.id)).toEqual([saved.id]);
  });

  it('POST cannot overwrite an existing record', async () => {
    await seed('victim', '2026-01-02T00:00:00.000Z', { kind: 'session_score', sessionId: 'sess-v', agree: true,
      baseline: { provider: 'heuristic', verdict: 'ok' }, jev: { model: 'jev-1.13.0', verdict: 'ok', latencyMs: 10, signals: {} } });
    const res = await post(body({ id: 'victim', sessionId: 'sess-v', agree: false }), intel);
    expect(res.status).toBe(201);
    expect((await res.json() as any).id).not.toBe('victim');
    const { json } = await getJson('/api/gov/jev/shadow?sessionId=sess-v');
    expect(json.items).toHaveLength(2);
    expect(json.items.find((r: any) => r.id === 'victim')).toMatchObject({ kind: 'session_score', agree: true, createdAt: '2026-01-02T00:00:00.000Z' });
  });

  it('GET /jev/shadow filters and pages', async () => {
    await seed('fixed-1', '2026-01-01T00:00:00.000Z', { kind: 'injection', sessionId: 'sess-2', agree: true,
      baseline: { provider: 'prompt-shields', verdict: 'clean', latencyMs: 120 }, jev: { model: 'jev-1.13.0', verdict: 'clean', latencyMs: 20, signals: {} } });
    for (let i = 0; i < 3; i++) await seed(`pg-${i}`, `2026-02-01T00:00:0${i}.000Z`, { sessionId: 'sess-pg' });
    const p1 = await getJson('/api/gov/jev/shadow?sessionId=sess-pg&limit=2');
    expect(p1.status).toBe(200);
    expect(p1.json.items.map((r: any) => r.id)).toEqual(['pg-2', 'pg-1']);
    const p2 = await getJson(`/api/gov/jev/shadow?sessionId=sess-pg&limit=2&cursor=${encodeURIComponent(p1.json.cursor)}`);
    expect(p2.json.items.map((r: any) => r.id)).toEqual(['pg-0']);
    expect(p2.json.cursor).toBeUndefined();
    const byKind = await getJson('/api/gov/jev/shadow?kind=injection&agree=true');
    expect(byKind.json.items.map((r: any) => r.id)).toEqual(['fixed-1']);
  });

  it('GET /jev/shadow rejects bad query params', async () => {
    expect((await getJson('/api/gov/jev/shadow?kind=bogus')).status).toBe(400);
    expect((await getJson('/api/gov/jev/shadow?limit=5000')).status).toBe(400);
    expect((await getJson('/api/gov/jev/shadow?since=yesterday')).status).toBe(400);
  });

  it('GET /jev/summary returns per-kind stats and queue counters', async () => {
    const { status, json } = await getJson('/api/gov/jev/summary');
    expect(status).toBe(200);
    expect(json).toMatchObject({ enabled: expect.any(Boolean), model: expect.any(String), truncated: false });
    expect(Object.keys(json.queue).sort()).toEqual(['completed', 'dropped', 'enqueued', 'failed', 'inFlight', 'queued']);
    const judge = json.kinds.find((k: any) => k.kind === 'judge');
    expect(judge).toMatchObject({ total: 3, compared: 3, agreed: 0, jevStricter: 3, jevLooser: 0 });
    expect(judge.confusion).toEqual({ allow: { deny: 3 } });
    const kindOnly = await getJson('/api/gov/jev/summary?kind=injection');
    expect(kindOnly.json.kinds.map((k: any) => k.kind)).toEqual(['injection']);
  });

  it('read endpoints require Viewer', async () => {
    const nobody: Principal = { id: 'x', roles: [], kind: 'user' };
    expect((await getJson('/api/gov/jev/summary', nobody)).status).toBe(403);
    expect((await getJson('/api/gov/jev/shadow', nobody)).status).toBe(403);
  });

  it('retention sweep prunes records older than JEV_SHADOW_RETENTION_DAYS', async () => {
    await seed('ancient', '2000-01-01T00:00:00.000Z', { sessionId: 'sess-old' });
    const { pruneJevShadowOnce } = await import('../../src/governance/jev/retention');
    expect(await pruneJevShadowOnce(Date.parse('2026-01-15T00:00:00Z'))).toBe(1);
    expect((await getJson('/api/gov/jev/shadow?sessionId=sess-old')).json.items).toHaveLength(0);
  });
});
