import type { ReactNode } from 'react';
import { Box, Button, IconButton, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import PolicyRoundedIcon from '@mui/icons-material/PolicyRounded';
import HealthAndSafetyRoundedIcon from '@mui/icons-material/HealthAndSafetyRounded';
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import MenuBookRoundedIcon from '@mui/icons-material/MenuBookRounded';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useThemeMode } from '../theme/ThemeModeProvider';
import { useLiveStatus } from '../api/live';
import { usePendingApprovals } from '../api/governance';
import { useAuth } from '../auth/context';
import { principalHasRole } from '../api/governance';
import { LiveDot } from './Primitives';
import { SettingsProvider, useOpenSettings } from './SettingsDialog';
import { AlertsMenu } from './AlertsMenu';
import { PrincipalMenu } from './gov/PrincipalMenu';
import { SimulationHeaderChip } from './gov/TestHarnessCard';
import { AskDrawerButton } from '../pages/ask/AskDrawerButton';

const TABS = [
  { path: '/overview', label: 'Overview' },
  { path: '/conversations', label: 'Conversations' },
  { path: '/governance', label: 'Governance', gov: true },
  { path: '/enforcements', label: 'Enforcements' },
  { path: '/approvals', label: 'Approvals', gov: true },
  { path: '/agents', label: 'Agents', gov: true },
  { path: '/lanes', label: 'Lanes', gov: true },
  { path: '/policies', label: 'Policies', gov: true, icon: <PolicyRoundedIcon fontSize="small" /> },
  { path: '/posture', label: 'Posture', gov: true, icon: <HealthAndSafetyRoundedIcon fontSize="small" /> },
  { path: '/incidents', label: 'Incidents', gov: true },
  { path: '/fleet', label: 'Fleet', gov: true, icon: <RadarRoundedIcon fontSize="small" /> },
  { path: '/jev', label: 'Jev vs LLM', gov: true, icon: <CompareArrowsRoundedIcon fontSize="small" /> },
  { path: '/ask', label: 'Ask', gov: true },
  { path: '/docs', label: 'Docs', icon: <MenuBookRoundedIcon fontSize="small" /> },
];

/** Pending-approvals count for the nav badge (live via gov.approval WS messages; polls as fallback). */
function ApprovalsLabel() {
  const live = useLiveStatus() === 'live';
  const { data } = usePendingApprovals(live ? 60_000 : 10_000);
  const n = data?.length ?? 0;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
      Approvals
      {n > 0 && (
        <Box component="span" aria-label={`${n} pending`} sx={{ minWidth: 18, height: 18, px: 0.6, borderRadius: 9, bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: 11, fontWeight: 700, lineHeight: '18px', textAlign: 'center' }}>
          {n > 99 ? '99+' : n}
        </Box>
      )}
    </Box>
  );
}

function LiveStatus() {
  const status = useLiveStatus();
  const label = status === 'live' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Reconnecting';
  return (
    <Tooltip title={status === 'live' ? 'Receiving live updates' : 'Live updates paused — retrying'}>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', px: 1.25, height: 28, borderRadius: 99, border: '1px solid', borderColor: 'divider', mr: 0.5 }}>
        <LiveDot on={status === 'live'} />
        <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 500 }}>{label}</Typography>
      </Stack>
    </Tooltip>
  );
}

function UnlockAdminHint() {
  return (
    <Tooltip title="Local loopback access is read-only for agents. To approve actions or edit policy, use the one-time admin login link printed by the server console, or launch the desktop app.">
      <Button size="small" variant="outlined" color="warning" sx={{ height: 28, px: 1.25 }}>
        Unlock admin
      </Button>
    </Tooltip>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <SettingsProvider><Shell>{children}</Shell></SettingsProvider>;
}

function Shell({ children }: { children: ReactNode }) {
  const { mode, toggle } = useThemeMode();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const openSettings = useOpenSettings();
  const { governance } = useAuth();
  const auth = useAuth();
  const needsLocalAdmin = governance && auth.mode === 'local' && !!auth.principal && !principalHasRole(auth.principal, 'Approver', 'PolicyAdmin');
  const tabs = TABS.filter(t => !t.gov || governance);
  const current = tabs.findIndex(t => pathname.startsWith(t.path));
  const range = params.get('range');
  const tabHref = (p: string) => (range ? `${p}?range=${range}` : p);

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box component="header" sx={{ px: { xs: 2, md: 3 }, pt: 2, position: 'sticky', top: 0, zIndex: 10, bgcolor: 'background.default', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
          <Typography variant="h4" component="h1" sx={{ flex: 1 }}>Agent Activity</Typography>
          <LiveStatus />
          {governance && <SimulationHeaderChip />}
          {needsLocalAdmin && <UnlockAdminHint />}
          {governance && <AskDrawerButton />}
          <Tooltip title="Sources, rules & privacy">
            <IconButton aria-label="Settings" onClick={() => openSettings('sources')}><TuneRoundedIcon fontSize="small" /></IconButton>
          </Tooltip>
          <AlertsMenu />
          <Tooltip title={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            <IconButton aria-label="Toggle theme" onClick={toggle} sx={{ '&:hover svg': { transform: 'rotate(-20deg)' }, '& svg': { transition: 'transform 300ms cubic-bezier(0.2,0,0,1)' } }}>
              {mode === 'dark' ? <LightModeOutlinedIcon fontSize="small" /> : <DarkModeOutlinedIcon fontSize="small" />}
            </IconButton>
          </Tooltip>
          <PrincipalMenu />
        </Stack>
        <Tabs value={current === -1 ? false : current} sx={{ mt: 0.5 }} aria-label="Sections" variant="scrollable" scrollButtons="auto" allowScrollButtonsMobile>
          {tabs.map(t => (
            <Tab key={t.path} icon={t.icon} iconPosition="start" label={t.path === '/approvals' ? <ApprovalsLabel /> : t.label} component={Link} to={tabHref(t.path)} />
          ))}
        </Tabs>
      </Box>
      <Box component="main" key={pathname.split('/')[1]} sx={{ flex: 1, px: { xs: 2, md: 3 }, py: 2.5, animation: 'am-fade-up 320ms both cubic-bezier(0.05, 0.7, 0.1, 1)' }}>
        {children}
      </Box>
    </Box>
  );
}
