import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Box, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import type { Approval, Decision, Principal, Role, SimulationResult } from '../api/governance';
import { ApprovalsPage } from '../pages/approvals/ApprovalsPage';
import { LaneEditorPage } from '../pages/lanes/LaneEditorPage';
import { SimulatePanel, SimulationResults } from '../pages/lanes/SimulatePanel';
import { DecisionDetail } from '../components/gov/DecisionDrawer';
import { RoleButton, RoleIconButton } from '../components/gov/GovCommon';
import { ChatPanel } from '../pages/ask/ChatPanel';
import { AppShell } from '../components/AppShell';
import { createSseParser, parseChatEvent } from '../lib/sse';
import { matchDecisions } from '../lib/decisionMatch';
import { diffLines, sideBySide } from '../lib/diff';
import { toYaml } from '../lib/yaml';
import { containmentCall } from '../pages/incidents/IncidentDetailPage';
import { bucketTrend } from '../pages/governance/DecisionTrend';
import type { ToolItem } from '../api/types';

describe('bucketTrend', () => {
  const pt = (t: string) => ({ t, allow: 1, deny: 0, wouldDeny: 0 });
  it('keeps short hourly series hourly', () => {
    expect(bucketTrend([pt('2026-09-29T10:00:00.000Z'), pt('2026-09-29T11:00:00.000Z')]).bucket).toBe('hour');
  });
  it('detects daily series from point spacing (no roll-up, day labels)', () => {
    const r = bucketTrend([pt('2026-09-28T00:00:00.000Z'), pt('2026-09-29T00:00:00.000Z')]);
    expect(r.bucket).toBe('day');
    expect(r.points).toHaveLength(2);
  });
});

// ── Harness ────────────────────────────────────────────────────────────────

type Handler = (url: string, init: RequestInit | undefined) => unknown;

interface FakeResponse {
  ok: boolean; status: number; statusText: string; headers: Headers;
  json: () => Promise<unknown>; text: () => Promise<string>; body: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } } | null;
}

const reply = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)), body: null,
});

const sse = (chunks: string[]): FakeResponse => {
  const enc = new TextEncoder();
  const queue = chunks.map(c => enc.encode(c));
  return {
    ...reply(null), body: { getReader: () => ({ read: async () => (queue.length ? { done: false, value: queue.shift() } : { done: true }) }) },
  };
};

let calls: { url: string; method: string; body?: unknown }[] = [];

function mockFetch(routes: Record<string, Handler | unknown>) {
  calls = [];
  const fn = vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.split('?')[0];
    const key = Object.keys(routes).find(k => k === `${method} ${path}`) ?? Object.keys(routes).find(k => k === `${method} ${url}`);
    if (!key) return reply({ error: 'not found' }, 404);
    const h = routes[key];
    const out = typeof h === 'function' ? (h as Handler)(url, init) : h;
    return (out && typeof out === 'object' && 'ok' in (out as object) && 'status' in (out as object)) ? out : reply(out);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

const principal = (...roles: Role[]): Principal => ({ id: 'alice@contoso.com', name: 'Alice', kind: 'user', roles });

function renderApp(ui: ReactNode, { route = '/', path = '*', roles = ['PolicyAdmin'] as Role[] } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const auth: AuthState = { mode: 'local', principal: principal(...roles), governance: true, config: null, loading: false };
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={buildTheme('dark')}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[route]}>
            <Routes><Route path={path} element={ui} /></Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

const approval = (over: Partial<Approval> = {}): Approval => ({
  id: 'ap-1', requestId: 'toolu_1', sessionId: 's-1', agentId: 'support-bot', laneId: 'support', toolName: 'issue_refund',
  summary: 'Refund $900 to order 42', reason: 'Refunds above $500 need approval', channels: ['dashboard', 'teams'], state: 'pending',
  requestedAt: new Date().toISOString(), expiresAt: inMinutes(5), ...over,
});

const decision = (over: Partial<Decision> = {}): Decision => ({
  id: 'd-1', requestId: 'toolu_9', sessionId: 's-1', agentId: 'support-bot', laneId: 'support', laneVersion: 3, mode: 'enforce',
  checkpoint: 'pre_tool', toolName: 'issue_refund', category: 'WRITE', verdict: 'deny', effectiveVerdict: 'deny', wouldDeny: false,
  stage: 'judge_escalation', reason: 'Refund destination is an external IBAN', ruleIds: ['refund-external'], tainted: true, latencyMs: 812,
  createdAt: '2026-01-01T00:00:10Z', seq: 41, prevHash: 'aaa111', hash: 'bbb222',
  judge: [{ verdict: 'deny', confidence: 0.82, rationale: 'Sending money to an unverified external account contradicts the lane purpose.', laneClause: 'never: move money outside the company', model: 'gpt-4.1', tier: 'escalation', latencyMs: 640 }],
  ...over,
});

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); });

