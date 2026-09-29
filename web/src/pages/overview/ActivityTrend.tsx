import { Box, Skeleton, useTheme } from '@mui/material';
import { LineChart, lineClasses } from '@mui/x-charts/LineChart';
import type { Overview } from '../../api/types';
import { agentStyle } from '../../components/AgentAvatar';
import { fmtNum } from '../../lib/format';

export function ActivityTrend({ data }: { data?: Overview }) {
  const t = useTheme().tokens;
  if (!data) return <Skeleton variant="rounded" height={200} />;
  const labels = data.buckets.map(b => {
    const d = new Date(data.bucket === 'hour' ? `${b}:00:00Z` : `${b}T00:00:00Z`);
    return data.bucket === 'hour'
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  if (!data.trend.length) {
    return <Box sx={{ height: 200, display: 'grid', placeItems: 'center', color: 'text.disabled', fontSize: 13 }}>No tool activity in this period</Box>;
  }
  return (
    <Box sx={{ height: 210, mx: -1 }}>
      <LineChart
        height={210}
        margin={{ left: 8, right: 16, top: 12, bottom: 4 }}
        xAxis={[{ data: labels, scaleType: 'point', tickLabelStyle: { fontSize: 11, fill: t.textTertiary }, disableLine: true, disableTicks: true }]}
        yAxis={[{ tickLabelStyle: { fontSize: 11, fill: t.textTertiary }, disableLine: true, disableTicks: true, width: 44, valueFormatter: (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v)) }]}
        series={data.trend.map(s => ({
          data: s.data, label: s.agentName, area: true, stack: 'total', showMark: false, curve: 'monotoneX' as const,
          color: agentStyle(s.agentKey).fg, valueFormatter: (v: number | null) => `${fmtNum(v ?? 0)} actions`,
        }))}
        grid={{ horizontal: true }}
        sx={{
          [`& .${lineClasses.area}`]: { fillOpacity: 0.16 },
          [`& .${lineClasses.line}`]: { strokeWidth: 2 },
          '& .MuiChartsGrid-line': { stroke: t.outline, strokeDasharray: '3 4' },
        }}
        slotProps={{ legend: { sx: { fontSize: 12, color: t.textSecondary } } }}
      />
    </Box>
  );
}
