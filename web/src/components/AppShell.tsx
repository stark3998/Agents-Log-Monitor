import { useState, type ReactNode } from 'react';
import { Box, Button, Drawer, IconButton, Stack, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import TuneRoundedIcon from '@mui/icons-material/TuneRounded';
import MenuRoundedIcon from '@mui/icons-material/MenuRounded';
import { useLocation } from 'react-router-dom';
import { useThemeMode } from '../theme/ThemeModeProvider';
import { useLiveStatus } from '../api/live';
import { useAuth } from '../auth/context';
import { principalHasRole } from '../api/governance';
import { LiveDot } from './Primitives';
import { SettingsProvider, useOpenSettings } from './SettingsDialog';
import { AlertsMenu } from './AlertsMenu';
import { PrincipalMenu } from './gov/PrincipalMenu';
import { SimulationHeaderChip } from './gov/TestHarnessCard';
import { AskDrawerButton } from '../pages/ask/AskDrawerButton';
import { SideNav } from './SideNav';
import { HEADER_HEIGHT, NAV_COLLAPSED_WIDTH, NAV_WIDTH } from './layout';

const COLLAPSED_KEY = 'agentmon.nav.collapsed';

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
  const openSettings = useOpenSettings();
  const { governance } = useAuth();
  const auth = useAuth();
  const theme = useTheme();
  const mobile = useMediaQuery(theme.breakpoints.down('md'), { noSsr: true });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* storage unavailable */ }
    return !c;
  });
  const needsLocalAdmin = governance && auth.mode === 'local' && !!auth.principal && !principalHasRole(auth.principal, 'Approver', 'PolicyAdmin');

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Box component="header" sx={{ px: { xs: 1.5, md: 2.5 }, height: HEADER_HEIGHT, flexShrink: 0, display: 'flex', alignItems: 'center', position: 'sticky', top: 0, zIndex: 10, bgcolor: 'background.default', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flex: 1, minWidth: 0 }}>
          {mobile && (
            <IconButton aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)} edge="start">
              <MenuRoundedIcon />
            </IconButton>
          )}
          <Typography variant="h5" component="h1" sx={{ flex: 1, fontWeight: 700, fontSize: { xs: 18, sm: 20 }, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>Agent Activity</Typography>
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
      </Box>
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {mobile ? (
          <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} slotProps={{ paper: { sx: { width: NAV_WIDTH + 24, bgcolor: 'background.default' } } }}>
            <Box component="nav" aria-label="Sections" sx={{ height: '100%' }}>
              <SideNav governance={governance} onNavigate={() => setDrawerOpen(false)} />
            </Box>
          </Drawer>
        ) : (
          <Box
            component="nav"
            aria-label="Sections"
            sx={{
              width: collapsed ? NAV_COLLAPSED_WIDTH : NAV_WIDTH, flexShrink: 0, position: 'sticky', top: HEADER_HEIGHT,
              height: `calc(100vh - ${HEADER_HEIGHT}px)`, borderRight: '1px solid', borderColor: 'divider',
              transition: 'width 200ms cubic-bezier(0.2, 0, 0, 1)', overflow: 'hidden',
            }}
          >
            <SideNav governance={governance} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />
          </Box>
        )}
        <Box component="main" key={pathname.split('/')[1]} sx={{ flex: 1, minWidth: 0, overflowX: 'clip', px: { xs: 2, md: 3 }, py: 2.5, animation: 'am-fade-up 320ms both cubic-bezier(0.05, 0.7, 0.1, 1)' }}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}
