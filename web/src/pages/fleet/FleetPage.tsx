import { useCallback } from 'react';
import { Box, Stack, Tab, Tabs, ToggleButton, ToggleButtonGroup } from '@mui/material';
import RadarRoundedIcon from '@mui/icons-material/RadarRounded';
import { useSearchParams } from 'react-router-dom';
import { useFleetSummary } from '../../api/fleet';
import { ApiError } from '../../api/client';
import { EmptyState } from '../../components/Common';
import { QueryError } from '../../components/gov/GovCommon';
import { DEFAULT_RANGE } from '../../lib/range';
import { fmtNum } from '../../lib/format';
import { PageHeader } from '../../components/PageHeader';
import { FleetSummaryPanel, type SummaryFilterKey } from './FleetSummary';
import { FleetAlertsPanel, type AlertTableFilters } from './FleetAlertsPanel';
import { FleetAgentsPanel } from './FleetAgentsPanel';
import { FleetSessionPanel } from './FleetSessionPanel';
import { FleetAlertDrawer } from './FleetAlertDrawer';

const WINDOWS = [
  { key: '24h', label: '24h', aria: 'Last 24 hours' },
  { key: '7d', label: '7d', aria: 'Last 7 days' },
  { key: '30d', label: '30d', aria: 'Last 30 days' },
];
type FleetTab = 'alerts' | 'agents' | 'session';
const TABS: { value: FleetTab; label: string }[] = [
  { value: 'alerts', label: 'Alerts' },
  { value: 'agents', label: 'Agents' },
  { value: 'session', label: 'Session timeline' },
];
const FILTER_KEYS: (keyof AlertTableFilters)[] = ['sev', 'type', 'platform', 'agent', 'session', 'incident'];

/**
 * Fleet: alerts raised by the Python monitoring fleet about Foundry / Copilot Studio agents and model
 * callers — summary, filterable alert table, per-agent roll-up and per-session timelines. Live via
 * `gov.fleet.alerts` WebSocket messages (see api/live.tsx).
 */
export function FleetPage() {
  const [params, setParams] = useSearchParams();
  const rawRange = params.get('range');
  const range = WINDOWS.some(w => w.key === rawRange) ? rawRange! : DEFAULT_RANGE;
  const tabParam = params.get('tab');
  const tab: FleetTab = tabParam === 'agents' || tabParam === 'session' ? tabParam : 'alerts';
  const alertId = params.get('alert');
  const sid = params.get('sid') ?? '';
  const filters = Object.fromEntries(FILTER_KEYS.map(k => [k, params.get(k) ?? ''])) as unknown as AlertTableFilters;
  const summary = useFleetSummary(range);

  const update = useCallback((patch: Record<string, string | null>) => setParams(p => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); }
    return n;
  }, { replace: true }), [setParams]);

  const sessionHref = (sessionId: string) => {
    const n = new URLSearchParams(params);
    n.set('tab', 'session');
    n.set('sid', sessionId);
    n.delete('alert');
    return `/fleet?${n.toString()}`;
  };
  const onOpen = (id: string) => update({ alert: id });
  const setFilter = useCallback((key: keyof AlertTableFilters, value: string) => update({ [key]: value || null }), [update]);
  const clearFilters = () => update(Object.fromEntries(FILTER_KEYS.map(k => [k, null])));
  const onSummaryFilter = (key: SummaryFilterKey, value: string) => update({ tab: null, [key]: value });

  if (summary.isError && summary.error instanceof ApiError && summary.error.status === 404) {
    return (
      <EmptyState
        icon={<RadarRoundedIcon />}
        title="Fleet monitoring is not available on this server"
        body="Start the monitor with the governance plane enabled and point the AgentMon Fleet (fleet/) at it to see alerts about Foundry and Copilot Studio agents."
      />
    );
  }

  return (
    <Stack spacing={2.5}>
      <PageHeader
        actions={
          <ToggleButtonGroup size="small" exclusive value={range} aria-label="Time window"
            onChange={(_, v: string | null) => v && update({ range: v === DEFAULT_RANGE ? null : v })}>
            {WINDOWS.map(w => <ToggleButton key={w.key} value={w.key} aria-label={w.aria}>{w.label}</ToggleButton>)}
          </ToggleButtonGroup>
        }
      />

      {summary.isError ?  <QueryError error={summary.error} onRetry={() => void summary.refetch()} title="Could not load the fleet summary" />
        : <FleetSummaryPanel summary={summary.data} onFilter={onSummaryFilter} />}

      <Box>
        <Tabs value={tab} onChange={(_, v: FleetTab) => update({ tab: v === 'alerts' ? null : v })} aria-label="Fleet views" sx={{ borderBottom: '1px solid', borderColor: 'divider', mb: 2 }}>
          {TABS.map(t => (
            <Tab
              key={t.value}
              value={t.value}
              id={`fleet-tab-${t.value}`}
              aria-controls="fleet-tabpanel"
              label={t.value === 'alerts' && summary.data ? `${t.label} (${fmtNum(summary.data.total)})` : t.label}
            />
          ))}
        </Tabs>
        <Box role="tabpanel" id="fleet-tabpanel" aria-labelledby={`fleet-tab-${tab}`}>
          {tab === 'alerts' && (
            <FleetAlertsPanel filters={filters} setFilter={setFilter} clearFilters={clearFilters} range={range} summary={summary.data} onOpen={onOpen} sessionHref={sessionHref} />
          )}
          {tab === 'agents' && <FleetAgentsPanel range={range} onViewAlerts={agent => update({ tab: null, agent })} />}
          {tab === 'session' && <FleetSessionPanel sid={sid} range={range} onSession={s => update({ sid: s || null })} onOpen={onOpen} />}
        </Box>
      </Box>

      <FleetAlertDrawer id={alertId} onClose={() => update({ alert: null })} sessionHref={sessionHref} />
    </Stack>
  );
}
