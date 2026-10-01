import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Box, ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { AuthContext, type AuthState } from '../auth/context';
import { AppShell } from '../components/AppShell';
import { PageHeader } from '../components/PageHeader';
import { NAV_SECTIONS, findNavItem, visibleSections } from '../lib/nav';

const reply = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300, status, statusText: status === 200 ? 'OK' : 'Error', headers: new Headers(),
  json: async () => body, text: async () => JSON.stringify(body), body: null,
});

function mockFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input).split('?')[0]}`;
    return key in routes ? reply(routes[key]) : reply({ error: 'not found' }, 404);
  }));
}

function renderShell(ui: ReactNode, { route = '/overview', governance = true } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const auth: AuthState = { mode: 'local', principal: { id: 'alice', kind: 'user', roles: ['Approver', 'PolicyAdmin'] }, governance, config: null, loading: false };
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider theme={buildTheme('dark')}>
        <AuthContext.Provider value={auth}>
          <MemoryRouter initialEntries={[route]}>
            <Routes><Route path="*" element={<AppShell>{ui}</AppShell>} /></Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('navigation config', () => {
  it('describes every page and maps detail routes to their section', () => {
    const items = NAV_SECTIONS.flatMap(s => s.items);
    expect(new Set(items.map(i => i.path)).size).toBe(items.length);
    for (const i of items) {
      expect(i.description.length, i.label).toBeGreaterThan(30);
      expect(i.purpose.length, i.label).toBeGreaterThan(20);
    }
    expect(findNavItem('/policies/p-1')?.item.label).toBe('Policies');
    expect(findNavItem('/docs/architecture/agents')?.section.title).toBe('Help');
    expect(findNavItem('/lanesque')).toBeUndefined();
  });

  it('hides governance pages (and empty sections) when governance is off', () => {
    expect(visibleSections(false).map(s => [s.title, s.items.map(i => i.label)])).toEqual([
      ['Monitor', ['Overview', 'Conversations', 'Enforcements']],
      ['Help', ['Docs']],
    ]);
  });
});

describe('app shell side navigation', () => {
  it('groups pages into sections, marks the current page and keeps the time range', async () => {
    mockFetch({ 'GET /api/gov/approvals': [{ id: 'ap-1' }, { id: 'ap-2' }] });
    renderShell(<Box>Body</Box>, { route: '/policies/p-1?range=30d' });
    const nav = screen.getByRole('navigation', { name: 'Sections' });

    expect(within(nav).getAllByRole('region').map(r => r.getAttribute('aria-label'))).toEqual(['Monitor', 'Govern', 'Fleet & posture', 'Help']);
    expect(await within(nav).findByLabelText('2 pending')).toBeInTheDocument();
    const govern = within(nav).getByRole('region', { name: 'Govern' });
    expect(within(govern).getAllByRole('link').map(l => l.textContent)).toEqual(['Governance', 'Approvals2', 'Policies', 'Lanes', 'Agents']);
    expect(within(nav).getByRole('link', { name: 'Policies' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs?range=30d');
  });

  it('collapses to an icon rail, keeping accessible names, and remembers the choice', () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    const { unmount } = renderShell(<Box>Body</Box>);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse navigation' }));
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    expect(within(nav).queryByText('Monitor')).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', '/fleet');
    expect(localStorage.getItem('agentmon.nav.collapsed')).toBe('1');
    unmount();

    renderShell(<Box>Body</Box>);
    expect(screen.getByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
  });

  it('shows only the monitoring pages and docs without governance', () => {
    mockFetch({});
    renderShell(<Box>Body</Box>, { governance: false });
    const links = within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link').map(l => l.textContent);
    expect(links).toEqual(['Overview', 'Conversations', 'Enforcements', 'Docs']);
  });
});

describe('page header', () => {
  it('shows the section, title, description and purpose for the current page, with actions', () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    renderShell(<PageHeader actions={<button type="button">New lane</button>} />, { route: '/lanes' });
    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 2, name: 'Lanes' })).toBeInTheDocument();
    expect(within(header).getByText('Govern')).toBeInTheDocument();
    expect(header).toHaveTextContent(/mandate as code/);
    expect(header).toHaveTextContent(/Purpose\s*Define what an agent may do/);
    expect(within(header).getByRole('button', { name: 'New lane' })).toBeInTheDocument();
  });

  it('lets a page override the title and description', () => {
    mockFetch({ 'GET /api/gov/approvals': [] });
    renderShell(<PageHeader title="Ask the monitor" description="Custom text." />, { route: '/ask' });
    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 2, name: 'Ask the monitor' })).toBeInTheDocument();
    expect(header).toHaveTextContent('Custom text.');
    expect(header).toHaveTextContent(/Purpose\s*Get answers with citations/);
  });
});
