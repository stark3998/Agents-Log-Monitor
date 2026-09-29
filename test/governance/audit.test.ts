import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `audit-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

type Db = typeof import('../../src/db');
let db: Db;
let store: import('../../src/governance/store/repository').GovernanceStore;

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const sqliteMod = await import('../../src/governance/store/sqlite');
  await db.initDb();
  store = new sqliteMod.SqliteGovernanceStore();
  await store.init();
  storeMod.setGovernanceStore(store);
});

afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch {} } });

function decision(id: string) {
  return { id, requestId: id, sessionId: 's', agentId: 'a', laneId: 'l', laneVersion: 1, mode: 'enforce' as const, checkpoint: 'pre_tool' as const, verdict: 'allow' as const, effectiveVerdict: 'allow' as const, wouldDeny: false, stage: 'default' as const, reason: 'ok', ruleIds: [], tainted: false, latencyMs: 1, createdAt: new Date().toISOString() };
}

describe('audit chain', () => {
  it('verifies and detects tampering', async () => {
    await store.appendDecision(decision('d1'));
    await store.appendDecision(decision('d2'));
    expect((await store.verifyAuditChain()).ok).toBe(true);
    const row = db.get<{ doc: string }>('SELECT doc FROM gov_decisions WHERE id = ?', ['d1'])!;
    const doc = JSON.parse(row.doc); doc.reason = 'tampered';
    db.run('UPDATE gov_decisions SET doc = ? WHERE id = ?', [JSON.stringify(doc), 'd1']);
    const verify = await store.verifyAuditChain();
    expect(verify.ok).toBe(false);
    expect(verify.brokenAt).toBe(1);
  });
});