// ── Approvals ──────────────────────────────────────────────────────────────

describe('approvals', () => {
  it('shows a local admin unlock hint for least-privilege loopback principals', async () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    renderApp(<AppShell><Box>Body</Box></AppShell>, { roles: ['Agent', 'Viewer'] });
    expect(screen.getByText('Unlock admin')).toBeInTheDocument();
  });

  it('approves only after explicit confirmation', async () => {
    mockFetch({
      'GET /api/gov/approvals': [approval()],
      'POST /api/gov/approvals/ap-1/approve': () => approval({ state: 'approved', resolvedBy: 'alice@contoso.com' }),
    });
    renderApp(<ApprovalsPage />, { route: '/approvals', roles: ['Approver'] });

    fireEvent.click(await screen.findByRole('button', { name: 'Approve Refund $900 to order 42' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Approve this action?')).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), { target: { value: 'verified with finance' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm approve' }));

    await waitFor(() => expect(calls.find(c => c.method === 'POST')).toMatchObject({ url: '/api/gov/approvals/ap-1/approve', body: { note: 'verified with finance' } }));
    expect(await within(dialog).findByText('Action approved.')).toBeInTheDocument();
  });

  it('opens a confirmation dialog for Teams deep links and never auto-resolves', async () => {
    mockFetch({
      'GET /api/gov/approvals': [approval()],
      'POST /api/gov/approvals/ap-1/deny': () => approval({ state: 'denied' }),
    });
    renderApp(<ApprovalsPage />, { route: '/approvals?id=ap-1&action=deny', roles: ['Approver'] });

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Deny this action?')).toBeInTheDocument();
    expect(await within(dialog).findByText('Refund $900 to order 42')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 50));
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm deny' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.url === '/api/gov/approvals/ap-1/deny')).toBe(true));
  });

  it('disables approve/deny for users without the Approver role', async () => {
    mockFetch({ 'GET /api/gov/approvals': [approval()] });
    renderApp(<ApprovalsPage />, { route: '/approvals', roles: ['Viewer'] });
    expect(await screen.findByRole('button', { name: 'Approve Refund $900 to order 42' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Deny Refund $900 to order 42' })).toBeDisabled();
  });
});

// ── Role-based disabling ───────────────────────────────────────────────────

describe('role gating', () => {
  it('disables PolicyAdmin actions for viewers and enables them for admins', () => {
    const { unmount } = renderApp(<><RoleButton roles={['PolicyAdmin']}>Activate</RoleButton><RoleIconButton roles={['PolicyAdmin']} title="Kill switch: pause bot">x</RoleIconButton></>, { roles: ['Viewer', 'Approver'] });
    expect(screen.getByRole('button', { name: 'Activate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Kill switch: pause bot' })).toBeDisabled();
    unmount();
    renderApp(<RoleButton roles={['Approver']}>Approve</RoleButton>, { roles: ['PolicyAdmin'] });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled(); // PolicyAdmin implies Approver
  });
});

// ── Lanes ──────────────────────────────────────────────────────────────────

describe('lanes editor', () => {
  it('shows YAML validation errors from the server', async () => {
    mockFetch({
      'GET /api/gov/agents': [],
      'POST /api/gov/lanes/validate': (_u: string, init?: RequestInit) => {
        const { yaml } = JSON.parse(String(init?.body)) as { yaml: string };
        return yaml.includes('purpose: ""') || !yaml.includes('purpose')
          ? { ok: false, errors: ['line 3: purpose is required', 'mode must be one of observe, enforce, enforce+approval'] }
          : { ok: true, errors: [] };
      },
    });
    renderApp(<LaneEditorPage />, { route: '/lanes/new', path: '/lanes/:id' });
    fireEvent.click(await screen.findByRole('tab', { name: 'YAML' }));
    const editor = screen.getByLabelText('Lane YAML');
    fireEvent.change(editor, { target: { value: 'id: demo\nversion: 1\nmode: sometimes\n' } });

    expect(await screen.findByText('line 3: purpose is required', {}, { timeout: 3000 })).toBeInTheDocument();
    const alert = screen.getByRole('alert', { name: 'Validation errors' });
    expect(within(alert).getByText('line 3: purpose is required')).toBeInTheDocument();
    expect(within(alert).getByText(/mode must be one of/)).toBeInTheDocument();
    expect(editor).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Activate' })).toBeDisabled();
  });

  it('renders simulation counts and samples', async () => {
    const result: SimulationResult = {
      evaluated: 120, wouldAllow: 100, wouldDeny: 12, wouldJudge: 6, wouldApprove: 2,
      samples: [{ eventId: 7, sessionId: 's-9', tool: 'Bash', summary: 'rm -rf /var/data', verdict: 'deny', ruleIds: ['no-recursive-delete'] }],
    };
    mockFetch({ 'GET /api/gov/agents': [], 'POST /api/gov/lanes/simulate': result });
    renderApp(<SimulatePanel yaml={'id: demo\n'} />);
    fireEvent.click(screen.getByRole('button', { name: 'Simulate against history' }));
    const out = await screen.findByTestId('simulation-results');
    expect(within(out).getByRole('group', { name: 'Would deny: 12' })).toBeInTheDocument();
    expect(within(out).getByRole('group', { name: 'Evaluated: 120' })).toBeInTheDocument();
    expect(within(out).getByText('rm -rf /var/data')).toBeInTheDocument();
    expect(within(out).getByText('no-recursive-delete')).toBeInTheDocument();
    expect(calls.find(c => c.method === 'POST')?.body).toMatchObject({ yaml: 'id: demo\n', limit: 50 });
  });

  it('renders provided results without a request', () => {
    renderApp(<SimulationResults result={{ evaluated: 3, wouldAllow: 3, wouldDeny: 0, wouldJudge: 0, wouldApprove: 0, samples: [] }} />);
    expect(screen.getByText('No sample actions.')).toBeInTheDocument();
  });
});

// ── Decision drawer ────────────────────────────────────────────────────────

describe('decision detail', () => {
  it('renders verdict, lane@version, rules, judge rationale and audit hash', () => {
    renderApp(<DecisionDetail d={decision()} />);
    expect(screen.getByLabelText('Verdict Denied')).toBeInTheDocument();
    expect(screen.getByText('Refund destination is an external IBAN')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'support@v3' })).toHaveAttribute('href', '/lanes/support?version=3');
    expect(screen.getByText('refund-external')).toBeInTheDocument();
    const judge = screen.getByTestId('judge-verdict');
    expect(within(judge).getByText(/unverified external account/)).toBeInTheDocument();
    expect(within(judge).getByText('gpt-4.1')).toBeInTheDocument();
    expect(within(judge).getByText('Escalation judge')).toBeInTheDocument();
    expect(within(judge).getByText('82%')).toBeInTheDocument();
    expect(within(judge).getByText('never: move money outside the company')).toBeInTheDocument();
    expect(screen.getByText(/tainted/)).toBeInTheDocument();
    expect(screen.getByText('bbb222')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open conversation' })).toHaveAttribute('href', '/conversations?c=s-1');
  });

  it('labels observe-mode suppressed denies as "Would deny"', () => {
    renderApp(<DecisionDetail d={decision({ verdict: 'allow', wouldDeny: true, mode: 'observe', judge: [] })} />);
    expect(screen.getByLabelText('Verdict Would deny')).toBeInTheDocument();
    expect(screen.getByText(/Observe mode/)).toBeInTheDocument();
  });
});

