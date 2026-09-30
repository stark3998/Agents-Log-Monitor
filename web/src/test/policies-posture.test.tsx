import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import type { Principal, Role } from '../api/governance';
import type { ClassifiersResponse, PolicyRecord, PresetCatalog } from '../api/policies';
import { PoliciesPage } from '../pages/policies/PoliciesPage';
import { PolicyEditorPage } from '../pages/policies/PolicyEditorPage';
import { PolicyForm } from '../pages/policies/PolicyForm';
import { newPolicy } from '../pages/policies/policyUtils';
import { PosturePage } from '../pages/posture/PosturePage';

interface FakeResponse { ok: boolean; status: number; statusText: string; headers: Headers; json: () => Promise<unknown>; text: () => Promise<string>; body: null }
type Handler = (url: string, init: RequestInit | undefined) => unknown;
const reply = (body: unknown, status = 200): FakeResponse => ({ ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(), json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)), body: null });
let calls: { url: string; method: string; body?: unknown }[] = [];
function mockFetch(routes: Record<string, Handler | unknown>) { calls = []; vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => { const method = init?.method ?? 'GET'; const url = String(input); calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined }); const path = url.split('?')[0]; const key = Object.keys(routes).find(k => k === `${method} ${path}`) ?? Object.keys(routes).find(k => k === `${method} ${url}`); if (!key) return reply({ error: 'not found' }, 404); const h = routes[key]; const out = typeof h === 'function' ? (h as Handler)(url, init) : h; return (out && typeof out === 'object' && 'ok' in (out as object) && 'status' in (out as object)) ? out as FakeResponse : reply(out); })); }
const principal = (...roles: Role[]): Principal => ({ id: 'alice', name: 'Alice', kind: 'user', roles });
function renderApp(ui: ReactNode, { route = '/', path = '*', roles = ['PolicyAdmin'] as Role[] } = {}) { const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); const auth: AuthState = { mode: 'local', principal: principal(...roles), governance: true, config: null, loading: false }; return render(<QueryClientProvider client={qc}><ThemeProvider theme={buildTheme('dark')}><AuthContext.Provider value={auth}><MemoryRouter initialEntries={[route]}><Routes><Route path={path} element={ui} /><Route path="*" element={<LocationEcho />} /></Routes></MemoryRouter></AuthContext.Provider></ThemeProvider></QueryClientProvider>); }
function LocationEcho() { const loc = useLocation(); return <div data-testid="location">{loc.pathname}</div>; }
afterEach(() => vi.unstubAllGlobals());

const policies: PolicyRecord[] = [{ status: 'active', updatedAt: '2026-01-01T00:00:00Z', policy: { id: 'exfil', version: 2, name: 'Block exfiltration', enabled: true, global: true, mode: 'enforce', severity: 'critical', rules: [{ id: 'deny-secrets', action: 'deny', classifier: ['secret'] }] } }];
const presets: PresetCatalog = { filesystem: [{ id: 'fs.home', group: 'Home', label: 'Home files', pattern: '~/**', description: 'User home' }], network: [], credential: [], capability: [{ id: 'cap.shell', group: 'Shell', label: 'Shell', pattern: 'shell', description: 'Shell execution' }], mcpCategory: [] };
const classifiers: ClassifiersResponse = { config: { overrides: {}, custom: [] }, items: [{ code: 'secret', label: 'Secret', description: 'Secrets', category: 'Secrets', sensitivity: 'High', contextRequired: false, isActive: true, enforceable: true, source: 'builtin', pattern: 'x' }, { code: 'pii', label: 'PII', description: 'PII', category: 'PII', sensitivity: 'Medium', contextRequired: false, isActive: true, enforceable: false, source: 'builtin', pattern: 'y' }] };

describe('policies ui', () => {
  it('renders policy list and navigates to the editor', async () => {
    mockFetch({ 'GET /api/gov/policies': policies });
    renderApp(<PoliciesPage />, { route: '/policies', path: '/policies' });
    fireEvent.click(await screen.findByText('Block exfiltration'));
    expect(await screen.findByTestId('location')).toHaveTextContent('/policies/exfil');
  });

  it('shows server validation errors in the policy editor', async () => {
    mockFetch({ 'GET /api/gov/presets': presets, 'GET /api/gov/classifiers': classifiers, 'POST /api/gov/policies/validate': { ok: false, errors: ['rule id is required'] } });
    renderApp(<PolicyEditorPage />, { route: '/policies/new', path: '/policies/:id' });
    expect(await screen.findByText('rule id is required', undefined, { timeout: 1500 })).toBeInTheDocument();
  });

  it('offers grouped presets and only enforceable classifiers in the rule builder', async () => {
    const policy = newPolicy('p1'); policy.rules = [{ id: 'r1', action: 'deny' }];
    renderApp(<PolicyForm policy={policy} onChange={() => undefined} presets={presets} classifiers={classifiers.items} />, { roles: ['PolicyAdmin'] });
    fireEvent.mouseDown(screen.getByLabelText('Filesystem'));
    expect(await screen.findByText('Home')).toBeInTheDocument();
    expect(screen.getByText(/Home files/)).toBeInTheDocument();
    const enforceable = screen.getByTestId('enforceable-classifiers');
    expect(enforceable).toHaveTextContent('Secret');
    expect(enforceable).not.toHaveTextContent('PII');
  });

  it('rolls classifier switch back when PATCH fails', async () => {
    mockFetch({ 'GET /api/gov/classifiers': classifiers, 'PATCH /api/gov/classifiers/secret': reply({ error: 'boom' }, 500) });
    renderApp(<PoliciesPage />, { route: '/policies?tab=classifiers', path: '/policies' });
    const sw = await screen.findByLabelText('Active secret');
    expect(sw).toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true));
    await waitFor(() => expect(screen.getByLabelText('Active secret')).toBeChecked());
  });
});

