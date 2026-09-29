import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Principal } from '../../src/governance/types';

const artifactDir = path.join(process.cwd(), '.test-artifacts');
fs.mkdirSync(artifactDir, { recursive: true });
const dbFile = path.join(artifactDir, `mcp-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;

type Db = typeof import('../../src/db');
type Store = typeof import('../../src/governance/store');
type StoreSqlite = typeof import('../../src/governance/store/sqlite');
type TelemetrySqlite = typeof import('../../src/governance/telemetry-sqlite');
type Mcp = typeof import('../../src/governance/mcp/server');
type Pdp = typeof import('../../src/governance/pdp');

let db: Db;
let storeMod: Store;
let storeSqlite: StoreSqlite;
let telemetrySqlite: TelemetrySqlite;
let mcp: Mcp;
let pdp: Pdp;

const viewer: Principal = { id: 'viewer', name: 'Viewer', roles: ['Viewer'], kind: 'user' };
const admin: Principal = { id: 'admin', name: 'Admin', roles: ['Viewer', 'Approver', 'PolicyAdmin'], kind: 'user' };
const approver: Principal = { id: 'approver', name: 'Approver', roles: ['Approver'], kind: 'user' };
const agent: Principal = { id: 'agent-principal', name: 'Agent', roles: ['Agent'], kind: 'agent' };
const guardian: Principal = { id: 'guardian-agent', name: 'Guardian', roles: ['Agent'], kind: 'agent' };

async function connect(principal: Principal): Promise<{ client: Client; server: McpServer; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = mcp.createMcpServer(principal);
  const client = new Client({ name: 'mcp-test', version: '0.1.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    server,
    close: async () => {
      await Promise.race([client.close(), new Promise<void>(resolve => setTimeout(resolve, 100))]);
      await Promise.race([server.close(), new Promise<void>(resolve => setTimeout(resolve, 100))]);
    },
  };
}

function parsed(result: unknown): any {
  const content = (result as any).content;
  return JSON.parse(content[0].text);
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 8, 29, 12, 0, second)).toISOString();
}

function mockAdminDecision(verdict: 'allow' | 'deny' = 'allow', reason = 'allowed') {
  return vi.spyOn(pdp, 'decide').mockResolvedValue({
    id: `${verdict}-admin`,
    requestId: 'r',
    sessionId: 'mcp:test',
    agentId: 'test',
    laneId: 'default',
    laneVersion: 1,
    mode: 'enforce',
    checkpoint: 'admin',
    toolName: 'admin',
    verdict,
    effectiveVerdict: verdict,
    wouldDeny: verdict === 'deny',
    stage: verdict === 'deny' ? 'rules_deny' : 'rules_allow',
    reason,
    ruleIds: [],
    tainted: false,
    latencyMs: 1,
    createdAt: at(9),
  });
}

beforeAll(async () => {
  process.env.GOVERNANCE_GUARDIAN_PRINCIPALS = guardian.id;
  db = await import('../../src/db');
  storeMod = await import('../../src/governance/store');
  storeSqlite = await import('../../src/governance/store/sqlite');
  telemetrySqlite = await import('../../src/governance/telemetry-sqlite');
  mcp = await import('../../src/governance/mcp/server');
  pdp = await import('../../src/governance/pdp');
  await db.initDb();
  const sqliteStore = new storeSqlite.SqliteGovernanceStore();
  await sqliteStore.init();
  storeMod.setGovernanceStore(sqliteStore);
  telemetrySqlite.initSqliteTelemetry();

  db.run(
    `INSERT INTO sessions (id, source, agent_key, title, started_at, last_activity_at, user, endpoint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ['s-mcp', 'copilot-cli', 'copilot-cli', 'MCP test session', at(0), at(5), 'dev@contoso.com', 'localhost'],
  );
  db.run(
    `INSERT INTO events (session_id, agent_id, event_type, raw_event_name, tool_name, status, payload, created_at, capture_channel, category, risk_level)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['s-mcp', 'main', 'tool_call', 'PreToolUse', 'powershell', 'pending', JSON.stringify({ tool_input: { command: 'Remove-Item guarded.txt' } }), at(1), 'log', 'EXEC', 'high'],
  );
  db.run(
    `INSERT INTO findings (event_id, session_id, kind, key, label, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [1, 's-mcp', 'policy', 'denied', 'Policy denied', 'high', at(1)],
  );

  const store = storeMod.govStore();
  await store.upsertAgent({
    id: 'agent-1', name: 'Copilot CLI', surface: 'copilot-cli', externalId: 'copilot-cli',
    status: 'active', discovered: true, firstSeenAt: at(0), lastSeenAt: at(5),
  });
  await store.saveLane({
    lane: { id: 'default', version: 1, purpose: 'default lane', dos: [], never: [], appliesTo: { surfaces: ['*'], agents: ['*'] }, rules: {}, mode: 'observe', failMode: { default: 'closed' }, approval: { channels: ['dashboard'], timeoutSec: 120 }, judge: { escalateBelow: 0.7, dataPolicy: 'redacted' } },
    status: 'active', updatedAt: at(0), updatedBy: 'test',
  });
  await store.appendDecision({
    id: 'decision-1', requestId: 'req-1', sessionId: 's-mcp', agentId: 'agent-1', laneId: 'default', laneVersion: 1,
    mode: 'enforce', checkpoint: 'pre_tool', toolName: 'powershell', category: 'EXEC', verdict: 'deny', effectiveVerdict: 'deny',
    wouldDeny: false, stage: 'rules_deny', reason: 'dangerous command', ruleIds: ['deny-exec'], riskLevel: 'high',
    tainted: false, latencyMs: 1, createdAt: at(2),
  });
  await store.createApproval({
    id: 'approval-1', requestId: 'req-2', sessionId: 's-mcp', agentId: 'agent-1', laneId: 'default', toolName: 'deploy',
    summary: 'Deploy to production', reason: 'approval rule matched', channels: ['dashboard'], state: 'pending',
    requestedAt: at(3), expiresAt: at(60),
  });
}, 30000);

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.restoreAllMocks();
  db.flushDb();
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  try { fs.rmdirSync(artifactDir); } catch { /* not empty */ }
});

