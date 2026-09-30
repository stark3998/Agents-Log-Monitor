import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { StrictMode, type ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import { DocsPage } from '../pages/docs/DocsPage';
import { ChatPanel } from '../pages/ask/ChatPanel';
import { citationHref } from '../lib/sse';
import { createSlugger, docRoute, highlightParts, resolveDocLink, slugify } from '../lib/docs';
import type { DocDetail, DocsIndex } from '../api/docs';

// ── Harness ────────────────────────────────────────────────────────────────

const json = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body), body: null,
});

function mockFetch(routes: Record<string, unknown | ((url: URL) => unknown)>) {
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    if (!(key in routes)) return json({ error: 'not found' }, 404);
    const h = routes[key];
    const out = typeof h === 'function' ? (h as (u: URL) => unknown)(url) : h;
    return out && typeof out === 'object' && 'ok' in out && 'status' in out ? out : json(out);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function LocationProbe() {
  const l = useLocation();
  return <div data-testid="location">{l.pathname}{l.search}{l.hash}</div>;
}

function renderAt(route: string, ui: ReactNode, path = '/docs/*') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const auth: AuthState = { mode: 'local', principal: { id: 'u', kind: 'user', roles: ['Viewer'] }, governance: true, config: null, loading: false };
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={buildTheme('light')}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[route]}>
            <Routes><Route path={path} element={<>{ui}<LocationProbe /></>} /></Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { vi.unstubAllGlobals(); });

const meta = (id: string, path: string, title: string, section: string, description = '') => ({
  id, path, title, section, description, headings: [], words: 400, updatedAt: '2026-09-01T00:00:00Z',
});

const INDEX: DocsIndex = {
  count: 3,
  sections: [
    { title: 'Guides', docs: [meta('installation', 'docs/installation.md', 'Installation', 'Guides', 'Local setup of every component')] },
    { title: 'Governance plane', docs: [meta('lanes', 'docs/lanes.md', 'Lanes', 'Governance plane', 'Lane schema'), meta('governance', 'docs/governance.md', 'Governance', 'Governance plane')] },
  ],
};

const LANES: DocDetail = {
  ...meta('lanes', 'docs/lanes.md', 'Lanes', 'Governance plane', 'Lane schema'),
  content: [
    '# Lanes',
    '',
    'Lanes are enforced by the [PDP](governance.md#decision-pipeline). Install first: [installation](./installation.md).',
    'Jump to [modes](#observe--enforce). Example charter: [charter](../fleet/charters/example.yaml).',
    '',
    '## Observe / enforce',
    '',
    'Observe logs would-deny decisions.',
    '',
    '## Rollout',
    '',
    'Roll out gradually.',
  ].join('\n'),
  headings: [
    { depth: 1, text: 'Lanes', slug: 'lanes' },
    { depth: 2, text: 'Observe / enforce', slug: 'observe--enforce' },
    { depth: 2, text: 'Rollout', slug: 'rollout' },
  ],
  links: [{ id: 'governance', title: 'Governance' }, { id: 'installation', title: 'Installation' }],
  backlinks: [{ id: 'governance', title: 'Governance' }],
  prev: { id: 'installation', title: 'Installation' },
  next: { id: 'governance', title: 'Governance' },
};

// ── Helpers ────────────────────────────────────────────────────────────────