const checks = { config: { checks: {}, orgDomains: ['contoso.com'], alertMinSeverity: 'high', incidentOnCritical: true }, items: [{ id: 'mcp-remote', title: 'Remote MCP server', description: 'Remote server configured', severity: 'high', effectiveSeverity: 'high', category: 'MCP', level: 'endpoint', platforms: ['win32'], confidence: 'confirmed', enabled: true, remediation: { summary: 'Remove the server', snippet: 'agent mcp remove bad', autoFix: true } }] };
const endpoint = { id: 'ep1', hostname: 'laptop', user: 'alice', os: 'Windows', lastScanAt: '2026-01-01T00:00:00Z', source: 'local', isLocal: true, findingCounts: { high: 1 }, agents: [{ id: 'a1', name: 'Copilot', version: '1.0' }], mcpServerCount: 1, extensionCount: 2 };
const finding = { id: 'f1', endpointId: 'ep1', hostname: 'laptop', checkId: 'mcp-remote', level: 'endpoint', title: 'Remote MCP server', severity: 'high', category: 'MCP', subject: 'bad-server', summary: 'A remote server is configured', evidence: { command: 'npx bad' }, fixable: true, state: 'open', firstSeenAt: '2026-01-01T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z' };

describe('posture ui', () => {
  function postureRoutes(extra: Record<string, Handler | unknown> = {}) { mockFetch({ 'GET /api/gov/posture/summary': { open: 1, endpoints: 1, bySeverity: { high: 1 }, byCategory: { MCP: 1 }, byCheck: { 'mcp-remote': 1 }, lastScanAt: '2026-01-01T00:00:00Z' }, 'GET /api/gov/posture/findings': [finding], 'GET /api/gov/posture/findings/f1': { ...finding, check: checks.items[0] }, 'GET /api/gov/posture/endpoints': [endpoint], 'GET /api/gov/posture/endpoints/ep1': { ...endpoint, inventory: { agents: [{ id: 'a1', name: 'Copilot', kind: 'cli', configPaths: ['settings.json'] }], mcpServers: [{ name: 'bad', client: 'copilot', configPath: 'mcp.json', transport: 'stdio', identities: ['alice'], categories: ['network'] }], extensions: [{ id: 'ext', host: 'vscode', permissions: ['workspace'] }], scheduledTasks: [{ source: 'Task Scheduler', name: 'agent', command: 'agent.exe' }], accounts: [{ agentId: 'a1', account: 'alice' }], errors: ['scan warning'] } }, 'GET /api/gov/posture/checks': checks, 'PUT /api/gov/posture/config': checks.config, ...extra }); }

  it('opens a finding drawer with remediation and local auto-fix action', async () => {
    postureRoutes();
    renderApp(<PosturePage />, { route: '/posture', path: '/posture' });
    fireEvent.click(await screen.findByText('Remote MCP server'));
    expect(await screen.findByText('agent mcp remove bad')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix automatically' })).toBeInTheDocument();
  });

  it('hides automatic fix when the endpoint is not local', async () => {
    postureRoutes({ 'GET /api/gov/posture/endpoints': [{ ...endpoint, isLocal: false }] });
    renderApp(<PosturePage />, { route: '/posture', path: '/posture' });
    fireEvent.click(await screen.findByText('Remote MCP server'));
    await screen.findByText('agent mcp remove bad');
    expect(screen.queryByRole('button', { name: 'Fix automatically' })).not.toBeInTheDocument();
  });

  it('saves posture check settings', async () => {
    postureRoutes();
    renderApp(<PosturePage />, { route: '/posture?tab=checks', path: '/posture' });
    await screen.findByText('Remote server configured');
    const save = screen.getByRole('button', { name: 'Save posture config' });
    await waitFor(() => expect(save).not.toBeDisabled());
    fireEvent.click(save);
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url === '/api/gov/posture/config')).toBe(true));
  });

  it('shows endpoint inventory in a drawer', async () => {
    postureRoutes();
    renderApp(<PosturePage />, { route: '/posture?tab=endpoints', path: '/posture' });
    fireEvent.click(await screen.findByText('laptop'));
    expect(await screen.findByText(/scan warning/)).toBeInTheDocument();
    expect(screen.getByText(/settings.json/)).toBeInTheDocument();
  });
});

