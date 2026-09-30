import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { JevShadowRecord } from '../../src/governance/jev/types';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `jev-store-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

type Db = typeof import('../../src/db');
let db: Db;
let store: import('../../src/governance/store/sqlite').SqliteGovernanceStore;

beforeAll(async () => {
  db = await import('../../src/db');
  await db.initDb();
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  store = new SqliteGovernanceStore();
  await store.init();
  await store.init(); // idempotent schema creation
});

afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

function rec(id: string, createdAt: string, extra: Partial<JevShadowRecord> = {}): JevShadowRecord {
  return {
    id, kind: 'judge', createdAt,
    baseline: { provider: 'foundry', model: 'gpt-4.1-mini', verdict: 'allow', latencyMs: 400, inputTokens: 900, outputTokens: 60 },
    jev: { model: 'jev-1.13.0', verdict: 'allow', latencyMs: 40, inputTokens: 700, signals: { q_destructive: 0.02, q_intent: 'aligned' } },
    agree: true,
    ...extra,
  };
}

describe('SqliteGovernanceStore — Jev shadow', () => {
  it('round-trips the full document', async () => {
    const r = rec('rt-1', '2026-02-01T00:00:00.000Z', { decisionId: 'd1', sessionId: 'sess-rt', laneId: 'lane-rt', toolName: 'Bash', checkpoint: 'pre_tool' });
    await store.appendJevShadow(r);
    const page = await store.queryJevShadow({ sessionId: 'sess-rt' });
    expect(page.items).toEqual([r]);
    expect(page.cursor).toBeUndefined();
  });

  it('is insert-only on id (an existing record is never overwritten)', async () => {
    await store.appendJevShadow(rec('up-1', '2026-02-02T00:00:00.000Z', { sessionId: 'sess-up', agree: true }));
    await store.appendJevShadow(rec('up-1', '2026-02-03T00:00:00.000Z', { sessionId: 'sess-up', kind: 'injection', agree: false }));
    const page = await store.queryJevShadow({ sessionId: 'sess-up' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ kind: 'judge', agree: true, createdAt: '2026-02-02T00:00:00.000Z' });
  });

  it('filters by kind, session, lane, agree and time window', async () => {
    await store.appendJevShadow(rec('f-1', '2026-03-01T00:00:01.000Z', { sessionId: 'sf', laneId: 'la', agree: true }));
    await store.appendJevShadow(rec('f-2', '2026-03-01T00:00:02.000Z', { sessionId: 'sf', laneId: 'lb', agree: false }));
    await store.appendJevShadow(rec('f-3', '2026-03-01T00:00:03.000Z', { sessionId: 'sf', kind: 'injection', agree: undefined }));
    await store.appendJevShadow(rec('f-4', '2026-03-01T00:00:04.000Z', { sessionId: 'sf', kind: 'session_score' }));
    const ids = async (q: Parameters<typeof store.queryJevShadow>[0]) => (await store.queryJevShadow({ sessionId: 'sf', ...q })).items.map(r => r.id);
    expect(await ids({})).toEqual(['f-4', 'f-3', 'f-2', 'f-1']);
    expect(await ids({ kind: ['injection', 'session_score'] })).toEqual(['f-4', 'f-3']);
    expect(await ids({ laneId: 'lb' })).toEqual(['f-2']);
    expect(await ids({ agree: false })).toEqual(['f-2']);
    expect(await ids({ agree: true })).toEqual(['f-4', 'f-1']);
    expect(await ids({ since: '2026-03-01T00:00:02.000Z', until: '2026-03-01T00:00:04.000Z' })).toEqual(['f-3', 'f-2']);
  });

  it('pages newest-first with a stable keyset cursor (ties on createdAt)', async () => {
    const at = '2026-04-01T00:00:00.000Z';
    for (const id of ['c-a', 'c-b', 'c-c']) await store.appendJevShadow(rec(id, at, { sessionId: 'sc' }));
    await store.appendJevShadow(rec('c-new', '2026-04-01T00:00:05.000Z', { sessionId: 'sc' }));
    await store.appendJevShadow(rec('c-old', '2026-03-31T23:59:59.000Z', { sessionId: 'sc' }));
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await store.queryJevShadow({ sessionId: 'sc', limit: 2, cursor });
      seen.push(...p.items.map(r => r.id));
      cursor = p.cursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['c-new', 'c-c', 'c-b', 'c-a', 'c-old']);
    expect(pages).toBe(3);
  });

  it('clamps limit to [1, 1000]', async () => {
    expect((await store.queryJevShadow({ sessionId: 'sf', limit: 0 })).items).toHaveLength(1);
  });

  it('prunes records older than the cutoff and reports the count', async () => {
    await store.appendJevShadow(rec('p-old-1', '2020-01-01T00:00:00.000Z', { sessionId: 'sp' }));
    await store.appendJevShadow(rec('p-old-2', '2020-01-02T00:00:00.000Z', { sessionId: 'sp' }));
    await store.appendJevShadow(rec('p-new', '2030-01-01T00:00:00.000Z', { sessionId: 'sp' }));
    expect(await store.pruneJevShadow('2021-01-01T00:00:00.000Z')).toBe(2);
    expect((await store.queryJevShadow({ sessionId: 'sp' })).items.map(r => r.id)).toEqual(['p-new']);
    expect(await store.pruneJevShadow('2021-01-01T00:00:00.000Z')).toBe(0);
  });

  it('does not touch the hash-chained decision log', async () => {
    const v = await store.verifyAuditChain();
    expect(v).toMatchObject({ ok: true, checked: 0 });
  });
});
