import { useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControl, InputLabel, MenuItem, Select, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow,
  Typography, useTheme,
} from '@mui/material';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import TravelExploreRoundedIcon from '@mui/icons-material/TravelExploreRounded';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Link as RouterLink, useParams } from 'react-router-dom';
import { api, apiSend } from '../../api/client';
import {
  errorMessage, govKeys, useIncident, useInvestigate, usePatchIncident, type Decision, type Incident, type IncidentRecommendation, type IncidentState,
} from '../../api/governance';
import { useAuth, useCan } from '../../auth/context';
import { SectionCard } from '../../components/Common';
import { SeverityChip, ToneChip } from '../../components/Chips';
import { Markdown } from '../../components/Markdown';
import { QueryError, RoleButton } from '../../components/gov/GovCommon';
import { IncidentStateChip, successTone } from '../../components/gov/GovChips';
import { DecisionsTable } from '../../components/gov/DecisionsTable';
import { DecisionDrawer } from '../../components/gov/DecisionDrawer';
import { RelativeTime } from '../../components/Primitives';
import { fmtDateTime } from '../../lib/format';

const STATES: IncidentState[] = ['open', 'investigating', 'contained', 'resolved', 'dismissed'];

/**
 * Map a Guardian recommendation to a containment API call. Returns null when the action has no direct
 * API (it is then only marked applied and logged).
 */
export function containmentCall(r: Pick<IncidentRecommendation, 'action' | 'target'>): { path: string; body: { reason: string } } | null {
  const a = r.action.toLowerCase().replace(/[\s-]+/g, '_');
  const m = a.match(/^(pause|resume|quarantine)(?:_(agent|session))?$/);
  if (!m || !r.target) return null;
  const kind = m[2] ?? (r.target.startsWith('session:') ? 'session' : 'agent');
  const target = r.target.replace(/^(agent|session):/, '');
  return { path: `gov/${kind === 'session' ? 'sessions' : 'agents'}/${encodeURIComponent(target)}/${m[1]}`, body: { reason: `Incident recommendation: ${r.action}` } };
}

