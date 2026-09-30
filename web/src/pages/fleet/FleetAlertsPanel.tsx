import { useEffect, useState } from 'react';
import {
  Box, Button, FormControl, InputAdornment, InputLabel, Link as MuiLink, MenuItem, Select, Skeleton, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import NotificationsNoneRoundedIcon from '@mui/icons-material/NotificationsNoneRounded';
import { Link as RouterLink } from 'react-router-dom';
import { FLEET_SEVERITIES, useFleetAlerts, type FleetAlert, type FleetAlertFilters, type FleetSeverity, type FleetSummary } from '../../api/fleet';
import { EmptyState } from '../../components/Common';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { QueryError } from '../../components/gov/GovCommon';
import { AlertTypeChip, FleetSeverityChip, FrameworkChips, PLATFORM_LABEL, ScoreBadge, agentKey, humanizeType, platformLabel } from '../../components/gov/FleetCommon';
import { fmtNum, shortId } from '../../lib/format';

export const ALERT_LIMIT = 500;

/** Table filters as stored in the URL (`sev`, `type`, `platform`, `agent`, `session`, `incident`). */
export interface AlertTableFilters { sev: string; type: string; platform: string; agent: string; session: string; incident: string }

export const toApiFilters = (f: AlertTableFilters): FleetAlertFilters => ({
  severity: f.sev ? [f.sev as FleetSeverity] : undefined,
  type: f.type ? [f.type] : undefined,
  platform: f.platform ? [f.platform] : undefined,
  agent: f.agent || undefined,
  session: f.session || undefined,
  incident: f.incident || undefined,
  limit: ALERT_LIMIT,
});

/** Option list from the summary keys, keeping the current value selectable even if it has no alerts. */
const options = (keys: string[], current: string) => [...new Set([...keys, ...(current ? [current] : [])])].filter(k => k !== 'unknown').sort();

function FilterSelect({ id, label, value, all, items, onChange, render = v => v, minWidth = 150 }: {
  id: string; label: string; value: string; all: string; items: string[]; onChange: (v: string) => void; render?: (v: string) => string; minWidth?: number;
}) {
  return (
    <FormControl size="small" sx={{ minWidth }}>
      <InputLabel id={`${id}-label`}>{label}</InputLabel>
      <Select labelId={`${id}-label`} id={id} label={label} value={value} onChange={e => onChange(String(e.target.value))}>
        <MenuItem value="">{all}</MenuItem>
        {items.map(v => <MenuItem key={v} value={v}>{render(v)}</MenuItem>)}
      </Select>
    </FormControl>
  );
}

/** Text filter that commits to the URL after a short pause (avoids a request per keystroke). */
function DebouncedField({ label, value, onCommit, placeholder }: { label: string; value: string; onCommit: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  useEffect(() => {
    if (text.trim() === value) return undefined;
    const h = setTimeout(() => onCommit(text.trim()), 350);
    return () => clearTimeout(h);
  }, [text, value, onCommit]);
  return (
    <TextField
      size="small"
      placeholder={placeholder}
      value={text}
      onChange={e => setText(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(text.trim()); }}
      sx={{ minWidth: 200, flex: 1 }}
      slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 18 }} /></InputAdornment> }, htmlInput: { 'aria-label': label } }}
    />
  );
}

