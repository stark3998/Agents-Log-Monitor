import express from 'express';
import fs from 'fs';
import http, { type Server } from 'http';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const root = process.cwd();
const tempRoot = path.join(root, 'test', 'e2e', '.tmp', `server-${process.pid}-${Date.now()}`);
const lanesDir = path.join(tempRoot, 'lanes');
const dbFile = path.join(tempRoot, 'agent-monitor.db');

fs.mkdirSync(lanesDir, { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'lanes')).filter(f => /\.ya?ml$/i.test(f))) {
  fs.copyFileSync(path.join(root, 'lanes', name), path.join(lanesDir, name));
}

process.env.AGENT_MONITOR_DB = dbFile;
process.env.GOVERNANCE_LANES_DIR = lanesDir;
process.env.GOVERNANCE_POLICIES_DIR = path.join(tempRoot, 'policies');
process.env.POSTURE_SCAN_INTERVAL_MIN = '0';
process.env.GOVERNANCE_ENFORCE = 'true';
process.env.GOVERNANCE_TRUST_LOOPBACK = 'true';
process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = 'false';
process.env.AGENT_MONITOR_MODE = 'local';
process.env.COPILOT_CLI_ENABLED = 'false';
process.env.FOUNDRY_OPENAI_ENDPOINT = '';
process.env.AZURE_OPENAI_ENDPOINT = '';
process.env.CONTENT_SAFETY_ENDPOINT = '';
process.env.GOVERNANCE_CONTROL_PLANE_URL = '';
process.env.HOOK_DEADLINE_MS = '3000';
process.env.GOVERNANCE_LOCAL_ADMIN_TOKEN = 'e2e-local-admin-token';

type DbModule = typeof import('../../src/db');

let db: DbModule;
let server: Server;
let baseUrl: string;
let adminCookie = '';
let syncLaneFilesOnce: typeof import('../../src/governance/lanes/loader').syncLaneFilesOnce;

const codingLaneFile = path.join(lanesDir, 'coding-agent.yaml');
const originalCodingYaml = fs.readFileSync(codingLaneFile, 'utf8');
const enforceCodingYaml = originalCodingYaml.replace(/^mode:\s*observe$/m, 'mode: enforce');
const enforceCodingYamlWithFileChange = enforceCodingYaml.replace(
  'dos:\n  - Read and edit source files in the workspace.',
  'dos:\n  - E2E file sync changed lane content.\n  - Read and edit source files in the workspace.',
);

function listen(s: Server): Promise<void> {
  return new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
}

