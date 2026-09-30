import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Principal } from '../../src/governance/types';

vi.mock('../../src/governance/judge', () => ({
  judge: { available: false, evaluate: vi.fn() },
  extractGoal: vi.fn(async () => null),
}));

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `harness-${process.pid}-${Date.now()}.db`);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
process.env.AGENT_MONITOR_DB = dbFile;
process.env.COPILOT_HOME = home;

const admin: Principal = { id: 'local-admin', roles: ['Viewer', 'Approver', 'PolicyAdmin', 'Agent'], kind: 'local' };
const viewer: Principal = { id: 'viewer', roles: ['Viewer'], kind: 'user' };
const agentAdmin: Principal = { id: 'bot', roles: ['PolicyAdmin', 'Agent'], kind: 'agent' };

type Db = typeof import('../../src/db');
let db: Db;
let server: http.Server;
let baseUrl: string;
let principal: Principal = admin;

beforeAll(async () => {
  db = await import('../../src/db');
  await db.initDb();
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { setGovernanceStore } = await import('../../src/governance/store');
  const store = new SqliteGovernanceStore();
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
  (await import('../../src/governance/simulation')).setSimulationStateForTests(null);
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.COPILOT_HOME;
});

async function call(method: string, p: string, body?: unknown, as: Principal = admin) {
  principal = as;
  const res = await fetch(`${baseUrl}${p}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}

describe('hook config builder', () => {
  it('matches install.ps1 for Copilot CLI and VS Code', async () => {
    const { buildHookConfig } = await import('../../src/governance/hooks/install');
    const cli = buildHookConfig('copilot-cli', { failMode: 'open', port: 4317, repoRoot: 'C:\\repo' }) as any;
    expect(cli.version).toBe(1);
    expect(Object.keys(cli.hooks)).toContain('preToolUse');
    const h = cli.hooks.preToolUse[0];
    expect(h.powershell).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join('C:\\repo', 'scripts', 'copilot-hook-forward.ps1')}" -Port 4317 -TimeoutSec 115 -Surface copilot-cli`);
    expect(h.bash).toMatch(/copilot-hook-forward\.sh' --port 4317 --timeout 115 --surface copilot-cli$/);
    expect(h).toMatchObject({ type: 'command', timeoutSec: 120, env: { AGENT_GOVERNANCE_FAIL_MODE: 'open', AGENT_GOVERNANCE_SURFACE: 'copilot-cli' } });
    const vs = buildHookConfig('vscode', { failMode: 'closed', port: 4400 }) as any;
    expect(vs.version).toBeUndefined();
    expect(vs.hooks.PreToolUse[0]).toMatchObject({ type: 'command', timeout: 120, env: { AGENT_GOVERNANCE_FAIL_MODE: 'closed', AGENT_GOVERNANCE_SURFACE: 'vscode' } });
    // Other hosts (the Copilot CLI agent host) run `command` and fail closed if it errors: it must suit this OS.
    expect(vs.hooks.PreToolUse[0].command).toBe(process.platform === 'win32' ? vs.hooks.PreToolUse[0].windows : vs.hooks.PreToolUse[0].linux);
    expect(vs.hooks.PreToolUse[0].windows).toMatch(/^powershell .*copilot-hook-forward\.ps1" -Port 4400 /);
    expect(vs.hooks.PreToolUse[0].osx).toMatch(/^sh '.*copilot-hook-forward\.sh' --port 4400 /);
    expect(vs.hooks.Stop[0].timeout).toBe(5);
  });
});

describe('test harness routes', () => {
  it('reports status without touching anything', async () => {
    const r = await call('GET', '/api/gov/hooks/copilot', undefined, viewer);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ mode: 'local', available: true, copilotHome: home, simulation: { enabled: false } });
    expect(r.json.targets.map((t: any) => [t.target, t.installed])).toEqual([['copilot-cli', false], ['vscode', false]]);
    expect(fs.existsSync(path.join(home, 'hooks'))).toBe(false);
  });

  it('only lets non-agent PolicyAdmins change things', async () => {
    expect((await call('POST', '/api/gov/hooks/copilot/install', {}, viewer)).status).toBe(403);
    expect((await call('POST', '/api/gov/hooks/copilot/install', {}, agentAdmin)).status).toBe(403);
    expect((await call('PUT', '/api/gov/simulation', { enabled: true }, agentAdmin)).status).toBe(403);
    expect((await call('POST', '/api/gov/hooks/copilot/install', { targets: ['claude'] })).status).toBe(400);
    expect(fs.existsSync(path.join(home, 'hooks'))).toBe(false);
  });

  it('installs with simulation on, then uninstalls', async () => {
    const r = await call('POST', '/api/gov/hooks/copilot/install', { targets: ['copilot-cli'], failMode: 'open', simulate: true });
    expect(r.status).toBe(200);
    expect(r.json.simulation.enabled).toBe(true);
    const cli = r.json.targets.find((t: any) => t.target === 'copilot-cli');
    expect(cli).toMatchObject({ installed: true, managed: true, failMode: 'open' });
    const file = path.join(home, 'hooks', 'agent-governance.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.preToolUse).toHaveLength(1);
    expect(r.json.targets.find((t: any) => t.target === 'vscode').installed).toBe(false);

    const sim = await call('GET', '/api/gov/simulation', undefined, viewer);
    expect(sim.json).toMatchObject({ enabled: true, source: 'setting', updatedBy: 'local-admin' });

    fs.writeFileSync(path.join(home, 'hooks', 'someone-else.json'), '{}');
    const u = await call('POST', '/api/gov/hooks/copilot/uninstall', {});
    expect(u.status).toBe(200);
    expect(u.json.targets.every((t: any) => !t.installed)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(home, 'hooks', 'someone-else.json'))).toBe(true);
  });

  it('toggles simulation and audits every change', async () => {
    expect((await call('PUT', '/api/gov/simulation', { enabled: 'yes' })).status).toBe(400);
    const off = await call('PUT', '/api/gov/simulation', { enabled: false });
    expect(off.json).toMatchObject({ enabled: false, enforcementEnabled: true });
    const { govStore } = await import('../../src/governance/store');
    const page = await govStore().queryDecisions({ limit: 50 });
    const tools = page.items.filter(d => d.checkpoint === 'admin').map(d => d.toolName);
    expect(tools).toEqual(expect.arrayContaining(['copilot_hooks_install', 'copilot_hooks_uninstall', 'governance_simulation']));
    expect(page.items.every(d => !d.simulated)).toBe(true);
  });
});
