import { Box, Stack, Typography } from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import { useNavigate } from 'react-router-dom';
import type { AgentRow } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { InfoTip } from '../../components/Primitives';
import { fmtNum } from '../../lib/format';

const header = (label: string, info?: string) => () => (
  <Box sx={{ display: 'flex', alignItems: 'center', fontWeight: 500, color: 'text.secondary', fontSize: 12 }}>
    {label}{info && <InfoTip title={info} />}
  </Box>
);

const num = (field: keyof AgentRow, label: string, info?: string, warm = false): GridColDef<AgentRow> => ({
  field, headerName: label, type: 'number', flex: 0.7, minWidth: 110, headerAlign: 'left', align: 'left',
  renderHeader: header(label, info),
  renderCell: p => (
    <Box component="span" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500, color: warm && Number(p.value) > 0 ? 'primary.main' : 'text.primary' }}>
      {fmtNum(Number(p.value))}
    </Box>
  ),
});

export function TopAgentsTable({ rows, loading, rangeParam }: { rows: AgentRow[]; loading: boolean; rangeParam: string }) {
  const navigate = useNavigate();
  const columns: GridColDef<AgentRow>[] = [
    {
      field: 'agentName', headerName: 'Agent', flex: 1.6, minWidth: 200, renderHeader: header('Agent'),
      renderCell: p => (
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'center', minWidth: 0 }}>
          <AgentAvatar agentKey={p.row.agentKey} size={28} />
          <Box sx={{ minWidth: 0, lineHeight: 1.3 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>{p.row.agentName}</Typography>
            <Typography variant="caption" noWrap component="div">{p.row.agentKind}</Typography>
          </Box>
        </Stack>
      ),
    },
    num('actions', 'Actions', 'Tool calls made by the agent in this period'),
    num('sessions', 'Sessions'),
    num('riskyActions', 'Risky actions', 'Tool calls matching a high or critical risk rule', true),
    num('detectors', 'Detectors', 'Distinct kinds of sensitive data detected'),
    num('mcps', 'MCPs', 'Distinct MCP servers called'),
    num('domains', 'Domains', 'Distinct external domains contacted'),
    num('enforcedEndpoints', 'Enforced endpoints', 'Endpoints where a tool call was blocked, denied or warned'),
  ];

  return (
    <>
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          getRowId={r => r.agentKey}
          loading={loading && !rows.length}
          rowHeight={56}
          columnHeaderHeight={40}
          hideFooter
          disableColumnMenu
          disableRowSelectionOnClick
          autoHeight
          onRowClick={p => navigate(`/conversations?${rangeParam}agent=${p.row.agentKey}`)}
          slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
          localeText={{ noRowsLabel: 'No agent activity in this period' }}
          sx={{ '& .MuiDataGrid-virtualScroller': { minHeight: rows.length ? undefined : 112 } }}
        />
      </Box>
      <Typography variant="caption" sx={{ display: 'block', mt: 1.25 }}>{rows.length} {rows.length === 1 ? 'row' : 'rows'}</Typography>
    </>
  );
}
