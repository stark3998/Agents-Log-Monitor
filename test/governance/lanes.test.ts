import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `lanes-${process.pid}-${Date.now()}.db`);
const lanesDir = path.join(dir, `lanes-${process.pid}-${Date.now()}`);
fs.mkdirSync(lanesDir, { recursive: true });
process.env.AGENT_MONITOR_DB = dbFile;
process.env.GOVERNANCE_LANES_DIR = lanesDir;

type Db = typeof import('../../src/db');
let db: Db;
let storeMod: typeof import('../../src/governance/store');
let sqliteMod: typeof import('../../src/governance/store/sqlite');
let loader: typeof import('../../src/governance/lanes/loader');
let engine: typeof import('../../src/governance/lanes/engine');
let features: typeof import('../../src/governance/features');
let simulator: typeof import('../../src/governance/lanes/simulate');
let registryMod: typeof import('../../src/governance/registry');

beforeAll(async () => {
  db = await import('../../src/db');
  storeMod = await import('../../src/governance/store');
  sqliteMod = await import('../../src/governance/store/sqlite');
  loader = await import('../../src/governance/lanes/loader');
  engine = await import('../../src/governance/lanes/engine');
  features = await import('../../src/governance/features');
  simulator = await import('../../src/governance/lanes/simulate');
  registryMod = await import('../../src/governance/registry');
  await db.initDb();
  const s = new sqliteMod.SqliteGovernanceStore();
  await s.init();
  storeMod.setGovernanceStore(s);
});

afterAll(() => {
  db.flushDb();
  fs.rmSync(lanesDir, { recursive: true, force: true });
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch {} }
});