async function json<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(adminCookie ? { cookie: adminCookie } : {}), ...(init?.headers ?? {}) },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}: ${body}`);
  return body ? JSON.parse(body) as T : {} as T;
}

function claudePreTool(sessionId: string, toolName: string, toolInput: unknown, id: string) {
  return json<Record<string, unknown>>('/hooks/claude-code', {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      agent_id: 'main',
      cwd: root,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: id,
    }),
  });
}

function claudeDecision(response: Record<string, unknown>): { permissionDecision?: string; permissionDecisionReason?: string } {
  return response.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string };
}

async function activateLane(yaml: string) {
  return json<{ lane: { id: string; version: number }; updatedBy?: string }>('/api/gov/lanes', {
    method: 'POST',
    body: JSON.stringify({ yaml, status: 'active' }),
  });
}

async function decide(body: Record<string, unknown>) {
  return json<Record<string, unknown>>('/v1/decide', { method: 'POST', body: JSON.stringify(body) });
}

beforeAll(async () => {
  db = await import('../../src/db');
  const { initGovernance } = await import('../../src/governance');
  const broadcast = await import('../../src/broadcast');
  ({ syncLaneFilesOnce } = await import('../../src/governance/lanes/loader'));

  await db.initDb();
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  await initGovernance(app);
  server = http.createServer(app);
  broadcast.attachWebSocket(server);
  await listen(server);
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind to an ephemeral port');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  const { adminLoginUrl } = await import('../../src/governance/local-admin');
  const login = await fetch(adminLoginUrl(addr.port), { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie') ?? '';
  adminCookie = setCookie.split(';')[0];
  if (!adminCookie) throw new Error('local admin login did not set a session cookie');
  await syncLaneFilesOnce();
});

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()));
  fs.rmSync(lanesDir, { recursive: true, force: true });
  await new Promise(resolve => setTimeout(resolve, 50));
  db?.flushDb();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('governance server e2e', () => {
  it('serves auth config in local mode', async () => {
    await expect(json('/api/gov/auth-config')).resolves.toMatchObject({ mode: 'local' });
  });

  it('returns no-opinion for default observe-mode Claude Code hooks while recording would-deny decisions', async () => {
    const out = await claudePreTool('s-observe', 'Read', { file_path: 'C:\\Users\\x\\.aws\\credentials' }, 'obs-cred');
    expect(out).toEqual({});

    const decisions = await json<{ items: Array<{ wouldDeny: boolean; effectiveVerdict: string }> }>('/api/gov/decisions?sessionId=s-observe&limit=5');
    expect(decisions.items[0]).toMatchObject({ wouldDeny: true, effectiveVerdict: 'deny' });
  });

  it('enforces coding-agent denials, benign commands, and native ask decisions', async () => {
    await activateLane(enforceCodingYaml);

    const cred = claudeDecision(await claudePreTool('s-enforce', 'Read', { file_path: 'C:\\Users\\x\\.aws\\credentials' }, 'enforce-cred'));
    expect(cred.permissionDecision).toBe('deny');

    const metadata = claudeDecision(await claudePreTool('s-enforce', 'Bash', { command: 'curl http://169.254.169.254/latest/meta-data' }, 'enforce-meta'));
    expect(metadata.permissionDecision).toBe('deny');

    const test = await claudePreTool('s-enforce', 'Bash', { command: 'npm test' }, 'enforce-test');
    expect(test).toEqual({});

    const push = claudeDecision(await claudePreTool('s-enforce', 'Bash', { command: 'git push --force origin HEAD' }, 'enforce-push'));
    expect(push.permissionDecision).toBe('ask');
  });

  it('keeps API lane precedence until lane file content changes', async () => {
    const api = await activateLane(enforceCodingYaml);

    fs.writeFileSync(codingLaneFile, originalCodingYaml);
    await syncLaneFilesOnce();
    const activeAfterTouch = await json<{ lane: { version: number }; updatedBy?: string }>('/api/gov/lanes/coding-agent');
    expect(activeAfterTouch.lane.version).toBe(api.lane.version);
    expect(activeAfterTouch.updatedBy).not.toBe('file-sync');

    const oldAuto = process.env.GOVERNANCE_LANES_AUTO_ACTIVATE;
    process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = 'true';
    try {
      fs.writeFileSync(codingLaneFile, enforceCodingYamlWithFileChange);
      await syncLaneFilesOnce();
      const activeAfterChange = await json<{ lane: { version: number; dos: string[] }; updatedBy?: string }>('/api/gov/lanes/coding-agent');
      expect(activeAfterChange.updatedBy).toBe('file-sync');
      expect(activeAfterChange.lane.version).toBeGreaterThan(api.lane.version);
      expect(activeAfterChange.lane.dos).toContain('E2E file sync changed lane content.');
    } finally {
      if (oldAuto == null) delete process.env.GOVERNANCE_LANES_AUTO_ACTIVATE; else process.env.GOVERNANCE_LANES_AUTO_ACTIVATE = oldAuto;
    }
  });

  it('denies Copilot CLI camelCase hooks with JSON-string toolArgs', async () => {
    const out = await json<{ permissionDecision: string }>('/hooks/copilot-cli', {
      method: 'POST',
      body: JSON.stringify({
        hookEventName: 'preToolUse',
        sessionId: 's-copilot',
        agentId: 'copilot-cli',
        cwd: root,
        toolName: 'powershell',
        toolArgs: '{"command":"Invoke-WebRequest http://169.254.169.254/latest/meta-data"}',
      }),
    });
    expect(out.permissionDecision).toBe('deny');
  });

  it('supports non-blocking approvals, approval resolution, and blocking approval fail-closed timeouts', async () => {
    const approvalLane = `id: support-approval
