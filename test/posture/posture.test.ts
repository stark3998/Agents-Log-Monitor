import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ScanContext } from '../../src/posture';
import { applyAutoFix, evaluateFleet, POSTURE_CHECKS, scanEndpoint, stableEndpointId } from '../../src/posture';

async function makeHome(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `posture-${name}-`));
}

async function write(file: string, text: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { mode });
  if (mode !== undefined) await fs.chmod(file, mode);
}

function ctx(home: string, overrides: Partial<ScanContext> = {}): Partial<ScanContext> {
  return {
    home,
    platform: overrides.platform ?? 'win32',
    hostname: 'host1',
    user: 'user1',
    env: { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), USERPROFILE: home, ...(overrides.env ?? {}) },
    exec: overrides.exec ?? (async () => ({ code: 0, stdout: '' })),
    processes: overrides.processes ?? (async () => []),
    processElevation: overrides.processElevation,
    orgDomains: overrides.orgDomains,
    corporateSaasDomains: overrides.corporateSaasDomains,
  };
}

const appData = (home: string) => path.join(home, 'AppData', 'Roaming');
const localAppData = (home: string) => path.join(home, 'AppData', 'Local');
const codeSettings = (home: string) => path.join(appData(home), 'Code', 'User', 'settings.json');

async function browserExt(home: string, id: string, manifest: Record<string, unknown>, browser = 'Google\\Chrome'): Promise<void> {
  await write(path.join(localAppData(home), ...browser.split('\\'), 'User Data', 'Default', 'Extensions', id, '1.0.0_0', 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'ChatGPT Helper', version: '1.0.0', ...manifest }, null, 2));
}

