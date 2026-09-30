import { useMemo, type ReactNode } from 'react';
import { Box, Button, Divider, Drawer, IconButton, Link as MuiLink, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { fleetKeys, useFleetAlert, type FleetAlert } from '../../api/fleet';
import { CodeBlock } from '../../components/CodeBlock';
import { CopyButton } from '../../components/Common';
import { QueryError } from '../../components/gov/GovCommon';
import { AlertTypeChip, FLEET_ALERT_TITLE, FleetSeverityChip, FrameworkChips, ScoreBadge, platformLabel } from '../../components/gov/FleetCommon';
import { fmtDateTime } from '../../lib/format';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="overline" color="text.secondary" component="div">{label}</Typography>
      <Box sx={{ fontSize: 13, minWidth: 0, wordBreak: 'break-word' }}>{children ?? <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</Box>
    </Box>
  );
}

function Mono({ text }: { text: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={text}>{text}</Box>
      <CopyButton text={text} label="Copy" />
    </Stack>
  );
}

/** Find an alert already loaded by any fleet list/timeline query (so the drawer opens instantly). */
function findCachedAlert(qc: QueryClient, id: string | null): FleetAlert | undefined {
  if (!id) return undefined;
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: fleetKeys.all })) {
    if (Array.isArray(data)) {
      const hit = (data as FleetAlert[]).find(a => a?.alert_id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Full alert detail: summary, classification, mappings, evidence, source events and links. */
export function FleetAlertDetail({ a, sessionHref, onClose }: { a: FleetAlert; sessionHref: (sessionId: string) => string; onClose?: () => void }) {
  const mappings = (a.owasp_llm?.length ?? 0) + (a.owasp_agentic?.length ?? 0) + (a.mitre_atlas?.length ?? 0);
  return (
    <Stack spacing={2} sx={{ p: 2.5 }} data-testid="fleet-alert-detail">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <FleetSeverityChip severity={a.severity} />
        <ScoreBadge score={a.score} />
        <Typography variant="h6" component="h2" sx={{ fontSize: 15, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.title}>
          {a.title}
        </Typography>
        {onClose && <Tooltip title="Close (Esc)"><IconButton size="small" aria-label="Close" onClick={onClose}><CloseRoundedIcon fontSize="small" /></IconButton></Tooltip>}
      </Stack>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <AlertTypeChip type={a.alert_type} />
        <Typography variant="caption">{fmtDateTime(a.created_at)}</Typography>
      </Stack>
      {FLEET_ALERT_TITLE[a.alert_type] && FLEET_ALERT_TITLE[a.alert_type] !== a.title && (
        <Typography variant="caption" component="div" sx={{ mt: -1 }}>{FLEET_ALERT_TITLE[a.alert_type]}</Typography>
      )}

      <Box sx={{ p: 1.5, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Typography variant="overline" component="div" color="text.secondary">Summary</Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{a.summary || '—'}</Typography>
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
        <Field label="Agent">{a.agent_name || a.agent_id ? <>{a.agent_name ?? a.agent_id}{a.agent_name && a.agent_id && a.agent_id !== a.agent_name && <Box component="div" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11, color: 'text.secondary' }}>{a.agent_id}</Box>}</> : null}</Field>
        <Field label="Platform">{platformLabel(a.platform)}</Field>
        <Field label="Detector"><Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{a.detector}</Box></Field>
        <Field label="Action">{a.action ?? null}</Field>
        <Field label="User">{a.user_id ?? null}</Field>
        <Field label="Lane">{a.lane_id ? <MuiLink component={RouterLink} to={`/lanes/${encodeURIComponent(a.lane_id)}`}>{a.lane_id}</MuiLink> : null}</Field>
      </Box>

      <Field label="Framework mappings">{mappings ? <Box sx={{ mt: 0.25 }}><FrameworkChips alert={a} /></Box> : null}</Field>

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        {a.session_id && (
          <Button variant="outlined" size="small" startIcon={<TimelineRoundedIcon />} component={RouterLink} to={sessionHref(a.session_id)}>
            Session timeline
          </Button>
        )}
        {a.incident_id && (
          <Button variant="outlined" size="small" color="warning" startIcon={<HealthAndSafetyOutlinedIcon />} component={RouterLink} to={`/incidents/${encodeURIComponent(a.incident_id)}`}>
            Open incident
          </Button>
        )}
      </Stack>

      <Box>
        <Typography variant="overline" color="text.secondary" component="div">Evidence</Typography>
        {a.evidence && Object.keys(a.evidence).length
          ? <CodeBlock json text={JSON.stringify(a.evidence, null, 2)} maxHeight={320} />
          : <Typography variant="body2" color="text.secondary">No evidence attached.</Typography>}
      </Box>

      <Box>
        <Typography variant="overline" color="text.secondary" component="div">Source events ({a.source_event_ids?.length ?? 0})</Typography>
        {a.source_event_ids?.length ? (
          <Stack spacing={0.25} component="ul" sx={{ m: 0, p: 0, listStyle: 'none' }} aria-label="Source event ids">
            {a.source_event_ids.map(id => <li key={id}><Mono text={id} /></li>)}
          </Stack>
        ) : <Typography variant="body2" color="text.secondary">None recorded.</Typography>}
      </Box>

      <Divider />
      <Stack spacing={0.75}>
        <Field label="Alert id"><Mono text={a.alert_id} /></Field>
        {a.session_id && <Field label="Session id"><Mono text={a.session_id} /></Field>}
        {a.incident_id && <Field label="Incident id"><Mono text={a.incident_id} /></Field>}
        {a.received_at && <Field label="Received">{fmtDateTime(a.received_at)}</Field>}
      </Stack>
    </Stack>
  );
}

/** Right-side drawer for one fleet alert (URL-driven via `?alert=`). */
export function FleetAlertDrawer({ id, onClose, sessionHref }: { id: string | null; onClose: () => void; sessionHref: (sessionId: string) => string }) {
  const qc = useQueryClient();
  const cached = useMemo(() => findCachedAlert(qc, id), [qc, id]);
  const q = useFleetAlert(id, cached);
  const a = q.data ?? cached;
  return (
    <Drawer
      anchor="right"
      open={!!id}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100vw', sm: 560 }, bgcolor: 'background.default' }, 'aria-label': 'Fleet alert detail' } as object }}
    >
      {a ? <FleetAlertDetail a={a} sessionHref={sessionHref} onClose={onClose} />
        : q.isError ? <Box sx={{ p: 2 }}><QueryError error={q.error} onRetry={() => void q.refetch()} title="Alert not found" /></Box>
        : <Stack spacing={1.5} sx={{ p: 2.5 }} aria-busy="true" aria-label="Loading alert"><Skeleton width="60%" height={32} /><Skeleton variant="rounded" height={80} /><Skeleton variant="rounded" height={160} /></Stack>}
    </Drawer>
  );
}
