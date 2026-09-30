import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Principal } from '../../src/governance/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-catalog-'));

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeAll(() => {
  write('README.md', '# Widget Monitor\n\nTop-level overview. See the [docs index](docs/README.md).\n');
  write('docs/README.md', [
    '# Documentation',
    '',
    '## Guides',
    '',
    '| Guide | What it covers |',
    '|---|---|',
    '| [Installing](install.md) | Local setup and **verification** |',
    '',
    '## Reference',
    '',
    '### Governance plane',
    '',
    '| Page | What it covers |',
    '|---|---|',
    '| [Lanes](governance/lanes.md) / [Policies](governance/policies.md) | Lane and policy schema |',
    '',
    '## Reading paths',
    '',
    '| If you are | Read |',
    '|---|---|',
    '| New | [Installing](install.md) → [Tools](../tools/README.md) |',
  ].join('\n'));
  write('docs/install.md', [
    '# Installing',
    '',
    'Install the monitor, then read about [lanes](governance/lanes.md#observe-and-enforce) and the [tools](../tools/).',
    '',
    '## Configure the environment',
    '',
    'Set `FOUNDRY_OPENAI_ENDPOINT` in `.env` to enable the judge.',
    '',
    '```bash',
    '# not a heading',
    'npm start',
    '```',
    '',
    '## Configure the environment',
    '',
    'Duplicate heading for slug de-duplication.',
  ].join('\n'));
  write('docs/governance/lanes.md', [
    '# Lanes',
    '',
    'A lane is an agent\'s governance contract. Back to [installing](../install.md).',
    '',
    '## Observe and enforce',
    '',
    'Observe mode logs would-deny decisions; enforce mode blocks them.',
    '',
    '### Rollout',
    '',
    'Start in observe, then switch to enforce.',
    '',
    '## Schema',
    '',
    'Fields: purpose, allow, never.',
  ].join('\n'));
  write('docs/governance/policies.md', '# Policies\n\nReusable policy presets shared by lanes.\n');
  write('tools/README.md', '# Tools\n\nHelper scripts for the widget monitor.\n');
  write('.gitignore', 'node_modules/\ngenerated/\n*.log\n');
  write('generated/report.md', '# Generated report\n\nShould not be indexed.\n');
  write('node_modules/pkg/README.md', '# Dependency\n');
  process.env.DOCS_ROOT = root;
});