function Recommendations({ incident }: { incident: Incident }) {
  const t = useTheme().tokens;
  const patch = usePatchIncident();
  const qc = useQueryClient();
  const { principal } = useAuth();
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recs = incident.recommendations ?? [];

  const resolve = async (idx: number, status: 'applied' | 'rejected') => {
    setBusy(idx);
    setError(null);
    try {
      const r = recs[idx];
      const containment = [...(incident.containment ?? [])];
      if (status === 'applied') {
        const call = containmentCall(r);
        if (call) {
          await apiSend('POST', call.path, call.body);
          void qc.invalidateQueries({ queryKey: govKeys.agents });
        }
        containment.push({ action: r.action, target: r.target, at: new Date().toISOString(), by: principal?.id ?? 'dashboard' });
      }
      await patch.mutateAsync({
        id: incident.id,
        patch: { recommendations: recs.map((x, i) => (i === idx ? { ...x, status } : x)), ...(status === 'applied' ? { containment } : {}) },
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!recs.length) return <Typography variant="body2" color="text.secondary">No recommendations.</Typography>;
  return (
    <Stack spacing={1}>
      {error && <Alert severity="error" role="alert">{error}</Alert>}
      {recs.map((r, i) => (
        <Box key={`${r.action}-${r.target}-${i}`} sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12.5, fontWeight: 600 }}>{r.action}</Box>
            <Typography variant="body2" color="text.secondary">→ {r.target}</Typography>
            <ToneChip tone={r.status === 'applied' ? successTone(t) : r.status === 'rejected' ? t.severity.info : t.severity.medium} label={r.status} sx={{ height: 20, fontSize: 11 }} />
            <Box sx={{ flex: 1 }} />
            {r.status === 'proposed' && (
              <>
                <RoleButton roles={['PolicyAdmin']} size="small" disabled={busy !== null} onClick={() => void resolve(i, 'rejected')}>Reject</RoleButton>
                <RoleButton roles={['PolicyAdmin']} size="small" variant="contained" disabled={busy !== null} onClick={() => void resolve(i, 'applied')}>{busy === i ? 'Applying…' : 'Apply'}</RoleButton>
              </>
            )}
          </Stack>
          <Typography variant="body2" sx={{ mt: 0.75 }}>{r.rationale}</Typography>
          {r.status === 'proposed' && containmentCall(r) && <Typography variant="caption">Applying calls POST /api/{containmentCall(r)!.path}.</Typography>}
        </Box>
      ))}
    </Stack>
  );
}

function LinkedDecisions({ ids }: { ids: string[] }) {
  const shown = ids.slice(0, 25);
  const results = useQueries({ queries: shown.map(id => ({ queryKey: govKeys.decision(id), queryFn: () => api<Decision>(`gov/decisions/${encodeURIComponent(id)}`), staleTime: Infinity, retry: false })) });
  const rows = results.map(r => r.data).filter((d): d is Decision => !!d);
  const [open, setOpen] = useState<Decision | null>(null);
  return (
    <>
      <DecisionsTable rows={rows} loading={results.some(r => r.isLoading) && !rows.length} onOpen={setOpen} empty="No linked decisions." />
      {ids.length > shown.length && <Typography variant="caption">Showing {shown.length} of {ids.length} decisions.</Typography>}
      <DecisionDrawer id={open?.id ?? null} initial={open ?? undefined} onClose={() => setOpen(null)} />
    </>
  );
}

export function IncidentDetailPage() {
  const { id = '' } = useParams();
  const q = useIncident(id);
  const patch = usePatchIncident();
  const investigate = useInvestigate();
  const isAdmin = useCan('PolicyAdmin');
  const inc = q.data;

  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} title="Incident not found" />;
  if (!inc) return <Stack spacing={2}><Skeleton width={320} height={36} /><Skeleton variant="rounded" height={240} /></Stack>;

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <Button size="small" component={RouterLink} to="/incidents" startIcon={<ArrowBackRoundedIcon />}>Incidents</Button>
        <SeverityChip severity={inc.severity} size="medium" />
        <Typography variant="h5" component="h2" sx={{ minWidth: 0, flex: 1 }}>{inc.title}</Typography>
        <IncidentStateChip state={inc.state} />
        <FormControl size="small" sx={{ minWidth: 150 }} disabled={!isAdmin || patch.isPending}>
          <InputLabel id="inc-state">Set state</InputLabel>
          <Select labelId="inc-state" label="Set state" value={inc.state} onChange={e => patch.mutate({ id: inc.id, patch: { state: e.target.value as IncidentState } })}>
            {STATES.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
          </Select>
        </FormControl>
        <RoleButton roles={['PolicyAdmin']} size="small" variant="contained" startIcon={<TravelExploreRoundedIcon />} disabled={investigate.isPending} onClick={() => investigate.mutate({ incidentId: inc.id })}>
          {investigate.isPending ? 'Investigating…' : 'Investigate'}
        </RoleButton>
      </Stack>
      <Typography variant="caption">
        Trigger <b>{inc.trigger}</b> · opened {fmtDateTime(inc.createdAt)} · updated <RelativeTime iso={inc.updatedAt} />
      </Typography>
      {investigate.isError && <Alert severity="error" role="alert">{errorMessage(investigate.error)}</Alert>}
      {investigate.isSuccess && <Alert severity="success" role="status">Guardian investigation complete — report updated.</Alert>}
      {patch.isError && <Alert severity="error" role="alert">{errorMessage(patch.error)}</Alert>}

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 3fr) minmax(320px, 2fr)' }, alignItems: 'start' }}>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          {inc.summary && <SectionCard title="Summary"><Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{inc.summary}</Typography></SectionCard>}
          <SectionCard title="Guardian report" subtitle="Written by the Guardian agent">
            {inc.report ? <Markdown>{inc.report}</Markdown> : (
              <Typography variant="body2" color="text.secondary">No report yet. Use <b>Investigate</b> to have the Guardian analyse this incident.</Typography>
            )}
          </SectionCard>
          <SectionCard title="Linked decisions">
            <LinkedDecisions ids={inc.decisionIds} />
          </SectionCard>
        </Stack>
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <SectionCard title="Recommendations"><Recommendations incident={inc} /></SectionCard>
          <SectionCard title="Containment log">
            {(inc.containment ?? []).length === 0 ? <Typography variant="body2" color="text.secondary">No containment actions taken.</Typography> : (
              <Table size="small" aria-label="Containment actions">
                <TableHead><TableRow><TableCell>Action</TableCell><TableCell>Target</TableCell><TableCell>By</TableCell><TableCell>When</TableCell></TableRow></TableHead>
                <TableBody>
                  {inc.containment!.map((c, i) => (
                    <TableRow key={`${c.at}-${i}`}>
                      <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{c.action}</TableCell>
                      <TableCell sx={{ wordBreak: 'break-all' }}>{c.target}</TableCell>
                      <TableCell>{c.by}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}><RelativeTime iso={c.at} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </SectionCard>
          <SectionCard title="Linked agents & sessions">
            <Typography variant="overline" color="text.secondary" component="div">Agents</Typography>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mb: 1.5 }}>
              {inc.agentIds.length ? inc.agentIds.map(a => <Chip key={a} size="small" variant="outlined" label={a} component={RouterLink} to={`/agents?id=${encodeURIComponent(a)}`} clickable />) : <Typography variant="body2" color="text.secondary">None</Typography>}
            </Stack>
            <Typography variant="overline" color="text.secondary" component="div">Sessions</Typography>
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
              {inc.sessionIds.length ? inc.sessionIds.map(s => <Chip key={s} size="small" variant="outlined" label={s.slice(0, 12)} title={s} component={RouterLink} to={`/conversations?c=${encodeURIComponent(s)}`} clickable />) : <Typography variant="body2" color="text.secondary">None</Typography>}
            </Stack>
          </SectionCard>
        </Stack>
      </Box>
    </Stack>
  );
}
