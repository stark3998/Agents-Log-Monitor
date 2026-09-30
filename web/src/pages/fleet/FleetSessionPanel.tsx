import { useMemo, useState } from 'react';
import { Box, Button, ButtonBase, Link as MuiLink, Skeleton, Stack, TextField, Typography, useTheme } from '@mui/material';
import TimelineRoundedIcon from '@mui/icons-material/TimelineRounded';
import { Link as RouterLink } from 'react-router-dom';
import { useFleetAlerts, useSessionFleetAlerts, type FleetAlert } from '../../api/fleet';
import { EmptyState, SectionCard } from '../../components/Common';
import { RelativeTime } from '../../components/Primitives';
import { QueryError } from '../../components/gov/GovCommon';
import {
  AlertTypeChip, FLEET_SEVERITY_RANK, FleetSeverityChip, FrameworkChips, ScoreBadge, agentKey, fleetSeverity, platformLabel,
} from '../../components/gov/FleetCommon';
import { fmtDateTime, fmtDuration, fmtNum, fmtTime } from '../../lib/format';
import { WINDOW_LIMIT } from './FleetAgentsPanel';

/** Sessions with alerts in the window, most alerts first (picker when no session is selected). */
function RecentSessions({ range, onPick }: { range: string; onPick: (sid: string) => void }) {
  const q = useFleetAlerts({ limit: WINDOW_LIMIT }, range);
  const sessions = useMemo(() => {
    const m = new Map<string, { sid: string; count: number; worst: FleetAlert['severity']; agent: string; lastAt: string }>();
    for (const a of q.data ?? []) {
      if (!a.session_id) continue;
      const s = m.get(a.session_id);
      if (!s) m.set(a.session_id, { sid: a.session_id, count: 1, worst: a.severity, agent: agentKey(a), lastAt: a.created_at });
      else {
        s.count++;
        if (FLEET_SEVERITY_RANK[a.severity] > FLEET_SEVERITY_RANK[s.worst]) s.worst = a.severity;
        if (a.created_at > s.lastAt) s.lastAt = a.created_at;
      }
    }
    return [...m.values()].sort((a, b) => FLEET_SEVERITY_RANK[b.worst] - FLEET_SEVERITY_RANK[a.worst] || b.count - a.count).slice(0, 12);
  }, [q.data]);
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <Stack spacing={1} aria-busy="true" aria-label="Loading sessions">{[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={40} />)}</Stack>;
  if (!sessions.length) return <Typography variant="body2" color="text.secondary">No sessions with alerts in this window.</Typography>;
  return (
    <Stack component="ul" spacing={0.5} sx={{ m: 0, p: 0, listStyle: 'none' }} aria-label="Sessions with alerts">
      {sessions.map(s => (
        <li key={s.sid}>
          <ButtonBase onClick={() => onPick(s.sid)} aria-label={`Show timeline for session ${s.sid}`} sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', gap: 1.25, px: 1, py: 0.75, borderRadius: 1.5, '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' } }}>
            <FleetSeverityChip severity={s.worst} />
            <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.sid}</Box>
            <Typography variant="caption" noWrap sx={{ maxWidth: 180 }}>{s.agent === 'unknown' ? '' : s.agent}</Typography>
            <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.primary', fontWeight: 600 }}>{fmtNum(s.count)} alert{s.count === 1 ? '' : 's'}</Typography>
            <Typography variant="caption" sx={{ whiteSpace: 'nowrap' }}><RelativeTime iso={s.lastAt} /></Typography>
          </ButtonBase>
        </li>
      ))}
    </Stack>
  );
}

function TimelineItem({ a, first, last, onOpen }: { a: FleetAlert; first: FleetAlert; last: boolean; onOpen: (id: string) => void }) {
  const t = useTheme().tokens;
  const tone = t.severity[fleetSeverity(a.severity)];
  const offset = Date.parse(a.created_at) - Date.parse(first.created_at);
  return (
    <Box component="li" sx={{ position: 'relative', pl: 3.5, pb: 2, '&:last-of-type': { pb: 0 } }} data-testid="fleet-timeline-item" data-alert-type={a.alert_type}>
      {!last && <Box aria-hidden sx={{ position: 'absolute', left: 7, top: 10, bottom: -4, width: 2, bgcolor: 'divider' }} />}
      <Box aria-hidden sx={{ position: 'absolute', left: 2, top: 4, width: 12, height: 12, borderRadius: '50%', bgcolor: tone.fg, boxShadow: `0 0 0 3px ${tone.bg}` }} />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.primary', fontWeight: 600 }} title={fmtDateTime(a.created_at)}>{fmtTime(a.created_at)}</Typography>
        {offset > 0 && <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>+{fmtDuration(offset)}</Typography>}
        <AlertTypeChip type={a.alert_type} />
        <FleetSeverityChip severity={a.severity} />
        <ScoreBadge score={a.score} />
        {a.action && <Typography variant="caption" sx={{ fontFamily: 'var(--am-mono)' }}>{a.action}</Typography>}
      </Stack>
      <MuiLink component="button" type="button" underline="hover" onClick={() => onOpen(a.alert_id)} sx={{ display: 'block', mt: 0.5, textAlign: 'left', fontSize: 13.5, fontWeight: 550, color: 'text.primary' }} aria-label={`Open alert ${a.title}`}>
        {a.title}
      </MuiLink>
      {a.summary && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25, whiteSpace: 'pre-wrap', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.summary}</Typography>}
      <Box sx={{ mt: 0.75 }}><FrameworkChips alert={a} /></Box>
    </Box>
  );
}

