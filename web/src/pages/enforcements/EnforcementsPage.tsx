import { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, FormControl, FormControlLabel, InputAdornment, InputLabel, MenuItem, Select, Stack, Switch, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import GppGoodOutlinedIcon from '@mui/icons-material/GppGoodOutlined';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { useSearchParams } from 'react-router-dom';
import { useDecisionsInfinite, useGovAgents, useLanes, type Decision, type DecisionFilters, type Verdict } from '../../api/governance';
import { EmptyState, TimeRangePicker } from '../../components/Common';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { CategoryChip } from '../../components/Chips';
import { DecisionDrawer } from '../../components/gov/DecisionDrawer';
import { QueryError } from '../../components/gov/GovCommon';
import { STAGE_LABEL, VerdictChip } from '../../components/gov/GovChips';
import { rangeBounds, useRangeKey } from '../../lib/range';
import { fmtDuration, fmtNum } from '../../lib/format';
import { ConversationDrawer } from '../conversation/ConversationDrawer';
import { LegacyEnforcements } from './LegacyEnforcements';

const VERDICTS: (Verdict | '')[] = ['', 'allow', 'deny', 'ask', 'escalate'];
const VERDICT_OPTION: Record<string, string> = { '': 'All verdicts', allow: 'Allowed', deny: 'Denied', ask: 'Asked user', escalate: 'Escalated' };

function useParam(key: string): [string, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = (v: string | null) => setParams(p => {
    const n = new URLSearchParams(p);
    if (v) n.set(key, v); else n.delete(key);
    return n;
  }, { replace: true });
  return [params.get(key) ?? '', set];
}

/** Policy decisions from /api/gov/decisions with filters, cursor paging and a detail drawer. */
function DecisionsView() {
  const [range] = useRangeKey();
  const [verdict, setVerdict] = useParam('verdict');
  const [wouldDeny, setWouldDeny] = useParam('wouldDeny');
  const [agent, setAgent] = useParam('agent');
  const [lane, setLane] = useParam('lane');
  const [q, setQ] = useParam('q');
  const [drawer, setDrawer] = useParam('d');
  const [conv, setConv] = useParam('c');
  const [text, setText] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => { if (text !== q) setQ(text || null); }, 300);
    return () => clearTimeout(id);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hour-truncated lower bound keeps the query key stable between renders.
  const since = `${rangeBounds(range).from.slice(0, 13)}:00:00.000Z`;
  const filters = useMemo<DecisionFilters>(() => ({
    verdict: (verdict as Verdict) || undefined, wouldDeny: wouldDeny === 'true' ? true : undefined,
    agentId: agent || undefined, laneId: lane || undefined, text: q || undefined, since,
  }), [verdict, wouldDeny, agent, lane, q, since]);

  const decisions = useDecisionsInfinite(filters);
  const agents = useGovAgents();
  const lanes = useLanes();
  const rows = useMemo(() => decisions.data?.pages.flatMap(p => p.items) ?? [], [decisions.data]);
  const selected = rows.find(r => r.id === drawer);
  const laneIds = useMemo(() => [...new Set((lanes.data ?? []).map(l => l.lane.id))].sort(), [lanes.data]);

  const columns: GridColDef<Decision>[] = [
    { field: 'createdAt', headerName: 'Time', width: 110, renderCell: p => <Box sx={{ color: 'text.secondary' }}><RelativeTime iso={p.row.createdAt} /></Box> },
    { field: 'verdict', headerName: 'Verdict', width: 150, renderCell: p => <VerdictChip verdict={p.row.verdict} wouldDeny={p.row.wouldDeny} /> },
    {
      field: 'toolName', headerName: 'Tool', width: 190,
      renderCell: p => <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}><Ellipsis text={p.row.toolName ?? p.row.checkpoint} mono sx={{ fontSize: 12 }} /><CategoryChip category={p.row.category ?? null} /></Stack>,
    },
    { field: 'reason', headerName: 'Reason', flex: 2, minWidth: 260, renderCell: p => <Ellipsis text={p.row.reason} /> },
    { field: 'stage', headerName: 'Stage', width: 150, valueGetter: (_v, r) => STAGE_LABEL[r.stage] ?? r.stage },
    { field: 'agentId', headerName: 'Agent', width: 150, renderCell: p => <Ellipsis text={p.row.agentId} /> },
    { field: 'laneId', headerName: 'Lane', width: 150, valueGetter: (_v, r) => `${r.laneId}@v${r.laneVersion}`, renderCell: p => <Ellipsis text={`${p.row.laneId}@v${p.row.laneVersion}`} mono sx={{ fontSize: 12 }} /> },
    {
      field: 'tainted', headerName: '', width: 44, sortable: false,
      renderCell: p => (p.row.tainted ? <Tooltip title="Session tainted by untrusted content"><WarningAmberRoundedIcon aria-label="Tainted" sx={{ fontSize: 17, color: 'warning.main' }} /></Tooltip> : null),
    },
    { field: 'latencyMs', headerName: 'Latency', width: 90, align: 'right', headerAlign: 'right', valueFormatter: (v: number) => fmtDuration(v) },
  ];

  return (
    <Stack spacing={1.5} sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }} role="search" aria-label="Filter decisions">
        <TimeRangePicker />
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="f-verdict">Verdict</InputLabel>
          <Select labelId="f-verdict" label="Verdict" value={verdict} onChange={e => setVerdict(e.target.value || null)}>
            {VERDICTS.map(v => <MenuItem key={v || 'all'} value={v}>{VERDICT_OPTION[v]}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="f-agent">Agent</InputLabel>
          <Select labelId="f-agent" label="Agent" value={agent} onChange={e => setAgent(e.target.value || null)}>
            <MenuItem value="">All agents</MenuItem>
            {(agents.data ?? []).map(a => <MenuItem key={a.id} value={a.id}>{a.name}</MenuItem>)}
            {agent && !(agents.data ?? []).some(a => a.id === agent) && <MenuItem value={agent}>{agent}</MenuItem>}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth: 150 }}>
          <InputLabel id="f-lane">Lane</InputLabel>
          <Select labelId="f-lane" label="Lane" value={lane} onChange={e => setLane(e.target.value || null)}>
            <MenuItem value="">All lanes</MenuItem>
            {laneIds.map(id => <MenuItem key={id} value={id}>{id}</MenuItem>)}
            {lane && !laneIds.includes(lane) && <MenuItem value={lane}>{lane}</MenuItem>}
          </Select>
        </FormControl>
        <FormControlLabel
          control={<Switch size="small" checked={wouldDeny === 'true'} onChange={e => setWouldDeny(e.target.checked ? 'true' : null)} />}
          label={<Typography variant="body2">Would deny only</Typography>}
        />
        <TextField
          size="small"
          placeholder="Search reason, tool, rule…"
          value={text}
          onChange={e => setText(e.target.value)}
          sx={{ flex: 1, minWidth: 200 }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 18 }} /></InputAdornment> }, htmlInput: { 'aria-label': 'Search decisions' } }}
        />
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper', display: 'flex', flexDirection: 'column' }}>
        {decisions.isError ? <QueryError error={decisions.error} onRetry={() => void decisions.refetch()} /> : (
          <>
            <Box sx={{ flex: 1, minHeight: 0 }}>
              <DataGrid
                rows={rows}
                columns={columns}
                loading={decisions.isLoading}
                rowHeight={46}
                columnHeaderHeight={40}
                disableColumnMenu
                hideFooter
                onRowClick={p => setDrawer(p.row.id)}
                getRowClassName={p => (p.row.id === drawer ? 'Mui-selected' : '')}
                slots={{
                  noRowsOverlay: () => (
                    <EmptyState icon={<GppGoodOutlinedIcon />} title="No decisions" body="No governance decisions match these filters in this period." />
                  ),
                }}
                slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
                sx={{ height: '100%' }}
              />
            </Box>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, py: 0.75, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="caption">{fmtNum(rows.length)} decisions loaded</Typography>
              <Box sx={{ flex: 1 }} />
              {decisions.hasNextPage && (
                <Button size="small" variant="outlined" disabled={decisions.isFetchingNextPage} onClick={() => void decisions.fetchNextPage()}>
                  {decisions.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </Stack>
          </>
        )}
      </Box>
      <DecisionDrawer id={drawer || null} initial={selected} onClose={() => setDrawer(null)} />
      <ConversationDrawer id={conv || null} onClose={() => setConv(null)} />
    </Stack>
  );
}

/** Enforcements: policy decisions (governance plane) with the legacy agent-reported events one toggle away. */
export function EnforcementsPage() {
  const [view, setView] = useParam('view');
  const legacy = view === 'events';
  return (
    <Stack spacing={1.5} sx={{ height: 'calc(100vh - 150px)', minHeight: 520 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <ToggleButtonGroup size="small" exclusive value={legacy ? 'events' : 'decisions'} onChange={(_, v) => v && setView(v === 'events' ? 'events' : null)} aria-label="Enforcement source">
          <ToggleButton value="decisions">Policy decisions</ToggleButton>
          <ToggleButton value="events">Agent-reported events</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ maxWidth: 440, display: { xs: 'none', md: 'block' } }}>
          {legacy ? 'Policy events reported by the agents themselves (logs and hooks).' : 'Every governed tool call, allowed or denied by the policy engine against the agent’s lane.'}
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0 }}>{legacy ? <LegacyEnforcements /> : <DecisionsView />}</Box>
    </Stack>
  );
}
