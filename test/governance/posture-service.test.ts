import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

vi.mock('../../src/governance/judge', () => ({
  judge: { available: false, evaluate: vi.fn() },
  extractGoal: vi.fn(async () => null),
}));

const dir = path.join(process.cwd(), '.test-data');
fs.mkdirSync(dir, { recursive: true });
const dbFile = path.join(dir, `posture-svc-${process.pid}-${Date.now()}.db`);
process.env.AGENT_MONITOR_DB = dbFile;
process.env.AGENT_MONITOR_MODE = 'local';

type Report = import('../../src/posture/types').PostureReport;
type Draft = import('../../src/posture/types').PostureFindingDraft;
let db: typeof import('../../src/db');
let store: import('../../src/governance/store/repository').GovernanceStore;
let svc: typeof import('../../src/governance/posture');

beforeAll(async () => {
  db = await import('../../src/db');
  const storeMod = await import('../../src/governance/store');
  const sqliteMod = await import('../../src/governance/store/sqlite');
  await db.initDb();
  store = new sqliteMod.SqliteGovernanceStore();
  await store.init();
  storeMod.setGovernanceStore(store);
  svc = await import('../../src/governance/posture');
  await import('../../src/governance/alerts');
  await import('../../src/posture');
}, 60_000);

afterAll(() => { db.flushDb(); for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } } });

let epSeq = 0;
let endpointId = '';
beforeEach(async () => {
  endpointId = `ep-${++epSeq}-${Date.now()}`;
  await store.putSetting(svc.POSTURE_SETTING_KEY, { checks: {}, orgDomains: [], alertMinSeverity: 'high', incidentOnCritical: false });
});

function draft(checkId: string, subject: string, severity: Draft['severity'] = 'high'): Draft {
  return { checkId, severity, category: 'Configuration', title: checkId, subject, summary: `${checkId} on ${subject}`, evidence: { key: 'x' }, fixable: false };
}

function report(findings: Draft[], opts: { id?: string; agents?: { id: string; name: string; kind: 'cli'; version?: string; configPaths: string[] }[]; accounts?: { agentId: string; account: string }[] } = {}): Report {
  return {
    scannerVersion: 'test', scannedAt: new Date().toISOString(), durationMs: 1,
    endpoint: { endpointId: opts.id ?? endpointId, hostname: `host-${opts.id ?? endpointId}`, os: 'win32', osRelease: '10', user: 'dev' },
    inventory: { agents: opts.agents ?? [], mcpServers: [], extensions: [], scheduledTasks: [], accounts: opts.accounts ?? [], errors: [] },
    findings,
  };
}

