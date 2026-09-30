import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useGovOverview, usePendingApprovals, useRecentDecisions, type Decision } from '../../api/governance';
import { EmptyState, SectionCard, TimeRangePicker } from '../../components/Common';
import { StatCard, QueryError } from '../../components/gov/GovCommon';
import { DecisionsTable } from '../../components/gov/DecisionsTable';
import { DecisionDrawer } from '../../components/gov/DecisionDrawer';
import { ApprovalStateChip } from '../../components/gov/GovChips';
import { Ellipsis } from '../../components/Primitives';
import { ApiError } from '../../api/client';
import { DEFAULT_RANGE, rangeBounds, useRangeKey } from '../../lib/range';
import { fmtDuration, fmtNum } from '../../lib/format';
import { fmtCountdown, useNow } from '../../lib/useNow';
import { DecisionTrend } from './DecisionTrend';
import { TestHarnessCard } from '../../components/gov/TestHarnessCard';

export function GovernanceOverviewPage() {
  const [range] = useRangeKey();
  const navigate = useNavigate();
  const overview = useGovOverview(range);
  const since = rangeBounds(range).from.slice(0, 13);
  const denies = useRecentDecisions({ verdict: 'deny', since: `${since}:00:00.000Z` }, 10);
  const approvals = usePendingApprovals();
  const [open, setOpen] = useState<Decision | null>(null);
  const now = useNow(1000);
  const o = overview.data;
  const rangeQs = range === DEFAULT_RANGE ? '' : `range=${range}`;
  const go = (path: string, qs = '') => () => navigate(`${path}${qs || rangeQs ? `?${[qs, rangeQs].filter(Boolean).join('&')}` : ''}`);

  if (overview.isError && overview.error instanceof ApiError && overview.error.status === 404) {
    return (
      <EmptyState
        icon={<PolicyOutlinedIcon />}
        title="Governance is not enabled on this server"
        body="Start the monitor with the governance plane enabled to see policy decisions, approvals and incidents."
      />
    );
  }

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TimeRangePicker />
        <Box sx={{ flex: 1 }} />
        <Button variant="outlined" size="small" component={RouterLink} to="/lanes">Manage lanes</Button>
      </Stack>

      <Typography variant="h5" component="h2">Governance overview</Typography>

      {overview.isError ? <QueryError error={overview.error} onRetry={() => void overview.refetch()} /> : (
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
          <StatCard index={0} label="Allowed" value={o?.decisions.allow} onClick={go('/enforcements', 'verdict=allow')} />
          <StatCard index={1} label="Denied" value={o?.decisions.deny} onClick={go('/enforcements', 'verdict=deny')} info="Tool calls blocked by a lane rule, the judge, a human or a kill switch" />
          <StatCard index={2} label="Would deny (observe)" value={o?.decisions.wouldDeny} onClick={go('/enforcements', 'wouldDeny=true')} info="Actions that were allowed only because the lane is in observe mode" />
          <StatCard index={3} label="Pending approvals" value={o?.pendingApprovals} onClick={go('/approvals')} />
          <StatCard index={4} label="Open incidents" value={o?.openIncidents} onClick={go('/incidents')} />
          <StatCard
            index={5}
            label="Paused / quarantined agents"
            value={o ? o.agents.paused + o.agents.quarantined : undefined}
            info={o ? `${fmtNum(o.agents.paused)} paused · ${fmtNum(o.agents.quarantined)} quarantined · ${fmtNum(o.agents.active)} active` : undefined}
            onClick={go('/agents', 'status=stopped')}
          />
          <StatCard index={6} label="Judge p95 latency" value={o?.judge.p95Ms} format={n => fmtDuration(n) || '0ms'} info={o ? `${fmtNum(o.judge.calls)} judge calls in this period` : undefined} />
        </Box>
      )}

      <SectionCard title="Decisions over time" subtitle="Allowed, denied and would-deny (observe mode) tool calls" delay={120}>
        <DecisionTrend data={o} />
      </SectionCard>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' } }}>
        <SectionCard
          title="Recent denies"
          delay={180}
          action={<Button size="small" component={RouterLink} to={`/enforcements?verdict=deny${rangeQs ? `&${rangeQs}` : ''}`}>View all</Button>}
        >
          {denies.isError ? <QueryError error={denies.error} onRetry={() => void denies.refetch()} />
            : <DecisionsTable rows={denies.data?.items ?? []} loading={denies.isLoading} onOpen={setOpen} empty="Nothing was denied in this period." dense />}
        </SectionCard>
        <SectionCard
          title="Waiting for approval"
          delay={220}
          action={<Button size="small" component={RouterLink} to="/approvals">Open queue</Button>}
        >
          {(approvals.data ?? []).length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{approvals.isLoading ? 'Loading…' : 'No pending approvals.'}</Typography>
          ) : (
            <Stack spacing={1}>
              {(approvals.data ?? []).slice(0, 6).map(a => (
                <Stack
                  key={a.id}
                  direction="row"
                  spacing={1}
                  component={RouterLink}
                  to={`/approvals?id=${encodeURIComponent(a.id)}`}
                  sx={{ alignItems: 'center', p: 1, borderRadius: 2, border: '1px solid', borderColor: 'divider', color: 'inherit', textDecoration: 'none', '&:hover, &:focus-visible': { bgcolor: 'action.hover' } }}
                >
                  <ApprovalStateChip state={a.state} />
                  <Box sx={{ flex: 1, minWidth: 0 }}><Ellipsis text={a.summary} sx={{ display: 'block' }} /></Box>
                  <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtCountdown(a.expiresAt, now)}</Typography>
                </Stack>
              ))}
            </Stack>
          )}
        </SectionCard>
      </Box>

      <TestHarnessCard delay={260} />

      <DecisionDrawer id={open?.id ?? null} initial={open ?? undefined} onClose={() => setOpen(null)} />
    </Stack>
  );
}
