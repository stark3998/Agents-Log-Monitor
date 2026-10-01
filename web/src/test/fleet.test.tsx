import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Box, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import { fleetKeys, type FleetAlert, type FleetSummary } from '../api/fleet';
import { handleGovMessage } from '../api/live';
import { FleetPage } from '../pages/fleet/FleetPage';
import { groupByAgent } from '../pages/fleet/FleetAgentsPanel';
import { AppShell } from '../components/AppShell';

// ── Harness (mirrors jev.test.tsx) ─────────────────────────────────────────

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

function renderApp(ui: ReactNode, { route = '/fleet', path = '/fleet', mode = 'dark' as 'dark' | 'light' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const auth: AuthState = { mode: 'local', principal: { id: 'alice', kind: 'user', roles: ['Viewer'] }, governance: true, config: null, loading: false };
  const utils = render(
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
  return { ...utils, qc };
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const alert = (over: Partial<FleetAlert> = {}): FleetAlert => ({
  alert_id: 'fa-1', alert_type: 'GOAL_DRIFT', severity: 'high', score: 72, title: 'Agent drifted from refund goal',
  summary: 'The agent started exporting the customer table instead of processing the refund.', detector: 'intent_alignment',
  platform: 'foundry', agent_id: 'asst_123', agent_name: 'support-bot', session_id: 's-1', user_id: 'bob@contoso.com',
  action: 'tool_call', owasp_llm: ['LLM01'], owasp_agentic: ['ASI01'], mitre_atlas: ['AML.T0051.001'],
  evidence: { tool: 'sql_query', similarity: 0.21 }, source_event_ids: ['ev-1', 'ev-2'], incident_id: 'inc-9',
  created_at: '2026-09-30T10:05:00.000Z',
  ...over,
});

const ALERTS: FleetAlert[] = [
  alert(),
  alert({
    alert_id: 'fa-2', alert_type: 'PROMPT_INJECTION_SUSPECTED', severity: 'critical', score: 91, title: 'Injection in retrieved doc',
    owasp_llm: ['LLM01'], owasp_agentic: ['ASI06'], mitre_atlas: [], incident_id: null, created_at: '2026-09-30T10:07:00.000Z',
  }),
  alert({
    alert_id: 'fa-3', alert_type: 'INTENT_OUT_OF_SCOPE', severity: 'medium', score: 45, title: 'Asked for legal advice',
    platform: 'copilot_studio', agent_id: 'cs-hr', agent_name: 'hr-helper', session_id: 's-2', owasp_llm: ['LLM06'],
    owasp_agentic: ['ASI01'], mitre_atlas: ['AML.T0051'], incident_id: null, evidence: {}, source_event_ids: [],
    created_at: '2026-09-30T09:00:00.000Z',
  }),
  alert({
    alert_id: 'fa-0', alert_type: 'USER_PERSISTENCE_AFTER_BLOCK', severity: 'medium', score: 50, title: 'User kept rephrasing',
    owasp_llm: ['LLM01'], owasp_agentic: ['ASI09'], mitre_atlas: ['AML.T0054'], incident_id: null, created_at: '2026-09-30T10:01:00.000Z',
  }),
];

const SUMMARY: FleetSummary = {
  since: '2026-09-23T00:00:00.000Z', total: 4,
  bySeverity: { critical: 1, high: 1, medium: 2 },
  byType: { GOAL_DRIFT: 1, PROMPT_INJECTION_SUSPECTED: 1, INTENT_OUT_OF_SCOPE: 1, USER_PERSISTENCE_AFTER_BLOCK: 1 },
  byPlatform: { foundry: 3, copilot_studio: 1 },
  byAgent: { 'support-bot': 3, 'hr-helper': 1 },
  byOwaspAgentic: { ASI01: 2, ASI06: 1, ASI09: 1 },
};

/** Server-side filtering stand-in for GET /api/gov/fleet/alerts (newest first, like the store). */
function alertsRoute(url: string): FleetAlert[] {
  const q = new URLSearchParams(url.split('?')[1] ?? '');
  const inList = (k: string, v: string) => !q.get(k) || q.get(k)!.split(',').includes(v);
  return ALERTS
    .filter(a => inList('severity', a.severity) && inList('type', a.alert_type) && inList('platform', a.platform))
    .filter(a => !q.get('agent') || a.agent_name === q.get('agent') || a.agent_id === q.get('agent'))
    .filter(a => !q.get('session') || a.session_id === q.get('session'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const routes = () => ({
  'GET /api/gov/fleet/summary': SUMMARY,
  'GET /api/gov/fleet/alerts': alertsRoute,
  'GET /api/gov/fleet/alerts/fa-1': ALERTS[0],
});

const alertCalls = () => calls.filter(u => u.startsWith('/api/gov/fleet/alerts?'));

afterEach(() => { vi.unstubAllGlobals(); });

// ── Page ───────────────────────────────────────────────────────────────────

describe('Fleet page', () => {
  it('renders summary tiles, per-dimension bars and the alerts table with badges, scores and framework chips', async () => {
    mockFetch(routes());
    renderApp(<FleetPage />);

    expect(await screen.findByLabelText('Alerts 4')).toBeInTheDocument();
    expect(screen.getByLabelText('Critical 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Medium 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Agents with alerts 2')).toBeInTheDocument();
    expect(within(screen.getByTestId('fleet-by-platform')).getByRole('button', { name: 'Filter by platform Foundry: 3 alerts' })).toBeInTheDocument();
    expect(within(screen.getByTestId('fleet-by-agent')).getByRole('button', { name: 'Filter by agent support-bot: 3 alerts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Alerts (4)', selected: true })).toBeInTheDocument();

    const table = await screen.findByRole('table', { name: 'Fleet alerts' });
    const rows = within(table).getAllByTestId('fleet-alert-row');
    expect(rows).toHaveLength(4);
    // Newest first.
    expect(within(rows[0]).getByLabelText('Alert type PROMPT_INJECTION_SUSPECTED')).toBeInTheDocument();
    expect(within(rows[0]).getByLabelText('Severity Critical')).toBeInTheDocument();
    expect(within(rows[0]).getByLabelText('Score 91')).toBeInTheDocument();

    const drift = rows.find(r => within(r).queryByLabelText('Alert type GOAL_DRIFT'))!;
    expect(within(drift).getByLabelText('Severity High')).toBeInTheDocument();
    expect(within(drift).getByLabelText('OWASP LLM LLM01')).toHaveAttribute('data-framework', 'owasp_llm');
    expect(within(drift).getByLabelText('OWASP Agentic ASI01')).toHaveAttribute('data-framework', 'owasp_agentic');
    expect(within(drift).getByLabelText('MITRE ATLAS AML.T0051.001')).toHaveAttribute('data-framework', 'mitre_atlas');
    expect(within(drift).getByRole('link', { name: 'Open incident inc-9' })).toHaveAttribute('href', '/incidents/inc-9');
    const sessionLink = within(drift).getByRole('link', { name: 'Session timeline s-1' });
    const qs = new URLSearchParams(sessionLink.getAttribute('href')!.split('?')[1]);
    expect(qs.get('tab')).toBe('session');
    expect(qs.get('sid')).toBe('s-1');
    // Only one alert is linked to an incident.
    expect(within(table).getAllByRole('link', { name: /Open incident/ })).toHaveLength(1);

    const first = alertCalls()[0];
    expect(first).toContain('limit=500');
    expect(first).toContain('since=');
    expect(calls.find(u => u.startsWith('/api/gov/fleet/summary'))).toContain('since=');
  });

  it('filters the table by severity, bar click and session id (sent to the API)', async () => {
    mockFetch(routes());
    renderApp(<FleetPage />, { mode: 'light' });
    await screen.findByRole('table', { name: 'Fleet alerts' });

    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Severity/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Medium' }));
    await waitFor(() => expect(screen.getAllByTestId('fleet-alert-row')).toHaveLength(2));
    expect(alertCalls().at(-1)).toContain('severity=medium');
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId('fleet-by-platform')).getByRole('button', { name: /Copilot Studio/ }));
    await waitFor(() => expect(screen.getAllByTestId('fleet-alert-row')).toHaveLength(1));
    expect(alertCalls().at(-1)).toMatch(/platform=copilot_studio/);
    expect(alertCalls().at(-1)).toContain('severity=medium');
    expect(screen.getByLabelText('Alert type INTENT_OUT_OF_SCOPE')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters' })[0]);
    await waitFor(() => expect(screen.getAllByTestId('fleet-alert-row')).toHaveLength(4));

    fireEvent.change(screen.getByLabelText('Filter by session id'), { target: { value: 's-2' } });
    await waitFor(() => expect(screen.getAllByTestId('fleet-alert-row')).toHaveLength(1));
    expect(alertCalls().at(-1)).toContain('session=s-2');

    fireEvent.change(screen.getByLabelText('Filter by session id'), { target: { value: 'nope' } });
    expect(await screen.findByText('No alerts match these filters')).toBeInTheDocument();
  });

  it('opens the alert drawer with summary, evidence, source events and links', async () => {
    mockFetch(routes());
    renderApp(<FleetPage />, { route: '/fleet?range=24h' });
    const table = await screen.findByRole('table', { name: 'Fleet alerts' });
    fireEvent.click(within(table).getByRole('button', { name: 'Open alert Agent drifted from refund goal' }));

    const detail = await screen.findByTestId('fleet-alert-detail');
    expect(within(detail).getByText(/exporting the customer table/)).toBeInTheDocument();
    expect(within(detail).getByText(/similarity/)).toBeInTheDocument();
    const sources = within(detail).getByRole('list', { name: 'Source event ids' });
    expect(within(sources).getByText('ev-1')).toBeInTheDocument();
    expect(within(sources).getByText('ev-2')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /Open incident/ })).toHaveAttribute('href', '/incidents/inc-9');
    const timeline = within(detail).getByRole('link', { name: /Session timeline/ });
    const qs = new URLSearchParams(timeline.getAttribute('href')!.split('?')[1]);
    expect(qs.get('sid')).toBe('s-1');
    expect(qs.get('range')).toBe('24h');
    expect(qs.get('alert')).toBeNull();
    // Served from the list cache — no per-alert request.
    expect(calls.some(u => u.startsWith('/api/gov/fleet/alerts/'))).toBe(false);
  });

  it('fetches a deep-linked alert that is not in any list', async () => {
    mockFetch({ ...routes(), 'GET /api/gov/fleet/alerts': [] });
    renderApp(<FleetPage />, { route: '/fleet?alert=fa-1' });
    expect(await screen.findByTestId('fleet-alert-detail')).toBeInTheDocument();
    expect(calls).toContain('/api/gov/fleet/alerts/fa-1');
  });

  it('groups alerts per agent on the Agents tab', async () => {
    mockFetch(routes());
    renderApp(<FleetPage />, { route: '/fleet?tab=agents' });
    const table = await screen.findByRole('table', { name: 'Agents with fleet alerts' });
    const support = within(table).getByRole('rowheader', { name: /support-bot/ }).closest('tr')!;
    expect(within(support).getByText('3')).toBeInTheDocument();
    expect(within(support).getByLabelText('Severity Critical')).toBeInTheDocument();
    expect(within(support).getByLabelText('PROMPT_INJECTION_SUSPECTED: 1')).toBeInTheDocument();
    expect(alertCalls()[0]).toContain('limit=2000');

    fireEvent.click(within(support).getByRole('button', { name: 'View alerts for support-bot' }));
    await waitFor(() => expect(screen.getAllByTestId('fleet-alert-row')).toHaveLength(3));
    expect(alertCalls().at(-1)).toContain('agent=support-bot');
  });

  it('shows a session timeline oldest-first', async () => {
    mockFetch(routes());
    renderApp(<FleetPage />, { route: '/fleet?tab=session&sid=s-1' });
    const list = await screen.findByTestId('fleet-session-timeline');
    const items = within(list).getAllByTestId('fleet-timeline-item');
    expect(items.map(i => i.getAttribute('data-alert-type'))).toEqual(['USER_PERSISTENCE_AFTER_BLOCK', 'GOAL_DRIFT', 'PROMPT_INJECTION_SUSPECTED']);
    expect(within(screen.getByTestId('fleet-session-header')).getByText(/support-bot/)).toBeInTheDocument();
    expect(alertCalls().some(u => u.includes('session=s-1'))).toBe(true);
  });
});

describe('fleet helpers', () => {
  it('groupByAgent derives per-agent counts, worst severity and top types', () => {
    const rows = groupByAgent(ALERTS);
    expect(rows.map(r => r.key)).toEqual(['support-bot', 'hr-helper']);
    expect(rows[0]).toMatchObject({ total: 3, worst: 'critical', maxScore: 91, sessions: 1, incidents: 1, platforms: ['foundry'] });
    expect(rows[1].topTypes).toEqual([{ type: 'INTENT_OUT_OF_SCOPE', count: 1 }]);
  });

  it('gov.fleet.alerts WS messages seed the alert cache and refresh fleet queries', () => {
    const qc = new QueryClient();
    expect(handleGovMessage(qc, { type: 'gov.fleet.alerts', alerts: [ALERTS[1]] })).toEqual(['fleet']);
    expect(qc.getQueryData(fleetKeys.alert('fa-2'))).toEqual(ALERTS[1]);
  });

  it('is linked from the navigation', () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    renderApp(<AppShell><Box>Body</Box></AppShell>, { route: '/overview', path: '*' });
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', '/fleet');
  });
});