function SessionTimeline({ sid, onOpen }: { sid: string; onOpen: (id: string) => void }) {
  const q = useSessionFleetAlerts(sid);
  const alerts = q.data ?? [];
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <Stack spacing={1} aria-busy="true" aria-label="Loading session timeline">{[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={72} />)}</Stack>;
  if (!alerts.length) return <EmptyState compact icon={<TimelineRoundedIcon />} title="No alerts for this session" body={<>No fleet alert references session <code>{sid}</code>.</>} />;
  const first = alerts[0];
  const last = alerts[alerts.length - 1];
  const worst = alerts.reduce((w, a) => (FLEET_SEVERITY_RANK[a.severity] > FLEET_SEVERITY_RANK[w] ? a.severity : w), alerts[0].severity);
  const agents = [...new Set(alerts.map(agentKey).filter(k => k !== 'unknown'))];
  const platforms = [...new Set(alerts.map(a => platformLabel(a.platform)))];
  const users = [...new Set(alerts.map(a => a.user_id).filter(Boolean))];
  const incidents = [...new Set(alerts.map(a => a.incident_id).filter((x): x is string => !!x))];
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }} data-testid="fleet-session-header">
        <FleetSeverityChip severity={worst} />
        <Typography variant="body2"><b>{fmtNum(alerts.length)}</b> alert{alerts.length === 1 ? '' : 's'} over {fmtDuration(Date.parse(last.created_at) - Date.parse(first.created_at)) || '0s'}</Typography>
        {agents.length > 0 && <Typography variant="body2" color="text.secondary">Agent: <b>{agents.join(', ')}</b></Typography>}
        <Typography variant="body2" color="text.secondary">Platform: <b>{platforms.join(', ')}</b></Typography>
        {users.length > 0 && <Typography variant="body2" color="text.secondary">User: <b>{users.join(', ')}</b></Typography>}
        {incidents.map(id => (
          <MuiLink key={id} component={RouterLink} to={`/incidents/${encodeURIComponent(id)}`} sx={{ fontSize: 13 }} aria-label={`Open incident ${id}`}>Incident</MuiLink>
        ))}
      </Stack>
      <Box component="ol" sx={{ m: 0, p: 0, listStyle: 'none' }} aria-label={`Alerts in session ${sid}, oldest first`} data-testid="fleet-session-timeline">
        {alerts.map((a, i) => <TimelineItem key={a.alert_id} a={a} first={first} last={i === alerts.length - 1} onOpen={onOpen} />)}
      </Box>
    </Stack>
  );
}

/** Chronological alert timeline for one session (`?tab=session&sid=`), with a session picker. */
export function FleetSessionPanel({ sid, range, onSession, onOpen }: { sid: string; range: string; onSession: (sid: string) => void; onOpen: (id: string) => void }) {
  const [text, setText] = useState(sid);
  const [lastSid, setLastSid] = useState(sid);
  if (sid !== lastSid) { setLastSid(sid); setText(sid); }
  return (
    <Stack spacing={2}>
      <Stack component="form" direction="row" spacing={1} sx={{ alignItems: 'center' }} role="search" aria-label="Choose session"
        onSubmit={e => { e.preventDefault(); onSession(text.trim()); }}>
        <TextField size="small" placeholder="Session id…" value={text} onChange={e => setText(e.target.value)} sx={{ flex: 1, maxWidth: 520 }} slotProps={{ htmlInput: { 'aria-label': 'Session id' } }} />
        <Button type="submit" variant="outlined" size="small" disabled={!text.trim() || text.trim() === sid}>Show timeline</Button>
        {sid && <Button size="small" onClick={() => onSession('')}>Clear</Button>}
      </Stack>
      {sid ? (
        <SectionCard title={<>Session <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 14 }}>{sid}</Box></>} subtitle="Every fleet alert raised in this session, oldest first">
          <SessionTimeline sid={sid} onOpen={onOpen} />
        </SectionCard>
      ) : (
        <SectionCard title="Sessions with alerts" subtitle="Pick a session to see how its alerts unfolded — worst severity first">
          <RecentSessions range={range} onPick={onSession} />
        </SectionCard>
      )}
    </Stack>
  );
}