version: 1
priority: 500
mode: enforce+approval
purpose: Support bot refund approvals
appliesTo: { surfaces: [sdk], agents: ['support-bot'] }
rules: { approve: [{ id: refund, tool: [issue_refund] }], deny: [], allow: [], judge: [] }
defaultVerdict: allow
failMode: { default: closed }
approval: { channels: [dashboard], timeoutSec: 1 }
`;
    await activateLane(approvalLane);
    const agent = { surface: 'sdk', externalId: 'support-bot', name: 'Support bot' };

    const escalated = await decide({
      requestId: 'refund-1',
      sessionId: 's-approval',
      checkpoint: 'pre_tool',
      agent,
      toolName: 'issue_refund',
      args: { orderId: '42' },
      options: { blocking: false, supportsAsk: false },
    });
    expect(escalated).toMatchObject({ verdict: 'escalate' });
    expect(escalated.approvalId).toEqual(expect.any(String));

    const pending = await json<Array<{ id: string; state: string }>>('/api/gov/approvals?state=pending');
    expect(pending.some(a => a.id === escalated.approvalId)).toBe(true);
    await json(`/api/gov/approvals/${escalated.approvalId}/approve`, { method: 'POST', body: JSON.stringify({ note: 'ok' }) });
    await expect(json(`/v1/approvals/${escalated.approvalId}`)).resolves.toMatchObject({ state: 'approved' });

    const timedOut = await decide({
      requestId: 'refund-timeout',
      sessionId: 's-approval-timeout',
      checkpoint: 'pre_tool',
      agent,
      toolName: 'issue_refund',
      args: { orderId: '43' },
      options: { blocking: true, supportsAsk: false, deadlineMs: 1500 },
    });
    expect(timedOut).toMatchObject({ verdict: 'deny', stage: 'fail_mode' });
  });

  it('returns null intent for sessions without governance state', async () => {
    expect(await json('/api/gov/sessions/s-ungoverned/intent')).toBeNull();
  });

  it('applies the session kill switch without prior intent', async () => {
    await json('/api/gov/sessions/s-paused/pause', { method: 'POST', body: JSON.stringify({ reason: 'e2e' }) });
    const out = claudeDecision(await claudePreTool('s-paused', 'Bash', { command: 'npm test' }, 'paused-test'));
    expect(out.permissionDecision).toBe('deny');
    const decisions = await json<{ items: Array<{ stage: string }> }>('/api/gov/decisions?sessionId=s-paused&limit=1');
    expect(decisions.items[0].stage).toBe('kill_switch');
  });

  it('serves MCP over Streamable HTTP for read and governed approval tools', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'e2e-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer e2e-local-admin-token' } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(t => t.name)).toContain('list_blocked_actions');

      const blocked = await client.callTool({ name: 'list_blocked_actions', arguments: { limit: 50 } });
      const blockedItems = blocked.structuredContent?.items as Array<{ effectiveVerdict: string }> | undefined;
      expect(blockedItems?.some(d => d.effectiveVerdict === 'deny')).toBe(true);

      const pendingDecision = await decide({
        requestId: 'mcp-approval',
        sessionId: 's-mcp-approval',
        checkpoint: 'pre_tool',
        agent: { surface: 'sdk', externalId: 'support-bot' },
        toolName: 'issue_refund',
        args: { orderId: '44' },
        options: { blocking: false, supportsAsk: false },
      });
      const approved = await client.callTool({
        name: 'approve_action',
        arguments: { approvalId: pendingDecision.approvalId, note: 'approved via mcp', sessionId: 's-mcp-admin' },
      });
      expect(approved.isError).not.toBe(true);
      expect(approved.structuredContent).toMatchObject({ state: 'approved' });
    } finally {
      await client.close();
    }
  });

  it('verifies the audit chain and detects tampering', async () => {
    const decisions = await json<{ items: unknown[] }>('/api/gov/decisions?limit=500');
    const verified = await json<{ ok: boolean; checked: number }>('/api/gov/audit/verify');
    expect(verified).toMatchObject({ ok: true, checked: decisions.items.length });

    db.run("UPDATE gov_decisions SET doc = replace(doc, 'deny', 'allow') WHERE seq = (SELECT seq FROM gov_decisions WHERE verdict = 'deny' LIMIT 1)");
    const broken = await json<{ ok: boolean; brokenAt?: number }>('/api/gov/audit/verify');
    expect(broken.ok).toBe(false);
    expect(broken.brokenAt).toEqual(expect.any(Number));
  });

  it('broadcasts governance decisions over /live WebSocket', async () => {
    const wsUrl = baseUrl.replace(/^http:/, 'ws:') + '/live';
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const message = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for gov.decision')), 5000);
      ws.on('message', data => {
        const parsed = JSON.parse(String(data)) as Record<string, unknown>;
        if (parsed.type === 'gov.decision') {
          clearTimeout(timer);
          resolve(parsed);
        }
      });
    });
    await claudePreTool('s-ws', 'Bash', { command: 'npm test' }, 'ws-test');
    await expect(message).resolves.toMatchObject({ type: 'gov.decision' });
    ws.close();
  });

  it('returns a continuous overview trend for a seven-day range', async () => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const overview = await json<{ trend: Array<{ t: string }> }>(`/api/gov/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(overview.trend.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < overview.trend.length; i++) {
      const prev = Date.parse(overview.trend[i - 1].t);
      const cur = Date.parse(overview.trend[i].t);
      expect(cur - prev).toBe(24 * 3600_000);
    }
  });
});

