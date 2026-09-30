import path from 'path';
import { detect } from '../../analytics/detectors';
import { expandHostValues, hostMatches } from '../../policies/presets';
import type { EndpointInventory, PostureFindingDraft, ScanContext } from '../types';
import vulnerable from '../data/vulnerable-extensions.json';
import { appData, asRecord, boolish, CAPPED_FILE_BYTES, CAPPED_TOTAL_BYTES, collectStrings, existsSafe, finding, getPath, joinHome, knownCliId, listSafe, localAppData, normalizeEmailDomain, parseJsonc, parseSimpleToml, parseSimpleYaml, readJson, semverCompare, subjectForFile, tryFile, versionInRange } from '../utils';
import { checkDef, POSTURE_CHECKS } from './defs';
import { isAiExtension } from '../inventory';

const SETTINGS_PRODUCTS = [
  { id: 'vscode', name: 'VS Code', dir: 'Code' }, { id: 'vscode-insiders', name: 'VS Code Insiders', dir: 'Code - Insiders' }, { id: 'vscodium', name: 'VSCodium', dir: 'VSCodium' },
  { id: 'cursor', name: 'Cursor', dir: 'Cursor' }, { id: 'windsurf', name: 'Windsurf', dir: 'Windsurf' }, { id: 'kiro', name: 'Kiro', dir: 'Kiro' }, { id: 'antigravity', name: 'Antigravity', dir: 'Antigravity' },
];