afterAll(() => {
  delete process.env.DOCS_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

async function catalog() {
  const mod = await import('../../src/docs/catalog');
  mod.resetDocsCatalog();
  return mod;
}

describe('docs catalog', () => {
  it('discovers every Markdown file except ignored and dependency folders', async () => {
    const { listDocs } = await catalog();
    const all = listDocs().sections.flatMap(s => s.docs.map(d => d.path));
    expect(all.sort()).toEqual(['README.md', 'docs/README.md', 'docs/governance/lanes.md', 'docs/governance/policies.md', 'docs/install.md', 'tools/README.md']);
  });

  it('groups docs into sections from the docs index, with descriptions from its tables', async () => {
    const { listDocs } = await catalog();
    const { sections, count } = listDocs();
    expect(count).toBe(6);
    expect(sections.map(s => [s.title, s.docs.map(d => d.id)])).toEqual([
      ['Overview', ['repo/README', 'README']],
      ['Guides', ['install']],
      ['Governance plane', ['governance/lanes', 'governance/policies']],
      ['More in the repository', ['repo/tools/README']],
    ]);
    expect(sections[1].docs[0].description).toBe('Local setup and verification');
    expect(sections[3].docs[0].description).toBe('Helper scripts for the widget monitor.');
  });

  it('parses headings with GitHub slugs (de-duplicated, code fences ignored)', async () => {
    const { getDoc } = await catalog();
    const doc = getDoc('install')!;
    expect(doc.title).toBe('Installing');
    expect(doc.headings.map(h => h.slug)).toEqual(['installing', 'configure-the-environment', 'configure-the-environment-1']);
  });

  it('links docs to each other, with backlinks and reading order', async () => {
    const { getDoc } = await catalog();
    expect(getDoc('install')!.links.map(l => l.id)).toEqual(['governance/lanes', 'repo/tools/README']);
    const lanes = getDoc('governance/lanes')!;
    expect(lanes.backlinks.map(b => b.id)).toEqual(['README', 'install']);
    expect(lanes.prev?.id).toBe('install');
    expect(lanes.next?.id).toBe('governance/policies');
    expect(getDoc('repo/README')!.prev).toBeUndefined();
  });

  it('looks docs up by id, repo path or in-app URL', async () => {
    const { getDoc } = await catalog();
    expect(getDoc('docs/governance/lanes.md')?.id).toBe('governance/lanes');
    expect(getDoc('/docs/governance/lanes#schema')?.id).toBe('governance/lanes');
    expect(getDoc('GOVERNANCE/LANES')?.id).toBe('governance/lanes');
    expect(getDoc('README.md')?.id).toBe('repo/README');
    expect(getDoc('README')?.id).toBe('README');
    expect(getDoc('nope')).toBeNull();
  });

  it('returns a heading section up to the next heading of the same level', async () => {
    const { getDoc, getDocSection } = await catalog();
    const s = getDocSection(getDoc('governance/lanes')!, 'observe-and-enforce')!;
    expect(s.content).toContain('### Rollout');
    expect(s.content).not.toContain('## Schema');
    expect(getDocSection(getDoc('governance/lanes')!, 'missing')).toBeNull();
  });

  it('ranks heading-level search hits with anchors, snippets and prefix matching', async () => {
    const { searchDocs, searchDocChunks } = await catalog();
    const hits = searchDocs('observe enforce');
    expect(hits[0]).toMatchObject({ id: 'governance/lanes', heading: 'Observe and enforce', anchor: 'observe-and-enforce' });
    expect(hits[0].terms).toEqual(expect.arrayContaining(['observe', 'enforce']));
    expect(searchDocs('FOUNDRY_OPENAI_ENDPOINT')[0]).toMatchObject({ id: 'install', anchor: 'configure-the-environment' });
    expect(searchDocs('rollo')[0]).toMatchObject({ id: 'governance/lanes', anchor: 'rollout' });
    expect(searchDocs('')).toEqual([]);
    expect(searchDocs('zzzz-nothing')).toEqual([]);
    expect(searchDocChunks('schema purpose')[0].text).toContain('Fields: purpose');
  });

  it('refreshes when files change', async () => {
    const { searchDocs, resetDocsCatalog } = await catalog();
    expect(searchDocs('kubernetes')).toEqual([]);
    write('docs/k8s.md', '# Kubernetes\n\nRun it on kubernetes.\n');
    resetDocsCatalog();
    expect(searchDocs('kubernetes')[0]?.id).toBe('k8s');
    fs.rmSync(path.join(root, 'docs/k8s.md'));
    resetDocsCatalog();
  });
});

describe('docs REST API', () => {
  it('serves the index, pages and search', async () => {
    await catalog();
    const { default: router } = await import('../../src/docs/router');
    const app = express();
    app.use('/api/docs', router);
    const server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/docs`;
    try {
      const index = await (await fetch(base)).json() as { count: number };
      expect(index.count).toBe(6);
      const page = await (await fetch(`${base}/page?id=${encodeURIComponent('governance/lanes')}`)).json() as { content: string; backlinks: unknown[] };
      expect(page.content).toContain('# Lanes');
      expect(page.backlinks).toHaveLength(2);
      expect((await fetch(`${base}/page?id=missing`)).status).toBe(404);
      const search = await (await fetch(`${base}/search?q=observe`)).json() as { hits: { id: string; text?: string }[] };
      expect(search.hits[0].id).toBe('governance/lanes');
      expect(search.hits[0].text).toBeUndefined();
      const full = await (await fetch(`${base}/search?q=observe&text=1`)).json() as { hits: { link: string; text: string }[] };
      expect(full.hits[0]).toMatchObject({ link: '/docs/governance/lanes#observe-and-enforce' });
      expect(full.hits[0].text).toContain('would-deny');
    } finally {
      await new Promise<void>(r => server.close(() => r()));
    }
  });
});

// ── Built-in Ask agent against a fake Foundry (Azure OpenAI) endpoint ─────────

interface FoundryCall {
  url: string;
  apiKey: string;
  body: { messages: { role: string; content: string | null; tool_calls?: unknown[] }[]; tools?: unknown[]; stream?: boolean };
}

async function fakeFoundry(rounds: string[][]): Promise<{ url: string; calls: FoundryCall[]; close: () => Promise<void> }> {
  const calls: FoundryCall[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      calls.push({ url: req.url ?? '', apiKey: String(req.headers['api-key'] ?? ''), body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of rounds[calls.length - 1] ?? []) res.write(`data: ${c}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>(r => server.close(() => r())) };
}

const toolCallChunk = (name: string, args: object) => JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
const textChunk = (text: string) => JSON.stringify({ choices: [{ delta: { content: text } }] });
const stop = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });

async function listenApp(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

describe('built-in Ask agent (Foundry)', { timeout: 20_000 }, () => {
  const envKeys = ['FOUNDRY_OPENAI_ENDPOINT', 'FOUNDRY_OPENAI_API_KEY', 'ASK_DEPLOYMENT', 'INTELLIGENCE_URL'];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => { for (const k of envKeys) saved[k] = process.env[k]; });
  afterEach(() => {
    for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.resetModules();
  });

  async function withFoundry(url: string) {
    vi.resetModules();
    process.env.FOUNDRY_OPENAI_ENDPOINT = url;
    process.env.FOUNDRY_OPENAI_API_KEY = 'test-key';
    process.env.ASK_DEPLOYMENT = 'gpt-4.1';
    delete process.env.INTELLIGENCE_URL;
    (await import('../../src/docs/catalog')).resetDocsCatalog();
    return import('../../src/docs/ask-agent');
  }

  async function intelligenceApp() {
    const router = (await import('../../src/governance/routes/intelligence')).default;
    const app = express();
    app.use(express.json());
    const viewer: Principal = { id: 'viewer', roles: ['Viewer'], kind: 'user' };
    app.use((req, _res, next) => { req.principal = viewer; next(); });
    app.use('/api/gov/intelligence', router);
    return listenApp(app);
  }

  it('grounds on retrieved docs, runs doc tools and cites pages', async () => {
    const foundry = await fakeFoundry([
      [toolCallChunk('read_doc', { id: 'governance/lanes', anchor: 'observe-and-enforce' }), stop],
      [textChunk('Observe mode logs would-deny decisions '), textChunk('([Lanes: Observe and enforce](/docs/governance/lanes#observe-and-enforce)). '), textChunk('See [Installing](/docs/install).'), stop],
    ]);
    try {
      const { runDocsAsk } = await withFoundry(foundry.url);
      const events = [];
      for await (const ev of runDocsAsk([{ role: 'user', content: 'What does observe mode do versus enforce?' }])) events.push(ev);

      expect(events[0]).toEqual({ type: 'meta', engine: 'foundry', model: 'gpt-4.1', grounding: 'docs' });
      expect(events[1]).toEqual({ type: 'tool', name: 'search_docs', args: { query: 'What does observe mode do versus enforce?' } });
      expect(events).toContainEqual({ type: 'tool', name: 'read_doc', args: { id: 'governance/lanes', anchor: 'observe-and-enforce' } });
      const text = events.filter(e => e.type === 'delta').map(e => (e as { text: string }).text).join('');
      expect(text).toContain('Observe mode logs would-deny decisions');
      expect(events.filter(e => e.type === 'citation')).toEqual([
        { type: 'citation', kind: 'doc', id: 'governance/lanes#observe-and-enforce', title: 'Lanes › Observe and enforce' },
        { type: 'citation', kind: 'doc', id: 'install', title: 'Installing' },
      ]);
      expect(events[events.length - 1]).toEqual({ type: 'done' });

      expect(foundry.calls).toHaveLength(2);
      const [first, second] = foundry.calls;
      expect(first.url).toContain('/openai/deployments/gpt-4.1/chat/completions?api-version=');
      expect(first.apiKey).toBe('test-key');
      expect(first.body.stream).toBe(true);
      expect(first.body.tools).toHaveLength(2);
      expect(first.body.messages[0].content).toContain('Answer only from the documentation');
      expect(first.body.messages[0].content).toContain('Lanes — /docs/governance/lanes');
      const question = first.body.messages[first.body.messages.length - 1].content!;
      expect(question).toContain('<documentation_excerpts>');
      expect(question).toContain('link: /docs/governance/lanes#observe-and-enforce');
      const toolMsg = second.body.messages[second.body.messages.length - 1];
      expect(toolMsg.role).toBe('tool');
      expect(toolMsg.content).toContain('Start in observe, then switch to enforce.');
      expect(second.body.messages[second.body.messages.length - 2].tool_calls).toHaveLength(1);
    } finally {
      await foundry.close();
    }
  });

  it('falls back to the retrieved pages as sources when the answer has no links', async () => {
    const foundry = await fakeFoundry([[textChunk('Lanes are governance contracts.'), stop]]);
    try {
      const { runDocsAsk } = await withFoundry(foundry.url);
      const events = [];
      for await (const ev of runDocsAsk([{ role: 'user', content: 'What is a lane governance contract?' }])) events.push(ev);
      const cites = events.filter(e => e.type === 'citation') as { id: string }[];
      expect(cites[0].id).toBe('governance/lanes');
    } finally {
      await foundry.close();
    }
  });

  it('is served by POST /api/gov/intelligence/chat when INTELLIGENCE_URL is unset', async () => {
    const foundry = await fakeFoundry([[textChunk('Set FOUNDRY_OPENAI_ENDPOINT ([Installing](/docs/install#configure-the-environment)).'), stop]]);
    try {
      await withFoundry(foundry.url);
      const { base, close } = await intelligenceApp();
      try {
        expect(await (await fetch(`${base}/api/gov/intelligence/status`)).json()).toEqual({ available: true, engine: 'foundry', model: 'gpt-4.1', grounding: 'docs' });
        const bad = await fetch(`${base}/api/gov/intelligence/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
        expect(bad.status).toBe(400);
        const res = await fetch(`${base}/api/gov/intelligence/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'How do I enable the judge?' }] }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/event-stream');
        expect(res.headers.get('cache-control')).toContain('no-transform');
        const events = (await res.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.replace(/^data: /, '')));
        expect(events[0]).toMatchObject({ type: 'meta', engine: 'foundry' });
        expect(events).toContainEqual({ type: 'citation', kind: 'doc', id: 'install#configure-the-environment', title: 'Installing › Configure the environment' });
        expect(events[events.length - 1]).toEqual({ type: 'done' });
      } finally {
        await close();
      }
    } finally {
      await foundry.close();
    }
  });

  it('reports Foundry failures as an error event', async () => {
    const failing = http.createServer((_req, res) => { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad deployment"}}'); });
    await new Promise<void>(r => failing.listen(0, '127.0.0.1', r));
    try {
      await withFoundry(`http://127.0.0.1:${(failing.address() as AddressInfo).port}`);
      const { base, close } = await intelligenceApp();
      try {
        const res = await fetch(`${base}/api/gov/intelligence/chat`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        const text = await res.text();
        expect(text).toContain('"type":"error"');
        expect(text).toContain('Foundry chat completion failed (400)');
        expect(text.trim().endsWith('data: {"type":"done"}')).toBe(true);
      } finally {
        await close();
      }
    } finally {
      await new Promise<void>(r => failing.close(() => r()));
    }
  });
});