async function vsix(home: string, dir: string, pkg: Record<string, unknown>): Promise<void> {
  await write(path.join(home, '.vscode', 'extensions', dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

async function hasFinding(home: string, checkId: string, overrides: Partial<ScanContext> = {}): Promise<{ hit: boolean; json: string; durationMs: number }> {
  const report = await scanEndpoint(ctx(home, overrides));
  return { hit: report.findings.some(f => f.checkId === checkId), json: JSON.stringify(report.findings), durationMs: report.durationMs };
}

type Fixture = { id: string; setup(home: string): Promise<Partial<ScanContext> | void> };
const plantedSecret = 'sk-ant-' + 'a'.repeat(40);

const endpointFixtures: Fixture[] = [
  { id: 'file-upload-capability', setup: async h => { await write(path.join(h, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { dropbox: { command: 'npx', args: ['@modelcontextprotocol/server-dropbox'] } } })); } },
  { id: 'ai-screen-capture-capability', setup: async h => { await browserExt(h, 'abcdefghijklmnopabcdefghijklmnop', { permissions: ['desktopCapture'] }); } },
  { id: 'ai-telemetry-may-leak-data', setup: async h => { await write(codeSettings(h), '{"telemetry.telemetryLevel":"all"}'); } },
  { id: 'ide-agent-terminal-unrestricted', setup: async h => { await write(codeSettings(h), '{"chat.tools.terminal.autoApprove":{".*":true}}'); } },
  { id: 'antigravity-autonomous-mode-enabled', setup: async h => { await write(path.join(h, '.gemini', 'antigravity-cli', 'settings.json'), '{"toolPermission":"always-proceed"}'); } },
  { id: 'openhands-confirmation-disabled', setup: async h => { await write(path.join(h, '.openhands', 'settings.json'), '{"confirmation_mode":false}'); } },
  { id: 'mentat-pr-bot-mode-active', setup: async h => { await write(path.join(h, 'repo', '.mentat', 'setup.sh'), 'echo bot'); } },
  { id: 'vscode-global-auto-approve-enabled', setup: async h => { await write(codeSettings(h), '{"chat.tools.global.autoApprove":true}'); } },
  { id: 'claude-code-extension-bypass-permission-prompts', setup: async h => { await write(codeSettings(h), '{"claudeCode.allowDangerouslySkipPermissions":true,"claudeCode.initialPermissionMode":"bypassPermissions"}'); } },
  { id: 'claude-desktop-third-party-dxt-installed', setup: async h => { await write(path.join(appData(h), 'Claude', 'Claude Extensions', 'evil', 'manifest.json'), JSON.stringify({ name: 'Evil DXT', version: '1.0.0', author: { name: 'Mallory' } })); } },
  { id: 'aider-yes-mode-enabled', setup: async h => { await write(path.join(h, '.aider.conf.yml'), 'yes-always: true\n'); } },
  { id: 'auto-commits-enabled', setup: async h => { await write(path.join(h, '.aider.conf.yml'), 'auto-commits: true\n'); } },
  { id: 'known-vulnerable-software', setup: async h => { await vsix(h, 'anthropic.claude-code-0.2.116', { publisher: 'anthropic', name: 'claude-code', displayName: 'Claude Code', version: '0.2.116' }); } },
  { id: 'gemini-oauth-tokens-exposed', setup: async h => { await write(path.join(h, '.gemini', 'oauth_creds.json'), '{}', 0o644); return { platform: 'linux' as NodeJS.Platform, env: { HOME: h } }; } },
  { id: 'claude-history-contains-secrets', setup: async h => { await write(path.join(h, '.claude', 'history.jsonl'), `{"text":"token ${plantedSecret}"}\n`); } },
  { id: 'gemini-cli-google-account-linked', setup: async h => { await write(path.join(h, '.gemini', 'google_accounts.json'), '{"active":"dev@gmail.com"}'); } },
  { id: 'plandex-auto-execute-enabled', setup: async h => { await write(path.join(h, '.bash_history'), 'plandex set-auto full\n'); } },
  { id: 'ide-workspace-trust-disabled', setup: async h => { await write(codeSettings(h), '{"security.workspace.trust.enabled":false}'); } },
  { id: 'cli-agent-running-as-root', setup: async _h => ({ platform: 'linux' as NodeJS.Platform, processes: async () => [{ pid: 42, name: 'claude', cmdline: 'claude', user: 'root' }] }) },
  { id: 'multiple-coding-agents', setup: async h => { await write(path.join(h, '.claude', 'settings.json'), '{}'); await write(path.join(h, '.gemini', 'settings.json'), '{}'); } },
  { id: 'antigravity-browser-has-corporate-sessions', setup: async h => { await write(path.join(h, '.gemini', 'antigravity-browser-profile', 'Default', 'Network', 'Cookies'), 'host_key .slack.com'); } },
  { id: 'antigravity-parallel-agents', setup: async h => { await write(path.join(h, '.gemini', 'antigravity', 'a', 'x'), '1'); await write(path.join(h, '.gemini', 'antigravity', 'b', 'x'), '1'); } },
  { id: 'antigravity-multiple-google-accounts', setup: async h => { await write(path.join(appData(h), 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), '{"a":"one@corp.test","b":"two@gmail.com"}'); } },
  { id: 'aider-api-key-in-config', setup: async h => { await write(path.join(h, '.aider.conf.yml'), `anthropic-api-key: ${plantedSecret}\n`); } },
  { id: 'ai-clipboard-access', setup: async h => { await browserExt(h, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { name: 'ChatGPT Assistant', permissions: ['clipboardRead'] }); } },
  { id: 'ai-agent-sprawl', setup: async h => { await write(path.join(h, '.claude', 'settings.json'), '{}'); await write(path.join(h, '.gemini', 'settings.json'), '{}'); await write(path.join(h, '.aider.conf.yml'), 'auto-commits: false'); await write(path.join(h, '.codex', 'config.toml'), 'approval_policy = "on-request"'); } },
  { id: 'cli-agent-scheduled-execution', setup: async _h => ({ exec: async (cmd: string) => cmd.toLowerCase().includes('powershell') ? { code: 0, stdout: JSON.stringify({ name: '\\Nightly Claude', actions: ['claude --yolo'] }) } : { code: 0, stdout: '' } }) },
  { id: 'kiro-third-party-power-installed', setup: async h => { await write(path.join(h, '.kiro', 'powers', 'bad', 'plugin.json'), '{"source":"https://github.com/evil/powers"}'); } },
];

describe('endpoint posture checks', () => {
  for (const f of endpointFixtures) {
    it(`${f.id} hits and clean fixture stays clean`, async () => {
      const hitHome = await makeHome(f.id);
      const overrides = (await f.setup(hitHome)) ?? {};
      const hit = await hasFinding(hitHome, f.id, overrides);
      expect(hit.hit, `${f.id} should hit`).toBe(true);
      expect(hit.json).not.toContain(plantedSecret);

      const cleanHome = await makeHome(`${f.id}-clean`);
      const clean = await hasFinding(cleanHome, f.id, f.id === 'gemini-oauth-tokens-exposed' || f.id === 'cli-agent-running-as-root' ? { platform: 'linux' } : {});
      expect(clean.hit, `${f.id} should be clean`).toBe(false);
    });
  }

  it('does not identify VS Code extension hosts mentioning Copilot or Codex as CLI agents', async () => {
    const home = await makeHome('process-negative');
    const report = await scanEndpoint(ctx(home, {
      platform: 'win32',
      processes: async () => [
        { pid: 100, name: 'Code.exe', cmdline: 'Code.exe --extensionHost github.copilot-chat openai.codex' },
      ],
      processElevation: async () => ({ 100: true }),
    }));
    expect(report.inventory.agents.some(a => a.id === 'copilot-cli' || a.id === 'codex-cli')).toBe(false);
    expect(report.findings.some(f => f.checkId === 'cli-agent-running-as-root')).toBe(false);
  });

  it('uses per-process Windows elevation and ignores unknown elevation', async () => {
    const home = await makeHome('process-elevation');
    const base = {
      platform: 'win32' as NodeJS.Platform,
      processes: async () => [{ pid: 200, name: 'claude.exe', cmdline: 'claude' }],
    };
    expect((await scanEndpoint(ctx(home, { ...base, processElevation: async () => ({ 200: null }) }))).findings.some(f => f.checkId === 'cli-agent-running-as-root')).toBe(false);
    expect((await scanEndpoint(ctx(home, { ...base, processElevation: async () => ({ 200: false }) }))).findings.some(f => f.checkId === 'cli-agent-running-as-root')).toBe(false);
    expect((await scanEndpoint(ctx(home, { ...base, processElevation: async () => ({ 200: true }) }))).findings.some(f => f.checkId === 'cli-agent-running-as-root')).toBe(true);
  });

  it('parses scheduled task actions without matching task-name substrings', async () => {
    const home = await makeHome('scheduled-negative');
    const tasks = [
      { name: '\\SampleCleanup', actions: ['C:\\Windows\\System32\\cmd.exe /c echo ok'] },
      { name: '\\RealClaude', actions: ['"C:\\tools\\claude.exe" --danger'] },
    ];
    const report = await scanEndpoint(ctx(home, {
      exec: async (cmd: string) => cmd.toLowerCase().includes('powershell') ? { code: 0, stdout: JSON.stringify(tasks) } : { code: 0, stdout: '' },
    }));
    const scheduled = report.findings.filter(f => f.checkId === 'cli-agent-scheduled-execution');
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].subject).toBe('schtasks:\\RealClaude');
    expect(scheduled[0].subject).not.toContain('SampleCleanup');
  });

  it('does not classify Email Helper as an AI browser extension', async () => {
    const home = await makeHome('email-helper');
    await browserExt(home, 'cccccccccccccccccccccccccccccccc', { name: 'Email Helper', description: 'Maintain details', permissions: ['clipboardRead'] });
    const report = await scanEndpoint(ctx(home));
    expect(report.inventory.agents.some(a => a.kind === 'browser-extension')).toBe(false);
    expect(report.findings.some(f => f.checkId === 'ai-clipboard-access')).toBe(false);
  });

  it('resolves Chrome __MSG names from locale files', async () => {
    const home = await makeHome('localized-ext');
    const extDir = path.join(localAppData(home), 'Google', 'Chrome', 'User Data', 'Default', 'Extensions', 'eppiocemhmnlbhjplcgkofciiegomcon', '5.5.0_0');
    await write(path.join(extDir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '__MSG_appName__', version: '5.5.0', default_locale: 'en', permissions: [] }));
    await write(path.join(extDir, '_locales', 'en', 'messages.json'), JSON.stringify({ appname: { message: 'Urban VPN Proxy' } }));
    const report = await scanEndpoint(ctx(home));
    const finding = report.findings.find(f => f.checkId === 'known-vulnerable-software');
    expect(finding?.summary).toContain('Urban VPN Proxy');
  });

  it('excludes browser extensions from Multiple Coding Agents but counts them for sprawl', async () => {
    const home = await makeHome('browser-agent-count');
    for (let i = 0; i < 4; i++) await browserExt(home, `${String.fromCharCode(100 + i).repeat(32)}`, { name: `ChatGPT Helper ${i}`, description: 'AI GPT helper' });
    const report = await scanEndpoint(ctx(home));
    expect(report.findings.some(f => f.checkId === 'multiple-coding-agents')).toBe(false);
    expect(report.findings.some(f => f.checkId === 'ai-agent-sprawl')).toBe(true);
  });
});

