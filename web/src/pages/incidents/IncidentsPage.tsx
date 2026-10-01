import { useMemo } from 'react';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useIncidents, type Incident } from '../../api/governance';
import { EmptyState } from '../../components/Common';
import { SeverityChip, severityRank } from '../../components/Chips';
import { QueryError } from '../../components/gov/GovCommon';
import { IncidentStateChip } from '../../components/gov/GovChips';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { fmtNum } from '../../lib/format';
import { PageHeader } from '../../components/PageHeader';
import { FILL_HEIGHT } from '../../components/layout';

const OPEN_STATES = ['open', 'investigating', 'contained'];

export function IncidentsPage() {
  const incidents = useIncidents();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const show = params.get('show') === 'all' ? 'all' : 'open';
  const rows = useMemo(() => (incidents.data ?? []).filter(i => show === 'all' || OPEN_STATES.includes(i.state)), [incidents.data, show]);
  const openCount = (incidents.data ?? []).filter(i => OPEN_STATES.includes(i.state)).length;

  const columns: GridColDef<Incident>[] = [
    {
      field: 'severity', headerName: 'Severity', width: 110, renderCell: p => <SeverityChip severity={p.row.severity} />,
      sortComparator: (a, b) => severityRank(a) - severityRank(b),
    },
    { field: 'title', headerName: 'Incident', flex: 2, minWidth: 260, renderCell: p => <Box sx={{ minWidth: 0 }}><Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{p.row.title}</Typography>{p.row.summary && <Ellipsis text={p.row.summary} sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }} />}</Box> },
    { field: 'state', headerName: 'State', width: 130, renderCell: p => <IncidentStateChip state={p.row.state} /> },
    { field: 'trigger', headerName: 'Trigger', width: 140, renderCell: p => <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{p.row.trigger}</Box> },
    { field: 'agents', headerName: 'Agents', width: 90, type: 'number', valueGetter: (_v, r) => r.agentIds.length },
    { field: 'decisions', headerName: 'Decisions', width: 100, type: 'number', valueGetter: (_v, r) => r.decisionIds.length },
    { field: 'createdAt', headerName: 'Opened', width: 120, renderCell: p => <Box sx={{ color: 'text.secondary' }}><RelativeTime iso={p.row.createdAt} /></Box> },
    { field: 'updatedAt', headerName: 'Updated', width: 120, renderCell: p => <Box sx={{ color: 'text.secondary' }}><RelativeTime iso={p.row.updatedAt} /></Box> },
  ];

  return (
    <Stack spacing={2} sx={{ height: FILL_HEIGHT, minHeight: 600 }}>
      <PageHeader />
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
        <ToggleButtonGroup size="small" exclusive value={show} aria-label="Show incidents"
          onChange={(_, v) => v && setParams(p => { const n = new URLSearchParams(p); if (v === 'all') n.set('show', 'all'); else n.delete('show'); return n; }, { replace: true })}>
          <ToggleButton value="open">Open · {fmtNum(openCount)}</ToggleButton>
          <ToggleButton value="all">All · {fmtNum(incidents.data?.length ?? 0)}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper' }}>
        {incidents.isError ? <QueryError error={incidents.error} onRetry={() => void incidents.refetch()} /> : (
          <DataGrid
            rows={rows}
            columns={columns}
            loading={incidents.isLoading}
            rowHeight={56}
            columnHeaderHeight={40}
            disableColumnMenu
            onRowClick={p => navigate(`/incidents/${encodeURIComponent(p.row.id)}`)}
            initialState={{ sorting: { sortModel: [{ field: 'updatedAt', sort: 'desc' }] }, pagination: { paginationModel: { pageSize: 50 } } }}
            pageSizeOptions={[50, 100]}
            slots={{ noRowsOverlay: () => <EmptyState icon={<HealthAndSafetyOutlinedIcon />} title={show === 'open' ? 'No open incidents' : 'No incidents'} body="The Guardian opens incidents for deny bursts, tainted sessions attempting risky actions, drift and runaway agents." /> }}
            slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
            sx={{ height: '100%' }}
          />
        )}
      </Box>
    </Stack>
  );
}
