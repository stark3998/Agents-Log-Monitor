import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Box, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import type {
  BenchmarkVariant, CompareBenchmarkRun, Decision, JevBenchmarks, JevKindSummary, JevShadowRecord, JevShadowSummary, TriageBenchmarkRun,
} from '../api/governance';
import { JevComparisonPage } from '../pages/jev/JevComparisonPage';
import { DecisionBadge } from '../pages/conversation/DecisionBadge';
import { AppShell } from '../components/AppShell';
import { outcomeTone } from '../components/gov/JevCommon';

// ── Harness (mirrors governance.test.tsx) ──────────────────────────────────

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body), body: null,
});

let calls: string[] = [];

function mockFetch(routes: Record<string, unknown | ((url: string) => unknown)>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    if (!(key in routes)) return reply({ error: 'not found' }, 404);
    const h = routes[key];
    return reply(typeof h === 'function' ? (h as (u: string) => unknown)(url) : h);
  }));
}

function renderApp(ui: ReactNode, { route = '/jev', path = '/jev', mode = 'dark' as 'dark' | 'light' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const auth: AuthState = { mode: 'local', principal: { id: 'alice', kind: 'user', roles: ['Viewer'] }, governance: true, config: null, loading: false };
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={buildTheme(mode)}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[route]}>
            <Routes><Route path={path} element={ui} /></Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const queue = (over: Partial<JevShadowSummary['queue']> = {}): JevShadowSummary['queue'] => ({ enqueued: 120, completed: 118, failed: 1, dropped: 0, inFlight: 1, queued: 0, ...over });

const judgeKind = (over: Partial<JevKindSummary> = {}): JevKindSummary => ({
  kind: 'judge', total: 60, compared: 50, agreed: 46, agreementRate: 0.92, jevErrors: 2,
  confusion: { allow: { allow: 30, deny: 3 }, deny: { allow: 1, deny: 16 } },
  jevStricter: 3, jevLooser: 1,
  latency: { jev: { count: 58, p50: 120, p95: 300, p99: 450, mean: 150 }, baseline: { count: 50, p50: 1200, p95: 3600, p99: 4000, mean: 1500 } },
  tokens: { jevInput: 42_000, baselineInput: 90_000, baselineOutput: 8_000 },
  estCostUsd: { jev: 0.042, baseline: 0.31 },
  baselineModels: ['gpt-4.1-mini'], jevModels: ['jev-1.13.0'],
  ...over,
});

const summary = (over: Partial<JevShadowSummary> = {}): JevShadowSummary => ({ enabled: true, model: 'jev-1.13.0', kinds: [judgeKind()], queue: queue(), ...over });

const record = (over: Partial<JevShadowRecord> = {}): JevShadowRecord => ({
  id: 'sh-1', kind: 'judge', decisionId: 'd-1', sessionId: 's-1', agentId: 'support-bot', laneId: 'support', toolName: 'issue_refund',
  baseline: { provider: 'foundry', model: 'gpt-4.1-mini', verdict: 'allow', confidence: 0.7, latencyMs: 1300, stage: 'judge_fast' },
  jev: { model: 'jev-1.13.0', verdict: 'deny', confidence: 0.88, latencyMs: 110, rationale: 'Refund target is an external account.', laneClause: 'never: move money outside the company', signals: { 'violates.never': 0.91, intent: 'refund' } },
  agree: false, createdAt: new Date().toISOString(),
  ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

// ── Page ───────────────────────────────────────────────────────────────────

describe('Jev vs LLM page', () => {
  it('explains how to enable Jev when shadow mode is disabled', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary({ enabled: false, kinds: [], queue: queue({ enqueued: 0, completed: 0, failed: 0, inFlight: 0 }) }) });
    renderApp(<JevComparisonPage />, { route: '/jev?view=live' });
    const card = await screen.findByTestId('jev-disabled');
    expect(within(card).getByText('Jev shadow mode is off')).toBeInTheDocument();
    expect(within(card).getByText('TYPESAFE_API_KEY')).toBeInTheDocument();
    expect(within(card).getByText(/never changes a verdict/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Decision kind' })).not.toBeInTheDocument();
    expect(calls.some(u => u.startsWith('/api/gov/jev/shadow'))).toBe(false);
  });

  it('renders KPIs, confusion matrix, latency and a queue warning from the summary', async () => {
    mockFetch({
      'GET /api/gov/jev/summary': summary({ queue: queue({ dropped: 4 }) }),
      'GET /api/gov/jev/shadow': { items: [] },
    });
    renderApp(<JevComparisonPage />, { route: '/jev?view=live', mode: 'light' });
    expect(await screen.findByLabelText('Agreement 92.0%')).toBeInTheDocument();
    expect(screen.getByLabelText('Compared 50')).toBeInTheDocument();
    expect(screen.getByLabelText('Speedup 10.0× at p50')).toBeInTheDocument();
    expect(screen.getByLabelText('Estimated cost Jev $0.04 versus baseline $0.31')).toBeInTheDocument();
    expect(screen.getByLabelText('Jev stricter 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Jev looser 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Jev errors 2')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'LLM judge (60)', selected: true })).toBeInTheDocument();

    const matrix = screen.getByRole('table', { name: /Confusion matrix/ });
    const denyRow = within(matrix).getByRole('rowheader', { name: 'deny' }).closest('tr')!;
    const cells = within(denyRow).getAllByRole('cell');
    expect(cells.map(c => c.textContent)).toEqual(['1', '16']);
    expect(cells[1]).toHaveAttribute('data-diagonal', 'true');
    expect(cells[0]).not.toHaveAttribute('data-diagonal');

    expect(screen.getByRole('group', { name: 'p95: Jev 300ms, baseline 3.6s' })).toBeInTheDocument();
    expect(within(screen.getByTestId('jev-queue')).getByText(/4 shadow comparisons were dropped/)).toBeInTheDocument();
    await screen.findByText('No disagreements in this period.');
    const shadowCall = calls.find(u => u.startsWith('/api/gov/jev/shadow'))!;
    expect(shadowCall).toContain('kind=judge');
    expect(shadowCall).toContain('agree=false');
  });

  it('lists disagreements with conversation deep links and expandable signals', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/shadow': { items: [record(), record({ id: 'sh-2', sessionId: undefined, decisionId: undefined })] } });
    renderApp(<JevComparisonPage />, { route: '/jev?view=live&range=24h' });
    const table = await screen.findByRole('table', { name: 'LLM judge disagreements' });
    const link = within(table).getByRole('link', { name: 'Open conversation s-1' });
    expect(link.getAttribute('href')).toMatch(/^\/jev\?/);
    expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('c')).toBe('s-1');
    expect(new URLSearchParams(link.getAttribute('href')!.split('?')[1]).get('range')).toBe('24h');
    expect(within(table).getAllByRole('link', { name: /Open conversation/ })).toHaveLength(1);
    expect(within(table).getAllByLabelText('Baseline allow')).toHaveLength(2);
    expect(within(table).getAllByLabelText('Jev deny')).toHaveLength(2);

    const toggle = within(table).getAllByRole('button', { name: 'Show signals' })[0];
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await within(table).findByText(/violates\.never/)).toBeInTheDocument();
  });

  it('switches decision kind via tabs', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/shadow': { items: [] } });
    renderApp(<JevComparisonPage />, { route: '/jev?view=live' });
    fireEvent.click(await screen.findByRole('tab', { name: 'Prompt injection (0)' }));
    expect(await screen.findByText('No prompt injection comparisons yet')).toBeInTheDocument();
    expect(screen.getByTestId('jev-empty-hint')).toHaveTextContent(/governance hooks/);
  });

  it('shows the six Fleet kinds as a grouped tab set with descriptions', async () => {
    const fleetKind = judgeKind({
      kind: 'fleet_intent', total: 7, compared: 7, agreed: 5, agreementRate: 5 / 7,
      confusion: { in_scope: { in_scope: 4, out_of_scope: 1 }, out_of_scope: { ambiguous: 1, out_of_scope: 1 } },
      jevStricter: 1, jevLooser: 1, baselineModels: ['rules'],
    });
    mockFetch({
      'GET /api/gov/jev/summary': summary({ kinds: [judgeKind(), fleetKind] }),
      'GET /api/gov/jev/shadow': { items: [record({ kind: 'fleet_intent', baseline: { provider: 'rules', verdict: 'in_scope' }, jev: { model: 'jev-1.13.0', verdict: 'out_of_scope', latencyMs: 30, signals: {} } })] },
    });
    renderApp(<JevComparisonPage />, { route: '/jev?view=live' });
    await screen.findByRole('tab', { name: 'LLM judge (60)' });
    const labels = [
      'Fleet · Real-time gate (0)', 'Fleet · Intent scope (7)', 'Fleet · Goal alignment (0)',
      'Fleet · Evasion (0)', 'Fleet · Injection (0)', 'Fleet · Code necessity (0)',
    ];
    const fleetTabs = labels.map(name => screen.getByRole('tab', { name }));
    for (const tab of fleetTabs) expect(tab).toHaveAttribute('data-group', 'fleet');
    expect(screen.getByRole('tab', { name: 'LLM judge (60)' })).toHaveAttribute('data-group', 'monitor');

    fireEvent.click(fleetTabs[1]);
    expect(await screen.findByTestId('jev-kind-description')).toHaveTextContent(/in_scope \/ out_of_scope \/ ambiguous/);
    const table = await screen.findByRole('table', { name: 'Fleet · Intent scope disagreements' });
    expect(within(table).getByLabelText('Baseline in_scope')).toBeInTheDocument();
    expect(within(table).getByLabelText('Jev out_of_scope')).toBeInTheDocument();
    expect(calls.some(u => u.startsWith('/api/gov/jev/shadow') && u.includes('kind=fleet_intent'))).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: 'Fleet · Code necessity (0)' }));
    expect(await screen.findByText('No Fleet code necessity comparisons yet')).toBeInTheDocument();
    expect(screen.getByTestId('jev-kind-description')).toHaveTextContent(/necessary \/ unnecessary/);
  });

  it('is linked from the navigation', () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    renderApp(<AppShell><Box>Body</Box></AppShell>, { route: '/overview', path: '*' });
    expect(screen.getByRole('tab', { name: 'Jev vs LLM' })).toHaveAttribute('href', '/jev');
  });
});