// ── Chat / SSE ─────────────────────────────────────────────────────────────

describe('chat SSE', () => {
  it('parses data lines split across chunks, multi-line data, comments and CRLF', () => {
    const got: string[] = [];
    const p = createSseParser(d => got.push(d));
    p.push('data: {"type":"del');
    p.push('ta","text":"Hel"}\n\n: keep-alive\n\ndata: {"type":"delta","text":"lo"}\r');
    p.push('\n\r\ndata: line1\ndata: line2\n\nevent: x\ndata: [DONE]');
    p.flush();
    expect(got).toEqual(['{"type":"delta","text":"Hel"}', '{"type":"delta","text":"lo"}', 'line1\nline2', '[DONE]']);
    expect(parseChatEvent(got[0])).toEqual({ type: 'delta', text: 'Hel' });
    expect(parseChatEvent('[DONE]')).toEqual({ type: 'done' });
    expect(parseChatEvent('not json')).toBeNull();
  });

  it('streams deltas as markdown with tool chips and citation links', async () => {
    mockFetch({
      'POST /api/gov/intelligence/chat': sse([
        'data: {"type":"tool","name":"list_blocked_actions","args":{"since":"24h"}}\n\n',
        'data: {"type":"delta","text":"Two actions were **blo"}\n\n',
        'data: {"type":"delta","text":"cked**."}\n\ndata: {"type":"citation","kind":"decision","id":"d-1","title":"Refund denied"}\n\n',
        'data: {"type":"citation","kind":"incident","id":"inc-7"}\n\ndata: {"type":"done"}\n\n',
      ]),
    });
    renderApp(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'What was blocked?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const turn = await screen.findByTestId('assistant-turn');
    await waitFor(() => expect(within(turn).getByText('blocked').tagName).toBe('STRONG'));
    expect(within(turn).getByText('list_blocked_actions')).toBeInTheDocument();
    expect(within(turn).getByRole('link', { name: /Refund denied/ })).toHaveAttribute('href', '/enforcements?d=d-1');
    expect(within(turn).getByRole('link', { name: /incident inc-7/ })).toHaveAttribute('href', '/incidents/inc-7');
    const sent = calls.find(c => c.url === '/api/gov/intelligence/chat');
    expect(sent?.body).toMatchObject({ messages: [{ role: 'user', content: 'What was blocked?' }] });
  });

  it('handles 503 (service not configured) gracefully', async () => {
    mockFetch({ 'POST /api/gov/intelligence/chat': reply({ error: 'not configured' }, 503) });
    renderApp(<ChatPanel />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hi' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })); });
    expect(await screen.findByText('Ask the monitor isn’t available')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toBeDisabled();
  });
});

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('governance helpers', () => {
  const tool = (id: number, name: string, t: string, extra: Partial<ToolItem> = {}): ToolItem => ({
    kind: 'tool', id, resultId: null, t, agentId: 'main', name, mcpServer: null, category: 'EXEC', status: 'success', durationMs: 1,
    preview: '', risk: null, channel: 'hook', hook: true, error: null, findings: [], ...extra,
  });

  it('matches decisions by tool_use_id first, then by tool name and time proximity', () => {
    const tools = [
      tool(1, 'Bash', '2026-01-01T00:00:00Z', { toolUseId: 'toolu_A' }),
      tool(2, 'Bash', '2026-01-01T00:00:05Z'),
      tool(3, 'Edit', '2026-01-01T00:00:06Z'),
      tool(4, 'Bash', '2026-01-01T01:00:00Z'),
    ];
    const ds = [
      decision({ id: 'x', requestId: 'toolu_A', toolName: 'Bash', createdAt: '2026-01-01T00:00:04Z' }),
      decision({ id: 'y', requestId: 'r2', toolName: 'bash', createdAt: '2026-01-01T00:00:04.5Z' }),
      decision({ id: 'z', requestId: 'r3', toolName: 'Edit', createdAt: '2026-01-01T00:00:30Z' }),
    ];
    const m = matchDecisions(tools, ds);
    expect(m.get(1)?.id).toBe('x');
    expect(m.get(2)?.id).toBe('y');
    expect(m.has(3)).toBe(false); // 24s away: outside the window
    expect(m.has(4)).toBe(false);
  });

  it('diffs YAML versions side by side', () => {
    const rows = sideBySide(diffLines('a\nb\nc\n', 'a\nB\nc\nd\n'));
    expect(rows.map(r => [r.left?.text ?? null, r.right?.text ?? null, !!(r.left?.changed || r.right?.changed)])).toEqual([
      ['a', 'a', false], ['b', 'B', true], ['c', 'c', false], [null, 'd', true],
    ]);
  });

  it('serialises lanes to YAML with quoting where needed', () => {
    const y = toYaml({ id: 'demo', mode: 'enforce+approval', purpose: 'Line one\nLine two', never: ['rm -rf: never', '*.pem'], judge: { escalateBelow: 0.7 }, empty: [] });
    expect(y).toContain('id: demo');
    expect(y).toContain('purpose: |\n  Line one\n  Line two');
    expect(y).toContain('never: ["rm -rf: never", "*.pem"]');
    expect(y).toContain('judge:\n  escalateBelow: 0.7');
    expect(y).not.toContain('empty');
  });

  it('maps Guardian recommendations to containment calls', () => {
    expect(containmentCall({ action: 'pause_agent', target: 'bot-1' })?.path).toBe('gov/agents/bot-1/pause');
    expect(containmentCall({ action: 'quarantine', target: 'session:s-9' })?.path).toBe('gov/sessions/s-9/quarantine');
    expect(containmentCall({ action: 'rotate_credentials', target: 'x' })).toBeNull();
  });
});