function AlertRow({ a, onOpen, sessionHref }: { a: FleetAlert; onOpen: (id: string) => void; sessionHref: (sessionId: string) => string }) {
  const agent = agentKey(a);
  return (
    <TableRow hover onClick={() => onOpen(a.alert_id)} sx={{ cursor: 'pointer' }} data-testid="fleet-alert-row">
      <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}><RelativeTime iso={a.created_at} /></TableCell>
      <TableCell><FleetSeverityChip severity={a.severity} /></TableCell>
      <TableCell align="right"><ScoreBadge score={a.score} /></TableCell>
      <TableCell sx={{ maxWidth: 380 }}>
        <Stack spacing={0.4} sx={{ alignItems: 'flex-start', minWidth: 0 }}>
          <AlertTypeChip type={a.alert_type} />
          <MuiLink
            component="button"
            type="button"
            underline="hover"
            onClick={e => { e.stopPropagation(); onOpen(a.alert_id); }}
            aria-label={`Open alert ${a.title}`}
            sx={{ textAlign: 'left', fontSize: 13, color: 'text.primary', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {a.title}
          </MuiLink>
        </Stack>
      </TableCell>
      <TableCell sx={{ maxWidth: 180 }}>
        <Ellipsis text={agent === 'unknown' ? null : agent} sx={{ display: 'block', fontSize: 12.5 }} />
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{platformLabel(a.platform)}</TableCell>
      <TableCell>
        {a.session_id ? (
          <MuiLink component={RouterLink} to={sessionHref(a.session_id)} onClick={e => e.stopPropagation()} sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }} aria-label={`Session timeline ${a.session_id}`} title={a.session_id}>
            {shortId(a.session_id)}
          </MuiLink>
        ) : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
      </TableCell>
      <TableCell sx={{ minWidth: 160 }}><FrameworkChips alert={a} max={4} /></TableCell>
      <TableCell>
        {a.incident_id ? (
          <MuiLink component={RouterLink} to={`/incidents/${encodeURIComponent(a.incident_id)}`} onClick={e => e.stopPropagation()} sx={{ fontSize: 12, whiteSpace: 'nowrap' }} aria-label={`Open incident ${a.incident_id}`}>
            Incident
          </MuiLink>
        ) : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
      </TableCell>
    </TableRow>
  );
}

/** Filter bar + newest-first alerts table. Filters live in the URL so views are shareable. */
export function FleetAlertsPanel({ filters, setFilter, clearFilters, range, summary, onOpen, sessionHref }: {
  filters: AlertTableFilters; setFilter: (key: keyof AlertTableFilters, value: string) => void; clearFilters: () => void; range: string;
  summary: FleetSummary | undefined; onOpen: (id: string) => void; sessionHref: (sessionId: string) => string;
}) {
  const q = useFleetAlerts(toApiFilters(filters), range);
  const rows = q.data ?? [];
  const active = Object.values(filters).some(Boolean);
  const types = options(Object.keys(summary?.byType ?? {}), filters.type);
  const platforms = options([...Object.keys(summary?.byPlatform ?? {}), ...Object.keys(PLATFORM_LABEL)], filters.platform);
  const agents = options(Object.keys(summary?.byAgent ?? {}), filters.agent);

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }} role="search" aria-label="Filter fleet alerts">
        <FilterSelect id="fleet-f-sev" label="Severity" value={filters.sev} all="All severities" items={FLEET_SEVERITIES} onChange={v => setFilter('sev', v)} render={v => v[0].toUpperCase() + v.slice(1)} minWidth={140} />
        <FilterSelect id="fleet-f-type" label="Alert type" value={filters.type} all="All types" items={types} onChange={v => setFilter('type', v)} render={humanizeType} minWidth={190} />
        <FilterSelect id="fleet-f-platform" label="Platform" value={filters.platform} all="All platforms" items={platforms} onChange={v => setFilter('platform', v)} render={platformLabel} />
        <FilterSelect id="fleet-f-agent" label="Agent" value={filters.agent} all="All agents" items={agents} onChange={v => setFilter('agent', v)} minWidth={170} />
        <DebouncedField label="Filter by session id" placeholder="Session id…" value={filters.session} onCommit={v => setFilter('session', v)} />
        {filters.incident && (
          <Button size="small" variant="outlined" onClick={() => setFilter('incident', '')} aria-label={`Remove incident filter ${filters.incident}`}>
            Incident {shortId(filters.incident)} ✕
          </Button>
        )}
        {active && <Button size="small" onClick={clearFilters}>Clear filters</Button>}
      </Stack>

      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper' }}>
        {q.isError ? <QueryError error={q.error} onRetry={() => void q.refetch()} />
          : q.isLoading ? (
            <Stack spacing={1} sx={{ p: 1.5 }} aria-busy="true" aria-label="Loading alerts">{[0, 1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={48} />)}</Stack>
          ) : !rows.length ? (
            <EmptyState
              compact
              icon={<NotificationsNoneRoundedIcon />}
              title={active ? 'No alerts match these filters' : 'No fleet alerts in this window'}
              body={active ? 'Try a wider time window or clear the filters.' : 'The monitoring fleet posts alerts about Foundry and Copilot Studio agents here as it detects them.'}
              action={active ? <Button size="small" variant="outlined" onClick={clearFilters}>Clear filters</Button> : undefined}
            />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table size="small" aria-label="Fleet alerts" data-testid="fleet-alerts-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Time</TableCell>
                    <TableCell>Severity</TableCell>
                    <TableCell align="right">Score</TableCell>
                    <TableCell>Alert</TableCell>
                    <TableCell>Agent</TableCell>
                    <TableCell>Platform</TableCell>
                    <TableCell>Session</TableCell>
                    <TableCell>OWASP / ATLAS</TableCell>
                    <TableCell>Incident</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>{rows.map(a => <AlertRow key={a.alert_id} a={a} onOpen={onOpen} sessionHref={sessionHref} />)}</TableBody>
              </Table>
            </Box>
          )}
      </Box>
      {rows.length > 0 && (
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {rows.length >= ALERT_LIMIT ? `Showing the newest ${fmtNum(ALERT_LIMIT)} alerts — narrow the filters to see older ones.` : `${fmtNum(rows.length)} alert${rows.length === 1 ? '' : 's'}`}
        </Typography>
      )}
    </Stack>
  );
}