// ── Offline benchmark view ─────────────────────────────────────────────────

const bvariant = (variant: string, over: Partial<BenchmarkVariant> = {}): BenchmarkVariant => ({
  variant, provider: variant.startsWith('jev') ? 'jev' : variant, models: [variant.startsWith('jev') ? 'jev-1.13.0' : 'gpt-4.1-mini'],
  total: 120, n: 120, errors: 0, accuracy: 0.8, macroF1: 0.6, positiveRecall: 1, positivePrecision: 0.72, falseAllowRate: 0, escalationRate: 0,
  perClass: {}, confusion: { allow: { allow: 43, deny: 1 }, deny: { deny: 52 }, escalate: { allow: 3, deny: 19 } },
  calibration: { brier: 0.16, ece: 0.14, n: 120 }, latency: { count: 120, p50: 1541, p95: 2156, p99: 2846, mean: 1611 },
  tokens: { input: 62_000, output: 6_600 }, costUsd: 0.035, costPer1kUsd: 0.3, selfConsistency: null,
  perTag: { adversarial: { n: 3, correct: 3, accuracy: 1 }, mcp: { n: 2, correct: 1, accuracy: 0.5 } },
  ...over,
});

const judgeRun = (): CompareBenchmarkRun => ({
  id: 'bench-judge', dataset: 'judge', generatedAt: new Date().toISOString(), cases: 120, repeat: 1, positiveLabel: 'deny',
  providers: [{ id: 'foundry-fast', variants: ['foundry-fast'] }, { id: 'jev', variants: ['jev:strict'] }], skipped: [],
  variants: [
    bvariant('foundry-fast', { n: 118, errors: 2 }),
    bvariant('jev:strict', {
      accuracy: 0.867, macroF1: 0.791, positiveRecall: 0.962, positivePrecision: 0.909, escalationRate: 0.1,
      latency: { count: 120, p50: 90, p95: 216, p99: 327, mean: 127 }, costPer1kUsd: 0.0844,
      perTag: { adversarial: { n: 3, correct: 3, accuracy: 1 }, mcp: { n: 2, correct: 2, accuracy: 1 } },
    }),
  ],
  agreement: { 'foundry-fast': { 'jev:strict': { agree: 99, compared: 118, rate: 0.839 } }, 'jev:strict': { 'foundry-fast': { agree: 99, compared: 118, rate: 0.839 } } },
  headline: { jev: 'jev:strict', baseline: 'foundry-fast', accuracyDelta: 0.062, positiveRecallDelta: -0.038, falseAllowDelta: 0, p95Speedup: 10, costRatio: 0.285 },
  sweep: { base: 'strict', constraintMet: false, minPositiveRecall: 1, minPositiveRecallSource: 'foundry-fast deny recall', best: { params: { deny: 0.9, review: 0.4 }, accuracy: 0.883, macroF1: 0.817, positiveRecall: 0.962, falseAllowRate: 0, escalationRate: 0.1 }, points: 87 },
  misses: [
    { id: 'coding-deny-mcp-finance', expected: 'deny', tags: ['mcp'], jev: { verdict: 'escalate', confidence: 0.52 }, baseline: { verdict: 'deny' }, jevCorrect: false, baselineCorrect: true },
    { id: 'ambiguous-subagent', expected: 'escalate', tags: [], jev: { verdict: 'allow', confidence: 0.64 }, baseline: { verdict: 'deny' }, jevCorrect: false, baselineCorrect: false },
    { id: 'coding-allow-read-src', expected: 'allow', tags: [], jev: { verdict: 'allow' }, baseline: { error: 'timed out' }, jevCorrect: true, baselineCorrect: false },
  ],
});

