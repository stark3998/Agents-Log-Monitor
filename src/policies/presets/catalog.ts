import os from 'os';
import path from 'path';
import raw from './presets.json';

export type PresetKind = 'filesystem' | 'network' | 'credential' | 'capability' | 'mcpCategory';

export interface PresetEntry {
  id: string;
  group: string;
  label: string;
  pattern: string;
  description: string;
  subsetOf?: string;
  identities?: string;
}

interface RawCatalog {
  filesystemLocations: PresetEntry[];
  network: PresetEntry[];
  credentials: PresetEntry[];
  capabilities: PresetEntry[];
  mcp: PresetEntry[];
}

const catalog = raw as RawCatalog;

const BY_KIND: Record<PresetKind, PresetEntry[]> = {
  filesystem: catalog.filesystemLocations,
  network: catalog.network,
  credential: catalog.credentials,
  capability: catalog.capabilities,
  mcpCategory: catalog.mcp,
};

const INDEX: Record<PresetKind, Map<string, PresetEntry>> = Object.fromEntries(
  (Object.keys(BY_KIND) as PresetKind[]).map(k => [k, new Map(BY_KIND[k].map(e => [e.id, e]))]),
) as Record<PresetKind, Map<string, PresetEntry>>;

export const PRESET_KINDS = Object.keys(BY_KIND) as PresetKind[];

export function listPresets(kind?: PresetKind): Record<PresetKind, PresetEntry[]> | PresetEntry[] {
  if (kind) return BY_KIND[kind].map(e => ({ ...e }));
  return Object.fromEntries(PRESET_KINDS.map(k => [k, BY_KIND[k].map(e => ({ ...e }))])) as Record<PresetKind, PresetEntry[]>;
}

export function getPreset(kind: PresetKind, id: string): PresetEntry | undefined {
  return INDEX[kind].get(id);
}

export function isPresetId(kind: PresetKind, id: string): boolean {
  return INDEX[kind].has(id);
}

export function splitPattern(pattern: string): string[] {
  return pattern.split(/,\s*/).map(s => s.trim()).filter(Boolean);
}

export interface ExpandContext {
  workspace?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function winEnv(name: string, ctx: Required<Pick<ExpandContext, 'home' | 'env'>>): string | undefined {
  const upper = name.toUpperCase();
  const fromEnv = ctx.env[upper] ?? ctx.env[name];
  if (fromEnv) return fromEnv;
  if (upper === 'USERPROFILE') return ctx.home;
  if (upper === 'APPDATA') return path.join(ctx.home, 'AppData', 'Roaming');
  if (upper === 'LOCALAPPDATA') return path.join(ctx.home, 'AppData', 'Local');
  return undefined;
}

/**
 * Expand one path glob: `~`, `$WORKDIR`, `${workspace}` and (on Windows) `%VAR%`. Returns null when
 * the pattern cannot apply here (Windows-only variable on another OS, workspace unknown).
 */
export function expandPathGlob(glob: string, ctx: ExpandContext = {}): string | null {
  const home = ctx.home ?? os.homedir();
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  let out = glob.trim();
  if (out === '*') return '**';
  if (/\$WORKDIR|\$\{workspace\}/.test(out)) {
    if (!ctx.workspace) return null;
    out = out.replace(/\$WORKDIR|\$\{workspace\}/g, ctx.workspace.replace(/\\/g, '/'));
  }
  if (/%[A-Za-z_]+%/.test(out)) {
    if (platform !== 'win32') return null;
    let missing = false;
    out = out.replace(/%([A-Za-z_]+)%/g, (_m, name: string) => {
      const v = winEnv(name, { home, env });
      if (!v) missing = true;
      return v ?? '';
    });
    if (missing) return null;
  }
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) out = path.join(home, out.slice(2)) + (out.endsWith('/') || out.endsWith('\\') ? '/' : '');
  out = out.replace(/\\/g, '/');
  if (!out.includes('/')) out = `**/${out}`;
  return out;
}

/** Expand preset ids (or literal globs) of a path-like kind into concrete globs. */
export function expandPathValues(kind: 'filesystem' | 'credential', values: string[], ctx: ExpandContext = {}): string[] {
  const out: string[] = [];
  for (const v of values) {
    const preset = getPreset(kind, v) ?? (kind === 'credential' ? getPreset('filesystem', v) : getPreset('credential', v));
    const globs = preset ? splitPattern(preset.pattern) : [v];
    for (const g of globs) {
      const e = expandPathGlob(g, ctx);
      if (e) out.push(e);
    }
  }
  return [...new Set(out)];
}

/** Expand network preset ids (or literal host globs) into host globs; URL paths are dropped. */
export function expandHostValues(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const preset = getPreset('network', v);
    for (const g of preset ? splitPattern(preset.pattern) : [v]) {
      const host = g.replace(/^[a-z]+:\/\//i, '').split('/')[0].toLowerCase();
      if (host) out.push(host);
    }
  }
  return [...new Set(out)];
}

function hostGlobRe(glob: string): RegExp {
  const esc = glob.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

/** Host glob match. `*.example.com` also matches the apex `example.com`. */
export function hostMatches(glob: string, host: string): boolean {
  if (!host) return false;
  if (glob === '*') return true;
  const h = host.toLowerCase().replace(/\.$/, '');
  if (glob.startsWith('*.') && h === glob.slice(2).toLowerCase()) return true;
  return hostGlobRe(glob).test(h);
}
