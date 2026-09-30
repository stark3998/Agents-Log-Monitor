import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Principal } from '../../src/governance/types';

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `fleet-routes-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

const viewer: Principal = { id: 'viewer', roles: ['Viewer'], kind: 'user' };
const fleet: Principal = { id: 'agentmon-fleet', roles: ['Agent'], kind: 'agent' };

type Db = typeof import('../../src/db');
let db: Db;
let server: http.Server;
let baseUrl: string;
let principal: Principal = viewer;

beforeAll(async () => {
  db = await import('../../src/db');
  await db.initDb();
  const { SqliteGovernanceStore } = await import('../../src/governance/store/sqlite');
  const { setGovernanceStore } = await import('../../src/governance/store');
  const store = new SqliteGovernanceStore();
  await store.init();
  setGovernanceStore(store);
  const fleetRouter = (await import('../../src/governance/routes/fleet')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.principal = principal; next(); });
  app.use('/api/gov', fleetRouter);
  server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
});

function alert(id: string, extra: Record<string, unknown> = {}) {
  return {
    alert_id: id, alert_type: 'BLOCKED_ACTION_WORKAROUND', severity: 'high', score: 82, title: 'Workaround',
    summary: 'agent retried a blocked e-mail through smtplib', detector: 'evasion_monitor', platform: 'foundry',
    agent_id: 'agentmon-it-helpdesk', agent_name: 'agentmon-it-helpdesk', session_id: 'conv-1',
    owasp_agentic: ['ASI10'], mitre_atlas: ['AML.T0107'], evidence: { signals: ['same_target_new_route'] },
    created_at: new Date().toISOString(), ...extra,
  };
}

async function post(b: unknown, as: Principal) {
  principal = as;
  return fetch(`${baseUrl}/api/gov/fleet/alerts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
}
async function getJson(p: string) {
  principal = viewer;
  const res = await fetch(`${baseUrl}${p}`);
  return { status: res.status, json: await res.json() as any };
}

describe('fleet alert routes', () => {
  it('rejects ingestion from viewers', async () => {
    expect((await post({ alerts: [alert('a0')] }, viewer)).status).toBe(403);
  });

  it('rejects malformed alerts', async () => {
    const res = await post({ alerts: [{ alert_id: 'x', severity: 'catastrophic' }] }, fleet);
    expect(res.status).toBe(400);
  });

  it('ingests idempotently and lists with filters', async () => {
    expect((await post({ alerts: [alert('a1'), alert('a2', { severity: 'medium', platform: 'copilot_studio', session_id: 'conv-2' })] }, fleet)).status).toBe(202);
    expect((await post({ alerts: [alert('a1', { incident_id: 'fleet-inc-1' })] }, fleet)).status).toBe(202);
    const all = await getJson('/api/gov/fleet/alerts');
    expect(all.json.map((a: any) => a.alert_id).sort()).toEqual(['a1', 'a2']);
    const high = await getJson('/api/gov/fleet/alerts?severity=high');
    expect(high.json).toHaveLength(1);
    expect(high.json[0].incident_id).toBe('fleet-inc-1');
    const bySession = await getJson('/api/gov/fleet/alerts?session=conv-2');
    expect(bySession.json[0].platform).toBe('copilot_studio');
    expect((await getJson('/api/gov/fleet/alerts/a2')).status).toBe(200);
    expect((await getJson('/api/gov/fleet/alerts/nope')).status).toBe(404);
  });

  it('summarizes', async () => {
    const s = await getJson('/api/gov/fleet/summary');
    expect(s.json.total).toBe(2);
    expect(s.json.byPlatform).toMatchObject({ foundry: 1, copilot_studio: 1 });
    expect(s.json.byOwaspAgentic.ASI10).toBe(2);
  });
});
