import path from 'path';
import { createHash } from 'crypto';
import type { ScanContext, PostureCheckDef, PostureFindingDraft, InventoryMcpServer } from './types';
import { listPresets, mcpCategoriesFor } from '../policies/presets';

export const ALL_PLATFORMS: ('win32' | 'darwin' | 'linux')[] = ['win32', 'darwin', 'linux'];
export const SCANNER_VERSION = '0.1.0';
export const CAPPED_FILE_BYTES = 2 * 1024 * 1024;
export const CAPPED_TOTAL_BYTES = 50 * 1024 * 1024;

export function stableEndpointId(hostname: string, user: string): string {
  return createHash('sha256').update(`${hostname}\0${user}`).digest('hex').slice(0, 16);
}

export function stripJsonComments(text: string): string {
  let out = '';
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export function parseJsonc(text: string | null): unknown {
  if (!text) return undefined;
  try { return JSON.parse(stripJsonComments(text)); } catch { return undefined; }
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

export function getPath(obj: unknown, dotted: string): unknown {
  const top = asRecord(obj);
  if (top && dotted in top) return top[dotted];
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    const rec = asRecord(cur);
    if (!rec || !(part in rec)) return undefined;
    cur = rec[part];
  }
  return cur;
}

export function boolish(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

export function subjectForFile(file: string, suffix?: string): string {
  return `file:${file}${suffix ? `#${suffix}` : ''}`;
}

export function fileFromSubject(subject: string): string | null {
  if (!subject.startsWith('file:')) return null;
  return subject.slice(5).split('#')[0];
}

export function finding(def: PostureCheckDef, subject: string, summary: string, evidence: Record<string, unknown> = {}): PostureFindingDraft {
  return { checkId: def.id, severity: def.severity, category: def.category, title: def.title, subject, summary, evidence: sanitizeEvidence(evidence), fixable: !!def.remediation.autoFix };
}

function sanitizeEvidence(e: Record<string, unknown>): Record<string, unknown> {
  const deny = /(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})/g;
  const clean = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(deny, m => `${m.slice(0, 4)}****${m.slice(-4)}`);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, clean(val)]));
    return v;
  };
  return clean(e) as Record<string, unknown>;
}

export function joinHome(ctx: Pick<ScanContext, 'home'>, ...parts: string[]): string {
  return path.join(ctx.home, ...parts);
}

export function appData(ctx: Pick<ScanContext, 'home' | 'env' | 'platform'>): string {
  if (ctx.platform === 'win32') return ctx.env.APPDATA ?? ctx.env.AppData ?? path.join(ctx.home, 'AppData', 'Roaming');
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support');
  return path.join(ctx.home, '.config');
}

export function localAppData(ctx: Pick<ScanContext, 'home' | 'env' | 'platform'>): string {
  if (ctx.platform === 'win32') return ctx.env.LOCALAPPDATA ?? path.join(ctx.home, 'AppData', 'Local');
  if (ctx.platform === 'darwin') return path.join(ctx.home, 'Library', 'Application Support');
  return path.join(ctx.home, '.config');
}

export async function readJson(ctx: ScanContext, file: string): Promise<unknown> {
  return parseJsonc(await ctx.readFile(file));
}

export async function tryFile(ctx: ScanContext, file: string): Promise<string | null> {
  try { return await ctx.readFile(file); } catch { return null; }
}

export async function listSafe(ctx: ScanContext, dir: string): Promise<string[]> {
  try { return await ctx.listDir(dir); } catch { return []; }
}

export async function existsSafe(ctx: ScanContext, p: string): Promise<boolean> {
  try { return await ctx.exists(p); } catch { return false; }
}

export function collectStrings(value: unknown, re: RegExp, out: string[] = [], limit = 20): string[] {
  if (out.length >= limit) return out;
  if (typeof value === 'string') {
    re.lastIndex = 0;
    if (re.test(value)) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, re, out, limit);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, re, out, limit);
  }
  return out;
}

