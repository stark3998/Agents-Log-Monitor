/**
 * Documentation catalog: every Markdown file in the repository, grouped into the sections of
 * docs/README.md, with headings, cross-document links (and backlinks) and a BM25 search index over
 * heading-level chunks. Shared by the Docs tab (/api/docs), the MCP `search_docs`/`get_doc` tools and
 * the built-in Ask agent.
 */
import fs from 'fs';
import path from 'path';

export interface DocHeading { depth: number; text: string; slug: string }
export interface DocRef { id: string; title: string }

export interface DocMeta {
  /** URL-safe id: the path under docs/ without `.md`, or `repo/<path>` for files elsewhere. */
  id: string;
  /** Repository-relative path with forward slashes. */
  path: string;
  title: string;
  section: string;
  description: string;
  headings: DocHeading[];
  words: number;
  updatedAt: string;
}

export interface DocDetail extends DocMeta {
  content: string;
  links: DocRef[];
  backlinks: DocRef[];
  prev?: DocRef;
  next?: DocRef;
}

export interface DocSection { title: string; docs: DocMeta[] }

export interface DocSearchHit {
  id: string;
  path: string;
  title: string;
  section: string;
  heading?: string;
  anchor?: string;
  snippet: string;
  /** Query terms (including prefix expansions) that matched, for client-side highlighting. */
  terms: string[];
  score: number;
}

export interface DocChunkHit extends DocSearchHit { text: string }

interface Chunk {
  doc: string; // doc id
  heading?: string;
  anchor?: string;
  raw: string;
  plain: string;
  bodyTf: Map<string, number>;
  headingTerms: Set<string>;
  len: number;
}

interface Catalog {
  signature: string;
  docs: Map<string, DocDetail>;
  byPath: Map<string, string>;
  sections: { title: string; docs: DocDetail[] }[];
  chunks: Chunk[];
  df: Map<string, number>;
  vocab: string[];
  avgLen: number;
  titleTerms: Map<string, Set<string>>;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'public', 'build', 'coverage', 'out', '__pycache__']);
const OVERVIEW = 'Overview';
const MORE = 'More in the repository';
const INDEX_SKIP_HEADINGS = /^(reading paths|glossary)$/i;
const MAX_FILE_BYTES = 1_000_000;
const REFRESH_MS = 5_000;

// ── Markdown helpers ────────────────────────────────────────────────────────

/** GitHub-compatible heading slug (the web renderer uses the same algorithm for heading ids). */
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

/** Markdown inline syntax → plain text (link text kept, URLs dropped). */
export function stripInline(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
}

