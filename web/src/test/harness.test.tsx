import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import type { CopilotHooksStatus, Principal } from '../api/governance';
import { SimulationHeaderChip, TestHarnessCard } from '../components/gov/TestHarnessCard';

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body), body: null,
});

let calls: { method: string; url: string; body?: unknown }[] = [];

function mockFetch(routes: Record<string, unknown | ((body: any) => unknown)>) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const key = `${method} ${url.split('?')[0]}`;
    if (!(key in routes)) return reply({ error: 'not found' }, 404);
    const h = routes[key];
    return reply(typeof h === 'function' ? (h as (b: unknown) => unknown)(body) : h);
  }));
}

const admin: Principal = { id: 'local-admin', kind: 'local', roles: ['Viewer', 'Approver', 'PolicyAdmin', 'Agent'] };
const viewer: Principal = { id: 'alice', kind: 'user', roles: ['Viewer'] };

function renderUi(ui: ReactNode, principal: Principal = admin) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const auth: AuthState = { mode: 'local', principal, governance: true, config: null, loading: false };
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={buildTheme('dark')}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter>{ui}</MemoryRouter>
        </AuthContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const status = (over: Partial<CopilotHooksStatus> = {}): CopilotHooksStatus => ({
  mode: 'local', available: true, simulation: { enabled: false, source: 'env' }, copilotHome: 'C:/Users/me/.copilot',
  forwarder: { powershell: 'C:/repo/scripts/copilot-hook-forward.ps1', bash: 'C:/repo/scripts/copilot-hook-forward.sh', present: true },
  targets: [
    { target: 'copilot-cli', path: 'C:/Users/me/.copilot/hooks/agent-governance.json', installed: false, managed: false },
    { target: 'vscode', path: 'C:/Users/me/.copilot/hooks/agent-governance-vscode.json', installed: false, managed: false },
  ],
  ...over,
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('governance test harness', () => {
  it('installs Copilot CLI hooks with simulation turned on first', async () => {
    const installed = status({
      simulation: { enabled: true, source: 'setting', updatedBy: 'local-admin' },
      targets: [
        { target: 'copilot-cli', path: 'C:/Users/me/.copilot/hooks/agent-governance.json', installed: true, managed: true, failMode: 'open', port: 4317 },
        status().targets[1],
      ],
    });
    mockFetch({ 'GET /api/gov/hooks/copilot': status(), 'POST /api/gov/hooks/copilot/install': installed });
    renderUi(<TestHarnessCard />);
    const row = await screen.findByTestId('hook-row-copilot-cli');
    expect(within(row).getByText('Not installed')).toBeInTheDocument();
    expect(screen.getByTestId('simulation-chip')).toHaveTextContent('Enforcing');
    fireEvent.click(within(row).getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(within(screen.getByTestId('hook-row-copilot-cli')).getByText('Installed')).toBeInTheDocument());
    expect(calls.find(c => c.method === 'POST')?.body).toEqual({ targets: ['copilot-cli'], failMode: 'open', simulate: true });
    expect(screen.getByTestId('simulation-chip')).toHaveTextContent(/Simulating/);
    expect(screen.getByTestId('hooks-next-step')).toHaveTextContent(/Uninstall the hooks or turn simulation off/);
  });

  it('warns when installing without simulation and uninstalls a target', async () => {
    const withCli = status({ targets: [{ ...status().targets[0], installed: true, managed: true, failMode: 'open' }, status().targets[1]] });
    mockFetch({ 'GET /api/gov/hooks/copilot': withCli, 'POST /api/gov/hooks/copilot/uninstall': status() });
    renderUi(<TestHarnessCard />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Turn on simulation when installing' }));
    expect(screen.getByText(/will block real tool calls/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('hook-row-copilot-cli')).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(within(screen.getByTestId('hook-row-copilot-cli')).getByText('Not installed')).toBeInTheDocument());
    expect(calls.find(c => c.method === 'POST')).toMatchObject({ url: '/api/gov/hooks/copilot/uninstall', body: { targets: ['copilot-cli'] } });
  });

  it('toggles simulation', async () => {
    mockFetch({ 'GET /api/gov/hooks/copilot': status(), 'PUT /api/gov/simulation': { enabled: true, source: 'setting' } });
    renderUi(<TestHarnessCard />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Simulation mode' }));
    await waitFor(() => expect(screen.getByTestId('simulation-chip')).toHaveTextContent(/Simulating/));
    expect(calls.find(c => c.method === 'PUT')?.body).toEqual({ enabled: true });
  });

  it('is read-only for non-admins', async () => {
    mockFetch({ 'GET /api/gov/hooks/copilot': status() });
    renderUi(<TestHarnessCard />, viewer);
    expect(await screen.findByRole('switch', { name: 'Simulation mode' })).toBeDisabled();
    expect(within(screen.getByTestId('hook-row-copilot-cli')).getByRole('button', { name: 'Install' })).toBeDisabled();
  });

  it('shows the header chip only while simulating', async () => {
    mockFetch({ 'GET /api/gov/simulation': { enabled: true, source: 'setting' } });
    renderUi(<SimulationHeaderChip />);
    expect(await screen.findByTestId('simulation-header-chip')).toHaveTextContent('Simulation');
  });
});
