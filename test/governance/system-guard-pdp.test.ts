import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/governance/judge', () => ({
  judge: { available: false, evaluate: vi.fn() },
  extractGoal: vi.fn(async () => null),
}));

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `guard-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;
process.env.GOVERNANCE_ENFORCE = 'true';
process.env.PORT = '4317';

type Db = typeof import('../../src/db');
let db: Db;
let decide: typeof import('../../src/governance/pdp').decide;

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { parseLaneYaml } = await import('../../src/governance/lanes/loader');
  await db.initDb();
  const store = new SqliteGovernanceStore();
  await store.init();
  storeMod.setGovernanceStore(store);
  ({ decide } = await import('../../src/governance/pdp'));
  const yaml = 'id: observe-all\nversion: 1\npriority: 999\nmode: observe\npurpose: Observe only\nappliesTo: { surfaces: [claude-code] }\n';
  await store.saveLane({ lane: parseLaneYaml(yaml), status: 'active', yaml, updatedAt: new Date().toISOString() });
});

afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

const agent = { surface: 'claude-code' as const, externalId: 'main', cwd: process.cwd() };
const opts = { blocking: true, supportsAsk: false };

describe('system self-protection guard in the PDP', () => {
  it('denies an agent approving its own request via the local API even when its lane is in observe mode', async () => {
    const d = await decide({ requestId: 'g1', sessionId: 'sg', checkpoint: 'pre_tool', agent, toolName: 'Bash',
      args: { command: 'curl -X POST http://127.0.0.1:4317/api/gov/approvals/appr-1/approve' } }, opts);
    expect(d.verdict).toBe('deny');
    expect(d.mode).toBe('enforce');
    expect(d.ruleIds.some(r => r.startsWith('system:'))).toBe(true);
  });

  it('still returns observe-mode allow (wouldDeny) for ordinary lane violations', async () => {
    const d = await decide({ requestId: 'g2', sessionId: 'sg', checkpoint: 'pre_tool', agent, toolName: 'Bash',
      args: { command: 'npm test' } }, opts);
    expect(d.verdict).toBe('allow');
    expect(d.ruleIds.some(r => r.startsWith('system:'))).toBe(false);
  });
});