describe('posture finding lifecycle', () => {
  it('opens, resolves and reopens findings with stable ids', async () => {
    const r1 = await svc.ingestPostureReport(report([draft('aider-yes-mode-enabled', 'file:a'), draft('auto-commits-enabled', 'file:a', 'medium')]), 'cli');
    expect(r1).toMatchObject({ endpointId, open: 2, new: 2, resolved: 0 });
    const ep = await store.getPostureEndpoint(endpointId);
    expect(ep?.findingCounts).toEqual({ high: 1, medium: 1 });

    const r2 = await svc.ingestPostureReport(report([draft('aider-yes-mode-enabled', 'file:a')]), 'cli');
    expect(r2).toMatchObject({ open: 1, new: 0, resolved: 1 });
    const id = svc.findingId(endpointId, 'auto-commits-enabled', 'file:a');
    expect((await store.getPostureFinding(id))?.state).toBe('resolved');

    const r3 = await svc.ingestPostureReport(report([draft('aider-yes-mode-enabled', 'file:a'), draft('auto-commits-enabled', 'file:a', 'medium')]), 'cli');
    expect(r3).toMatchObject({ open: 2, reopened: 1 });
    const f = await store.getPostureFinding(id);
    expect(f?.state).toBe('open');
    expect(f?.resolvedAt).toBeUndefined();
  });

  it('keeps suppressed findings suppressed until the suppression expires', async () => {
    await svc.ingestPostureReport(report([draft('ai-agent-sprawl', 'endpoint')]), 'cli');
    const id = svc.findingId(endpointId, 'ai-agent-sprawl', 'endpoint');
    await svc.suppressFinding(id, 'admin', 'accepted risk');
    await svc.ingestPostureReport(report([draft('ai-agent-sprawl', 'endpoint')]), 'cli');
    expect((await store.getPostureFinding(id))?.state).toBe('suppressed');
    await svc.suppressFinding(id, 'admin', 'short', new Date(Date.now() - 1000).toISOString());
    await svc.ingestPostureReport(report([draft('ai-agent-sprawl', 'endpoint')]), 'cli');
    expect((await store.getPostureFinding(id))?.state).toBe('open');
    await svc.unsuppressFinding(id);
  });

  it('applies check config: disable, severity override and endpoint scope', async () => {
    await store.putSetting(svc.POSTURE_SETTING_KEY, {
      checks: {
        'multiple-coding-agents': { enabled: false },
        'ai-agent-sprawl': { severity: 'critical' },
        'ai-clipboard-access': { scope: { endpoints: ['other-host'] } },
      },
      orgDomains: [], alertMinSeverity: 'high', incidentOnCritical: false,
    });
    await svc.ingestPostureReport(report([draft('multiple-coding-agents', 'e', 'low'), draft('ai-agent-sprawl', 'e', 'medium'), draft('ai-clipboard-access', 'x', 'low')]), 'cli');
    const findings = await store.listPostureFindings({ endpointId });
    expect(findings.map(f => [f.checkId, f.severity])).toEqual([['ai-agent-sprawl', 'critical']]);
  });

  it('opens an incident for new critical findings when configured', async () => {
    await store.putSetting(svc.POSTURE_SETTING_KEY, { checks: {}, orgDomains: [], alertMinSeverity: 'critical', incidentOnCritical: true });
    await svc.ingestPostureReport(report([draft('vscode-global-auto-approve-enabled', 'file:settings.json', 'critical')]), 'cli');
    const f = (await store.listPostureFindings({ endpointId }))[0];
    expect(f.incidentId).toBeTruthy();
    const inc = await store.getIncident(f.incidentId!);
    expect(inc).toMatchObject({ trigger: 'posture', severity: 'critical' });
    await svc.ingestPostureReport(report([draft('vscode-global-auto-approve-enabled', 'file:settings.json', 'critical')]), 'cli');
    expect((await store.listIncidents()).filter(i => i.summary?.includes(f.id))).toHaveLength(1);
  });

  it('sanitises oversized evidence and caps field sizes', async () => {
    const d = { ...draft('claude-history-contains-secrets', 's'), evidence: { blob: 'x'.repeat(20_000) }, summary: 'y'.repeat(5000) };
    await svc.ingestPostureReport(report([d]), 'cli');
    const f = (await store.listPostureFindings({ endpointId }))[0];
    expect(JSON.stringify(f.evidence).length).toBeLessThanOrEqual(8 * 1024);
    expect(f.summary.length).toBeLessThanOrEqual(1000);
  });
});

describe('fleet posture', () => {
  it('flags version mismatch on minority endpoints and non-corporate accounts', async () => {
    await store.putSetting(svc.POSTURE_SETTING_KEY, { checks: {}, orgDomains: ['contoso.com'], alertMinSeverity: 'critical', incidentOnCritical: false });
    const base = `fleet-${Date.now()}`;
    const agent = (v: string) => [{ id: 'aider', name: 'Aider', kind: 'cli' as const, version: v, configPaths: [] }];
    await svc.ingestPostureReport(report([], { id: `${base}-a`, agents: agent('0.80.0'), accounts: [{ agentId: 'claude-code', account: 'dev@contoso.com' }] }), 'cli');
    await svc.ingestPostureReport(report([], { id: `${base}-b`, agents: agent('0.80.0'), accounts: [{ agentId: 'claude-code', account: 'dev@gmail.com' }] }), 'cli');
    await svc.ingestPostureReport(report([], { id: `${base}-c`, agents: agent('0.70.1'), accounts: [{ agentId: 'claude-code', account: 'dev@fabrikam.io' }] }), 'cli');
    const c = await store.listPostureFindings({ endpointId: `${base}-c`, level: 'fleet' });
    expect(c.map(f => f.checkId).sort()).toEqual(['ai-agent-non-corporate-user', 'ai-agent-version-mismatch']);
    expect(await store.listPostureFindings({ endpointId: `${base}-a`, level: 'fleet' })).toHaveLength(0);
    expect(await store.listPostureFindings({ endpointId: `${base}-b`, level: 'fleet' })).toHaveLength(0);

    await svc.ingestPostureReport(report([], { id: `${base}-c`, agents: agent('0.80.0'), accounts: [] }), 'cli');
    const after = await store.listPostureFindings({ endpointId: `${base}-c`, level: 'fleet' });
    expect(after.every(f => f.state === 'resolved')).toBe(true);
  });

  it('does not flag multiple installed versions on a single endpoint', async () => {
    await store.putSetting(svc.POSTURE_SETTING_KEY, { checks: {}, orgDomains: [], alertMinSeverity: 'critical', incidentOnCritical: false });
    const id = `solo-${Date.now()}`;
    const agents = [
      { id: 'anthropic.claude-code', name: 'Claude Code', kind: 'cli' as const, version: '2.1.280', configPaths: [] },
      { id: 'anthropic.claude-code', name: 'Claude Code', kind: 'cli' as const, version: '2.1.282', configPaths: [] },
    ];
    await svc.ingestPostureReport(report([], { id, agents }), 'cli');
    expect(await store.listPostureFindings({ endpointId: id, level: 'fleet', state: ['open'] })).toHaveLength(0);
  });
});

