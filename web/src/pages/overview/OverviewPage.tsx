import { Box, Stack } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { exportUrl, useAgents, useConnections, useOverview } from '../../api/client';
import { ExportMenu, SectionCard, TimeRangePicker } from '../../components/Common';
import { rangeBounds, useRangeKey, DEFAULT_RANGE } from '../../lib/range';
import { fmtNum } from '../../lib/format';
import { KpiCard, type KpiDef } from './KpiCard';
import { TopAgentsTable } from './TopAgentsTable';
import { ConnectionsHeatmap } from './ConnectionsHeatmap';
import { ActivityTrend } from './ActivityTrend';
import { PageHeader } from '../../components/PageHeader';

export function OverviewPage() {
  const [range] = useRangeKey();
  const navigate = useNavigate();
  const overview = useOverview(range);
  const agents = useAgents(range);
  const connections = useConnections(range);
  const rangeParam = range === DEFAULT_RANGE ? '' : `range=${range}&`;
  const go = (qs: string) => () => navigate(`/conversations?${rangeParam}${qs}`);

  const defs: KpiDef[] = [
    { key: 'activeAgents', label: 'Active agents', info: 'Distinct agents with activity in this period', onClick: go('') },
    { key: 'totalSessions', label: 'Total sessions', onClick: go('') },
    { key: 'sensitiveSessions', label: 'Sessions with sensitive data', info: 'Sessions where secrets or personal data were detected in prompts or tool traffic', risk: true, onClick: go('data=any') },
    { key: 'riskyActions', label: 'Risky actions', info: 'Tool calls matching a high or critical risk rule (e.g. force push, credential reads, recursive deletes of root)', risk: true, onClick: go('severity=critical,high') },
    { key: 'blockedWarned', label: 'Blocked / warned actions', info: 'Tool calls that were blocked, denied by the user, or flagged with a critical warning', risk: true, onClick: () => navigate(`/enforcements${range === DEFAULT_RANGE ? '' : `?range=${range}`}`) },
  ];

  const bounds = rangeBounds(range);

  return (
    <Stack spacing={2.5}>
      <PageHeader
        actions={<>
          <TimeRangePicker />
          <ExportMenu
            label="Export activity logs"
            options={[
              { label: 'CSV', hint: 'One row per event, spreadsheet friendly', href: exportUrl('export', { ...bounds, format: 'csv' }) },
              { label: 'JSON Lines', hint: 'One JSON object per event', href: exportUrl('export', { ...bounds, format: 'jsonl' }) },
            ]}
          />
        </>}
      />

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}>
        {defs.map((d, i) => (
          <KpiCard key={d.key} def={d} index={i} kpi={overview.data?.kpis[d.key as keyof NonNullable<typeof overview.data>['kpis']]} />
        ))}
      </Box>

      <SectionCard
        title="Activity over time"
        subtitle={overview.data ? `${fmtNum(overview.data.totalActions)} tool calls by agent` : 'Tool calls by agent'}
        delay={120}
      >
        <ActivityTrend data={overview.data} />
      </SectionCard>

      <SectionCard title="Top agents" subtitle="Per-agent activity, MCP connectivity, and external-domain breakdown" delay={180}>
        <TopAgentsTable rows={agents.data ?? []} loading={agents.isLoading} rangeParam={rangeParam} />
      </SectionCard>

      <SectionCard title="What agents connect to" subtitle="MCP servers and external domains reached by each agent" delay={240}>
        <ConnectionsHeatmap data={connections.data} rangeParam={rangeParam} />
      </SectionCard>
    </Stack>
  );
}