export function normalizeEmailDomain(email: string): string | null {
  const m = /@([^@\s>]+)$/i.exec(email.trim());
  return m ? m[1].toLowerCase() : null;
}

export function domainMatchesOrg(domain: string, orgDomains: string[]): boolean {
  const d = domain.toLowerCase();
  return orgDomains.some(o => d === o.toLowerCase() || d.endsWith(`.${o.toLowerCase()}`));
}

export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const val = m[2].trim();
    out[m[1]] = /^(true|false)$/i.test(val) ? /^true$/i.test(val) : val.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function parseSimpleToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cur = root;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      cur = root;
      for (const part of sec[1].split('.')) cur = (cur[part] ??= {}) as Record<string, unknown>;
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim();
    cur[m[1]] = /^(true|false)$/i.test(v) ? /^true$/i.test(v) : v.replace(/^['"]|['"]$/g, '');
  }
  return root;
}

export function semverCompare(a: string, b: string): number {
  const pa = a.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const pb = b.split(/[^0-9A-Za-z]+/).filter(Boolean);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? '0'; const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN; const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const c = Number.isNaN(nx) || Number.isNaN(ny) ? x.localeCompare(y) : nx - ny;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

export function versionInRange(version: string | undefined, below?: string, affected?: string): boolean {
  if (!version) return true;
  if (affected) {
    if (/^=/.test(affected)) return version === affected.slice(1).trim();
    if (/^all$/i.test(affected)) return true;
    const exact = /^([0-9][^,\s]*)$/.exec(affected.trim());
    if (exact) return version === exact[1];
    const lower = />=\s*([^,\s]+)/.exec(affected);
    const upper = /<\s*([^,\s]+)/.exec(affected);
    if (lower && semverCompare(version, lower[1]) < 0) return false;
    if (upper && semverCompare(version, upper[1]) >= 0) return false;
    return !!(lower || upper);
  }
  return below ? semverCompare(version, below) < 0 : false;
}

export function mcpCategoryIds(): string[] {
  return (listPresets('mcpCategory') as { id: string }[]).map(p => p.id);
}

export function inferMcp(serverName: string, raw: Record<string, unknown>, client: string, configPath: string): InventoryMcpServer {
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  const args = Array.isArray(raw.args) ? raw.args.filter(a => typeof a === 'string') as string[] : [];
  const url = typeof raw.url === 'string' ? raw.url : (typeof raw.endpoint === 'string' ? raw.endpoint : undefined);
  const identities: string[] = [];
  let pkg: string | undefined;
  const cmdBase = (command ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  const argText = args.join(' ');
  if (url) {
    try { identities.push(new URL(url).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  if (/npx|npm|pnpm|yarn|bunx/.test(cmdBase)) {
    pkg = args.find(a => !a.startsWith('-') && !/^(run|exec|dlx)$/i.test(a));
    if (pkg) identities.push(`npm:${pkg}`);
  } else if (/uvx|pipx|python|pip/.test(cmdBase)) {
    pkg = args.find(a => !a.startsWith('-') && !/^(run|install)$/i.test(a));
    if (pkg) identities.push(`pypi:${pkg}`);
  } else if (/docker|podman/.test(cmdBase)) {
    const idx = args.findIndex(a => a === 'run');
    // Skip option values (`-e TOKEN=…`, `-v a:b`, `--name x`) so an env secret is never taken as the image.
    const VALUE_OPTS = new Set(['-e', '--env', '-v', '--volume', '--name', '-p', '--publish', '--env-file', '-w', '--workdir', '--network', '--mount', '-u', '--user', '--entrypoint', '-l', '--label']);
    const rest = args.slice(idx + 1);
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (VALUE_OPTS.has(a)) { i++; continue; }
      if (a.startsWith('-') || a.includes('=')) continue;
      pkg = a;
      break;
    }
    if (pkg) identities.push(`docker:${pkg}`);
  } else if (command) {
    const atPkg = /(@[\w.-]+\/[\w.-]+|[\w.-]+\/mcp[\w.-]*|mcp-[\w.-]+)/i.exec(`${command} ${argText}`);
    if (atPkg) { pkg = atPkg[1]; identities.push(`npm:${pkg}`); }
  }
  const transport: InventoryMcpServer['transport'] = url ? (/sse/i.test(String(raw.transport)) ? 'sse' : 'http') : command ? 'stdio' : 'unknown';
  const categories = mcpCategoriesFor({ server: serverName, identities }, mcpCategoryIds());
  return { name: serverName, client, configPath, transport, command, package: pkg, url, identities, categories };
}

const CLI_EXECUTABLES: Record<string, string> = {
  claude: 'claude-code',
  aider: 'aider',
  gemini: 'gemini-cli',
  codex: 'codex-cli',
  copilot: 'copilot-cli',
  plandex: 'plandex',
  pdx: 'plandex',
  openhands: 'openhands',
  goose: 'goose',
  amp: 'amp',
  opencode: 'opencode',
  agy: 'antigravity',
};

const INTERPRETERS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'pythonw', 'uv', 'pipx']);

const INTERPRETER_PACKAGES: [RegExp, string][] = [
  [/@anthropic-ai[\\/\s]+claude-code(?:[\\/\s"']|$)/i, 'claude-code'],
  [/@google[\\/\s]+gemini-cli(?:[\\/\s"']|$)/i, 'gemini-cli'],
  [/@openai[\\/\s]+codex(?:[\\/\s"']|$)/i, 'codex-cli'],
  [/@github[\\/\s]+copilot(?:[\\/\s"']|$)/i, 'copilot-cli'],
  [/\bopencode-ai(?:[\\/\s"']|$)/i, 'opencode'],
  [/@sourcegraph[\\/\s]+amp(?:[\\/\s"']|$)/i, 'amp'],
  [/\baider-chat(?:[\\/\s"']|$)|[\\/]aider[\\/]/i, 'aider'],
  [/\bopenhands(?:[\\/\s"']|$)/i, 'openhands'],
  [/\bplandex(?:[\\/\s"']|$)/i, 'plandex'],
];

function firstCommandToken(cmdline: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(cmdline);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function commandBase(value: string): string {
  const base = value.replace(/\\/g, '/').split('/').pop() ?? value;
  return base.replace(/\.(?:exe|cmd|bat|ps1|js)$/i, '').toLowerCase();
}

function packageCliId(cmdline: string): string | null {
  if (/github\.copilot-chat/i.test(cmdline)) return null;
  return INTERPRETER_PACKAGES.find(([re]) => re.test(cmdline))?.[1] ?? null;
}

/** Identify a running CLI agent without matching incidental words in IDE extension hosts. */
export function knownCliId(cmdline: string, name = ''): string | null {
  const nameBase = commandBase(name);
  if (CLI_EXECUTABLES[nameBase]) return CLI_EXECUTABLES[nameBase];
  const exeBase = commandBase(firstCommandToken(cmdline));
  if (CLI_EXECUTABLES[exeBase]) return CLI_EXECUTABLES[exeBase];
  if (INTERPRETERS.has(exeBase) || INTERPRETERS.has(nameBase)) return packageCliId(cmdline);
  return null;
}

/** Identify scheduled action commands using executable/path token boundaries. */
export function scheduledCliId(command: string): string | null {
  const direct = knownCliId(command, commandBase(firstCommandToken(command)));
  if (direct) return direct;
  const pkg = packageCliId(command);
  if (pkg) return pkg;
  for (const [name, id] of Object.entries(CLI_EXECUTABLES)) {
    const re = new RegExp(`(?:^|[\\\\/\\s"'])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.exe|\\.cmd|\\.ps1|\\.js)?(?=[\\s"']|$)`, 'i');
    if (re.test(command)) return id;
  }
  return null;
}
