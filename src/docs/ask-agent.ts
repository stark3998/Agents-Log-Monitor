/**
 * Built-in "Ask the monitor" agent: answers questions from the repository documentation using a
 * Microsoft Foundry (Azure OpenAI-compatible) chat deployment. Used by POST /api/gov/intelligence/chat
 * when the Python intelligence service (INTELLIGENCE_URL) isn't configured.
 *
 * Grounding: the latest question is searched in the docs catalog first and the top sections are
 * attached as context; the model can call `search_docs` / `read_doc` for more, and must cite pages
 * as in-app links (`/docs/<id>#<anchor>`), which are turned into `citation` events.
 */
import { govConfig } from '../governance/config';
import { docHref, getDoc, getDocSection, listDocs, searchDocChunks, type DocChunkHit } from './catalog';

export type AskEvent =
  | { type: 'meta'; engine: 'foundry'; model: string; grounding: 'docs' }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; args?: unknown }
  | { type: 'citation'; kind: 'doc'; id: string; title?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

export interface AskMessage { role: 'user' | 'assistant'; content: string }

const MAX_ROUNDS = 5;
const MAX_HISTORY = 12;
const MAX_MESSAGE_CHARS = 8_000;
const CONTEXT_HITS = 6;
const EXCERPT_CHARS = 1_800;
const TOOL_RESULT_CHARS = 12_000;
const TIMEOUT_MS = 180_000;

export function askDeployment(): string {
  return process.env.ASK_DEPLOYMENT || process.env.CHAT_DEPLOYMENT || govConfig.foundry.fastDeployment;
}

export function docsAskAvailable(): boolean {
  return govConfig.foundry.enabled;
}

/** Keep well-formed user/assistant turns (most recent MAX_HISTORY), each capped in length. */
export function sanitizeMessages(raw: unknown): AskMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m): m is AskMessage => !!m && typeof m === 'object'
      && ((m as AskMessage).role === 'user' || (m as AskMessage).role === 'assistant')
      && typeof (m as AskMessage).content === 'string' && !!(m as AskMessage).content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

function catalogPrompt(): string {
  return listDocs().sections
    .map(s => `${s.title}:\n${s.docs.map(d => `- ${d.title} — ${docHref(d.id)}${d.description ? `: ${d.description}` : ''}`).join('\n')}`)
    .join('\n');
}

export function systemPrompt(): string {
  return `You are "Ask the monitor", the documentation assistant for Agent Logs Monitor, a monitoring and governance platform for AI agents.

Ground every answer in the project documentation:
- Use the documentation excerpts attached to the question. Call search_docs for anything they don't cover, and read_doc to read a whole page or section when you need more detail.
- Answer only from the documentation. If it doesn't cover something, say so plainly and point to the closest pages. Never guess configuration names, environment variables, commands, API paths, roles or defaults.
- Cite the pages you used as Markdown links to their in-app URL exactly as given (for example [Fleet: Alert taxonomy](/docs/fleet#alert-taxonomy)), inline next to the claims they support.
- Lead with the answer, then give steps, commands or configuration in fenced code blocks where useful. Keep it concise.
- You can't see live monitor data (sessions, decisions, incidents). For those, explain which dashboard page or API the docs describe.

Documentation catalog:
${catalogPrompt()}`;
}

function excerpt(h: DocChunkHit, i: number): string {
  const where = h.heading ? `${h.title} › ${h.heading}` : h.title;
  return `[${i + 1}] ${where}\nlink: ${docHref(h.id, h.anchor)}\n${clip(h.text, EXCERPT_CHARS)}`;
}

/** Retrieval query: the latest question, plus the previous one when the latest is a short follow-up. */
function retrievalQuery(messages: AskMessage[]): string {
  const users = messages.filter(m => m.role === 'user').map(m => m.content);
  const last = users[users.length - 1] ?? '';
  return last.trim().split(/\s+/).length < 5 && users.length > 1 ? `${users[users.length - 2]} ${last}` : last;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_docs',
      description: 'Full-text search over all project documentation. Returns the best-matching sections with their Markdown and in-app link.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords or a question' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_doc',
      description: 'Read one documentation page by id (as in its link, e.g. "fleet" or "repo/infra/README"), optionally only the section under a heading anchor.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, anchor: { type: 'string', description: 'Heading anchor without #' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
  },
] as const;

