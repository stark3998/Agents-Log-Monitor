import { Box, ButtonBase, Skeleton, Stack, Typography, useTheme } from '@mui/material';
import type { FleetSummary } from '../../api/fleet';
import { FLEET_SEVERITIES } from '../../api/fleet';
import { SectionCard } from '../../components/Common';
import { StatCard } from '../../components/gov/GovCommon';
import { FLEET_ALERT_TITLE, fleetSeverity, humanizeType, platformLabel } from '../../components/gov/FleetCommon';
import { fmtNum } from '../../lib/format';

export type SummaryFilterKey = 'sev' | 'type' | 'platform' | 'agent';

interface BarEntry { key: string; label: string; count: number; title?: string }

/** Horizontal bar list; each row is a button that applies the matching table filter. */
function BarList({ title, noun, entries, color, onSelect, max = 8, testId }: {
  title: string; noun: string; entries: BarEntry[]; color: (key: string) => string; onSelect: (key: string) => void; max?: number; testId: string;
}) {
  const top = entries.slice(0, max);
  const peak = Math.max(1, ...top.map(e => e.count));
  return (
    <SectionCard title={title} sx={{ p: 2 }}>
      {!top.length ? <Typography variant="body2" color="text.secondary" sx={{ py: 1.5 }}>No alerts in this window.</Typography> : (
        <Stack component="ul" spacing={0.25} data-testid={testId} aria-label={title} sx={{ m: 0, p: 0, listStyle: 'none' }}>
          {top.map(e => (
            <li key={e.key}>
              <ButtonBase
                onClick={() => onSelect(e.key)}
                aria-label={`Filter by ${noun} ${e.label}: ${fmtNum(e.count)} alerts`}
                title={e.title}
                sx={{ display: 'block', width: '100%', textAlign: 'left', borderRadius: 1.5, px: 1, py: 0.5, '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main' } }}
              >
                <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline' }}>
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>{e.label}</Typography>
                  <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: 'text.primary', fontWeight: 600 }}>{fmtNum(e.count)}</Typography>
                </Stack>
                <Box sx={{ mt: 0.4, height: 6, borderRadius: 99, bgcolor: 'action.hover', overflow: 'hidden' }} aria-hidden>
                  <Box sx={{ height: '100%', borderRadius: 99, bgcolor: color(e.key), width: `${Math.max(2, (e.count / peak) * 100)}%`, transition: 'width 400ms cubic-bezier(0.2,0,0,1)' }} />
                </Box>
              </ButtonBase>
            </li>
          ))}
          {entries.length > max && <Typography component="li" variant="caption" sx={{ px: 1, pt: 0.5 }}>+{fmtNum(entries.length - max)} more</Typography>}
        </Stack>
      )}
    </SectionCard>
  );
}

const sortDesc = (m: Record<string, number>, label: (k: string) => string = k => k, title?: (k: string) => string | undefined): BarEntry[] =>
  Object.entries(m).map(([key, count]) => ({ key, count, label: label(key), title: title?.(key) })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

/** KPI tiles + per-dimension bars for the selected window. Clicking a bar filters the alerts table. */
export function FleetSummaryPanel({ summary, onFilter }: { summary: FleetSummary | undefined; onFilter: (key: SummaryFilterKey, value: string) => void }) {
  const t = useTheme().tokens;
  if (!summary) {
    return (
      <Stack spacing={1.5} aria-busy="true" aria-label="Loading fleet summary">
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} variant="rounded" height={92} />)}</Box>
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>{[0, 1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={180} />)}</Box>
      </Stack>
    );
  }
  const sev = summary.bySeverity;
  const agents = Object.keys(summary.byAgent).filter(k => k !== 'unknown').length;
  const severityEntries: BarEntry[] = FLEET_SEVERITIES.filter(s => sev[s]).map(s => ({ key: s, label: s[0].toUpperCase() + s.slice(1), count: sev[s] ?? 0 }));
  const sevCard = (s: 'critical' | 'high' | 'medium', index: number) => {
    const n = sev[s] ?? 0;
    const label = s[0].toUpperCase() + s.slice(1);
    return <StatCard index={index} label={label} value={n} tone={n ? t.severity[s].fg : undefined} onClick={n ? () => onFilter('sev', s) : undefined} ariaLabel={`${label} ${fmtNum(n)}`} />;
  };
  return (
    <Stack spacing={1.5} data-testid="fleet-summary">
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCard index={0} label="Alerts" value={summary.total} ariaLabel={`Alerts ${fmtNum(summary.total)}`} />
        {sevCard('critical', 1)}
        {sevCard('high', 2)}
        {sevCard('medium', 3)}
        <StatCard index={4} label="Agents with alerts" value={agents} info="Distinct agents (by name or id) that raised at least one alert in this window" ariaLabel={`Agents with alerts ${fmtNum(agents)}`} />
      </Box>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(4, minmax(0, 1fr))' } }}>
        <BarList title="By severity" noun="severity" testId="fleet-by-severity" entries={severityEntries} color={k => t.severity[fleetSeverity(k)].fg} onSelect={k => onFilter('sev', k)} />
        <BarList title="By alert type" noun="type" testId="fleet-by-type" entries={sortDesc(summary.byType, humanizeType, k => FLEET_ALERT_TITLE[k] ?? k)} color={() => t.accent} onSelect={k => onFilter('type', k)} />
        <BarList title="By platform" noun="platform" testId="fleet-by-platform" entries={sortDesc(summary.byPlatform, platformLabel)} color={() => t.channel.hook.fg} onSelect={k => onFilter('platform', k)} />
        <BarList title="By agent" noun="agent" testId="fleet-by-agent" entries={sortDesc(summary.byAgent)} color={() => t.channel.log.fg} onSelect={k => onFilter('agent', k)} />
      </Box>
    </Stack>
  );
}