function toPlain(md: string): string {
  return stripInline(md
    .replace(/^\s*(`{3,}|~{3,})\s*mermaid\b[\s\S]*?^\s*\1\s*$/gm, '') // diagram source isn't prose
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(`{3,}|~{3,}).*$/gm, ''))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

interface ParsedLine { text: string; inCode: boolean }

function lines(md: string): ParsedLine[] {
  let fence: string | null = null;
  return md.split(/\r?\n/).map(text => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (m) {
      if (!fence) { fence = m[1][0]; return { text, inCode: true }; }
      if (m[1][0] === fence) { fence = null; return { text, inCode: true }; }
    }
    return { text, inCode: fence !== null };
  });
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const LINK_RE = /\[((?:[^[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** Resolve a relative Markdown link to a repo-relative path + anchor (null for external/absolute links). */
export function resolveRelative(fromPath: string, href: string): { path: string; anchor?: string } | null {
  if (isExternal(href) || href.startsWith('/')) return null;
  const [rawPath, rawAnchor] = href.split('#', 2);
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch { /* keep raw */ }
  const target = decoded ? path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), decoded)) : fromPath;
  if (target.startsWith('..')) return null;
  return { path: target.replace(/\/$/, ''), anchor: rawAnchor || undefined };
}

export function docIdForPath(p: string): string {
  const noExt = p.replace(/\.md$/i, '');
  return p.startsWith('docs/') ? noExt.slice(5) : `repo/${noExt}`;
}

/** In-app URL of a doc (and optional heading anchor) as rendered by the Docs tab. */
export function docHref(id: string, anchor?: string): string {
  return `/docs/${id.split('/').map(encodeURIComponent).join('/')}${anchor ? `#${anchor}` : ''}`;
}

// ── Tokenizer ───────────────────────────────────────────────────────────────

const STOP = new Set(('a an and are as at be by can do does for from has have how i if in into is it its of on or our that the '
  + 'their then there these this to was we what when where which who why will with you your').split(' '));

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter(t => t.length > 1 && !STOP.has(t));
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

// ── Discovery ───────────────────────────────────────────────────────────────

function looksLikeRoot(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'docs', 'README.md')) || fs.existsSync(path.join(dir, 'README.md'));
}

/** Repository root holding the docs: DOCS_ROOT, then the folder above src/ or dist/, then the working directory. */
export function resolveDocsRoot(): string {
  const candidates = [process.env.DOCS_ROOT, path.join(__dirname, '..', '..'), process.cwd()].filter((p): p is string => !!p);
  return path.resolve(candidates.find(looksLikeRoot) ?? candidates[0]);
}

interface Found { rel: string; abs: string; stat: fs.Stats }

/** Literal (wildcard-free) entries of the root .gitignore: generated output such as `eval/results/` isn't documentation. */
function ignoredPaths(root: string): { names: Set<string>; prefixes: string[] } {
  const names = new Set<string>();
  const prefixes: string[] = [];
  let text = '';
  try { text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8'); } catch { return { names, prefixes }; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line)) continue;
    const p = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!p) continue;
    if (p.includes('/') || line.startsWith('/')) prefixes.push(`${p}/`);
    else names.add(p);
  }
  return { names, prefixes };
}

function discover(root: string): Found[] {
  const out: Found[] = [];
  const ignored = ignoredPaths(root);
  const skip = (rel: string, name: string) =>
    ignored.names.has(name) || ignored.prefixes.some(p => `${rel}/`.startsWith(p) || rel === p.slice(0, -1));
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (skip(rel, e.name)) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, depth + 1);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        try {
          const stat = fs.statSync(abs);
          if (stat.size <= MAX_FILE_BYTES) out.push({ rel, abs, stat });
        } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ── Build ───────────────────────────────────────────────────────────────────

interface IndexEntry { path: string; description: string }

/** Sections and one-line descriptions from the tables in docs/README.md (first mention wins). */
function parseDocsIndex(indexPath: string, content: string): { title: string; entries: IndexEntry[] }[] {
  const sections: { title: string; entries: IndexEntry[] }[] = [];
  const seen = new Set<string>();
  let current: { title: string; entries: IndexEntry[] } | null = null;
  for (const { text, inCode } of lines(content)) {
    if (inCode) continue;
    const h = HEADING_RE.exec(text);
    if (h) {
      if (h[1].length < 2) continue;
      const title = stripInline(h[2]).trim();
      current = INDEX_SKIP_HEADINGS.test(title) ? null : { title, entries: [] };
      if (current) sections.push(current);
      continue;
    }
    if (!current || !/^\s*\|/.test(text) || /^\s*\|?\s*:?-{3,}/.test(text)) continue;
    const cells = text.trim().replace(/^\||\|$/g, '').split('|');
    const description = stripInline(cells[1] ?? '').trim();
    for (const m of (cells[0] ?? '').matchAll(LINK_RE)) {
      const r = resolveRelative(indexPath, m[2]);
      if (!r || seen.has(r.path)) continue;
      seen.add(r.path);
      current.entries.push({ path: r.path, description });
    }
  }
  return sections.filter(s => s.entries.length);
}

function firstParagraph(content: string): string {
  const para: string[] = [];
  for (const { text, inCode } of lines(content)) {
    if (inCode || HEADING_RE.test(text) || !text.trim()) { if (para.length) break; continue; }
    if (!para.length && /^\s*(\||>|[-*+]\s|\d+\.\s|<)/.test(text)) continue;
    para.push(text.trim());
  }
  const s = stripInline(para.join(' ')).replace(/\s+/g, ' ').trim();
  return s.length > 220 ? `${s.slice(0, 217).replace(/\s+\S*$/, '')}…` : s;
}

