/**
 * Heading slugs and doc-link resolution for rendered documentation. The slug algorithm matches the
 * server's docs catalog (src/docs/catalog.ts) so search-result and cross-doc anchors land on the
 * rendered headings.
 */

export function slugify(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return text => {
    const base = slugify(text);
    const n = seen.get(base);
    seen.set(base, (n ?? 0) + 1);
    return n === undefined ? base : `${base}-${n}`;
  };
}

// Minimal hast shapes (avoids depending on @types/hast directly).
interface HastNode { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] }

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** Rehype plugin: GitHub-style `id`s on headings. Run after rehype-sanitize so ids aren't prefixed. */
export function rehypeHeadingIds() {
  return (tree: HastNode) => {
    const slug = createSlugger();
    const visit = (node: HastNode) => {
      if (node.type === 'element' && node.tagName && /^h[1-6]$/.test(node.tagName)) {
        node.properties = { ...node.properties, id: slug(textOf(node)) };
        return;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

/** In-app route of a doc (and optional anchor). */
export function docRoute(id: string, anchor?: string): string {
  return `/docs/${id.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${anchor}` : ''}`;
}

function normalizePosix(p: string): string | null {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!out.length) return null; out.pop(); } else out.push(part);
  }
  return out.join('/');
}

export type ResolvedLink =
  | { kind: 'internal'; to: string }
  | { kind: 'external'; href: string }
  | { kind: 'file'; path: string };

/**
 * Resolve a link inside a rendered doc: relative links to other docs become in-app routes, in-page
 * anchors stay anchors, other repository files are reported as `file` (not served by the app).
 */
export function resolveDocLink(fromPath: string, href: string, idByPath: Map<string, string>): ResolvedLink {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return { kind: 'external', href };
  if (href.startsWith('#') || href.startsWith('/')) return { kind: 'internal', to: href };
  const [rawPath, anchor] = href.split('#', 2);
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch { /* keep raw */ }
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  const target = normalizePosix(dir ? `${dir}/${decoded}` : decoded);
  if (target === null) return { kind: 'file', path: decoded };
  const id = idByPath.get(target.toLowerCase()) ?? idByPath.get(`${target}/README.md`.toLowerCase().replace(/^\//, ''));
  return id ? { kind: 'internal', to: docRoute(id, anchor) } : { kind: 'file', path: target || decoded };
}

/** Split text into plain/highlighted parts for search terms (word-prefix, case-insensitive). */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const clean = [...new Set(terms.filter(t => t.length > 1))].sort((a, b) => b.length - a.length);
  if (!clean.length) return [{ text, hit: false }];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(${clean.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu');
  const parts: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push({ text: text.slice(last, i), hit: false });
    parts.push({ text: m[0], hit: true });
    last = i + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}
