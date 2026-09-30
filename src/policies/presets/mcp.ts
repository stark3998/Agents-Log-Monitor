import { getPreset, hostMatches, splitPattern } from './catalog';

export const BROWSER_TOOL_RE = /chromium|selenium|marionette|chrome-?devtools|chrome-cu|playwright|puppeteer|\bbrowser_|browser\b/i;

export interface McpSubject {
  /** MCP server name as configured (e.g. `github`, `atlassian-remote`). */
  server?: string | null;
  /** Known identities: `npm:<pkg>`, `pypi:<pkg>`, `docker:<image>`, `dxt:<id>`, `go:<mod>`, or bare hosts. */
  identities?: string[];
}

function nameGlobRe(glob: string): RegExp {
  const esc = glob.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

function nameMatches(glob: string, name: string): boolean {
  return nameGlobRe(glob).test(name);
}

function identityMatches(pattern: string, identities: string[]): boolean {
  const m = /^(npm|pypi|docker|dxt|go):(.+)$/i.exec(pattern);
  if (m) {
    const prefix = m[1].toLowerCase() + ':';
    return identities.some(id => id.toLowerCase().startsWith(prefix) && nameMatches(m[2], id.slice(prefix.length)));
  }
  return identities.some(id => !/^(npm|pypi|docker|dxt|go):/i.test(id) && hostMatches(pattern, id));
}

/**
 * Match an MCP server against category preset ids or literal server-name globs. Name patterns are
 * checked against the server name; category `identities` against the server's package/host.
 */
export function mcpCategoryMatches(values: string[], subject: McpSubject): boolean {
  const server = (subject.server ?? '').toLowerCase();
  const identities = subject.identities ?? [];
  if (!server && !identities.length) return false;
  return values.some(v => {
    if (v === '*') return true;
    const preset = getPreset('mcpCategory', v);
    if (!preset) return !!server && nameMatches(v, server);
    if (server && splitPattern(preset.pattern).some(p => nameMatches(p, server))) return true;
    return !!preset.identities && identities.length > 0 && splitPattern(preset.identities).some(p => identityMatches(p, identities));
  });
}

/** Category ids a server belongs to (for inventory and UI). */
export function mcpCategoriesFor(subject: McpSubject, ids: string[]): string[] {
  return ids.filter(id => mcpCategoryMatches([id], subject));
}