describe('governance MCP server', () => {
  it('lists the contract tools', async () => {
    const { client, close } = await connect(admin);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map(t => t.name);
      expect(names).toEqual(expect.arrayContaining([
        'list_agents', 'get_agent', 'list_sessions', 'get_session_timeline', 'search_actions',
        'list_decisions', 'get_decision', 'list_blocked_actions', 'list_pending_approvals',
        'list_incidents', 'get_incident', 'list_lanes', 'get_lane', 'simulate_lane',
        'verify_audit_chain', 'get_overview_stats', 'approve_action', 'deny_action',
        'pause_agent', 'resume_agent', 'quarantine_session', 'propose_lane_change',
        'create_incident', 'update_incident', 'acknowledge_incident',
      ]));
    } finally {
      await close();
    }
  });

  it('reads decisions, actions and pending approvals', async () => {
    const { client, close } = await connect(admin);
    try {
      expect(parsed(await client.callTool({ name: 'list_decisions', arguments: { sessionId: 's-mcp' } })).items[0].id).toBe('decision-1');
      expect(parsed(await client.callTool({ name: 'search_actions', arguments: { text: 'Remove-Item' } })).items[0].toolName).toBe('powershell');
      expect(parsed(await client.callTool({ name: 'list_pending_approvals', arguments: {} })).items[0].id).toBe('approval-1');
    } finally {
      await close();
    }
  });

  it('prevents a Viewer from approving actions', async () => {
    vi.spyOn(pdp, 'decide').mockResolvedValueOnce({
      id: 'allow-admin', requestId: 'r', sessionId: 'admin:viewer', agentId: 'viewer', laneId: 'default', laneVersion: 1,
      mode: 'enforce', checkpoint: 'admin', toolName: 'approve_action', verdict: 'allow', effectiveVerdict: 'allow',
      wouldDeny: false, stage: 'rules_allow', reason: 'allowed', ruleIds: [], tainted: false,
      latencyMs: 1, createdAt: at(8),
    });
    const { client, close } = await connect(viewer);
    try {
      const result = await client.callTool({ name: 'approve_action', arguments: { approvalId: 'approval-1', note: 'ok' } });
      expect((result as any).isError).toBe(true);
      expect((result as any).content[0].text).toContain('requires role');
    } finally {
      await close();
    }
  });

  it('gates admin writes with the PDP deny verdict', async () => {
    vi.spyOn(pdp, 'decide').mockResolvedValueOnce({
      id: 'deny-admin', requestId: 'r', sessionId: 'admin:admin', agentId: 'admin', laneId: 'default', laneVersion: 1,
      mode: 'enforce', checkpoint: 'admin', toolName: 'pause_agent', verdict: 'deny', effectiveVerdict: 'deny',
      wouldDeny: false, stage: 'rules_deny', reason: 'admin action blocked', ruleIds: [], tainted: false,
      latencyMs: 1, createdAt: at(9),
    });
    const { client, close } = await connect(admin);
    try {
      const result = await client.callTool({ name: 'pause_agent', arguments: { agentId: 'agent-1', reason: 'test' } });
      expect((result as any).isError).toBe(true);
      expect((result as any).content[0].text).toContain('admin action blocked');
      expect((await storeMod.govStore().getAgent('agent-1'))?.status).toBe('active');
    } finally {
      await close();
    }
  });

  it('proposes a lane change without activating it', async () => {
    const { client, close } = await connect(viewer);
    try {
      const result = parsed(await client.callTool({
        name: 'propose_lane_change',
        arguments: { lane: { id: 'reviewer', purpose: 'review code changes' }, rationale: 'suggested by test' },
      }));
      expect(result.status).toBe('proposed');
      expect(result.lane.id).toBe('reviewer');
      expect(await storeMod.govStore().getLane('reviewer')).toBeUndefined();
      expect((await storeMod.govStore().listLaneVersions('reviewer'))[0].status).toBe('proposed');
    } finally {
      await close();
    }
  });

  it('enforces the MCP write role matrix before the PDP gate', async () => {
    const spy = mockAdminDecision('allow');

    const { client: agentClient, close: closeAgent } = await connect(agent);
    try {
      const pause = await agentClient.callTool({ name: 'pause_agent', arguments: { agentId: 'agent-1' } });
      const resume = await agentClient.callTool({ name: 'resume_agent', arguments: { agentId: 'agent-1' } });
      expect((pause as any).isError).toBe(true);
      expect((resume as any).isError).toBe(true);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await closeAgent();
    }

    const { client: guardianClient, close: closeGuardian } = await connect(guardian);
    try {
      const pause = await guardianClient.callTool({ name: 'pause_agent', arguments: { agentId: 'agent-1', reason: 'contain' } });
      expect((pause as any).isError).toBeFalsy();
      const resume = await guardianClient.callTool({ name: 'resume_agent', arguments: { agentId: 'agent-1' } });
      expect((resume as any).isError).toBe(true);
      expect((resume as any).content[0].text).toContain('PolicyAdmin');
    } finally {
      await closeGuardian();
    }

    const { client: approverClient, close: closeApprover } = await connect(approver);
    try {
      await storeMod.govStore().createApproval({
        id: 'approval-role-matrix', requestId: 'req-role', sessionId: 's-mcp', agentId: 'agent-1', laneId: 'default',
        toolName: 'deploy', summary: 'role matrix', reason: 'test', channels: ['dashboard'], state: 'pending',
        requestedAt: at(20), expiresAt: at(60),
      });
      const approved = await approverClient.callTool({ name: 'approve_action', arguments: { approvalId: 'approval-role-matrix' } });
      expect((approved as any).isError).toBeFalsy();
    } finally {
      await closeApprover();
    }
  });

  it('does not let tool arguments choose the PDP admin session id', async () => {
    const spy = mockAdminDecision('allow');
    const { client, close } = await connect(admin);
    try {
      await client.callTool({ name: 'quarantine_session', arguments: { sessionId: 'caller-controlled-session', reason: 'test' } });
      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0][0].sessionId).toBe('mcp:admin');
    } finally {
      await close();
    }
  });

  it('rejects monitor Guardian lane proposals for non-admins', async () => {
    const spy = mockAdminDecision('allow');
    const { client, close } = await connect(viewer);
    try {
      const result = await client.callTool({
        name: 'propose_lane_change',
        arguments: { lane: { id: 'monitor-guardian', purpose: 'monitor guard' } },
      });
      expect((result as any).isError).toBe(true);
      expect((result as any).content[0].text).toContain('monitor Guardian');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('rate limits lane proposals per principal', async () => {
    mockAdminDecision('allow');
    const rateLimited: Principal = { id: 'rate-limited-viewer', name: 'Rate Limited', roles: ['Viewer'], kind: 'user' };
    const { client, close } = await connect(rateLimited);
    try {
      for (let i = 0; i < 10; i++) {
        const result = await client.callTool({
          name: 'propose_lane_change',
          arguments: { lane: { id: `rate-${i}`, purpose: `rate ${i}` } },
        });
        expect((result as any).isError).toBeFalsy();
      }
      const limited = await client.callTool({
        name: 'propose_lane_change',
        arguments: { lane: { id: 'rate-10', purpose: 'rate 10' } },
      });
      expect((limited as any).isError).toBe(true);
      expect((limited as any).content[0].text).toContain('rate limit');
    } finally {
      await close();
    }
  });
});
