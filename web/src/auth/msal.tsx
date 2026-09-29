/**
 * MSAL (Entra ID) shell — loaded lazily only in cloud mode.
 *
 * Tokens: acquireTokenSilent() for every request; interactive redirect only when silent acquisition
 * fails with InteractionRequiredAuthError. MSAL manages its own cache (sessionStorage) — tokens are
 * never persisted by the app.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Card, CircularProgress, Stack, Typography } from '@mui/material';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import { useQuery } from '@tanstack/react-query';
import {
  EventType, InteractionRequiredAuthError, PublicClientApplication, type AccountInfo, type AuthenticationResult, type EventMessage,
} from '@azure/msal-browser';
import { MsalProvider, useIsAuthenticated, useMsal } from '@azure/msal-react';
import { fetchMe, govKeys, type GovConfig } from '../api/governance';
import { setTokenProvider } from './token';
import { apiScope, type AuthState, type EntraSettings } from './context';

let instance: { key: string; pca: PublicClientApplication; ready: Promise<void> } | null = null;

function getPca(s: EntraSettings) {
  const key = `${s.tenantId}|${s.clientId}`;
  if (instance?.key === key) return instance;
  const pca = new PublicClientApplication({
    auth: {
      clientId: s.clientId,
      authority: `https://login.microsoftonline.com/${s.tenantId}`,
      redirectUri: `${window.location.origin}/`,
      postLogoutRedirectUri: `${window.location.origin}/`,
    },
    cache: { cacheLocation: 'sessionStorage' },
  });
  const ready = (async () => {
    await pca.initialize();
    const res = await pca.handleRedirectPromise().catch(() => null);
    if (res?.account) pca.setActiveAccount(res.account);
    else if (!pca.getActiveAccount() && pca.getAllAccounts().length) pca.setActiveAccount(pca.getAllAccounts()[0]);
    pca.addEventCallback((e: EventMessage) => {
      if (e.eventType === EventType.LOGIN_SUCCESS && (e.payload as AuthenticationResult | null)?.account) {
        pca.setActiveAccount((e.payload as AuthenticationResult).account);
      }
    });
  })();
  instance = { key, pca, ready };
  return instance;
}

function SignIn({ scope }: { scope: string }) {
  const { instance: pca, inProgress } = useMsal();
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Card sx={{ p: 4, maxWidth: 420, width: '100%' }}>
        <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
          <ShieldOutlinedIcon sx={{ fontSize: 32, color: 'primary.main' }} />
          <Typography variant="h5" component="h1">Agent governance</Typography>
          <Typography variant="body2" color="text.secondary">
            Sign in with your Microsoft Entra ID work account to view agent activity, approve actions and manage lanes.
          </Typography>
          <Button
            variant="contained"
            disabled={inProgress !== 'none'}
            onClick={() => void pca.loginRedirect({ scopes: [scope] })}
          >
            {inProgress !== 'none' ? 'Signing in…' : 'Sign in with Microsoft'}
          </Button>
        </Stack>
      </Card>
    </Box>
  );
}

function Authenticated({ scope, config, provide, children }: {
  scope: string; config: GovConfig | null; provide: (s: AuthState, n: ReactNode) => ReactNode; children: ReactNode;
}) {
  const { instance: pca } = useMsal();
  const [tokenReady, setTokenReady] = useState(false);

  useEffect(() => {
    setTokenProvider(async () => {
      const account: AccountInfo | null = pca.getActiveAccount() ?? pca.getAllAccounts()[0] ?? null;
      if (!account) return null;
      try {
        const r = await pca.acquireTokenSilent({ scopes: [scope], account });
        return r.accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) await pca.acquireTokenRedirect({ scopes: [scope], account });
        throw e;
      }
    });
    setTokenReady(true);
    return () => setTokenProvider(null);
  }, [pca, scope]);

  const me = useQuery({ queryKey: govKeys.me, queryFn: fetchMe, enabled: tokenReady, staleTime: 5 * 60_000, retry: 1 });
  const value = useMemo<AuthState>(() => ({
    mode: 'entra', principal: me.data ?? null, governance: !me.isError, config, loading: !tokenReady || me.isLoading,
    signOut: () => void pca.logoutRedirect(),
  }), [me.data, me.isError, me.isLoading, tokenReady, config, pca]);

  if (!tokenReady) return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress size={28} aria-label="Loading" /></Box>;
  return <>{provide(value, children)}</>;
}

function Gate({ scope, config, provide, children }: {
  scope: string; config: GovConfig | null; provide: (s: AuthState, n: ReactNode) => ReactNode; children: ReactNode;
}) {
  const authed = useIsAuthenticated();
  if (!authed) return <SignIn scope={scope} />;
  return <Authenticated scope={scope} config={config} provide={provide}>{children}</Authenticated>;
}

export default function MsalShell({ settings, config, provide, children }: {
  settings: EntraSettings; config: GovConfig | null; provide: (s: AuthState, n: ReactNode) => ReactNode; children: ReactNode;
}) {
  const { pca, ready } = getPca(settings);
  const [initialised, setInitialised] = useState(false);
  useEffect(() => { let alive = true; void ready.then(() => { if (alive) setInitialised(true); }); return () => { alive = false; }; }, [ready]);
  const scope = apiScope(settings.audience);
  if (!initialised) return <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><CircularProgress size={28} aria-label="Signing in" /></Box>;
  return (
    <MsalProvider instance={pca}>
      <Gate scope={scope} config={config} provide={provide}>{children}</Gate>
    </MsalProvider>
  );
}