describe('policies, presets and classifiers API e2e', () => {
  it('serves the preset catalog and classifier list', async () => {
    const presets = await json<Record<string, unknown[]>>('/api/gov/presets');
    expect(presets.capability.length).toBe(53);
    const cls = await json<{ items: { code: string; enforceable: boolean }[] }>('/api/gov/classifiers');
    expect(cls.items.find(c => c.code === 'us_ssn')?.enforceable).toBe(true);
  });

  it('validates, saves, activates and enforces a global policy through the Claude hook', async () => {
    const yaml = 'id: e2e-no-paste\nname: No paste sites\nglobal: true\nmode: enforce\nseverity: high\nrules:\n  - id: paste\n    action: deny\n    network: [paste_sites]\n';
    await expect(json('/api/gov/policies/validate', { method: 'POST', body: JSON.stringify({ yaml }) })).resolves.toMatchObject({ ok: true });
    const bad = await fetch(`${baseUrl}/api/gov/policies`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ yaml: 'id: bad\nrules:\n  - id: r\n    action: deny\n    capability: [nope]\n' }) });
    expect(bad.status).toBe(400);
    const saved = await json<{ policy: { id: string; version: number }; status: string }>('/api/gov/policies', { method: 'POST', body: JSON.stringify({ yaml }) });
    expect(saved.status).toBe('draft');
    const activated = await json<{ status: string }>(`/api/gov/policies/e2e-no-paste/versions/${saved.policy.version}/activate`, { method: 'POST', body: '{}' });
    expect(activated.status).toBe('active');
    const res = claudeDecision(await claudePreTool('s-pol', 'Bash', { command: 'curl https://pastebin.com/raw/abc' }, 'pol-1'));
    expect(res.permissionDecision).toBe('deny');
    expect(res.permissionDecisionReason).toMatch(/No paste sites|paste/);
    const sim = await json<{ evaluated: number; ruleHits: Record<string, number> }>('/api/gov/policies/simulate', { method: 'POST', body: JSON.stringify({ yaml }) });
    expect(sim.evaluated).toBeGreaterThanOrEqual(0);
    await json(`/api/gov/policies/e2e-no-paste/versions/${saved.policy.version}/archive`, { method: 'POST', body: '{}' });
  });

  it('toggles a classifier and tests custom classifiers without storing raw values', async () => {
    const patched = await json<{ code: string; isActive: boolean }>('/api/gov/classifiers/date_of_birth', { method: 'PATCH', body: JSON.stringify({ isActive: true }) });
    expect(patched.isActive).toBe(true);
    const t = await json<{ detections: { key: string; maskedSample: string }[] }>('/api/gov/classifiers/test', { method: 'POST', body: JSON.stringify({ text: 'ticket PRJ-123456 opened', custom: { code: 'jira_ticket', label: 'Ticket', category: 'Code', sensitivity: 'Low', pattern: 'PRJ-\\d{6}' } }) });
    expect(t.detections.map(d => d.key)).toContain('jira_ticket');
    const list = await json<{ items: { code: string }[] }>('/api/gov/classifiers');
    expect(list.items.some(c => c.code === 'jira_ticket')).toBe(false);
    await json('/api/gov/classifiers/date_of_birth', { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
  });
});