const triageRun = (): TriageBenchmarkRun => ({
  id: 'bench-triage.json', dataset: 'triage', generatedAt: new Date().toISOString(), model: 'jev-1.13.0', questionsVersion: 'guardian-triage-v1',
  metrics: { cases: 40, errors: 0, severityExact: 0.9, severityWithinOne: 1, incidentTypeAccuracy: 0.875, investigatePrecision: 1, investigateRecall: 1, latencyP50Ms: 90, latencyP95Ms: 225, avgInputTokens: 1782 },
  misses: [{ id: 'taint-npm-test', expected: { severity: 'low', incident_type: 'benign_burst', investigate: false }, got: { severity: 'medium', incident_type: 'benign_burst', investigate: false } }],
});

const benchmarks = (over: Partial<JevBenchmarks> = {}): JevBenchmarks => ({
  available: true,
  runs: [{ id: 'bench-judge', dataset: 'judge', generatedAt: new Date().toISOString() }, { id: 'bench-triage.json', dataset: 'triage', generatedAt: new Date().toISOString() }],
  judge: judgeRun(), triage: triageRun(), ...over,
});

describe('Jev vs LLM page — offline benchmark', () => {
  it('is the default view and shows the head-to-head numbers', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary({ enabled: false, kinds: [] }), 'GET /api/gov/jev/benchmarks': benchmarks() });
    renderApp(<JevComparisonPage />);
    expect(await screen.findByTestId('jev-benchmarks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Offline benchmark/, pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Judge (120)', selected: true })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Accuracy: Jev 86.7%, Foundry fast 80.0%, +6.7 pp' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^p95 latency: Jev 216ms, Foundry fast 2\.2s, 10\.0× faster$/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /^Cost \/ 1k decisions: Jev .*3\.6× cheaper$/ })).toBeInTheDocument();
    expect(screen.getByTestId('bench-gate')).toHaveTextContent(/safety gate not met/);
    expect(screen.getByTestId('bench-sweep')).toHaveTextContent('Recall floor not met');
    expect(await screen.findByTestId('jev-live-off')).toBeInTheDocument();
    expect(calls.some(u => u.startsWith('/api/gov/jev/shadow'))).toBe(false);

    const board = screen.getByRole('table', { name: 'Provider comparison' });
    expect(within(board).getByRole('rowheader', { name: /Jev · strict/ })).toBeInTheDocument();
    expect(within(board).getByText('(2 err)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: /Jev · strict confusion matrix/ })).toBeInTheDocument();
  });

  it('filters missed cases', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/benchmarks': benchmarks() });
    renderApp(<JevComparisonPage />);
    const misses = await screen.findByRole('table', { name: 'Missed cases' });
    expect(within(misses).getByText('coding-deny-mcp-finance')).toBeInTheDocument();
    expect(within(misses).queryByText('coding-allow-read-src')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Foundry fast wrong (2)' }));
    const next = screen.getByRole('table', { name: 'Missed cases' });
    expect(within(next).getByText('coding-allow-read-src')).toBeInTheDocument();
    expect(within(next).queryByText('coding-deny-mcp-finance')).not.toBeInTheDocument();
  });

  it('shows Guardian triage metrics', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/benchmarks': benchmarks() });
    renderApp(<JevComparisonPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Guardian triage (40)' }));
    expect(await screen.findByLabelText('Severity exact 90.0%')).toBeInTheDocument();
    expect(screen.getByLabelText('Investigate recall 100.0%')).toBeInTheDocument();
    expect(within(screen.getByTestId('bench-triage-misses')).getByText('low → medium')).toBeInTheDocument();
  });

  it('explains how to run the benchmark when there are no results', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/benchmarks': { available: true, runs: [] } });
    renderApp(<JevComparisonPage />);
    expect(await screen.findByText('No benchmark results yet')).toBeInTheDocument();
    expect(screen.getByText(/npm run eval:compare/)).toBeInTheDocument();
  });

  it('switches to the live shadow view', async () => {
    mockFetch({ 'GET /api/gov/jev/summary': summary(), 'GET /api/gov/jev/benchmarks': benchmarks(), 'GET /api/gov/jev/shadow': { items: [] } });
    renderApp(<JevComparisonPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Live shadow/ }));
    expect(await screen.findByLabelText('Agreement 92.0%')).toBeInTheDocument();
  });
});

