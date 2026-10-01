import { Badge, Box, Divider, List, ListItemButton, ListItemIcon, ListItemText, Tooltip, Typography, alpha } from '@mui/material';
import KeyboardDoubleArrowLeftRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowLeftRounded';
import KeyboardDoubleArrowRightRoundedIcon from '@mui/icons-material/KeyboardDoubleArrowRightRounded';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useLiveStatus } from '../api/live';
import { usePendingApprovals } from '../api/governance';
import { visibleSections, type NavItem } from '../lib/nav';

/** Pending-approvals count (live via gov.approval WS messages; polls as fallback). */
function usePendingCount() {
  const live = useLiveStatus() === 'live';
  const { data } = usePendingApprovals(live ? 60_000 : 10_000);
  return data?.length ?? 0;
}

function CountPill({ n }: { n: number }) {
  return (
    <Box component="span" aria-label={`${n} pending`} sx={{ minWidth: 20, height: 20, px: 0.6, borderRadius: 10, bgcolor: 'primary.main', color: 'primary.contrastText', fontSize: 11, fontWeight: 700, lineHeight: '20px', textAlign: 'center' }}>
      {n > 99 ? '99+' : n}
    </Box>
  );
}

function NavLink({ item, active, collapsed, pending, href, onNavigate }: {
  item: NavItem; active: boolean; collapsed: boolean; pending?: number; href: string; onNavigate?: () => void;
}) {
  const icon = collapsed && pending ? <Badge color="primary" variant="dot" overlap="circular">{item.icon}</Badge> : item.icon;
  return (
    <Tooltip
      placement="right"
      describeChild
      enterDelay={collapsed ? 150 : 700}
      enterNextDelay={collapsed ? 50 : 300}
      title={
        <Box sx={{ py: 0.25 }}>
          <Box sx={{ fontWeight: 600, mb: 0.25 }}>{item.label}{pending ? ` · ${pending} pending` : ''}</Box>
          <Box sx={{ color: 'text.secondary' }}>{item.description}</Box>
        </Box>
      }
    >
      <ListItemButton
        component={Link}
        to={href}
        selected={active}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? item.label : undefined}
        onClick={onNavigate}
        sx={theme => ({
          mx: 1, mb: 0.25, minHeight: 36, py: 0.5, borderRadius: 2, px: collapsed ? 0 : 1.25,
          justifyContent: collapsed ? 'center' : 'flex-start', color: 'text.secondary',
          transition: 'background-color 120ms, color 120ms',
          '&:hover': { color: 'text.primary' },
          '&.Mui-selected, &.Mui-selected:hover': { bgcolor: alpha(theme.palette.primary.main, 0.14), color: 'text.primary' },
          '&.Mui-selected .nav-icon': { color: 'primary.main' },
        })}
      >
        <ListItemIcon className="nav-icon" sx={{ minWidth: collapsed ? 0 : 34, color: 'inherit', '& svg': { fontSize: 20 } }}>{icon}</ListItemIcon>
        {!collapsed && (
          <>
            <ListItemText primary={item.label} sx={{ my: 0 }} slotProps={{ primary: { sx: { fontSize: 13.5, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap' } } }} />
            {!!pending && <CountPill n={pending} />}
          </>
        )}
      </ListItemButton>
    </Tooltip>
  );
}

function ApprovalsNavLink(props: Omit<Parameters<typeof NavLink>[0], 'pending'>) {
  return <NavLink {...props} pending={usePendingCount()} />;
}

/** Grouped app navigation, used as the desktop rail and inside the mobile drawer. */
export function SideNav({ governance, collapsed = false, onToggleCollapsed, onNavigate }: {
  governance: boolean; collapsed?: boolean; onToggleCollapsed?: () => void; onNavigate?: () => void;
}) {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const range = params.get('range');
  const href = (p: string) => (range ? `${p}?range=${range}` : p);
  const sections = visibleSections(governance);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', py: 1.5 }}>
        {sections.map((s, i) => (
          <Box key={s.title} component="section" aria-label={s.title} sx={{ mb: 0.75 }}>
            {collapsed
              ? i > 0 && <Divider sx={{ mx: 2, mb: 1 }} />
              : <Typography variant="overline" component="div" sx={{ display: 'block', px: 2.25, pt: i > 0 ? 1 : 0, pb: 0.5, color: 'text.secondary', lineHeight: 1.6, fontSize: 10.5 }}>{s.title}</Typography>}
            <List disablePadding>
              {s.items.map(item => {
                const active = pathname === item.path || pathname.startsWith(`${item.path}/`);
                const Comp = item.path === '/approvals' ? ApprovalsNavLink : NavLink;
                return <Comp key={item.path} item={item} active={active} collapsed={collapsed} href={href(item.path)} onNavigate={onNavigate} />;
              })}
            </List>
          </Box>
        ))}
      </Box>
      {onToggleCollapsed && (
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider', py: 1 }}>
          <Tooltip title={collapsed ? 'Expand navigation' : 'Collapse navigation'} placement="right">
            <ListItemButton
              onClick={onToggleCollapsed}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-expanded={!collapsed}
              sx={{ mx: 1, minHeight: 34, py: 0.5, borderRadius: 2, px: collapsed ? 0 : 1.25, justifyContent: collapsed ? 'center' : 'flex-start', color: 'text.secondary' }}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 34, color: 'inherit', '& svg': { fontSize: 20 } }}>
                {collapsed ? <KeyboardDoubleArrowRightRoundedIcon /> : <KeyboardDoubleArrowLeftRoundedIcon />}
              </ListItemIcon>
              {!collapsed && <ListItemText primary="Collapse" slotProps={{ primary: { sx: { fontSize: 13 } } }} />}
            </ListItemButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}
