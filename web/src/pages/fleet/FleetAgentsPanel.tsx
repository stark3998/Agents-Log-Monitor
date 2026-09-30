import { useMemo } from 'react';
import { Box, Button, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography, useTheme } from '@mui/material';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { useFleetAlerts, type FleetAlert, type FleetSeverity } from '../../api/fleet';
import { EmptyState } from '../../components/Common';
import { ToneChip } from '../../components/Chips';
import { RelativeTime } from '../../components/Primitives';
import { QueryError } from '../../components/gov/GovCommon';
import { FLEET_ALERT_TITLE, FLEET_SEVERITY_RANK, FleetSeverityChip, ScoreBadge, agentKey, platformLabel } from '../../components/gov/FleetCommon';
import { fmtNum } from '../../lib/format';

export const WINDOW_LIMIT = 2000;

export interface FleetAgentRow {
  key: string;
  name: string | null;
  ids: string[];
  platforms: string[];
  total: number;
  bySeverity: Partial<Record<FleetSeverity, number>>;
  worst: FleetSeverity;
  maxScore: number;
  topTypes: { type: string; count: number }[];
  sessions: number;
  incidents: number;
  lastAt: string;
}

/** Group alerts per agent (agent_name, else agent_id) — everything here is derived from alerts only. */
export function groupByAgent(alerts: FleetAlert[]): FleetAgentRow[] {
  const groups = new Map<string, FleetAlert[]>();
  for (const a of alerts) {
    const k = agentKey(a);
    const g = groups.get(k);
    if (g) g.push(a); else groups.set(k, [a]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const types = new Map<string, number>();
    const bySeverity: Partial<Record<FleetSeverity, number>> = {};
    let worst: FleetSeverity = 'informational';
    for (const a of list) {
      types.set(a.alert_type, (types.get(a.alert_type) ?? 0) + 1);
      bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      if ((FLEET_SEVERITY_RANK[a.severity] ?? 0) > FLEET_SEVERITY_RANK[worst]) worst = a.severity;
    }
    return {
      key,
      name: list.find(a => a.agent_name)?.agent_name ?? null,
      ids: [...new Set(list.map(a => a.agent_id).filter((x): x is string => !!x))],
      platforms: [...new Set(list.map(a => a.platform))].sort(),
      total: list.length,
      bySeverity,
      worst,
      maxScore: Math.max(...list.map(a => a.score)),
      topTypes: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)).slice(0, 3),
      sessions: new Set(list.map(a => a.session_id).filter(Boolean)).size,
      incidents: new Set(list.map(a => a.incident_id).filter(Boolean)).size,
      lastAt: list.reduce((m, a) => (a.created_at > m ? a.created_at : m), list[0].created_at),
    };
  }).sort((a, b) => FLEET_SEVERITY_RANK[b.worst] - FLEET_SEVERITY_RANK[a.worst] || b.total - a.total || a.key.localeCompare(b.key));
}

/** Per-agent roll-up of alerts in the window with a shortcut to the filtered alerts table. */
export function FleetAgentsPanel({ range, onViewAlerts }: { range: string; onViewAlerts: (agent: string) => void }) {
  const t = useTheme().tokens;
  const q = useFleetAlerts({ limit: WINDOW_LIMIT }, range);
  const rows = useMemo(() => groupByAgent(q.data ?? []), [q.data]);

  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <Stack spacing={1} aria-busy="true" aria-label="Loading agents">{[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={56} />)}</Stack>;
  if (!rows.length) return <EmptyState compact icon={<SmartToyOutlinedIcon />} title="No agents with alerts in this window" body="Agents appear here once the monitoring fleet raises an alert about them." />;

  return (
    <Stack spacing={1}>
      <Typography variant="caption" component="div">
        Derived from fleet alerts in this window{(q.data?.length ?? 0) >= WINDOW_LIMIT ? ` (newest ${fmtNum(WINDOW_LIMIT)})` : ''}. Agent charters are configured in the fleet and are not exposed by this API.
      </Typography>
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3, overflowX: 'auto', bgcolor: 'background.paper' }}>
        <Table size="small" aria-label="Agents with fleet alerts" data-testid="fleet-agents-table">
          <TableHead>
            <TableRow>
              <TableCell>Agent</TableCell>
              <TableCell>Platform</TableCell>
              <TableCell>Worst</TableCell>
              <TableCell align="right">Alerts</TableCell>
              <TableCell>Critical / High</TableCell>
              <TableCell align="right">Max score</TableCell>
              <TableCell>Top alert types</TableCell>
              <TableCell align="right">Sessions</TableCell>
              <TableCell align="right">Incidents</TableCell>
              <TableCell>Last alert</TableCell>
              <TableCell><Box component="span" sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>Actions</Box></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(r => (
              <TableRow key={r.key} hover>
                <TableCell component="th" scope="row" sx={{ maxWidth: 220 }}>
                  <Typography variant="body2" noWrap sx={{ fontWeight: 550 }} title={r.key}>{r.key === 'unknown' ? 'Unattributed' : r.name ?? r.key}</Typography>
                  {r.ids.filter(id => id !== r.name).slice(0, 2).map(id => (
                    <Typography key={id} variant="caption" component="div" noWrap sx={{ fontFamily: 'var(--am-mono)', fontSize: 11 }} title={id}>{id}</Typography>
                  ))}
                </TableCell>
                <TableCell sx={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{r.platforms.map(platformLabel).join(', ')}</TableCell>
                <TableCell><FleetSeverityChip severity={r.worst} /></TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{fmtNum(r.total)}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Stack direction="row" spacing={0.5}>
                    <ToneChip tone={r.bySeverity.critical ? t.severity.critical : t.severity.info} label={fmtNum(r.bySeverity.critical ?? 0)} aria-label={`${fmtNum(r.bySeverity.critical ?? 0)} critical`} sx={{ height: 20, fontSize: 11 }} />
                    <ToneChip tone={r.bySeverity.high ? t.severity.high : t.severity.info} label={fmtNum(r.bySeverity.high ?? 0)} aria-label={`${fmtNum(r.bySeverity.high ?? 0)} high`} sx={{ height: 20, fontSize: 11 }} />
                  </Stack>
                </TableCell>
                <TableCell align="right"><ScoreBadge score={r.maxScore} /></TableCell>
                <TableCell sx={{ minWidth: 220 }}>
                  <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
                    {r.topTypes.map(tt => (
                      <Tooltip key={tt.type} title={FLEET_ALERT_TITLE[tt.type] ?? tt.type}>
                        <ToneChip tone={t.severity.info} label={`${tt.type} · ${tt.count}`} aria-label={`${tt.type}: ${tt.count}`} sx={{ height: 20, fontSize: 10.5, fontFamily: 'var(--am-mono)', color: 'text.primary' }} />
                      </Tooltip>
                    ))}
                  </Stack>
                </TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.sessions)}</TableCell>
                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtNum(r.incidents)}</TableCell>
                <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}><RelativeTime iso={r.lastAt} /></TableCell>
                <TableCell>
                  {r.key !== 'unknown' && (
                    <Button size="small" onClick={() => onViewAlerts(r.key)} aria-label={`View alerts for ${r.key}`} sx={{ whiteSpace: 'nowrap' }}>View alerts</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
    </Stack>
  );
}
