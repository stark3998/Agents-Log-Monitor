import { Box, Skeleton, useTheme } from '@mui/material';
import { LineChart, lineClasses } from '@mui/x-charts/LineChart';
import type { GovOverview } from '../../api/governance';
import { fmtNum } from '../../lib/format';

type Point = GovOverview['trend'][number];

/**
 * Choose the label granularity. The server already sends a continuous series (hourly ≤ 48h, daily
 * otherwise); daily input is detected from point spacing. Long hourly series are rolled up to days.
 */
export function bucketTrend(trend: Point[]): { bucket: 'hour' | 'day'; points: Point[] } {
  const spacing = trend.length > 1 ? Date.parse(trend[1].t) - Date.parse(trend[0].t) : 0;
  if (spacing >= 23 * 3600_000) return { bucket: 'day', points: trend };
  if (trend.length <= 48) return { bucket: 'hour', points: trend };
  const days = new Map<string, Point>();
  for (const p of trend) {
    const k = p.t.slice(0, 10);
    const d = days.get(k) ?? { t: `${k}T00:00:00.000Z`, allow: 0, deny: 0, wouldDeny: 0 };
    d.allow += p.allow; d.deny += p.deny; d.wouldDeny += p.wouldDeny;
    days.set(k, d);
  }
  return { bucket: 'day', points: [...days.values()].sort((a, b) => a.t.localeCompare(b.t)) };
}

/** Allowed / denied / would-deny decisions over time (same chart approach as ActivityTrend). */
export function DecisionTrend({ data }: { data?: GovOverview }) {
  const t = useTheme().tokens;
  if (!data) return <Skeleton variant="rounded" height={200} />;
  if (!data.trend.length) {
    return <Box sx={{ height: 200, display: 'grid', placeItems: 'center', color: 'text.disabled', fontSize: 13 }}>No governance decisions in this period</Box>;
  }
  const { bucket, points } = bucketTrend(data.trend);
  const labels = points.map(p => {
    const d = new Date(p.t);
    return bucket === 'hour'
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  const fmt = (label: string) => (v: number | null) => `${fmtNum(v ?? 0)} ${label}`;
  return (
    <Box sx={{ height: 210, mx: -1 }}>
      <LineChart
        height={210}
        margin={{ left: 8, right: 16, top: 12, bottom: 4 }}
        xAxis={[{ data: labels, scaleType: 'point', tickLabelStyle: { fontSize: 11, fill: t.textTertiary }, disableLine: true, disableTicks: true }]}
        yAxis={[{ tickLabelStyle: { fontSize: 11, fill: t.textTertiary }, disableLine: true, disableTicks: true, width: 44 }]}
        series={[
          { data: points.map(p => p.allow), label: 'Allowed', area: true, showMark: false, curve: 'monotoneX', color: t.success, valueFormatter: fmt('allowed') },
          { data: points.map(p => p.deny), label: 'Denied', area: true, showMark: false, curve: 'monotoneX', color: t.severity.critical.fg, valueFormatter: fmt('denied') },
          { data: points.map(p => p.wouldDeny), label: 'Would deny (observe)', showMark: false, curve: 'monotoneX', color: t.severity.medium.fg, valueFormatter: fmt('would deny') },
        ]}
        grid={{ horizontal: true }}
        sx={{
          [`& .${lineClasses.area}`]: { fillOpacity: 0.14 },
          [`& .${lineClasses.line}`]: { strokeWidth: 2 },
          '& .MuiChartsGrid-line': { stroke: t.outline, strokeDasharray: '3 4' },
        }}
        slotProps={{ legend: { sx: { fontSize: 12, color: t.textSecondary } } }}
      />
    </Box>
  );
}