describe('lane YAML and rule engine', () => {
  it('fills defaults, leaves path macros for evaluation, and rejects invalid YAML', () => {
    const ok = loader.validateLaneYaml(`id: test\npurpose: Test lane\nappliesTo: { surfaces: ['*'] }\nrules:\n  deny:\n    - id: creds\n      path: ['~/.aws/**']\n`);
    expect(ok.ok).toBe(true);
    expect(ok.lane?.mode).toBe('observe');
    expect(ok.lane?.rules.deny?.[0].path?.[0]).toBe('~/.aws/**');
    const bad = loader.validateLaneYaml('id: 123\npurpose:');
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it('matches risk levels, canonical tools, private hosts and credential paths', () => {
    const lane = loader.parseLaneYaml(`id: eval\npurpose: Eval\nrules:\n  deny:\n    - id: meta\n      domain: ['169.254.169.254']\n    - id: readcreds\n      path: ['~/.aws/**']\n    - id: highrisk\n      risk: [high]\n  allow:\n    - id: search\n      tool: [Grep]\n`);
    const req = { requestId: '1', sessionId: 's', checkpoint: 'pre_tool' as const, agent: { surface: 'sdk' as const }, toolName: 'powershell', args: { command: 'curl http://169.254.169.254/latest/meta-data' } };
    const ev = engine.laneEngine.evaluate(lane, req, features.extractFeatures(req), { tainted: false, workspace: process.cwd() });
    expect(ev.deny?.ruleId).toBe('meta');
    const readReq = { ...req, toolName: 'read', category: 'READ' as const, args: { path: '~/.aws/credentials' } };
    expect(engine.laneEngine.evaluate(lane, readReq, features.extractFeatures(readReq), { tainted: false }).deny?.ruleId).toBe('readcreds');
    const grepReq = { ...req, toolName: 'rg', args: { command: '' } };
    expect(engine.laneEngine.evaluate(lane, grepReq, features.extractFeatures(grepReq), { tainted: false }).allow[0]?.ruleId).toBe('search');
  });

  it('expands lane path macros at evaluation time with Windows-aware matching', () => {
    const oldUserProfile = process.env.USERPROFILE;
    const oldHome = process.env.HOME;
    process.env.USERPROFILE = 'C:\\Users\\Alice';
    process.env.HOME = 'C:\\Users\\Alice';
    try {
      const lane = loader.parseLaneYaml(`id: eval-paths\npurpose: Eval paths\nrules:\n  deny:\n    - id: ssh\n      path: ['~/.ssh/**']\n  allow:\n    - id: workspace\n      category: [READ]\n      path: ['\${workspace}/**']\n`);
      expect(lane.rules.deny?.[0].path?.[0]).toBe('~/.ssh/**');
      const req = { requestId: '2', sessionId: 's', checkpoint: 'pre_tool' as const, agent: { surface: 'sdk' as const, cwd: 'C:\\Repo\\App' }, toolName: 'read', category: 'READ' as const, args: { path: 'c:\\users\\alice\\.ssh\\id_rsa' } };
      expect(engine.laneEngine.evaluate(lane, req, features.extractFeatures(req), { tainted: false, workspace: req.agent.cwd }).deny?.ruleId).toBe('ssh');
      const workspaceReq = { ...req, args: { path: 'c:\\repo\\app\\src\\index.ts' } };
      expect(engine.laneEngine.evaluate(lane, workspaceReq, features.extractFeatures(workspaceReq), { tainted: false, workspace: req.agent.cwd }).allow[0]?.ruleId).toBe('workspace');
    } finally {
      if (oldUserProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldUserProfile;
      if (oldHome == null) delete process.env.HOME; else process.env.HOME = oldHome;
    }
  });

  it('rejects invalid command regexes and skips invalid runtime rules without throwing', () => {
    const bad = loader.validateLaneYaml(`id: bad-regex\npurpose: Bad regex\nrules:\n  deny:\n    - id: broken\n      command: ['[unterminated']\n`);
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toContain('invalid command regex');

    const lane = { ...engine.BUILTIN_DEFAULT_LANE, id: 'runtime-regex', rules: { deny: [{ id: 'broken', command: ['[unterminated'] }], allow: [{ id: 'exec', command: ['echo'] }] } };
    const req = { requestId: '3', sessionId: 's', checkpoint: 'pre_tool' as const, agent: { surface: 'sdk' as const }, toolName: 'Bash', args: { command: 'echo hi' } };
    expect(() => engine.laneEngine.evaluate(lane, req, features.extractFeatures(req), { tainted: false })).not.toThrow();
    expect(engine.laneEngine.evaluate(lane, req, features.extractFeatures(req), { tainted: false }).allow[0]?.ruleId).toBe('exec');
  });

  it('simulates default verdicts and workspace allow rules using session workspace', async () => {
    const workspace = 'C:\\Work\\Repo';
    const sessionId = `sim-${Date.now()}`;
    db.run('INSERT INTO sessions (id, source, project_path, started_at) VALUES (?, ?, ?, ?)', [sessionId, 'test', workspace, new Date().toISOString()]);
    db.run('INSERT INTO events (session_id, agent_id, event_type, tool_name, category, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sessionId, 'agent', 'tool', 'read', 'READ', JSON.stringify({ path: 'c:\\work\\repo\\src\\file.ts' }), new Date().toISOString()]);

    const denyLane = loader.parseLaneYaml('id: deny-default\npurpose: deny\nrules: {}\ndefaultVerdict: deny\n');
    const denied = await simulator.simulateLane(denyLane, { agentId: 'agent', limit: 1 });
    expect(denied.wouldDeny).toBe(1);
    expect(denied.wouldAllow).toBe(0);

    const allowLane = loader.parseLaneYaml(`id: allow-workspace\npurpose: allow\nrules:\n  allow:\n    - id: in-workspace\n      category: [READ]\n      path: ['\${workspace}/**']\ndefaultVerdict: deny\n`);
    const allowed = await simulator.simulateLane(allowLane, { agentId: 'agent', limit: 1 });
    expect(allowed.wouldAllow).toBe(1);
    expect(allowed.wouldDeny).toBe(0);
  });

  it('does not collapse placeholder external ids across users or endpoints', async () => {
    const a = await registryMod.registry.identify({ surface: 'claude-code', externalId: 'main', user: 'alice', endpoint: 'laptop-a' });
    const b = await registryMod.registry.identify({ surface: 'claude-code', externalId: 'main', user: 'bob', endpoint: 'laptop-b' });
    const again = await registryMod.registry.identify({ surface: 'claude-code', externalId: 'main', user: 'alice', endpoint: 'laptop-a' });
    expect(a.id).not.toBe(b.id);
    expect(again.id).toBe(a.id);

    const hinted = await registryMod.registry.identify({ surface: 'claude-code', agentId: 'explicit-agent-id', externalId: 'main', user: 'carol', endpoint: 'laptop-c' });
    expect(hinted.id).toBe('explicit-agent-id');
  });

  it('bootstraps new lane files as active but proposes later file changes unless auto-activation is enabled', async () => {
    const oldAuto = process.env.GOVERNANCE_LANES_AUTO_ACTIVATE;
    process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = 'false';
    const laneId = `file-sync-${Date.now()}`;
    const laneFile = path.join(lanesDir, `${laneId}.yaml`);
    try {
      fs.writeFileSync(laneFile, `id: ${laneId}\nversion: 1\npurpose: Bootstrap lane\nrules: {}\n`);
      let saved = await loader.syncLaneFilesOnce();
      expect(saved.find(r => r.lane.id === laneId)?.status).toBe('active');
      expect((await storeMod.govStore().getLane(laneId))?.lane.purpose).toBe('Bootstrap lane');

      fs.writeFileSync(laneFile, `id: ${laneId}\nversion: 1\npurpose: Proposed lane\nrules: {}\n`);
      saved = await loader.syncLaneFilesOnce();
      expect(saved.find(r => r.lane.id === laneId)?.status).toBe('proposed');
      expect((await storeMod.govStore().getLane(laneId))?.lane.purpose).toBe('Bootstrap lane');

      process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = 'true';
      fs.writeFileSync(laneFile, `id: ${laneId}\nversion: 1\npurpose: Auto-activated lane\nrules: {}\n`);
      saved = await loader.syncLaneFilesOnce();
      expect(saved.find(r => r.lane.id === laneId)?.status).toBe('active');
      expect((await storeMod.govStore().getLane(laneId))?.lane.purpose).toBe('Auto-activated lane');
    } finally {
      if (oldAuto == null) delete process.env.GOVERNANCE_LANES_AUTO_ACTIVATE; else process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = oldAuto;
      fs.rmSync(laneFile, { force: true });
    }
  });
});