function build(files: Found[], signature: string): Catalog {
  const docs = new Map<string, DocDetail>();
  const byPath = new Map<string, string>();
  const rawLinks = new Map<string, string[]>();
  const chunks: Chunk[] = [];

  for (const f of files) {
    let content: string;
    try { content = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    const id = docIdForPath(f.rel);
    const slug = createSlugger();
    const headings: DocHeading[] = [];
    const links: string[] = [];
    let title = '';
    // Every heading starts a new search chunk.
    let chunk: { heading?: string; anchor?: string; raw: string[] } = { raw: [] };
    const flush = () => {
      const raw = chunk.raw.join('\n').trim();
      if (!raw && !chunk.heading) return;
      const plain = toPlain(raw);
      const tokens = tokenize(plain);
      chunks.push({
        doc: id, heading: chunk.heading, anchor: chunk.anchor, raw, plain,
        bodyTf: termFreq(tokens), headingTerms: new Set(tokenize(chunk.heading ?? '')), len: tokens.length,
      });
    };
    for (const { text, inCode } of lines(content)) {
      const h = inCode ? null : HEADING_RE.exec(text);
      if (h) {
        const depth = h[1].length;
        const htext = stripInline(h[2]).trim();
        const s = slug(htext);
        headings.push({ depth, text: htext, slug: s });
        if (!title && depth === 1) title = htext;
        flush();
        chunk = { heading: htext, anchor: s, raw: [] };
        continue;
      }
      chunk.raw.push(text);
      if (!inCode) for (const m of text.matchAll(LINK_RE)) links.push(m[2]);
    }
    flush();
    docs.set(id, {
      id, path: f.rel, title: title || f.rel, section: MORE, description: firstParagraph(content), headings,
      words: (content.match(/\S+/g) ?? []).length, updatedAt: f.stat.mtime.toISOString(), content, links: [], backlinks: [],
    });
    byPath.set(f.rel.toLowerCase(), id);
    rawLinks.set(id, links);
  }

  // Sections: the top-level README and the docs index lead, then the tables of docs/README.md.
  const lookup = (p: string) => byPath.get(p.toLowerCase());
  const sections: { title: string; docs: DocDetail[] }[] = [];
  const placed = new Set<string>();
  const place = (title: string, ids: (string | undefined)[]) => {
    const list = ids.filter((id): id is string => !!id && docs.has(id) && !placed.has(id)).map(id => {
      placed.add(id);
      const d = docs.get(id)!;
      d.section = title;
      return d;
    });
    if (list.length) sections.push({ title, docs: list });
  };
  place(OVERVIEW, [lookup('README.md'), lookup('docs/README.md')]);
  const indexId = lookup('docs/README.md');
  if (indexId) {
    for (const s of parseDocsIndex('docs/README.md', docs.get(indexId)!.content)) {
      for (const e of s.entries) {
        const id = lookup(e.path);
        if (id && e.description && !placed.has(id)) docs.get(id)!.description = e.description;
      }
      place(s.title, s.entries.map(e => lookup(e.path)));
    }
  }
  place(MORE, [...docs.keys()]);

  // Cross-links, backlinks and reading order.
  const order = sections.flatMap(s => s.docs.map(d => d.id));
  const rank = new Map(order.map((id, i) => [id, i] as const));
  for (const [id, hrefs] of rawLinks) {
    const d = docs.get(id)!;
    const targets = new Set<string>();
    for (const href of hrefs) {
      const r = resolveRelative(d.path, href);
      const target = r ? lookup(r.path) ?? lookup(`${r.path}/README.md`) : undefined;
      if (target && target !== id) targets.add(target);
    }
    d.links = [...targets].sort((a, b) => rank.get(a)! - rank.get(b)!).map(t => ({ id: t, title: docs.get(t)!.title }));
    for (const t of targets) docs.get(t)!.backlinks.push({ id, title: d.title });
  }
  order.forEach((id, i) => {
    const d = docs.get(id)!;
    const ref = (j: number): DocRef | undefined => { const o = docs.get(order[j]); return o ? { id: o.id, title: o.title } : undefined; };
    d.prev = ref(i - 1);
    d.next = ref(i + 1);
    d.backlinks.sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  });

  const df = new Map<string, number>();
  for (const c of chunks) for (const t of new Set([...c.bodyTf.keys(), ...c.headingTerms])) df.set(t, (df.get(t) ?? 0) + 1);
  const titleTerms = new Map([...docs.values()].map(d => [d.id, new Set(tokenize(d.title))] as const));
  const avgLen = chunks.reduce((n, c) => n + c.len, 0) / Math.max(chunks.length, 1);

  return { signature, docs, byPath, sections, chunks, df, vocab: [...df.keys()].sort(), avgLen, titleTerms };
}

// ── Cache ───────────────────────────────────────────────────────────────────

let cached: Catalog | null = null;
let checkedAt = 0;

/** The catalog, rebuilt when any Markdown file is added, removed or modified (checked at most every 5s). */
function catalog(): Catalog {
  const now = Date.now();
  if (cached && now - checkedAt < REFRESH_MS) return cached;
  checkedAt = now;
  const root = resolveDocsRoot();
  const files = discover(root);
  const signature = `${root}|${files.map(f => `${f.rel}:${f.stat.size}:${f.stat.mtimeMs}`).join('|')}`;
  if (!cached || cached.signature !== signature) cached = build(files, signature);
  return cached;
}

/** Test hook: forget the cached catalog (e.g. after changing DOCS_ROOT). */
export function resetDocsCatalog(): void {
  cached = null;
  checkedAt = 0;
}

// ── Public API ──────────────────────────────────────────────────────────────

const meta = (d: DocDetail): DocMeta => ({
  id: d.id, path: d.path, title: d.title, section: d.section, description: d.description, headings: d.headings, words: d.words, updatedAt: d.updatedAt,
});

export function listDocs(): { sections: DocSection[]; count: number } {
  const c = catalog();
  return { sections: c.sections.map(s => ({ title: s.title, docs: s.docs.map(meta) })), count: c.docs.size };
}

/**
 * Look a doc up by id (`fleet`, `repo/infra/README`), repo path (`docs/fleet.md`) or in-app URL
 * (`/docs/fleet#anchor`), case-insensitively. Paths ending in `.md` resolve as paths first.
 */
export function getDoc(idOrPath: string): DocDetail | null {
  const c = catalog();
  const key = idOrPath.trim().split('#')[0].replace(/^\/+/, '');
  const byId = (k: string) => {
    const lower = k.toLowerCase().replace(/\.md$/i, '');
    for (const d of c.docs.values()) if (d.id.toLowerCase() === lower) return d;
    return null;
  };
  const byPath = (k: string) => {
    const id = c.byPath.get(k.toLowerCase()) ?? c.byPath.get(`${k.toLowerCase()}.md`);
    return id ? c.docs.get(id) ?? null : null;
  };
  const find = (k: string) => (/\.md$/i.test(k) ? byPath(k) ?? byId(k) : byId(k) ?? byPath(k));
  return find(key) ?? (/^docs\//i.test(key) ? find(key.slice(5)) : null);
}

/** Markdown of one heading's section (until the next heading of the same or a higher level). */
export function getDocSection(doc: DocDetail, anchor: string): { heading: DocHeading; content: string } | null {
  const idx = doc.headings.findIndex(h => h.slug === anchor.replace(/^#/, ''));
  if (idx === -1) return null;
  const heading = doc.headings[idx];
  const all = lines(doc.content);
  let seen = -1;
  let start = -1;
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    const h = all[i].inCode ? null : HEADING_RE.exec(all[i].text);
    if (!h) continue;
    seen++;
    if (seen === idx) start = i;
    else if (start !== -1 && h[1].length <= heading.depth) { end = i; break; }
  }
  return start === -1 ? null : { heading, content: all.slice(start, end).map(l => l.text).join('\n').trim() };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function snippetFor(plain: string, terms: string[], max = 220): string {
  const text = plain.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(t)}`, 'u').exec(lower);
    if (m && (at === -1 || m.index < at)) at = m.index + m[1].length;
  }
  if (at === -1) return `${text.slice(0, max).replace(/\s+\S*$/, '')}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  let s = text.slice(start, start + max);
  if (start > 0) s = `…${s.replace(/^\S*\s/, '')}`;
  if (start + max < text.length) s = `${s.replace(/\s+\S*$/, '')}…`;
  return s;
}

/**
 * BM25 over heading-level chunks with heading/title boosts, prefix matching of the last query term
 * (search-as-you-type), a coverage factor favouring chunks that match every term and an exact-phrase
 * bonus. At most `perDoc` chunks per document.
 */
export function searchDocChunks(query: string, opts: { limit?: number; perDoc?: number } = {}): DocChunkHit[] {
  const c = catalog();
  const qTokens = [...new Set(tokenize(query))].slice(0, 16);
  if (!qTokens.length) return [];
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const perDoc = Math.max(opts.perDoc ?? 3, 1);
  const N = c.chunks.length;
  const k1 = 1.2;
  const b = 0.75;
  const idf = (t: string) => { const n = c.df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };

  // Each query term → weighted candidate terms: the exact term plus prefix expansions of the last
  // (still being typed) term, or of any term that isn't in the vocabulary.
  const groups = qTokens.map((q, i) => {
    const out: [string, number][] = c.df.has(q) ? [[q, 1]] : [];
    if (i === qTokens.length - 1 || !out.length) {
      let n = 0;
      for (const v of c.vocab) {
        if (v !== q && v.startsWith(q)) { out.push([v, 0.7]); if (++n >= 12) break; }
      }
    }
    return out;
  });
  const phrase = qTokens.length > 1 ? query.trim().toLowerCase().replace(/\s+/g, ' ') : '';

  const scored: { chunk: Chunk; score: number; terms: string[] }[] = [];
  for (const chunk of c.chunks) {
    let score = 0;
    let covered = 0;
    const terms: string[] = [];
    const title = c.titleTerms.get(chunk.doc)!;
    for (const group of groups) {
      let best = 0;
      for (const [t, w] of group) {
        const tf = chunk.bodyTf.get(t) ?? 0;
        let s = tf ? (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * chunk.len) / (c.avgLen || 1))) : 0;
        if (chunk.headingTerms.has(t)) s += 2.5;
        if (title.has(t)) s += 1.2;
        s *= idf(t) * w;
        if (s > 0) terms.push(t);
        best = Math.max(best, s);
      }
      if (best > 0) covered++;
      score += best;
    }
    if (!score) continue;
    score *= (covered / groups.length) ** 2;
    if (phrase && `${chunk.heading ?? ''} ${chunk.plain}`.toLowerCase().replace(/\s+/g, ' ').includes(phrase)) score *= 1.5;
    scored.push({ chunk, score, terms: [...new Set(terms)] });
  }
  scored.sort((x, y) => y.score - x.score);

  const perDocCount = new Map<string, number>();
  const hits: DocChunkHit[] = [];
  for (const s of scored) {
    const n = perDocCount.get(s.chunk.doc) ?? 0;
    if (n >= perDoc) continue;
    perDocCount.set(s.chunk.doc, n + 1);
    const d = c.docs.get(s.chunk.doc)!;
    // The H1 chunk stands for the page itself: no heading/anchor.
    const isTop = !s.chunk.anchor || (d.headings[0]?.depth === 1 && d.headings[0].slug === s.chunk.anchor);
    hits.push({
      id: d.id, path: d.path, title: d.title, section: d.section,
      heading: isTop ? undefined : s.chunk.heading, anchor: isTop ? undefined : s.chunk.anchor,
      snippet: snippetFor(s.chunk.plain || d.description, s.terms), terms: s.terms,
      score: Math.round(s.score * 1000) / 1000, text: s.chunk.raw,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export function searchDocs(query: string, opts: { limit?: number; perDoc?: number } = {}): DocSearchHit[] {
  return searchDocChunks(query, opts).map(({ text: _text, ...hit }) => hit);
}