describe('docs helpers', () => {
  it('slugs headings like GitHub (and the server catalog)', () => {
    expect(slugify('Observe / enforce')).toBe('observe--enforce');
    expect(slugify('5.3 Copilot Studio real-time webhook')).toBe('53-copilot-studio-real-time-webhook');
    expect(slugify('Intelligence proxy — /api/gov/intelligence/* forwards to INTELLIGENCE_URL')).toBe('intelligence-proxy--apigovintelligence-forwards-to-intelligence_url');
    const slug = createSlugger();
    expect([slug('Setup'), slug('Setup'), slug('Setup')]).toEqual(['setup', 'setup-1', 'setup-2']);
  });

  it('resolves relative doc links to in-app routes', () => {
    const byPath = new Map([['docs/lanes.md', 'lanes'], ['docs/architecture/agents.md', 'architecture/agents'], ['infra/readme.md', 'repo/infra/README'], ['readme.md', 'repo/README']]);
    expect(resolveDocLink('docs/architecture/agents.md', '../lanes.md#rollout', byPath)).toEqual({ kind: 'internal', to: '/docs/lanes#rollout' });
    expect(resolveDocLink('docs/lanes.md', 'architecture/agents.md', byPath)).toEqual({ kind: 'internal', to: '/docs/architecture/agents' });
    expect(resolveDocLink('docs/lanes.md', '../infra/', byPath)).toEqual({ kind: 'internal', to: '/docs/repo/infra/README' });
    expect(resolveDocLink('docs/lanes.md', '../README.md', byPath)).toEqual({ kind: 'internal', to: '/docs/repo/README' });
    expect(resolveDocLink('docs/lanes.md', '#modes', byPath)).toEqual({ kind: 'internal', to: '#modes' });
    expect(resolveDocLink('docs/lanes.md', 'https://learn.microsoft.com', byPath)).toEqual({ kind: 'external', href: 'https://learn.microsoft.com' });
    expect(resolveDocLink('docs/lanes.md', '../.env.example', byPath)).toEqual({ kind: 'file', path: '.env.example' });
    expect(docRoute('repo/infra/README', 'x')).toBe('/docs/repo/infra/README#x');
  });

  it('highlights search terms at word starts only', () => {
    expect(highlightParts('Enforce mode; reinforce it', ['enforce'])).toEqual([
      { text: 'Enforce', hit: true }, { text: ' mode; reinforce it', hit: false },
    ]);
  });

  it('routes doc citations to the docs tab with their anchor', () => {
    expect(citationHref({ kind: 'doc', id: 'fleet#alert-taxonomy' })).toBe('/docs/fleet#alert-taxonomy');
    expect(citationHref({ kind: 'doc', id: 'repo/infra/README' })).toBe('/docs/repo/infra/README');
  });
});

// ── Docs page ──────────────────────────────────────────────────────────────

