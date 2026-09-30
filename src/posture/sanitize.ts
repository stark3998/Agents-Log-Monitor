import { redactText } from '../analytics/detectors';
import type { EndpointInventory } from './types';

const SECRET = new Set(['secret'] as const);
const ENV_ASSIGN_RE = /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|AUTH)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g;
const SECRET_QUERY_RE = /([?&](?:[\w-]*(?:key|token|secret|sig|signature|auth|password|code)[\w-]*)=)[^&#\s]+/gi;

/** Mask secrets in free text: known token formats, KEY=value env assignments and secret-looking URL params. */
export function redactFreeText(s: string, max = 1000): string {
  let out = redactText(String(s), SECRET);
  out = out.replace(ENV_ASSIGN_RE, (_m, k: string) => `${k}=****`);
  out = out.replace(SECRET_QUERY_RE, '$1****');
  return out.length > max ? out.slice(0, max) + '…' : out;
}

/** Keep only scheme + host (+ port): MCP URLs often embed credentials in the path or query. */
export function urlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return undefined; }
}

function cleanIdentity(id: string): string | null {
  if (!id || id.includes('=')) return null;
  if (/^[a-z]+:\/\//i.test(id)) return urlOrigin(id) ?? null;
  const r = redactText(id, SECRET);
  return r.includes('****') ? null : r.slice(0, 300);
}

/**
 * Remove secret material from an inventory before it is stored or sent anywhere. Used by the
 * scanner and again server-side on ingest (reports may come from older or third-party scanners).
 */
export function sanitizeInventory<T extends Partial<EndpointInventory>>(inv: T): T {
  const out = { ...inv } as T & EndpointInventory;
  if (Array.isArray(out.scheduledTasks)) {
    out.scheduledTasks = out.scheduledTasks.slice(0, 2000).map(t => ({ ...t, name: String(t.name ?? '').slice(0, 300), command: redactFreeText(String(t.command ?? ''), 500) }));
  }
  if (Array.isArray(out.mcpServers)) {
    out.mcpServers = out.mcpServers.slice(0, 2000).map(s => ({
      ...s,
      url: urlOrigin(s.url),
      command: s.command ? redactFreeText(s.command, 300) : s.command,
      package: s.package && !s.package.includes('=') ? redactText(s.package, SECRET).slice(0, 200) : undefined,
      identities: (s.identities ?? []).map(cleanIdentity).filter((x): x is string => !!x),
    }));
  }
  if (Array.isArray(out.errors)) out.errors = out.errors.slice(0, 200).map(e => redactFreeText(String(e), 300));
  return out;
}
