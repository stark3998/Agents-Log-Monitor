import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `approvals-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

type Db = typeof import('../../src/db');
let db: Db;
let approvals: typeof import('../../src/governance/approvals').approvals;
let sqliteStore: import('../../src/governance/store/sqlite').SqliteGovernanceStore;
let setGovernanceStore: typeof import('../../src/governance/store').setGovernanceStore;

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const sqliteMod = await import('../../src/governance/store/sqlite');
  await db.initDb();
  sqliteStore = new sqliteMod.SqliteGovernanceStore();
  await sqliteStore.init();
  setGovernanceStore = storeMod.setGovernanceStore;
  setGovernanceStore(sqliteStore);
  ({ approvals } = await import('../../src/governance/approvals'));
});

afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch {} } });

const lane = { id: 'l', version: 1, appliesTo: {}, priority: 1, purpose: 'p', dos: [], never: [], rules: {}, mode: 'enforce' as const, failMode: { default: 'closed' as const }, approval: { channels: ['dashboard' as const], timeoutSec: 1 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' as const } };
const agent = { id: 'a', name: 'a', surface: 'sdk' as const, status: 'active' as const, discovered: true, firstSeenAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
function req(id: string) { return { req: { requestId: id, sessionId: 's', checkpoint: 'pre_tool' as const, agent: { surface: 'sdk' as const }, toolName: 'Bash' }, agent, lane, summary: 'Bash deploy', reason: 'needs approval', channels: ['dashboard' as const], timeoutSec: 1 }; }

describe('approvals', () => {
  it('approves and wakes waiters', async () => {
    const a = await approvals.request(req('approve'));
    setTimeout(() => { void approvals.resolve(a.id, 'approved', 'u1', 'ok'); }, 20);
    const r = await approvals.wait(a.id, 1000);
    expect(r.state).toBe('approved');
    expect(r.resolvedBy).toBe('u1');
  });

  it('denies idempotently', async () => {
    const a = await approvals.request(req('deny'));
    const d1 = await approvals.resolve(a.id, 'denied', 'u2');
    const d2 = await approvals.resolve(a.id, 'approved', 'u3');
    expect(d1?.state).toBe('denied');
    expect(d2?.state).toBe('denied');
  });

  it('expires pending approvals', async () => {
    const a = await approvals.request(req('expire'));
    const r = await approvals.wait(a.id, 30);
    expect(r.state).toBe('expired');
  });

  it('wait falls back to an expired result if the store is unreachable at timeout', async () => {
    const pending = await approvals.request(req('store-down'));
    let reads = 0;
    const flakyStore = Object.create(sqliteStore) as typeof sqliteStore;
    flakyStore.getApproval = async (id: string) => {
      reads++;
      if (reads === 1) return sqliteStore.getApproval(id);
      throw new Error('store down');
    };
    flakyStore.updateApproval = async () => { throw new Error('store down'); };
    setGovernanceStore(flakyStore);
    try {
      const r = await approvals.wait(pending.id, 5);
      expect(r.state).toBe('expired');
      expect(r.id).toBe(pending.id);
    } finally {
      setGovernanceStore(sqliteStore);
    }
  });
});