// ── Conversation decision popover ──────────────────────────────────────────

describe('outcomeTone (fleet verdict colours)', () => {
  it('colours fleet labels safe / middle / risky consistently with the core vocabulary', () => {
    const t = buildTheme('dark').tokens;
    const safe = outcomeTone(t, 'allow');
    const risky = outcomeTone(t, 'deny');
    const middle = outcomeTone(t, 'escalate');
    for (const v of ['in_scope', 'aligned', 'different', 'clean', 'necessary']) expect(outcomeTone(t, v), v).toEqual(safe);
    for (const v of ['ambiguous', 'review']) expect(outcomeTone(t, v), v).toEqual(middle);
    for (const v of ['block', 'out_of_scope', 'Out-of-Scope', 'misaligned', 'same', 'attack', 'unnecessary']) expect(outcomeTone(t, v), v).toEqual(risky);
    expect(outcomeTone(t, 'mystery')).toEqual(t.severity.info);
  });
});

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: 'd-1', requestId: 'toolu_9', sessionId: 's-1', agentId: 'support-bot', laneId: 'support', laneVersion: 3, mode: 'enforce',
  checkpoint: 'pre_tool', toolName: 'issue_refund', verdict: 'allow', effectiveVerdict: 'allow', wouldDeny: false, stage: 'judge_fast',
  reason: 'Within lane purpose', ruleIds: [], tainted: false, latencyMs: 1300, createdAt: '2026-01-01T00:00:10Z',
  judge: [{ verdict: 'allow', confidence: 0.7, rationale: 'Routine refund.', model: 'gpt-4.1-mini', tier: 'fast', latencyMs: 1200, provider: 'foundry', usage: { inputTokens: 1500, outputTokens: 80 } }],
  ...over,
});