describe('posture ingest hardening', () => {
  it('binds endpoints to their first reporting principal', async () => {
    await svc.ingestPostureReport(report([draft('ai-agent-sprawl', 'e')]), 'device', 'device-a');
    await expect(svc.ingestPostureReport(report([]), 'device', 'device-b')).rejects.toBeInstanceOf(svc.PostureOwnershipError);
    expect((await store.listPostureFindings({ endpointId, state: ['open'] }))).toHaveLength(1);
    await expect(svc.ingestPostureReport(report([]), 'device', 'device-a')).resolves.toMatchObject({ resolved: 1 });
  });

  it('strips secrets from stored inventory and evidence', async () => {
    const token = 'ghp_' + 'A'.repeat(36);
    const r = report([{ ...draft('cli-agent-scheduled-execution', 'cron:1'), evidence: { command: `OPENAI_API_KEY=abc123secretvalue codex exec --token ${token}` } }]);
    r.inventory.scheduledTasks = [{ source: 'cron', name: 'crontab:1', command: `OPENAI_API_KEY=abc123secretvalue codex exec`, agentId: 'codex' }];
    r.inventory.mcpServers = [{ name: 'zap', client: 'cursor', configPath: 'x', transport: 'http', url: 'https://mcp.zapier.com/api/mcp/s/SECRETPATH/mcp?api_key=zzz', identities: ['https://mcp.zapier.com/api/mcp/s/SECRETPATH/mcp', 'GITHUB_PERSONAL_ACCESS_TOKEN=' + token], categories: [] }];
    await svc.ingestPostureReport(r, 'cli');
    const stored = JSON.stringify(await store.getPostureEndpoint(endpointId)) + JSON.stringify(await store.listPostureFindings({ endpointId }));
    for (const secret of ['abc123secretvalue', 'SECRETPATH', 'api_key=zzz', token]) expect(stored).not.toContain(secret);
    expect(stored).toContain('https://mcp.zapier.com');
  });
});

describe('posture auto-fix gating', () => {
  it('refuses findings from other endpoints and findings without an automatic fix', async () => {
    await svc.ingestPostureReport(report([{ ...draft('ide-workspace-trust-disabled', 'file:x'), fixable: true }, draft('ai-agent-sprawl', 'e')]), 'cli');
    const fixable = svc.findingId(endpointId, 'ide-workspace-trust-disabled', 'file:x');
    expect((await svc.fixFinding(fixable)).status).toBe(409);
    expect((await svc.fixFinding(svc.findingId(endpointId, 'ai-agent-sprawl', 'e'))).status).toBe(400);
    expect((await svc.fixFinding('missing')).status).toBe(404);
  });

  it('validates posture config', () => {
    expect(svc.validatePostureConfig({ checks: { x: { severity: 'huge' } } }).errors).toEqual(['checks.x.severity: invalid']);
    expect(svc.validatePostureConfig({ orgDomains: ['@Contoso.com', 'not a domain'] }).config?.orgDomains).toEqual(['contoso.com']);
  });
});
