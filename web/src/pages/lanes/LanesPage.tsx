import { useMemo } from 'react';
import { Box, Button, Card, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import AltRouteRoundedIcon from '@mui/icons-material/AltRouteRounded';
import RateReviewOutlinedIcon from '@mui/icons-material/RateReviewOutlined';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useLanes, type LaneRecord } from '../../api/governance';
import { EmptyState, SectionCard } from '../../components/Common';
import { QueryError } from '../../components/gov/GovCommon';
import { LaneModeChip, LaneStatusChip } from '../../components/gov/GovChips';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { summariseLanes } from './laneUtils';
import { PageHeader } from '../../components/PageHeader';

export function LanesPage() {
  const lanes = useLanes();
  const navigate = useNavigate();
  const rows = useMemo(() => summariseLanes(lanes.data ?? []), [lanes.data]);
  const proposals = useMemo(() => (lanes.data ?? []).filter(r => r.status === 'proposed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [lanes.data]);
  const open = (r: LaneRecord) => navigate(`/lanes/${encodeURIComponent(r.lane.id)}?version=${r.lane.version}`);

  return (
    <Stack spacing={2.5}>
      <PageHeader actions={<Button variant="contained" size="small" startIcon={<AddRoundedIcon />} component={RouterLink} to="/lanes/new">New lane</Button>} />

      {proposals.length > 0 && (
        <SectionCard title={`Proposals awaiting review · ${proposals.length}`} subtitle="Drafted by people or the AI lane drafter. Approving a proposal activates it." delay={40}>
          <Stack spacing={1}>
            {proposals.map(p => (
              <Card key={`${p.lane.id}@${p.lane.version}`} sx={{ p: 1.5 }} component="article" aria-label={`Proposal ${p.lane.id} v${p.lane.version}`}>
                <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
                  <RateReviewOutlinedIcon sx={{ color: 'text.secondary' }} />
                  <Box sx={{ flex: 1, minWidth: 200 }}>
                    <Typography variant="subtitle2">{p.lane.name || p.lane.id} <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>v{p.lane.version}</Box></Typography>
                    <Typography variant="caption">
                      {p.lane.meta?.source === 'ai-draft' ? 'AI draft' : 'Proposed'}{p.updatedBy ? ` by ${p.updatedBy}` : ''} · <RelativeTime iso={p.updatedAt} />
                    </Typography>
                  </Box>
                  <LaneModeChip mode={p.lane.mode} />
                  <Button size="small" variant="outlined" onClick={() => open(p)}>Review</Button>
                </Stack>
              </Card>
            ))}
          </Stack>
        </SectionCard>
      )}

      <Card>
        {lanes.isError ? <QueryError error={lanes.error} onRetry={() => void lanes.refetch()} />
          : !lanes.isLoading && rows.length === 0 ? (
            <EmptyState icon={<AltRouteRoundedIcon />} title="No lanes yet" body="Create a lane, or draft one with AI from the Agents page." action={<Button variant="outlined" size="small" component={RouterLink} to="/lanes/new">New lane</Button>} />
          ) : (
            <Box sx={{ overflowX: 'auto' }}>
              <Table aria-label="Lanes">
                <TableHead>
                  <TableRow>
                    <TableCell>Lane</TableCell><TableCell>Status</TableCell><TableCell>Mode</TableCell><TableCell>Version</TableCell>
                    <TableCell>Applies to</TableCell><TableCell>Priority</TableCell><TableCell>Updated</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(lanes.isLoading ? [] : rows).map(({ current: r, versions, proposals: np }) => (
                    <TableRow
                      key={r.lane.id}
                      hover
                      tabIndex={0}
                      onClick={() => navigate(`/lanes/${encodeURIComponent(r.lane.id)}`)}
                      onKeyDown={e => { if (e.key === 'Enter') navigate(`/lanes/${encodeURIComponent(r.lane.id)}`); }}
                      sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
                    >
                      <TableCell sx={{ maxWidth: 360 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.lane.name || r.lane.id}</Typography>
                        <Ellipsis text={r.lane.purpose} sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }} />
                      </TableCell>
                      <TableCell><Stack direction="row" spacing={0.5}><LaneStatusChip status={r.status} />{np > 0 && <LaneStatusChip status="proposed" />}</Stack></TableCell>
                      <TableCell><LaneModeChip mode={r.lane.mode} /></TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>v{r.lane.version}<Typography variant="caption" component="span"> · {versions} total</Typography></TableCell>
                      <TableCell sx={{ maxWidth: 220 }}><Ellipsis text={[...(r.lane.appliesTo?.surfaces ?? []), ...(r.lane.appliesTo?.agents ?? [])].join(', ') || 'unscoped'} sx={{ display: 'block', fontSize: 12 }} /></TableCell>
                      <TableCell>{r.lane.priority ?? 0}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}><RelativeTime iso={r.updatedAt} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )}
      </Card>
    </Stack>
  );
}
