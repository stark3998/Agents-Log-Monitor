/**
 * Auth wrapper for the dashboard.
 *
 * - Reads GET /api/gov/config → auth { mode, clientId, tenantId, audience }.
 * - Entra (cloud) mode: lazily loads MSAL (separate chunk, so local mode never downloads it), signs the
 *   user in and registers a token provider so every /api request, the chat SSE stream and the live
 *   WebSocket carry `Bearer` tokens for scope `api://<audience>/access_as_user`.
 * - Local mode: no sign-in; the server trusts loopback callers as the `local` principal.
 * - GET /api/gov/me supplies the principal + roles used to hide/disable actions.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, CircularProgress } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { fetchMe, govKeys, type GovConfig } from '../api/governance';
import { ApiError } from '../api/client';
import { AuthContext, type AuthState, type EntraSettings } from './context';

type Boot =
  | { kind: 'loading' }
  | { kind: 'local'; config: GovConfig | null; governance: boolean }
  | { kind: 'entra'; config: GovConfig | null; entra: EntraSettings };

function isEntra(cfg: GovConfig): boolean {
  const m = cfg.auth?.mode;
  return m === 'entra' || (m === 'cloud' && !!cfg.auth.clientId && !!cfg.auth.tenantId);
}

/**
 * Discover auth settings. /api/gov/config is itself protected in cloud mode, so on 401 use the public
 * GET /api/gov/auth-config, then fall back to the RFC 9728 protected-resource metadata (tenant +
 * audience) and the SPA client id from VITE_ENTRA_CLIENT_ID.
 */
export async function bootstrapAuth(): Promise<Boot> {
  let res: Response;
  try {
    res = await fetch('/api/gov/config', { headers: { Accept: 'application/json' } });
  } catch {
    return { kind: 'local', config: null, governance: false };
  }
  if (res.ok) {
    const cfg = await res.json() as GovConfig;
    if (isEntra(cfg)) {
      const audience = cfg.auth.audience ?? cfg.auth.clientId!;
      return { kind: 'entra', config: cfg, entra: { clientId: cfg.auth.clientId!, tenantId: cfg.auth.tenantId!, audience } };
    }
    return { kind: 'local', config: cfg, governance: true };
  }
  if (res.status === 401) {
    // Preferred: the server's public sign-in bootstrap endpoint.
    try {
      const pub = await fetch('/api/gov/auth-config', { headers: { Accept: 'application/json' } })
        .then(r => (r.ok ? r.json() : null)) as { mode?: string; clientId?: string; tenantId?: string; audience?: string } | null;
      if (pub?.mode === 'entra' && pub.clientId && pub.tenantId && pub.audience) {
        return { kind: 'entra', config: null, entra: { clientId: pub.clientId, tenantId: pub.tenantId, audience: pub.audience } };
      }
    } catch { /* fall back below */ }
    const env = import.meta.env as Record<string, string | undefined>;
    let tenantId = env.VITE_ENTRA_TENANT_ID ?? '';
    let audience = env.VITE_ENTRA_AUDIENCE ?? '';
    try {
      const md = await fetch('/.well-known/oauth-protected-resource').then(r => (r.ok ? r.json() : null)) as { resource?: string; authorization_servers?: string[] } | null;
      if (md?.resource && !audience) audience = md.resource;
      const as = md?.authorization_servers?.[0];
      const m = as?.match(/login\.microsoftonline\.com\/([^/]+)/i);
      if (m && !tenantId) tenantId = m[1];
    } catch { /* ignore */ }
    const clientId = env.VITE_ENTRA_CLIENT_ID ?? audience.replace(/^api:\/\//, '');
    if (clientId && tenantId && audience) return { kind: 'entra', config: null, entra: { clientId, tenantId, audience } };
  }
  return { kind: 'local', config: null, governance: res.status !== 404 };
}

const MsalShell = lazy(() => import('./msal'));

function FullPageSpinner() {
  return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress size={28} aria-label="Loading" /></Box>;
}

/** Local mode: principal from /api/gov/me (the server returns the `local` principal for loopback). */
function LocalAuth({ config, governance, children }: { config: GovConfig | null; governance: boolean; children: ReactNode }) {
  const me = useQuery({
    queryKey: govKeys.me, queryFn: fetchMe, enabled: governance, staleTime: 5 * 60_000,
    retry: (n, e) => !(e instanceof ApiError) && n < 1,
  });
  const value = useMemo<AuthState>(() => ({
    mode: 'local', principal: me.data ?? null, governance: governance && !me.isError, config, loading: me.isLoading,
  }), [me.data, me.isError, me.isLoading, governance, config]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<Boot>({ kind: 'loading' });
  useEffect(() => {
    let alive = true;
    void bootstrapAuth().then(b => { if (alive) setBoot(b); });
    return () => { alive = false; };
  }, []);
  const provide = useCallback((state: AuthState, node: ReactNode) => <AuthContext.Provider value={state}>{node}</AuthContext.Provider>, []);

  if (boot.kind === 'loading') return <FullPageSpinner />;
  if (boot.kind === 'local') return <LocalAuth config={boot.config} governance={boot.governance}>{children}</LocalAuth>;
  return (
    <Suspense fallback={<FullPageSpinner />}>
      <MsalShell settings={boot.entra} config={boot.config} provide={provide}>{children}</MsalShell>
    </Suspense>
  );
}