describe('posture API e2e', () => {
  const report = (findings: unknown[]) => ({
    scannerVersion: 'e2e', scannedAt: new Date().toISOString(),
    endpoint: { endpointId: 'e2e-remote-endpoint', hostname: 'build-agent-7', os: 'linux', osRelease: '6.1', user: 'ci' },
    inventory: { agents: [{ id: 'aider', name: 'Aider', kind: 'cli', version: '0.80.0', configPaths: [] }], mcpServers: [], extensions: [], scheduledTasks: [], accounts: [], errors: [] },
    findings,
  });

  it('lists all 30 checks with config', async () => {
    const checks = await json<{ items: { id: string; enabled: boolean; remediation: { summary: string } }[] }>('/api/gov/posture/checks');
    expect(checks.items).toHaveLength(30);
    expect(checks.items.every(c => c.enabled && c.remediation.summary)).toBe(true);
  });

  it('ingests reports, lists findings and refuses remote auto-fix', async () => {
    const res = await json<{ endpointId: string; new: number }>('/api/gov/posture/reports', { method: 'POST', body: JSON.stringify(report([
      { checkId: 'aider-yes-mode-enabled', severity: 'high', category: 'Configuration', title: 'Aider Yes Mode Enabled', subject: 'file:/home/ci/.aider.conf.yml', summary: 'yes-always: true', evidence: { key: 'yes-always' }, fixable: true },
    ])) });
    expect(res).toMatchObject({ endpointId: 'e2e-remote-endpoint', new: 1 });
    const findings = await json<{ id: string; state: string; hostname: string }[]>('/api/gov/posture/findings?state=open&endpointId=e2e-remote-endpoint');
    expect(findings).toHaveLength(1);
    expect(findings[0].hostname).toBe('build-agent-7');
    const fix = await fetch(`${baseUrl}/api/gov/posture/findings/${findings[0].id}/fix`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: '{}' });
    expect(fix.status).toBe(409);
    const summary = await json<{ open: number; bySeverity: Record<string, number> }>('/api/gov/posture/summary');
    expect(summary.bySeverity.high).toBeGreaterThanOrEqual(1);
    const endpoints = await json<{ id: string; isLocal: boolean; agents: unknown[] }[]>('/api/gov/posture/endpoints');
    expect(endpoints.find(e => e.id === 'e2e-remote-endpoint')).toMatchObject({ isLocal: false });
    const suppressed = await json<{ state: string }>(`/api/gov/posture/findings/${findings[0].id}/suppress`, { method: 'POST', body: JSON.stringify({ reason: 'CI sandbox' }) });
    expect(suppressed.state).toBe('suppressed');
  });

  it('rejects malformed reports and invalid config', async () => {
    const bad = await fetch(`${baseUrl}/api/gov/posture/reports`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ endpoint: {} }) });
    expect(bad.status).toBe(400);
    const cfg = await fetch(`${baseUrl}/api/gov/posture/config`, { method: 'PUT', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ alertMinSeverity: 'nope' }) });
    expect(cfg.status).toBe(400);
    await expect(json('/api/gov/posture/config', { method: 'PUT', body: JSON.stringify({ orgDomains: ['contoso.com'], alertMinSeverity: 'high', checks: { 'ai-agent-sprawl': { enabled: false } } }) })).resolves.toMatchObject({ orgDomains: ['contoso.com'] });
  });
});