describe('fleet posture checks', () => {
  it('flags non-corporate user domains and ignores personal allowlist', () => {
    const endpoint = { endpointId: 'e1', hostname: 'h', os: 'win32' as NodeJS.Platform, osRelease: 'x', user: 'u' };
    const inventory = { agents: [], mcpServers: [], extensions: [], scheduledTasks: [], errors: [], accounts: [{ agentId: 'claude', account: 'dev@contractor.test' }, { agentId: 'gemini', account: 'me@gmail.com' }] };
    const findings = evaluateFleet([{ endpoint, inventory }], { orgDomains: ['corp.test'] });
    expect(findings.some(f => f.checkId === 'ai-agent-non-corporate-user')).toBe(true);
    expect(evaluateFleet([{ endpoint, inventory: { ...inventory, accounts: [{ agentId: 'claude', account: 'dev@corp.test' }] } }], { orgDomains: ['corp.test'] })).toEqual([]);
  });

  it('flags version mismatches away from the modal version', () => {
    const inv = (v: string) => ({ agents: [{ id: 'claude-code', name: 'Claude', kind: 'cli' as const, version: v, configPaths: [] }], mcpServers: [], extensions: [], scheduledTasks: [], errors: [], accounts: [] });
    const eps = ['e1', 'e2', 'e3'].map((id, i) => ({ endpoint: { endpointId: id, hostname: id, os: 'win32' as NodeJS.Platform, osRelease: 'x', user: 'u' }, inventory: inv(i === 2 ? '2.0.0' : '1.0.0') }));
    const findings = evaluateFleet(eps, { orgDomains: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ checkId: 'ai-agent-version-mismatch', endpointId: 'e3' });
  });
});