describe('decision badge', () => {
  it('shows judge provider/tokens and a collapsible Jev shadow result', async () => {
    mockFetch({ 'GET /api/gov/jev/shadow': { items: [record({ decisionId: 'd-other' }), record()] } });
    renderApp(<DecisionBadge decision={decision()} />, { route: '/', path: '/' });
    fireEvent.click(screen.getByRole('button', { name: /Governance: Allowed/ }));
    expect(await screen.findByTestId('judge-usage')).toHaveTextContent('Foundry · 1,500 in / 80 out tokens');
    const section = await screen.findByTestId('jev-shadow');
    expect(within(section).getByText('disagrees')).toBeInTheDocument();
    const btn = within(section).getByRole('button', { name: /Jev shadow/ });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(await within(section).findByText('Refund target is an external account.')).toBeInTheDocument();
    expect(calls.find(u => u.startsWith('/api/gov/jev/shadow'))).toContain('sessionId=s-1');
  });

  it('renders no Jev section when there is no matching record (or the endpoint is missing)', async () => {
    mockFetch({});
    renderApp(<DecisionBadge decision={decision({ judge: [{ verdict: 'allow', confidence: 0.7, rationale: 'Routine refund.', model: 'gpt-4.1-mini', tier: 'fast', latencyMs: 1200 }] })} />, { route: '/', path: '/' });
    fireEvent.click(screen.getByRole('button', { name: /Governance: Allowed/ }));
    await screen.findByText('Routine refund.');
    await waitFor(() => expect(calls.some(u => u.startsWith('/api/gov/jev/shadow'))).toBe(true));
    expect(screen.queryByTestId('jev-shadow')).not.toBeInTheDocument();
    expect(screen.queryByTestId('judge-usage')).not.toBeInTheDocument();
  });
});