export function runDocsTool(name: string, args: Record<string, unknown>): unknown {
  if (name === 'search_docs') {
    const query = typeof args.query === 'string' ? args.query : '';
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 10) : 5;
    const hits = query.trim() ? searchDocChunks(query, { limit, perDoc: 2 }) : [];
    return { query, hits: hits.map(h => ({ title: h.title, heading: h.heading, link: docHref(h.id, h.anchor), text: clip(h.text, EXCERPT_CHARS) })) };
  }
  if (name === 'read_doc') {
    const doc = getDoc(typeof args.id === 'string' ? args.id.replace(/^\/?docs\//, '') : '');
    if (!doc) return { error: `document not found: ${String(args.id)}` };
    const anchor = typeof args.anchor === 'string' ? args.anchor.replace(/^#/, '') : '';
    const section = anchor ? getDocSection(doc, anchor) : null;
    if (anchor && !section) return { error: `heading not found: ${anchor}`, headings: doc.headings.map(h => h.slug) };
    return {
      title: doc.title, link: docHref(doc.id, section?.heading.slug),
      content: clip(section?.content ?? doc.content, TOOL_RESULT_CHARS),
      headings: section ? undefined : doc.headings.filter(h => h.depth <= 3).map(h => ({ text: h.text, anchor: h.slug })),
      relatedDocs: [...doc.links, ...doc.backlinks].slice(0, 15).map(r => ({ title: r.title, link: docHref(r.id) })),
    };
  }
  return { error: `unknown tool: ${name}` };
}

/** Doc citations from in-app links in the answer, e.g. `](/docs/fleet#alert-taxonomy)`. */
export function docCitations(text: string): Extract<AskEvent, { type: 'citation' }>[] {
  const out: Extract<AskEvent, { type: 'citation' }>[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/\]\(\s*<?\/docs\/([^)\s>]+)>?\s*\)/g)) {
    const [rawId, rawAnchor] = m[1].split('#', 2);
    let id = rawId;
    try { id = decodeURIComponent(rawId); } catch { /* keep raw */ }
    const doc = getDoc(id);
    if (!doc) continue;
    const heading = rawAnchor ? doc.headings.find(h => h.slug === rawAnchor) : undefined;
    const key = heading ? `${doc.id}#${heading.slug}` : doc.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'citation', kind: 'doc', id: key, title: heading && heading.depth > 1 ? `${doc.title} › ${heading.text}` : doc.title });
    if (out.length >= 8) break;
  }
  return out;
}

// ── Foundry streaming ───────────────────────────────────────────────────────

interface ToolCall { id: string; name: string; arguments: string }
type WireMessage = Record<string, unknown>;

interface StreamChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
}

async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
    if (done) {
      if (buf.startsWith('data:')) yield buf.slice(5).trim();
      return;
    }
  }
}

async function openStream(deployment: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  // Loaded on first use so mounting the route doesn't pull in @azure/identity.
  const { foundryChatUrl, foundryHeaders } = await import('../governance/judge/client');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(foundryChatUrl(deployment), { method: 'POST', headers: await foundryHeaders(), body: JSON.stringify(body), signal });
    if (res.ok && res.body) return res.body;
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await new Promise(r => setTimeout(r, Number(res.headers.get('retry-after')) * 1000 || 1500));
      continue;
    }
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Foundry chat completion failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
}

/**
 * Stream an answer as Ask events: meta → tool (retrieval and each tool call) → delta… → citation… → done.
 * Throws on Foundry/transport errors (the caller reports them as an `error` event).
 */
export async function* runDocsAsk(messages: AskMessage[], opts: { signal?: AbortSignal } = {}): AsyncGenerator<AskEvent> {
  const deployment = askDeployment();
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  yield { type: 'meta', engine: 'foundry', model: deployment, grounding: 'docs' };

  const query = retrievalQuery(messages);
  yield { type: 'tool', name: 'search_docs', args: { query } };
  const hits = searchDocChunks(query, { limit: CONTEXT_HITS, perDoc: 2 });
  const last = messages[messages.length - 1];
  const context = hits.length
    ? `<documentation_excerpts>\n${hits.map(excerpt).join('\n\n')}\n</documentation_excerpts>`
    : '<documentation_excerpts>No sections matched this question; use search_docs with other keywords.</documentation_excerpts>';
  const wire: WireMessage[] = [
    { role: 'system', content: systemPrompt() },
    ...messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: `${last.content}\n\n${context}` },
  ];

  const reasoning = /^(o\d|gpt-5)/i.test(deployment); // same rule as the judge client's isReasoningDeployment
  const limits: Record<string, unknown> = reasoning ? { max_completion_tokens: 8000 } : { max_tokens: 1600, temperature: 0.2 };
  // Doc answers need little deliberation; `low` cuts time-to-first-token several-fold. `off` omits the parameter.
  const effort = (process.env.ASK_REASONING_EFFORT ?? 'low').trim().toLowerCase();
  if (reasoning && effort && effort !== 'off') limits.reasoning_effort = effort;

  let answer = '';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const allowTools = round < MAX_ROUNDS - 1;
    const stream = await openStream(deployment, { messages: wire, stream: true, ...limits, ...(allowTools ? { tools: TOOLS, tool_choice: 'auto' } : {}) }, signal);
    const calls: ToolCall[] = [];
    let content = '';
    for await (const data of sseData(stream)) {
      if (!data || data === '[DONE]') continue;
      let chunk: StreamChunk;
      try { chunk = JSON.parse(data) as StreamChunk; } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        yield { type: 'delta', text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: '', name: '', arguments: '' });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
    }
    answer += content;
    const toolCalls = calls.filter(c => c && c.name);
    if (!toolCalls.length) break;
    if (content && !content.endsWith('\n')) { answer += '\n\n'; yield { type: 'delta', text: '\n\n' }; }

    wire.push({
      role: 'assistant', content: content || null,
      tool_calls: toolCalls.map((c, i) => ({ id: c.id || `call_${round}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })),
    });
    for (const [i, c] of toolCalls.entries()) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments || '{}') as Record<string, unknown>; } catch { /* malformed: run with no args */ }
      yield { type: 'tool', name: c.name, args };
      wire.push({ role: 'tool', tool_call_id: c.id || `call_${round}_${i}`, content: JSON.stringify(runDocsTool(c.name, args)) });
    }
  }

  let citations = docCitations(answer);
  if (!citations.length && answer.trim()) {
    const seen = new Set<string>();
    citations = hits.filter(h => !seen.has(h.id) && !!seen.add(h.id)).slice(0, 3)
      .map(h => ({ type: 'citation' as const, kind: 'doc' as const, id: h.id, title: h.title }));
  }
  for (const c of citations) yield c;
  yield { type: 'done' };
}
