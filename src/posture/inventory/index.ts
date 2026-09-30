import path from 'path';
import type { EndpointInventory, InventoryAgent, InventoryExtension, InventoryScheduledTask, ScanContext } from '../types';
import { appData, asRecord, collectStrings, existsSafe, getPath, inferMcp, joinHome, knownCliId, listSafe, localAppData, parseJsonc, parseSimpleToml, readJson, scheduledCliId, tryFile } from '../utils';

const IDE_PRODUCTS = [
  { id: 'vscode', name: 'VS Code', host: 'vscode' as const, userData: 'Code', extDir: '.vscode' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', host: 'vscode' as const, userData: 'Code - Insiders', extDir: '.vscode-insiders' },
  { id: 'vscodium', name: 'VSCodium', host: 'vscode' as const, userData: 'VSCodium', extDir: '.vscode-oss' },
  { id: 'cursor', name: 'Cursor', host: 'cursor' as const, userData: 'Cursor', extDir: '.cursor' },
  { id: 'windsurf', name: 'Windsurf', host: 'windsurf' as const, userData: 'Windsurf', extDir: '.windsurf' },
  { id: 'devin-desktop', name: 'Devin Desktop', host: 'windsurf' as const, userData: 'Devin', extDir: '.windsurf' },
  { id: 'kiro', name: 'Kiro', host: 'kiro' as const, userData: 'Kiro', extDir: '.kiro' },
  { id: 'antigravity', name: 'Antigravity', host: 'antigravity' as const, userData: 'Antigravity', extDir: '.antigravity' },
];

export async function collectInventory(ctx: ScanContext): Promise<EndpointInventory> {
  const inv: EndpointInventory = { agents: [], mcpServers: [], extensions: [], scheduledTasks: [], accounts: [], errors: [] };
  const tasks: [string, () => Promise<void>][] = [
    ['ide', () => collectIde(ctx, inv)],
    ['cli', () => collectCli(ctx, inv)],
    ['claude-desktop', () => collectClaudeDesktop(ctx, inv)],
    ['browser', () => collectBrowserExtensions(ctx, inv)],
    ['mcp', () => collectMcp(ctx, inv)],
    ['scheduled', () => collectScheduled(ctx, inv)],
  ];
  for (const [name, fn] of tasks) {
    try { await fn(); } catch (e) { inv.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  dedupe(inv);
  return inv;
}

function addAgent(inv: EndpointInventory, agent: InventoryAgent): void {
  const found = inv.agents.find(a => a.id === agent.id && a.installPath === agent.installPath);
  if (found) {
    found.configPaths = [...new Set([...found.configPaths, ...agent.configPaths])];
    found.version = found.version ?? agent.version;
    found.running = found.running || agent.running;
    found.elevated = found.elevated || agent.elevated;
    found.accounts = [...new Set([...(found.accounts ?? []), ...(agent.accounts ?? [])])];
  } else inv.agents.push(agent);
}

async function collectIde(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  const base = appData(ctx);
  for (const p of IDE_PRODUCTS) {
    const userDir = path.join(base, p.userData, 'User');
    const settings = path.join(userDir, 'settings.json');
    const configPaths: string[] = [];
    if (await existsSafe(ctx, settings)) configPaths.push(settings);
    const profiles = path.join(userDir, 'profiles');
    for (const profile of await listSafe(ctx, profiles)) {
      const fp = path.join(profiles, profile, 'settings.json');
      if (await existsSafe(ctx, fp)) configPaths.push(fp);
    }
    if (configPaths.length || await existsSafe(ctx, userDir)) addAgent(inv, { id: p.id, name: p.name, kind: 'ide', installPath: userDir, configPaths });
    await collectVsixExtensions(ctx, inv, p.host, path.join(ctx.home, p.extDir, 'extensions'));
    await collectVsixExtensions(ctx, inv, p.host, path.join(userDir, 'extensions'));
  }
}

async function collectVsixExtensions(ctx: ScanContext, inv: EndpointInventory, host: InventoryExtension['host'], extRoot: string): Promise<void> {
  for (const entry of (await listSafe(ctx, extRoot)).slice(0, 500)) {
    const full = path.join(extRoot, entry);
    const st = await ctx.stat(full);
    if (!st?.isDir) continue;
    const pkgFile = path.join(full, 'package.json');
    const pkg = asRecord(await readJson(ctx, pkgFile));
    if (!pkg) continue;
    const publisher = typeof pkg.publisher === 'string' ? pkg.publisher : undefined;
    const name = typeof pkg.name === 'string' ? pkg.name : entry;
    const id = publisher ? `${publisher}.${name}` : name;
    inv.extensions.push({ id, name: typeof pkg.displayName === 'string' ? pkg.displayName : name, version: typeof pkg.version === 'string' ? pkg.version : undefined, host, publisher, path: full });
    if (/claude|copilot|cursor|cline|codeium|windsurf|kiro|continue|gemini|codex|aider|amazon q/i.test(`${id} ${String(pkg.displayName ?? '')}`)) {
      addAgent(inv, { id: id.toLowerCase(), name: String(pkg.displayName ?? id), kind: 'extension', version: typeof pkg.version === 'string' ? pkg.version : undefined, installPath: full, configPaths: [] });
    }
  }
}

async function collectCli(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  const candidates = [
    { id: 'claude-code', name: 'Claude Code', dir: joinHome(ctx, '.claude'), files: ['settings.json', 'history.jsonl'] },
    { id: 'gemini-cli', name: 'Gemini CLI', dir: joinHome(ctx, '.gemini'), files: ['settings.json', 'oauth_creds.json', 'google_accounts.json'] },
    { id: 'aider', name: 'Aider', dir: ctx.home, files: ['.aider.conf.yml'] },
    { id: 'plandex', name: 'Plandex', dir: joinHome(ctx, '.plandex-home-v2'), files: ['auth.json', 'accounts.json'] },
    { id: 'openhands', name: 'OpenHands', dir: joinHome(ctx, '.openhands'), files: ['settings.json', 'config.toml', 'agent_settings.json', 'cli_config.json'] },
    { id: 'codex-cli', name: 'Codex CLI', dir: ctx.env.CODEX_HOME ?? joinHome(ctx, '.codex'), files: ['config.toml', 'auth.json'] },
    { id: 'copilot-cli', name: 'GitHub Copilot CLI', dir: ctx.env.COPILOT_HOME ?? joinHome(ctx, '.copilot'), files: ['config.json', 'settings.json', 'permissions-config.json', 'mcp-config.json'] },
    { id: 'antigravity', name: 'Antigravity CLI', dir: joinHome(ctx, '.gemini', 'antigravity-cli'), files: ['settings.json'] },
    { id: 'kiro', name: 'Kiro CLI', dir: joinHome(ctx, '.kiro', 'settings'), files: ['cli.json', 'mcp.json', 'permissions.yaml'] },
  ];
  for (const c of candidates) {
    const configPaths: string[] = [];
    for (const f of c.files) { const fp = path.join(c.dir, f); if (await existsSafe(ctx, fp)) configPaths.push(fp); }
    if (configPaths.length || await existsSafe(ctx, c.dir)) addAgent(inv, { id: c.id, name: c.name, kind: 'cli', configPaths, installPath: c.dir });
  }
  const claudeState = asRecord(await readJson(ctx, joinHome(ctx, '.claude.json')));
  const claudeEmail = typeof getPath(claudeState, 'oauthAccount.emailAddress') === 'string' ? String(getPath(claudeState, 'oauthAccount.emailAddress')) : undefined;
  if (claudeEmail) { inv.accounts.push({ agentId: 'claude-code', account: claudeEmail }); addAgent(inv, { id: 'claude-code', name: 'Claude Code', kind: 'cli', configPaths: [joinHome(ctx, '.claude.json')], accounts: [claudeEmail] }); }
  const gemAccounts = asRecord(await readJson(ctx, joinHome(ctx, '.gemini', 'google_accounts.json')));
  for (const acct of collectStrings(gemAccounts, /[^@\s]+@[^@\s]+\.[^@\s]+/g)) inv.accounts.push({ agentId: 'gemini-cli', account: acct });
  await collectProcesses(ctx, inv);
}

async function collectProcesses(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  for (const p of await ctx.processes()) {
    const id = knownCliId(p.cmdline, p.name);
    if (!id) continue;
    addAgent(inv, { id, name: id, kind: 'cli', configPaths: [], running: true, elevated: !!p.elevated || p.user === 'root' });
  }
}

async function collectClaudeDesktop(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  const dirs = ctx.platform === 'win32'
    ? [path.join(appData(ctx), 'Claude'), path.join(localAppData(ctx), 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude')]
    : ctx.platform === 'darwin' ? [path.join(appData(ctx), 'Claude')] : [];
  for (const dir of dirs) {
    const configPaths: string[] = [];
    const cfg = path.join(dir, 'claude_desktop_config.json');
    if (await existsSafe(ctx, cfg)) configPaths.push(cfg);
    if (configPaths.length || await existsSafe(ctx, dir)) addAgent(inv, { id: 'claude-desktop', name: 'Claude Desktop', kind: 'desktop', installPath: dir, configPaths });
    const extRoot = path.join(dir, 'Claude Extensions');
    for (const ext of await listSafe(ctx, extRoot)) {
      const manifest = asRecord(await readJson(ctx, path.join(extRoot, ext, 'manifest.json')));
      if (!manifest) continue;
      const author = asRecord(manifest.author);
      inv.extensions.push({ id: ext, name: typeof manifest.name === 'string' ? manifest.name : ext, version: typeof manifest.version === 'string' ? manifest.version : undefined, host: 'claude-desktop', publisher: typeof author?.name === 'string' ? author.name : undefined, path: path.join(extRoot, ext), permissions: collectStrings(manifest, /mcp|server|tool/i) });
    }
  }
}

async function collectBrowserExtensions(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  const roots: { host: InventoryExtension['host']; root: string }[] = [];
  const la = localAppData(ctx);
  if (ctx.platform === 'win32') {
    roots.push({ host: 'chrome', root: path.join(la, 'Google', 'Chrome', 'User Data') }, { host: 'edge', root: path.join(la, 'Microsoft', 'Edge', 'User Data') }, { host: 'brave', root: path.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data') });
  } else if (ctx.platform === 'darwin') {
    roots.push({ host: 'chrome', root: path.join(la, 'Google', 'Chrome') }, { host: 'edge', root: path.join(la, 'Microsoft Edge') }, { host: 'brave', root: path.join(la, 'BraveSoftware', 'Brave-Browser') });
  } else {
    roots.push({ host: 'chrome', root: path.join(la, 'google-chrome') }, { host: 'edge', root: path.join(la, 'microsoft-edge') }, { host: 'brave', root: path.join(la, 'BraveSoftware', 'Brave-Browser') });
  }
  for (const { host, root } of roots) {
    const profiles = new Set(['Default', 'Profile 1', 'Profile 2']);
    const localState = asRecord(await readJson(ctx, path.join(root, 'Local State')));
    const cache = asRecord(getPath(localState, 'profile.info_cache'));
    if (cache) for (const p of Object.keys(cache)) profiles.add(p);
    for (const profile of profiles) {
      const extBase = path.join(root, profile, 'Extensions');
      for (const id of await listSafe(ctx, extBase)) {
        const idDir = path.join(extBase, id);
        const versions = await listSafe(ctx, idDir);
        const version = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
        if (!version) continue;
        const dir = path.join(idDir, version);
        const manifest = asRecord(await readJson(ctx, path.join(dir, 'manifest.json')));
        if (!manifest) continue;
        const localizedName = await resolveChromeMessage(ctx, dir, manifest, typeof manifest.name === 'string' ? manifest.name : id);
        const localizedDescription = await resolveChromeMessage(ctx, dir, manifest, typeof manifest.description === 'string' ? manifest.description : '');
        const permissions = [
          ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
          ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
          ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
        ].filter(v => typeof v === 'string') as string[];
        const cs = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
        for (const c of cs) if (asRecord(c) && Array.isArray((c as Record<string, unknown>).matches)) permissions.push(...((c as Record<string, unknown>).matches as unknown[]).filter(v => typeof v === 'string') as string[]);
        const name = localizedName || id;
        inv.extensions.push({ id, name, version: typeof manifest.version === 'string' ? manifest.version : version.replace(/_\d+$/, ''), host, permissions, path: dir });
        if (isAiExtension(id, `${name} ${localizedDescription}`)) addAgent(inv, { id: `browser:${id}`, name, kind: 'browser-extension', version: typeof manifest.version === 'string' ? manifest.version : undefined, installPath: dir, configPaths: [] });
      }
    }
  }
}

export function isAiExtension(id: string, text: string): boolean {
  return /\b(?:ai|gpt|chatgpt|claude|gemini|copilot|deepseek|llm|openai|anthropic|perplexity|mistral)\b/i.test(text) || ['fnmihdojmnkclgjpcoonokmkhjpjechg', 'inhcgfpbfdjbjogdfjbclgolkmhnooop', 'eppiocemhmnlbhjplcgkofciiegomcon', 'nimlmejbmnecnaghgmbahmbaddhjbecg'].includes(id);
}

async function resolveChromeMessage(ctx: ScanContext, extDir: string, manifest: Record<string, unknown>, value: string): Promise<string> {
  const msg = /^__MSG_(.+)__$/i.exec(value);
  if (!msg) return value;
  const locales = [typeof manifest.default_locale === 'string' ? manifest.default_locale : undefined, 'en'].filter(Boolean) as string[];
  for (const locale of locales) {
    const messages = asRecord(await readJson(ctx, path.join(extDir, '_locales', locale, 'messages.json')));
    if (!messages) continue;
    const wanted = msg[1].toLowerCase();
    const key = Object.keys(messages).find(k => k.toLowerCase() === wanted);
    const rec = key ? asRecord(messages[key]) : undefined;
    if (typeof rec?.message === 'string') return rec.message;
  }
  return value;
}

async function collectMcp(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  const paths = [
    { client: 'claude-code', file: joinHome(ctx, '.claude.json'), type: 'json' },
    { client: 'claude-code', file: joinHome(ctx, '.claude', 'settings.json'), type: 'json' },
    { client: 'claude-desktop', file: path.join(appData(ctx), 'Claude', 'claude_desktop_config.json'), type: 'json' },
    { client: 'cursor', file: joinHome(ctx, '.cursor', 'mcp.json'), type: 'json' },
    { client: 'gemini-cli', file: joinHome(ctx, '.gemini', 'settings.json'), type: 'json' },
    { client: 'codex-cli', file: path.join(ctx.env.CODEX_HOME ?? joinHome(ctx, '.codex'), 'config.toml'), type: 'toml' },
    { client: 'copilot-cli', file: path.join(ctx.env.COPILOT_HOME ?? joinHome(ctx, '.copilot'), 'mcp-config.json'), type: 'json' },
    { client: 'kiro', file: joinHome(ctx, '.kiro', 'settings', 'mcp.json'), type: 'json' },
    { client: 'antigravity', file: joinHome(ctx, '.gemini', 'antigravity-cli', 'settings.json'), type: 'json' },
  ];
  for (const ide of IDE_PRODUCTS) paths.push({ client: ide.id, file: path.join(appData(ctx), ide.userData, 'User', 'mcp.json'), type: 'json' }, { client: ide.id, file: path.join(appData(ctx), ide.userData, 'User', 'settings.json'), type: 'json' });
  for (const p of paths) {
    const text = await tryFile(ctx, p.file);
    if (!text) continue;
    if (p.type === 'toml') collectTomlMcp(text, p.client, p.file, inv);
    else collectJsonMcp(parseJsonc(text), p.client, p.file, inv);
  }
}

function collectJsonMcp(obj: unknown, client: string, file: string, inv: EndpointInventory): void {
  const candidates = [getPath(obj, 'mcpServers'), getPath(obj, 'mcp.servers')];
  const projects = asRecord(getPath(obj, 'projects'));
  if (projects) for (const v of Object.values(projects)) candidates.push(getPath(v, 'mcpServers'));
  for (const c of candidates) {
    const rec = asRecord(c);
    if (!rec) continue;
    for (const [name, raw] of Object.entries(rec)) if (asRecord(raw)) inv.mcpServers.push(inferMcp(name, raw as Record<string, unknown>, client, file));
  }
}

function collectTomlMcp(text: string, client: string, file: string, inv: EndpointInventory): void {
  const re = /^\[mcp_servers\.([^\]]+)\]([\s\S]*?)(?=^\[|\z)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = parseSimpleToml(m[2]);
    inv.mcpServers.push(inferMcp(m[1].replace(/^['"]|['"]$/g, ''), raw, client, file));
  }
}

async function collectScheduled(ctx: ScanContext, inv: EndpointInventory): Promise<void> {
  if (ctx.platform === 'win32') {
    const script = "Get-ScheduledTask | ForEach-Object { [pscustomobject]@{ name = $_.TaskPath + $_.TaskName; actions = @($_.Actions | ForEach-Object { ($_.Execute + ' ' + $_.Arguments).Trim() }) } } | ConvertTo-Json -Compress -Depth 3";
    const out = await ctx.exec('powershell.exe', ['-NoProfile', '-Command', script], 15000);
    if (out?.stdout) parseWindowsScheduled(out.stdout, inv);
  } else {
    const cron = await ctx.exec('crontab', ['-l'], 3000);
    if (cron?.stdout) parseCron(cron.stdout, inv);
    const launch = ctx.platform === 'darwin' ? joinHome(ctx, 'Library', 'LaunchAgents') : joinHome(ctx, '.config', 'systemd', 'user');
    const source = ctx.platform === 'darwin' ? 'launchd' : 'systemd';
    for (const f of await listSafe(ctx, launch)) {
      const txt = await tryFile(ctx, path.join(launch, f));
      if (txt) parseServiceFile(txt, source, inv, f);
    }
  }
}

function parseWindowsScheduled(text: string, inv: EndpointInventory): void {
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    for (const row of rows) {
      const rec = asRecord(row);
      if (!rec || typeof rec.name !== 'string') continue;
      const actions = Array.isArray(rec.actions) ? rec.actions : [rec.actions];
      for (const action of actions.filter((a): a is string => typeof a === 'string' && !!a.trim())) {
        const id = scheduledCliId(action);
        if (id) { inv.scheduledTasks.push({ source: 'schtasks', name: rec.name, command: action.trim(), agentId: id }); break; }
      }
    }
  } catch { /* ignore malformed task output */ }
}

function parseCron(text: string, inv: EndpointInventory): void {
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return;
    const id = scheduledCliId(line);
    if (id) inv.scheduledTasks.push({ source: 'cron', name: `crontab:${i + 1}`, command: line, agentId: id });
  });
}

function parseServiceFile(text: string, source: 'launchd' | 'systemd', inv: EndpointInventory, name: string): void {
  const actions: string[] = [];
  if (source === 'systemd') {
    for (const m of text.matchAll(/^\s*ExecStart\s*=\s*(.+)$/gm)) actions.push(m[1].trim());
  } else {
    const block = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(text)?.[1];
    if (block) actions.push([...block.matchAll(/<string>([\s\S]*?)<\/string>/gi)].map(m => m[1].trim()).join(' '));
    for (const m of text.matchAll(/<key>Program<\/key>\s*<string>([\s\S]*?)<\/string>/gi)) actions.push(m[1].trim());
  }
  for (const action of actions) {
    const id = scheduledCliId(action);
    if (id) { inv.scheduledTasks.push({ source, name, command: action, agentId: id }); break; }
  }
}

function dedupe(inv: EndpointInventory): void {
  inv.agents = [...new Map(inv.agents.map(a => [`${a.id}\0${a.installPath ?? ''}`, a])).values()];
  inv.extensions = [...new Map(inv.extensions.map(e => [`${e.host}\0${e.id}\0${e.version ?? ''}`, e])).values()];
  inv.mcpServers = [...new Map(inv.mcpServers.map(s => [`${s.client}\0${s.configPath}\0${s.name}`, s])).values()];
  inv.accounts = [...new Map(inv.accounts.map(a => [`${a.agentId}\0${a.account}`, a])).values()];
}
