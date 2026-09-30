import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/governance/judge', () => ({
  judge: { available: false, evaluate: vi.fn() },
  extractGoal: vi.fn(async () => null),
}));

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `simulation-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;
process.env.GOVERNANCE_ENFORCE = 'true';
process.env.PORT = '4317';

type Db = typeof import('../../src/db');
let db: Db;
let decide: typeof import('../../src/governance/pdp').decide;
let sim: typeof import('../../src/governance/simulation');
let store: import('../../src/governance/store/sqlite').SqliteGovernanceStore;

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { parseLaneYaml } = await import('../../src/governance/lanes/loader');
  await db.initDb();
  store = new SqliteGovernanceStore();
  await store.init();
  storeMod.setGovernanceStore(store);
  ({ decide } = await import('../../src/governance/pdp'));
  sim = await import('../../src/governance/simulation');
  const yaml = [
    'id: strict-sim', 'version: 1', 'priority: 999', 'mode: enforce+approval', 'purpose: Strict test lane',
    'appliesTo: { surfaces: [copilot-cli] }',
    'rules:',
    '  deny:',
    '    - id: no-rm',
    '      command: ["rm *"]',
    '  approve:',
    '    - id: needs-human',
    '      command: ["git push*"]',
    'approval: { channels: [dashboard], timeoutSec: 5 }',
  ].join('\n');
  await store.saveLane({ lane: parseLaneYaml(yaml), status: 'active', yaml, updatedAt: new Date().toISOString() });
});

afterEach(() => { sim.setSimulationStateForTests(null); });
afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

const agent = { surface: 'copilot-cli' as const, externalId: 'main', cwd: process.cwd() };
const opts = { blocking: true, supportsAsk: false };
let n = 0;
const bash = (command: string) => ({ requestId: `r${++n}`, sessionId: `s${n}`, checkpoint: 'pre_tool' as const, agent, toolName: 'bash', args: { command } });

describe('governance simulation mode', () => {
  it('enforces normally when off', async () => {
    const d = await decide(bash('rm -rf build'), opts);
    expect(d.verdict).toBe('deny');
    expect(d.simulated).toBeUndefined();
  });

  it('records what would have been denied but never blocks', async () => {
    sim.setSimulationStateForTests({ enabled: true });
    const d = await decide(bash('rm -rf build'), opts);
    expect(d).toMatchObject({ verdict: 'allow', effectiveVerdict: 'deny', wouldDeny: true, mode: 'observe', simulated: true, stage: 'rules_deny' });
  });

  it('also downgrades the system self-protection guard', async () => {
    sim.setSimulationStateForTests({ enabled: true });
    const d = await decide(bash('curl -X POST http://127.0.0.1:4317/api/gov/approvals/a1/approve'), opts);
    expect(d).toMatchObject({ verdict: 'allow', effectiveVerdict: 'deny', wouldDeny: true, simulated: true });
    expect(d.ruleIds.some(r => r.startsWith('system:'))).toBe(true);
  });

  it('does not request (or wait for) human approval', async () => {
    sim.setSimulationStateForTests({ enabled: true });
    const started = Date.now();
    const d = await decide(bash('git push origin main'), opts);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d).toMatchObject({ verdict: 'allow', effectiveVerdict: 'escalate', stage: 'human', simulated: true });
    expect(d.approvalId).toBeUndefined();
    expect(d.reason).toMatch(/simulation/);
  });

  it('never simulates admin actions', () => {
    sim.setSimulationStateForTests({ enabled: true });
    expect(sim.isSimulated({ checkpoint: 'admin', agent: { surface: 'monitor' } as never })).toBe(false);
    expect(sim.isSimulated({ checkpoint: 'pre_tool', agent: { surface: 'monitor' } as never })).toBe(false);
    expect(sim.isSimulated({ checkpoint: 'pre_tool', agent: { surface: 'copilot-cli' } as never })).toBe(true);
  });

  it('persists the switch as a governance setting', async () => {
    const s = await sim.setSimulation(true, 'tester');
    expect(s).toMatchObject({ enabled: true, source: 'setting', updatedBy: 'tester' });
    sim.setSimulationStateForTests({ enabled: false });
    expect((await sim.refreshSimulation()).enabled).toBe(true);
    await sim.setSimulation(false, 'tester');
  });
});