export async function evaluateEndpoint(inv: EndpointInventory, ctx: ScanContext): Promise<PostureFindingDraft[]> {
  const out: PostureFindingDraft[] = [];
  const disabled = new Set(ctx.disabledChecks ?? []);
  for (const fn of CHECKS) {
    const id = fn.id;
    if (disabled.has(id)) continue;
    const def = checkDef(id);
    if (def.level !== 'endpoint' || !def.platforms.includes(ctx.platform as 'win32' | 'darwin' | 'linux')) continue;
    try { out.push(...await fn(inv, ctx)); } catch (e) { inv.errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return out;
}

type CheckFn = ((inv: EndpointInventory, ctx: ScanContext) => Promise<PostureFindingDraft[]> | PostureFindingDraft[]) & { id: string };
function check(id: string, fn: (inv: EndpointInventory, ctx: ScanContext) => Promise<PostureFindingDraft[]> | PostureFindingDraft[]): CheckFn { return Object.assign(fn, { id }); }

const CHECKS: CheckFn[] = [
  check('file-upload-capability', async inv => {
    const d = checkDef('file-upload-capability');
    const out: PostureFindingDraft[] = [];
    for (const s of inv.mcpServers) if ((s.categories.includes('mcp_company_data') || /dropbox|drive|box|slack|notion|atlassian|upload|file/i.test(`${s.name} ${s.package ?? ''} ${s.identities.join(' ')}`)) && /upload|file|drive|dropbox|box|slack|notion|atlassian/i.test(`${s.name} ${s.command ?? ''} ${s.package ?? ''} ${s.identities.join(' ')}`)) out.push(finding(d, `${s.client}:${s.name}`, `MCP server ${s.name} may upload files to external services.`, { client: s.client, configPath: s.configPath, categories: s.categories, identities: s.identities }));
    for (const e of inv.extensions) if (['chrome', 'edge', 'brave'].includes(e.host) && isAiExtension(e.id, `${e.name ?? ''}`) && (e.permissions ?? []).some(p => p === '<all_urls>' || p === '*://*/*')) out.push(finding(d, `${e.host}:${e.id}@${e.version ?? 'unknown'}`, `AI browser extension ${e.name ?? e.id} has broad host access.`, { permissions: e.permissions, version: e.version }));
    return out;
  }),
  check('ai-screen-capture-capability', inv => {
    const d = checkDef('ai-screen-capture-capability');
    const out: PostureFindingDraft[] = [];
    for (const e of inv.extensions) if ((e.permissions ?? []).some(p => /desktopCapture|tabCapture/i.test(p))) out.push(finding(d, `${e.host}:${e.id}@${e.version ?? 'unknown'}`, `Extension ${e.name ?? e.id} can capture screens or tabs.`, { permissions: e.permissions }));
    for (const s of inv.mcpServers) if (s.categories.includes('mcp_browser') || /screenshot|screen|desktop|browser|playwright|puppeteer|computer-use/i.test(`${s.name} ${s.command ?? ''} ${s.package ?? ''}`)) out.push(finding(d, `${s.client}:${s.name}`, `MCP server ${s.name} may capture or drive the screen/browser.`, { configPath: s.configPath, categories: s.categories, identities: s.identities }));
    return out;
  }),
  check('ai-telemetry-may-leak-data', async (_inv, ctx) => {
    const d = checkDef('ai-telemetry-may-leak-data');
    const out: PostureFindingDraft[] = [];
    for (const f of await settingsFiles(ctx)) {
      const obj = await readJson(ctx, f);
      if (getPath(obj, 'telemetry.telemetryLevel') === 'all' || getPath(obj, 'telemetry.enabled') === true || getPath(obj, 'privacy.usageStatisticsEnabled') === true || getPath(obj, 'telemetry.logPrompts') === true) out.push(finding(d, subjectForFile(f), 'Telemetry or prompt logging appears enabled.', { path: f, keys: ['telemetry'] }));
    }
    const claudeSettings = await readJson(ctx, joinHome(ctx, '.claude', 'settings.json'));
    const env = asRecord(getPath(claudeSettings, 'env'));
    if (env && (env.OTEL_LOG_USER_PROMPTS === '1' || env.OTEL_LOG_RAW_API_BODIES === '1' || env.CLAUDE_CODE_ENABLE_TELEMETRY === '1')) out.push(finding(d, subjectForFile(joinHome(ctx, '.claude', 'settings.json')), 'Claude telemetry can export prompts or raw API bodies.', { keys: Object.keys(env).filter(k => /OTEL|TELEMETRY/.test(k)) }));
    if (ctx.env.OTEL_LOG_USER_PROMPTS === '1' || ctx.env.OTEL_LOG_RAW_API_BODIES === '1') out.push(finding(d, 'env:otel', 'Environment enables prompt/raw API telemetry.', { keys: ['OTEL_LOG_USER_PROMPTS', 'OTEL_LOG_RAW_API_BODIES'].filter(k => ctx.env[k]) }));
    return out;
  }),
  check('ide-agent-terminal-unrestricted', async (_inv, ctx) => {
    const d = checkDef('ide-agent-terminal-unrestricted');
    const out: PostureFindingDraft[] = [];
    for (const f of await settingsFiles(ctx)) {
      const obj = await readJson(ctx, f);
      const term = getPath(obj, 'chat.tools.terminal.autoApprove');
      if (term === true || isBroadAllow(term) || getPath(obj, 'chat.tools.terminal.ignoreDefaultAutoApproveRules') === true || getPath(obj, 'chat.agent.terminal.autoApprove') === true) out.push(finding(d, subjectForFile(f), 'IDE terminal approval rules allow broad command execution.', { path: f, keys: ['chat.tools.terminal.autoApprove'] }));
      const allowList = getPath(obj, 'windsurf.cascadeCommandsAllowList') ?? getPath(obj, 'kiroAgent.trustedCommands');
      if (isBroadAllow(allowList)) out.push(finding(d, subjectForFile(f), 'IDE command allowlist contains wildcard shell execution.', { path: f, keys: ['allowList'] }));
    }
    const cursorPerms = [joinHome(ctx, '.cursor', 'permissions.json')];
    for (const f of cursorPerms) {
      const obj = await readJson(ctx, f); const allow = getPath(obj, 'terminalAllowlist');
      if (isBroadAllow(allow)) out.push(finding(d, subjectForFile(f), 'Cursor terminal allowlist permits unrestricted commands.', { path: f, key: 'terminalAllowlist' }));
    }
    const claude = await readJson(ctx, joinHome(ctx, '.claude', 'settings.json'));
    if (isBroadAllow(getPath(claude, 'permissions.allow'))) out.push(finding(d, subjectForFile(joinHome(ctx, '.claude', 'settings.json')), 'Claude Code permissions allow broad shell execution.', { key: 'permissions.allow' }));
    const codexText = await tryFile(ctx, path.join(ctx.env.CODEX_HOME ?? joinHome(ctx, '.codex'), 'config.toml'));
    if (codexText && /approval_policy\s*=\s*["']never["'][\s\S]*sandbox_mode\s*=\s*["']danger-full-access["']|sandbox_mode\s*=\s*["']danger-full-access["'][\s\S]*approval_policy\s*=\s*["']never["']/.test(codexText)) out.push(finding(d, subjectForFile(path.join(ctx.env.CODEX_HOME ?? joinHome(ctx, '.codex'), 'config.toml')), 'Codex CLI disables approvals with full filesystem access.', { keys: ['approval_policy', 'sandbox_mode'] }));
    return out;
  }),
  check('antigravity-autonomous-mode-enabled', async (_inv, ctx) => {
    const d = checkDef('antigravity-autonomous-mode-enabled');
    const f = joinHome(ctx, '.gemini', 'antigravity-cli', 'settings.json');
    const obj = await readJson(ctx, f);
    if (getPath(obj, 'toolPermission') === 'always-proceed' || getPath(obj, 'artifactReviewPolicy') === 'always-proceed' || getPath(obj, 'allowNonWorkspaceAccess') === true || getPath(obj, 'enableTerminalSandbox') === false) return [finding(d, subjectForFile(f), 'Antigravity is configured for autonomous/no-review operation.', { path: f, riskyKeys: ['toolPermission', 'artifactReviewPolicy', 'allowNonWorkspaceAccess', 'enableTerminalSandbox'] })];
    return [];
  }),
  check('openhands-confirmation-disabled', async (inv, ctx) => {
    const d = checkDef('openhands-confirmation-disabled');
    const out: PostureFindingDraft[] = [];
    for (const f of [joinHome(ctx, '.openhands', 'settings.json'), joinHome(ctx, '.openhands', 'agent_settings.json'), joinHome(ctx, '.openhands', 'cli_config.json')]) {
      const txt = await tryFile(ctx, f); const obj = parseJsonc(txt);
      if (txt && (getPath(obj, 'confirmation_mode') === false || getPath(obj, 'confirmation_policy.kind') === 'NeverConfirm' || /NeverConfirm|always-approve|--yolo/i.test(txt))) out.push(finding(d, subjectForFile(f), 'OpenHands confirmation is disabled or never-confirm is configured.', { path: f, keys: ['confirmation_mode'] }));
    }
    const toml = await tryFile(ctx, joinHome(ctx, '.openhands', 'config.toml'));
    if (toml && /confirmation_mode\s*=\s*false/i.test(toml)) out.push(finding(d, subjectForFile(joinHome(ctx, '.openhands', 'config.toml')), 'OpenHands legacy confirmation_mode is false.', { path: joinHome(ctx, '.openhands', 'config.toml'), key: 'confirmation_mode' }));
    for (const a of inv.agents) if (a.id === 'openhands' && a.running) out.push(...(await ctx.processes()).filter(p => /openhands/i.test(p.cmdline) && /--always-approve|--yolo|headless/i.test(p.cmdline)).map(p => finding(d, `process:${p.pid}`, 'OpenHands process is running without confirmations.', { pid: p.pid, flags: p.cmdline.match(/--always-approve|--yolo|headless/ig) ?? [] })));
    return out;
  }),
  check('mentat-pr-bot-mode-active', async (_inv, ctx) => {
    const d = checkDef('mentat-pr-bot-mode-active');
    const out: PostureFindingDraft[] = [];
    for (const dir of [path.join(ctx.home, '.mentat'), path.join(ctx.home, 'repo', '.mentat')]) {
      if (await existsSafe(ctx, path.join(dir, 'setup.sh')) || await existsSafe(ctx, path.join(dir, 'precommit.sh'))) out.push(finding(d, dir, 'Mentat automation files are present in a local clone.', { path: dir, indicators: ['setup.sh', 'precommit.sh'] }));
    }
    return out;
  }),
  check('vscode-global-auto-approve-enabled', async (_inv, ctx) => {
    const d = checkDef('vscode-global-auto-approve-enabled');
    const out: PostureFindingDraft[] = [];
    for (const f of await settingsFiles(ctx)) {
      const obj = await readJson(ctx, f);
      const keys = ['chat.tools.global.autoApprove', 'chat.tools.autoApprove', 'chat.permissions.default'].filter(k => getPath(obj, k) === true || ['autoApprove', 'autopilot'].includes(String(getPath(obj, k))));
      if (keys.length) out.push(finding(d, subjectForFile(f), 'IDE global tool auto-approval is enabled.', { path: f, keys }));
    }
    return out;
  }),
  check('claude-code-extension-bypass-permission-prompts', async (_inv, ctx) => {
    const d = checkDef('claude-code-extension-bypass-permission-prompts');
    const out: PostureFindingDraft[] = [];
    for (const f of await settingsFiles(ctx)) {
      const obj = await readJson(ctx, f);
      const keys = ['claudeCode.allowDangerouslySkipPermissions', 'claudeCode.initialPermissionMode'].filter(k => getPath(obj, k) === true || getPath(obj, k) === 'bypassPermissions');
      if (keys.length) out.push(finding(d, subjectForFile(f), 'Claude Code extension can bypass permission prompts.', { path: f, keys }));
    }
    return out;
  }),
  check('claude-desktop-third-party-dxt-installed', inv => {
    const d = checkDef('claude-desktop-third-party-dxt-installed');
    return inv.extensions.filter(e => e.host === 'claude-desktop' && !/anthropic/i.test(`${e.publisher ?? ''} ${e.name ?? ''}`)).map(e => finding(d, `claude-desktop:${e.id}@${e.version ?? 'unknown'}`, `Claude Desktop extension ${e.name ?? e.id} is not verified first-party.`, { publisher: e.publisher, version: e.version, path: e.path }));
  }),
  check('aider-yes-mode-enabled', async (inv, ctx) => {
    const d = checkDef('aider-yes-mode-enabled');
    const out: PostureFindingDraft[] = [];
    const f = joinHome(ctx, '.aider.conf.yml'); const txt = await tryFile(ctx, f); const y = txt ? parseSimpleYaml(txt) : {};
    if (txt && (y['yes-always'] === true || y.yes === true || /^\s*yes\s*:/m.test(txt))) out.push(finding(d, subjectForFile(f), 'Aider auto-confirm yes mode is enabled.', { path: f, keys: Object.keys(y).filter(k => k.startsWith('yes')) }));
    for (const p of await ctx.processes()) if (/\baider\b/i.test(p.cmdline) && /\s--yes\b|\s-y\b|--yes-always\b/i.test(p.cmdline)) out.push(finding(d, `process:${p.pid}`, 'Aider process was launched with --yes/auto-confirm.', { pid: p.pid, flags: p.cmdline.match(/--yes(?:-always)?|-y/g) ?? [] }));
    return out;
  }),
  check('auto-commits-enabled', async (_inv, ctx) => {
    const d = checkDef('auto-commits-enabled');
    const out: PostureFindingDraft[] = [];
    const f = joinHome(ctx, '.aider.conf.yml'); const txt = await tryFile(ctx, f); const y = txt ? parseSimpleYaml(txt) : {};
    if (y['auto-commits'] === true || y.autoCommit === true || y.autoCommits === true) out.push(finding(d, subjectForFile(f), 'Aider automatic commits are enabled.', { path: f, keys: ['auto-commits'] }));
    for (const f2 of await settingsFiles(ctx)) { const obj = await readJson(ctx, f2); if (getPath(obj, 'autoCommit') === true || getPath(obj, 'autoCommits') === true) out.push(finding(d, subjectForFile(f2), 'AI agent automatic commits are enabled.', { path: f2, keys: ['autoCommit'] })); }
    return out;
  }),
  check('known-vulnerable-software', inv => {
    const d = checkDef('known-vulnerable-software');
    const out: PostureFindingDraft[] = [];
    for (const e of inv.extensions) for (const v of vulnerable as { id: string; host: string; vulnerableBelow?: string; affected?: string; advisoryUrl: string; cve?: string; name: string }[]) {
      if (e.id.toLowerCase() === v.id.toLowerCase() && (v.host === e.host || (v.host === 'vscode' && ['cursor', 'windsurf', 'kiro', 'antigravity'].includes(e.host))) && versionInRange(e.version, v.vulnerableBelow, v.affected)) out.push(finding(d, `${e.host}:${e.id}@${e.version ?? 'unknown'}`, `${e.name ?? e.id} version ${e.version ?? 'unknown'} matches a known vulnerable range.`, { version: e.version, vulnerableBelow: v.vulnerableBelow, affected: v.affected, advisoryUrl: v.advisoryUrl, cve: v.cve }));
    }
    return out;
  }),
  check('gemini-oauth-tokens-exposed', async (_inv, ctx) => {
    const d = checkDef('gemini-oauth-tokens-exposed'); const f = joinHome(ctx, '.gemini', 'oauth_creds.json');
    if (!await existsSafe(ctx, f)) return [];
    const st = await ctx.stat(f);
    if (ctx.platform !== 'win32' && st && (st.mode & 0o077) !== 0) return [finding(d, subjectForFile(f), 'Gemini OAuth token file is readable by group or others.', { path: f, mode: `0${(st.mode & 0o777).toString(8)}` })];
    if (ctx.platform === 'win32') {
      const out = await ctx.exec('icacls.exe', [f], 3000);
      if (out && out.code === 0 && /\b(?:Everyone|Users|Authenticated Users)\b[^\r\n]*\((?:F|M|R|RX|RW|GR|GA)\)/i.test(out.stdout)) return [finding(d, subjectForFile(f), 'Gemini OAuth token ACL grants read access to broad principals.', { path: f, aclPrincipals: ['Everyone/Users/Authenticated Users'] })];
    }
    return [];
  }),
  check('claude-history-contains-secrets', async (_inv, ctx) => {
    const d = checkDef('claude-history-contains-secrets');
    const files: string[] = [];
    const base = joinHome(ctx, '.claude');
    if (await existsSafe(ctx, path.join(base, 'history.jsonl'))) files.push(path.join(base, 'history.jsonl'));
    const projects = path.join(base, 'projects');
    for (const proj of (await listSafe(ctx, projects)).slice(0, 100)) for (const f of (await listSafe(ctx, path.join(projects, proj))).filter(x => x.endsWith('.jsonl')).slice(0, 20)) files.push(path.join(projects, proj, f));
    let total = 0; const hits: Record<string, { count: number; maskedSample: string; files: string[] }> = {};
    for (const f of files) {
      const st = await ctx.stat(f); if (!st || total >= CAPPED_TOTAL_BYTES) continue;
      const txt = (await tryFile(ctx, f) ?? '').slice(0, CAPPED_FILE_BYTES); total += Math.min(st.size, CAPPED_FILE_BYTES);
      for (const h of detect(txt)) { const cur = hits[h.key] ??= { count: 0, maskedSample: h.maskedSample, files: [] }; cur.count++; if (!cur.files.includes(f)) cur.files.push(f); }
    }
    return Object.keys(hits).length ? [finding(d, 'claude-history', 'Claude history contains masked secret/PII detector matches.', { detectors: hits, scannedFiles: files.length, scannedBytes: total })] : [];
  }),
  check('gemini-cli-google-account-linked', async (_inv, ctx) => {
    const d = checkDef('gemini-cli-google-account-linked'); const out: PostureFindingDraft[] = [];
    const settings = await readJson(ctx, joinHome(ctx, '.gemini', 'settings.json'));
    if (getPath(settings, 'security.auth.selectedType') === 'oauth-personal' || getPath(settings, 'selectedAuthType') === 'oauth-personal') out.push(finding(d, subjectForFile(joinHome(ctx, '.gemini', 'settings.json')), 'Gemini CLI uses personal OAuth authentication.', { key: 'security.auth.selectedType' }));
    const acctFile = joinHome(ctx, '.gemini', 'google_accounts.json'); const acct = await tryFile(ctx, acctFile);
    if (acct && /@/.test(acct)) out.push(finding(d, subjectForFile(acctFile), 'Gemini CLI has linked Google account metadata.', { path: acctFile, accounts: collectStrings(parseJsonc(acct), /[^@\s]+@[^@\s]+\.[^@\s]+/g).map(maskEmail) }));
    else if (await existsSafe(ctx, joinHome(ctx, '.gemini', 'oauth_creds.json'))) out.push(finding(d, subjectForFile(joinHome(ctx, '.gemini', 'oauth_creds.json')), 'Gemini CLI OAuth credentials are present.', { path: joinHome(ctx, '.gemini', 'oauth_creds.json') }));
    return out;
  }),
  check('plandex-auto-execute-enabled', async (_inv, ctx) => {
    const d = checkDef('plandex-auto-execute-enabled'); const files = [joinHome(ctx, '.bash_history'), joinHome(ctx, '.zsh_history'), path.join(ctx.home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt')];
    const out: PostureFindingDraft[] = [];
    for (const f of files) { const txt = await tryFile(ctx, f); if (txt && /plandex\s+.*(--full|set-auto\s+full|set-config\s+.*auto-exec\s+true|auto-apply\s+true)/i.test(txt)) out.push(finding(d, subjectForFile(f), 'Shell history shows Plandex full/auto-exec autonomy commands.', { path: f, matched: true })); }
    for (const p of await ctx.processes()) if (/plandex|pdx/i.test(p.cmdline) && /--full|auto-exec\s+true/i.test(p.cmdline)) out.push(finding(d, `process:${p.pid}`, 'Plandex process includes full/auto-exec flags.', { pid: p.pid, flags: p.cmdline.match(/--full|auto-exec\s+true/ig) ?? [] }));
    return out;
  }),
  check('ide-workspace-trust-disabled', async (_inv, ctx) => {
    const d = checkDef('ide-workspace-trust-disabled'); const out: PostureFindingDraft[] = [];
    for (const f of await settingsFiles(ctx)) { const obj = await readJson(ctx, f); if (getPath(obj, 'security.workspace.trust.enabled') === false) out.push(finding(d, subjectForFile(f), 'IDE workspace trust is disabled.', { path: f, key: 'security.workspace.trust.enabled' })); }
    const gem = await readJson(ctx, joinHome(ctx, '.gemini', 'settings.json')); if (getPath(gem, 'security.folderTrust.enabled') === false) out.push(finding(d, subjectForFile(joinHome(ctx, '.gemini', 'settings.json')), 'Gemini folder trust is disabled.', { key: 'security.folderTrust.enabled' }));
    return out;
  }),
  check('cli-agent-running-as-root', async (_inv, ctx) => {
    const d = checkDef('cli-agent-running-as-root'); const out: PostureFindingDraft[] = [];
    const processes = (await ctx.processes()).map(p => ({ p, id: knownCliId(p.cmdline, p.name) })).filter((x): x is { p: Awaited<ReturnType<ScanContext['processes']>>[number]; id: string } => !!x.id);
    if (ctx.platform === 'win32') {
      const elevation = ctx.processElevation ? await ctx.processElevation(processes.map(x => x.p.pid)) : {};
      for (const { p, id } of processes) if (elevation[p.pid] === true) out.push(finding(d, `process:${p.pid}`, `CLI agent ${id} is running with elevated privileges.`, { pid: p.pid, agentId: id, user: p.user ?? ctx.user, elevated: true }));
    } else {
      for (const { p, id } of processes) if (p.user === 'root') out.push(finding(d, `process:${p.pid}`, `CLI agent ${id} is running as root.`, { pid: p.pid, agentId: id, user: p.user, elevated: true }));
    }
    return out;
  }),
  check('multiple-coding-agents', inv => {
    const d = checkDef('multiple-coding-agents'); const ids = codingAgentIds(inv);
    return ids.length > 1 ? [finding(d, 'endpoint:agents', `Multiple coding agents detected: ${ids.join(', ')}.`, { agentIds: ids })] : [];
  }),
  check('antigravity-browser-has-corporate-sessions', async (_inv, ctx) => {
    const d = checkDef('antigravity-browser-has-corporate-sessions');
    const domains = corporateDomains(ctx); const hosts = await antigravityCookieHosts(ctx);
    const matches = hosts.filter(h => domains.some(dom => hostMatches(dom, h.replace(/^\./, '')) || hostMatches(dom, h)));
    return matches.length ? [finding(d, 'antigravity-browser:cookies', 'Antigravity browser profile has cookies for corporate SaaS domains.', { matchedHosts: matches.slice(0, 20), matchCount: matches.length })] : [];
  }),
  check('antigravity-parallel-agents', async (_inv, ctx) => {
    const d = checkDef('antigravity-parallel-agents'); const root = joinHome(ctx, '.gemini', 'antigravity'); const entries = (await listSafe(ctx, root)).filter(e => !e.startsWith('.'));
    return entries.length > 1 ? [finding(d, root, `Antigravity has ${entries.length} workspace/conversation directories.`, { path: root, count: entries.length, entries: entries.slice(0, 10) })] : [];
  }),
  check('antigravity-multiple-google-accounts', async (_inv, ctx) => {
    const d = checkDef('antigravity-multiple-google-accounts'); const files = [path.join(appData(ctx), 'Antigravity', 'User', 'globalStorage', 'state.vscdb'), joinHome(ctx, '.gemini', 'antigravity-cli', 'settings.json')]; const emails = new Set<string>();
    for (const f of files) { const txt = await tryFile(ctx, f); if (txt) for (const e of collectStrings(parseJsonc(txt) ?? txt, /[^@\s"']+@[^@\s"']+\.[^@\s"']+/g, [], 20)) emails.add(e); }
    return emails.size > 1 ? [finding(d, 'antigravity:accounts', 'Multiple Google accounts are linked in Antigravity.', { accounts: [...emails].map(maskEmail), count: emails.size })] : [];
  }),
  check('aider-api-key-in-config', async (_inv, ctx) => {
    const d = checkDef('aider-api-key-in-config'); const files = [joinHome(ctx, '.aider.conf.yml'), joinHome(ctx, '.env'), joinHome(ctx, '.aider', 'oauth-keys.env')]; const out: PostureFindingDraft[] = [];
    for (const f of files) { const txt = await tryFile(ctx, f); if (!txt) continue; const hits = detect(txt).filter(h => h.cls === 'secret'); if (hits.length || /(?:openai|anthropic|api-key)\s*[:=]\s*(?!\$\{|%|env:|<)/i.test(txt)) out.push(finding(d, subjectForFile(f), 'Aider configuration contains hardcoded API key material.', { path: f, detectors: hits.map(h => ({ key: h.key, maskedSample: h.maskedSample })) })); }
    return out;
  }),
  check('ai-clipboard-access', inv => {
    const d = checkDef('ai-clipboard-access'); return inv.extensions.filter(e => ['chrome', 'edge', 'brave'].includes(e.host) && (e.permissions ?? []).includes('clipboardRead') && isAiExtension(e.id, `${e.name ?? ''}`)).map(e => finding(d, `${e.host}:${e.id}@${e.version ?? 'unknown'}`, `AI extension ${e.name ?? e.id} can read clipboard contents.`, { permissions: e.permissions, version: e.version }));
  }),
  check('ai-agent-sprawl', inv => {
    const d = checkDef('ai-agent-sprawl'); const ids = allAiAgentIds(inv);
    return ids.length > 3 ? [finding(d, 'endpoint:agents', `Endpoint has ${ids.length} AI agents installed or running.`, { agentIds: ids, count: ids.length })] : [];
  }),
  check('cli-agent-scheduled-execution', inv => {
    const d = checkDef('cli-agent-scheduled-execution'); return inv.scheduledTasks.map(t => finding(d, `${t.source}:${t.name}`, `Scheduled task launches AI coding agent ${t.agentId ?? 'unknown'}.`, { source: t.source, name: t.name, command: redactCommand(t.command), agentId: t.agentId }));
  }),
  check('kiro-third-party-power-installed', async (_inv, ctx) => {
    const d = checkDef('kiro-third-party-power-installed'); const root = joinHome(ctx, '.kiro', 'powers'); const out: PostureFindingDraft[] = [];
    for (const p of await listSafe(ctx, root)) {
      const dir = path.join(root, p); const manifest = asRecord(await readJson(ctx, path.join(dir, 'plugin.json'))) ?? asRecord(await readJson(ctx, path.join(dir, 'power.json')));
      const src = String(getPath(manifest, 'source') ?? getPath(manifest, 'registry') ?? getPath(manifest, 'repository') ?? '');
      if (manifest && !/github\.com[/:]kirodotdev\/powers|kiro\.dev\/powers/i.test(src)) out.push(finding(d, `kiro-power:${p}`, `Kiro power ${p} is installed from a non-official source.`, { path: dir, source: src || 'unknown' }));
    }
    return out;
  }),
];

async function settingsFiles(ctx: ScanContext): Promise<string[]> {
  const files: string[] = [];
  const base = appData(ctx);
  for (const p of SETTINGS_PRODUCTS) {
    const user = path.join(base, p.dir, 'User');
    const f = path.join(user, 'settings.json'); if (await existsSafe(ctx, f)) files.push(f);
    const profiles = path.join(user, 'profiles');
    for (const prof of await listSafe(ctx, profiles)) { const pf = path.join(profiles, prof, 'settings.json'); if (await existsSafe(ctx, pf)) files.push(pf); }
  }
  return files;
}

function isBroadAllow(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'string') return /^(\*|bash|sh|zsh|cmd|powershell|Bash|Bash\(\*\)|PowerShell\(\*\))$/i.test(v);
  if (Array.isArray(v)) return v.some(isBroadAllow);
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).some(([k, val]) => boolish(val) && /(\*|\.\*|bash|sh|cmd|powershell|Bash\(\*\)|PowerShell\(\*\))/.test(k));
  return false;
}

function codingAgentIds(inv: EndpointInventory): string[] {
  const skip = new Set(['vscode', 'vscode-insiders', 'vscodium']);
  return [...new Set(inv.agents.filter(a => a.kind !== 'browser-extension').map(a => a.id).filter(id => !skip.has(id)))].sort();
}

function allAiAgentIds(inv: EndpointInventory): string[] {
  const skip = new Set(['vscode', 'vscode-insiders', 'vscodium']);
  return [...new Set(inv.agents.map(a => a.id).filter(id => !skip.has(id)))].sort();
}

function maskEmail(e: string): string { const domain = normalizeEmailDomain(e); return domain ? `${e[0] ?? ''}***@${domain}` : e; }
function redactCommand(c: string): string { return c.replace(/(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AIza[0-9A-Za-z_-]{12,})/g, m => `${m.slice(0, 4)}****${m.slice(-4)}`); }

function corporateDomains(ctx: ScanContext): string[] {
  const defaults = expandHostValues(['collab_atlassian', 'collab_slack', 'collab_notion', 'collab_google', 'cloud_azure']).concat(['*.salesforce.com', '*.sharepoint.com', '*.office.com', '*.microsoft.com']);
  return [...new Set([...(ctx.orgDomains ?? []).map(d => `*.${d}`), ...(ctx.corporateSaasDomains ?? []), ...defaults])];
}

async function antigravityCookieHosts(ctx: ScanContext): Promise<string[]> {
  const roots = [joinHome(ctx, '.gemini', 'antigravity-browser-profile'), path.join(localAppData(ctx), 'Google', 'Antigravity', 'User Data')];
  const files: string[] = [];
  for (const r of roots) for (const p of ['Default', 'Profile 1']) for (const f of ['Network/Cookies', 'Cookies']) { const fp = path.join(r, p, ...f.split('/')); if (await existsSafe(ctx, fp)) files.push(fp); }
  const hosts = new Set<string>();
  for (const f of files) {
    const sqliteHosts = readCookieHostsSqlite(f);
    for (const h of sqliteHosts) hosts.add(h);
    if (!sqliteHosts.length) {
      const txt = await tryFile(ctx, f);
      if (txt) for (const m of txt.matchAll(/\.?[a-z0-9.-]+\.(?:com|net|org|io|so|app|dev)/ig)) hosts.add(m[0].toLowerCase());
    }
  }
  return [...hosts];
}

function readCookieHostsSqlite(file: string): string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sqlite = require('node:sqlite') as { DatabaseSync?: new (p: string, opts?: { readOnly?: boolean }) => { prepare(sql: string): { all(): { host_key: string }[] }; close(): void } };
    if (!sqlite.DatabaseSync) return [];
    const db = new sqlite.DatabaseSync(file, { readOnly: true });
    try { return db.prepare('SELECT DISTINCT host_key FROM cookies').all().map(r => r.host_key).filter(Boolean); } finally { db.close(); }
  } catch { return []; }
}