describe('auto-fix and API contract', () => {
  it('auto-fixes JSONC settings, creates backup, preserves comments, and is idempotent', async () => {
    const home = await makeHome('fix');
    const file = codeSettings(home);
    await write(file, '{\n  // keep me\n  "chat.tools.global.autoApprove": true\n}\n');
    const report = await scanEndpoint(ctx(home));
    const finding = report.findings.find(f => f.checkId === 'vscode-global-auto-approve-enabled');
    expect(finding).toBeTruthy();
    const fixed = await applyAutoFix('vscode-global-auto-approve-enabled', finding!.subject, ctx(home));
    expect(fixed.ok).toBe(true);
    expect(fixed.backups).toHaveLength(1);
    const text = await fs.readFile(file, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).toContain('"chat.tools.global.autoApprove": false');
    expect((await scanEndpoint(ctx(home))).findings.some(f => f.checkId === 'vscode-global-auto-approve-enabled')).toBe(false);
    const second = await applyAutoFix('vscode-global-auto-approve-enabled', finding!.subject, ctx(home));
    expect(second.message).toBe('already compliant');
  });

  it('exports stable ids and all required checks', () => {
    expect(stableEndpointId('h', 'u')).toHaveLength(16);
    expect(POSTURE_CHECKS).toHaveLength(30);
    expect(new Set(POSTURE_CHECKS.map(c => c.id)).size).toBe(30);
  });
});

describe('real default-context smoke', () => {
  it('scanEndpoint completes without throwing within 30 seconds', async () => {
    const started = Date.now();
    const report = await scanEndpoint();
    const elapsed = Date.now() - started;
    expect(report.endpoint.endpointId).toBeTruthy();
    expect(elapsed).toBeLessThan(30_000);
    console.log(`posture smoke duration ${report.durationMs} ms`);
  }, 35_000);
});