describe('docs page', () => {
  it('shows the index of every section and document', async () => {
    mockFetch({ 'GET /api/docs': INDEX });
    renderAt('/docs', <DocsPage />);
    expect(await screen.findByRole('heading', { name: 'Documentation' })).toBeInTheDocument();
    expect(screen.getByText(/3 documents in 2 sections/)).toBeInTheDocument();
    const gov = screen.getByRole('region', { name: 'Governance plane' });
    expect(within(gov).getByRole('link', { name: /Lanes Lane schema/ })).toHaveAttribute('href', '/docs/lanes');
    expect(within(screen.getByRole('region', { name: 'Guides' })).getByText('Local setup of every component')).toBeInTheDocument();
  });

  it('renders a doc with linked headings, cross-doc links, backlinks and paging', async () => {
    const fetchMock = mockFetch({ 'GET /api/docs': INDEX, 'GET /api/docs/page': LANES });
    renderAt('/docs/lanes', <DocsPage />);
    const article = await screen.findByRole('article', { name: 'Lanes' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/docs/page?id=lanes'))).toBe(true);
    expect(within(article).getByRole('heading', { name: 'Observe / enforce' })).toHaveAttribute('id', 'observe--enforce');
    await waitFor(() => expect(within(article).getByRole('link', { name: 'PDP' })).toHaveAttribute('href', '/docs/governance#decision-pipeline'));
    expect(within(article).getByRole('link', { name: 'installation' })).toHaveAttribute('href', '/docs/installation');
    expect(within(article).getByRole('link', { name: 'modes' })).toHaveAttribute('href', '/docs/lanes#observe--enforce');
    expect(within(article).queryByRole('link', { name: 'charter' })).toBeNull();
    expect(within(article).getByText('charter')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Referenced by')).getByRole('link', { name: 'Governance' })).toHaveAttribute('href', '/docs/governance');
    expect(within(article).getByRole('link', { name: /Next Governance/ })).toHaveAttribute('href', '/docs/governance');
    expect(within(article).getByRole('link', { name: /Previous Installation/ })).toHaveAttribute('href', '/docs/installation');
    expect(within(screen.getByRole('navigation', { name: 'On this page' })).getByRole('link', { name: 'Rollout' })).toHaveAttribute('href', '/docs/lanes#rollout');
    expect(screen.getByText('Referenced by 1 page')).toBeInTheDocument();
  });

  it('shows a not-found state for unknown docs', async () => {
    mockFetch({ 'GET /api/docs': INDEX, 'GET /api/docs/page': json({ error: 'document not found: nope' }, 404) });
    renderAt('/docs/nope', <DocsPage />);
    expect(await screen.findByText('Document not found')).toBeInTheDocument();
    expect(screen.getByText('document not found: nope')).toBeInTheDocument();
  });

  it('searches with highlighted, anchored results and opens the top hit on Enter', async () => {
    mockFetch({
      'GET /api/docs': INDEX,
      'GET /api/docs/search': (u: URL) => ({
        query: u.searchParams.get('q'),
        hits: [{ id: 'lanes', path: 'docs/lanes.md', title: 'Lanes', section: 'Governance plane', heading: 'Observe / enforce', anchor: 'observe--enforce', snippet: 'Observe logs would-deny decisions.', terms: ['observe'], score: 3 }],
      }),
    });
    renderAt('/docs', <DocsPage />);
    const box = await screen.findByLabelText('Search documentation');
    fireEvent.change(box, { target: { value: 'observe' } });
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(screen.getByRole('status')).toHaveTextContent('1 match for “observe”');
    const hit = within(results).getByRole('link');
    expect(hit).toHaveAttribute('href', '/docs/lanes#observe--enforce');
    expect(within(hit).getAllByText('Observe')[0].tagName).toBe('MARK');
    expect(screen.getByRole('link', { name: /Ask the assistant/ })).toHaveAttribute('href', '/ask?q=observe');
    expect(screen.getByTestId('location')).toHaveTextContent('/docs?q=observe');

    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/docs/lanes#observe--enforce'));
  });
});

// ── Ask chat: doc citations ────────────────────────────────────────────────

const sse = (chunks: string[]) => {
  const enc = new TextEncoder();
  const queue = chunks.map(c => enc.encode(c));
  return { ...json(null), body: { getReader: () => ({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true }) }) } };
};

describe('ask chat grounded in docs', () => {
  it('shows the Foundry model, inline doc links and doc citation chips', async () => {
    mockFetch({
      'GET /api/gov/intelligence/status': { available: true, engine: 'foundry', model: 'gpt-5.5', grounding: 'docs' },
      'POST /api/gov/intelligence/chat': sse([
        'data: {"type":"meta","engine":"foundry","model":"gpt-5.5","grounding":"docs"}\n\n',
        'data: {"type":"tool","name":"search_docs","args":{"query":"alert types"}}\n\n',
        'data: {"type":"delta","text":"Alerts map to OWASP ([Fleet](/docs/fleet#alert-taxonomy))."}\n\n',
        'data: {"type":"citation","kind":"doc","id":"fleet#alert-taxonomy","title":"AgentMon Fleet › Alert taxonomy"}\n\ndata: {"type":"done"}\n\n',
      ]),
    });
    renderAt('/ask', <ChatPanel />, '/ask');
    expect(await screen.findByLabelText('Model: Microsoft Foundry · gpt-5.5')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'documentation' })).toHaveAttribute('href', '/docs');
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'What alert types exist?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const turn = await screen.findByTestId('assistant-turn');
    await waitFor(() => expect(within(turn).getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', '/docs/fleet#alert-taxonomy'));
    expect(within(turn).getByText('search_docs')).toBeInTheDocument();
    expect(within(turn).getByRole('link', { name: /AgentMon Fleet › Alert taxonomy/ })).toHaveAttribute('href', '/docs/fleet#alert-taxonomy');
  });

  it('asks a handed-over question straight away', async () => {
    const fetchMock = mockFetch({ 'POST /api/gov/intelligence/chat': sse(['data: {"type":"delta","text":"ok"}\n\ndata: {"type":"done"}\n\n']) });
    renderAt('/ask', <StrictMode><ChatPanel initialQuestion="How do lanes work?" /></StrictMode>, '/ask');
    const turn = await screen.findByTestId('assistant-turn');
    await waitFor(() => expect(within(turn).getByText('ok')).toBeInTheDocument());
    expect(within(turn).queryByText('Stopped.')).toBeNull();
    const call = fetchMock.mock.calls.find(([u]) => String(u) === '/api/gov/intelligence/chat');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ messages: [{ role: 'user', content: 'How do lanes work?' }] });
    expect(fetchMock.mock.calls.filter(([u]) => String(u) === '/api/gov/intelligence/chat')).toHaveLength(1);
  });
});
