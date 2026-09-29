import { useMemo, useState } from 'react';
import { Box, Stack, ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme } from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import GppGoodOutlinedIcon from '@mui/icons-material/GppGoodOutlined';
import { useSearchParams } from 'react-router-dom';
import { useEnforcements } from '../../api/client';
import type { EnforcementRow } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { ChannelBadge, ToneChip } from '../../components/Chips';
import { EmptyState, TimeRangePicker } from '../../components/Common';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { useRangeKey } from '../../lib/range';
import { cleanTitle, fmtNum } from '../../lib/format';
import { ConversationDrawer } from '../conversation/ConversationDrawer';

type Outcome = EnforcementRow['outcome'];
const OUTCOME_LABEL: Record<Outcome, string> = { blocked: 'Blocked', denied: 'Denied', warned: 'Warned', prompted: 'Permission prompt', approved: 'Approved' };

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  const t = useTheme().tokens;
  const tone = outcome === 'blocked' ? t.severity.critical : outcome === 'denied' ? t.severity.high : outcome === 'warned' ? t.severity.medium : outcome === 'approved' ? t.channel.hook : t.severity.info;
  return <ToneChip tone={tone} label={OUTCOME_LABEL[outcome]} />;
}

/** Agent-reported policy events (blocked / denied / warned / permission prompts) captured from logs and hooks. */
export function LegacyEnforcements() {
  const [range] = useRangeKey();
  const { data, isLoading } = useEnforcements(range);
  const [params, setParams] = useSearchParams();
  const [show, setShow] = useState<'all' | 'enforced' | 'prompts'>('all');
  const selected = params.get('c');
  const all = data ?? [];
  const rows = useMemo(() => all.filter(r =>
    show === 'all' ? true : show === 'enforced' ? ['blocked', 'denied', 'warned'].includes(r.outcome) : ['prompted', 'approved'].includes(r.outcome),
  ), [all, show]);
  const counts = useMemo(() => ({
    enforced: all.filter(r => ['blocked', 'denied', 'warned'].includes(r.outcome)).length,
    prompts: all.filter(r => ['prompted', 'approved'].includes(r.outcome)).length,
  }), [all]);

  const open = (id: string | null) => setParams(p => { const n = new URLSearchParams(p); if (id) n.set('c', id); else n.delete('c'); return n; });

  const columns: GridColDef<EnforcementRow>[] = [
    { field: 't', headerName: 'Time', width: 120, renderCell: p => <Box sx={{ color: 'text.secondary' }}><RelativeTime iso={p.row.t} /></Box>, sortComparator: (a, b) => Date.parse(a) - Date.parse(b) },
    { field: 'outcome', headerName: 'Outcome', width: 160, renderCell: p => <OutcomeChip outcome={p.row.outcome} /> },
    { field: 'label', headerName: 'Action', flex: 2, minWidth: 260, renderCell: p => <Ellipsis text={p.row.label} /> },
    { field: 'tool', headerName: 'Tool', width: 130, renderCell: p => <Ellipsis text={p.row.tool} mono sx={{ fontSize: 12 }} /> },
    {
      field: 'title', headerName: 'Conversation', flex: 1.6, minWidth: 220,
      renderCell: p => <Tooltip title={cleanTitle(p.row.title) ?? p.row.sessionId}><Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{cleanTitle(p.row.title) ?? p.row.sessionId}</Typography></Tooltip>,
    },
    {
      field: 'agentName', headerName: 'Agent', width: 150,
      renderCell: p => <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}><AgentAvatar agentKey={p.row.agentKey} size={20} /><Typography variant="body2" noWrap>{p.row.agentName}</Typography></Stack>,
    },
    { field: 'endpoint', headerName: 'Endpoint', width: 150, renderCell: p => <Ellipsis text={p.row.endpoint} /> },
    { field: 'channel', headerName: 'Channel', width: 100, renderCell: p => (p.row.channel ? <ChannelBadge channel={p.row.channel} /> : null) },
  ];

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <TimeRangePicker />
        <ToggleButtonGroup size="small" exclusive value={show} onChange={(_, v) => v && setShow(v)}>
          <ToggleButton value="all">All · {fmtNum(all.length)}</ToggleButton>
          <ToggleButton value="enforced">Blocked / denied / warned · {fmtNum(counts.enforced)}</ToggleButton>
          <ToggleButton value="prompts">Permission prompts · {fmtNum(counts.prompts)}</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" sx={{ maxWidth: 420 }}>
          Read-only: Agent Monitor records policy events reported by agents; it never blocks actions itself.
        </Typography>
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper', animation: 'am-fade-up 380ms 60ms both cubic-bezier(0.05,0.7,0.1,1)' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          loading={isLoading}
          rowHeight={48}
          columnHeaderHeight={40}
          disableColumnMenu
          initialState={{ sorting: { sortModel: [{ field: 't', sort: 'desc' }] }, pagination: { paginationModel: { pageSize: 100 } } }}
          pageSizeOptions={[50, 100, 250]}
          onRowClick={p => open(p.row.sessionId)}
          slots={{
            noRowsOverlay: () => (
              <EmptyState
                icon={<GppGoodOutlinedIcon />}
                title="No policy events"
                body="Blocked tool calls, permission denials and critical-risk warnings show up here. Nothing was flagged in this period."
              />
            ),
          }}
          slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
          sx={{ height: '100%' }}
        />
      </Box>
      <ConversationDrawer id={selected} onClose={() => open(null)} />
    </Stack>
  );
}
