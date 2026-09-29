import { useMemo, useState } from 'react';
import { Badge, Box, Divider, IconButton, Popover, Stack, Tooltip, Typography } from '@mui/material';
import NotificationsNoneRoundedIcon from '@mui/icons-material/NotificationsNoneRounded';
import NotificationsOffOutlinedIcon from '@mui/icons-material/NotificationsOffOutlined';
import { useNavigate } from 'react-router-dom';
import { useConversations } from '../api/client';
import { SeverityChip } from './Chips';
import { AgentAvatar } from './AgentAvatar';
import { EmptyState } from './Common';
import { cleanTitle, fmtRelative } from '../lib/format';

const SEEN_KEY = 'am-alerts-seen';

/** Bell menu: critical/high conversations active in the last 24 hours. */
export function AlertsMenu() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [seenAt, setSeenAt] = useState(() => Number(localStorage.getItem(SEEN_KEY) || 0));
  const { data } = useConversations('24h');
  const navigate = useNavigate();
  const alerts = useMemo(
    () => (data ?? []).filter(c => c.severity === 'critical' || c.severity === 'high').slice(0, 8),
    [data],
  );
  const unseen = alerts.filter(a => a.lastActivityAt && Date.parse(a.lastActivityAt) > seenAt).length;

  const open = (e: React.MouseEvent<HTMLElement>) => {
    setAnchor(e.currentTarget);
    const now = Date.now();
    localStorage.setItem(SEEN_KEY, String(now));
    setSeenAt(now);
  };

  return (
    <>
      <Tooltip title="Alerts">
        <IconButton aria-label="Alerts" onClick={open}>
          <Badge color="primary" variant="dot" invisible={!unseen} overlap="circular">
            <NotificationsNoneRoundedIcon fontSize="small" />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 380, mt: 0.5 } } }}
      >
        <Box sx={{ px: 2, py: 1.5 }}>
          <Typography variant="subtitle2">Alerts</Typography>
          <Typography variant="caption">High and critical conversations · last 24 hours</Typography>
        </Box>
        <Divider />
        {alerts.length === 0 ? (
          <EmptyState compact icon={<NotificationsOffOutlinedIcon />} title="All quiet" body="No high-severity activity in the last 24 hours." />
        ) : (
          <Stack sx={{ py: 0.5, maxHeight: 420, overflow: 'auto' }}>
            {alerts.map(c => (
              <Box
                key={c.id}
                role="button"
                tabIndex={0}
                onClick={() => { setAnchor(null); navigate(`/conversations?range=24h&c=${c.id}`); }}
                onKeyDown={e => { if (e.key === 'Enter') { setAnchor(null); navigate(`/conversations?range=24h&c=${c.id}`); } }}
                sx={{ display: 'flex', gap: 1.25, px: 2, py: 1.25, cursor: 'pointer', alignItems: 'flex-start', '&:hover': { bgcolor: 'action.hover' } }}
              >
                <AgentAvatar agentKey={c.agentKey} size={24} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{cleanTitle(c.title) ?? c.id}</Typography>
                  <Typography variant="caption" noWrap component="div">{c.severityReasons.slice(0, 2).join(' · ')}</Typography>
                </Box>
                <Stack spacing={0.5} sx={{ alignItems: 'flex-end' }}>
                  <SeverityChip severity={c.severity} />
                  <Typography variant="caption">{fmtRelative(c.lastActivityAt)}</Typography>
                </Stack>
              </Box>
            ))}
          </Stack>
        )}
      </Popover>
    </>
  );
}
