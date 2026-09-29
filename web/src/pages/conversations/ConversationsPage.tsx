import { useEffect, useMemo, useState } from 'react';
import { Box, Checkbox, IconButton, InputAdornment, ListItemText, Menu, MenuItem, Stack, TextField, Tooltip } from '@mui/material';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import { DataGrid, type GridColumnVisibilityModel, type GridRowSelectionModel } from '@mui/x-data-grid';
import { useSearchParams } from 'react-router-dom';
import { exportUrl, useConversations } from '../../api/client';
import { useFlashIds } from '../../api/live';
import type { Conversation } from '../../api/types';
import { EmptyState, ExportMenu, TimeRangePicker, downloadText } from '../../components/Common';
import { applyFilters, useFilters } from '../../lib/filters';
import { rangeBounds, useRangeKey } from '../../lib/range';
import { fmtNum } from '../../lib/format';
import { FilterBar } from './FilterBar';
import { conversationColumns } from './columns';
import { ConversationDrawer } from '../conversation/ConversationDrawer';

const VIS_KEY = 'am-conv-columns';

function toCsv(rows: Conversation[]): string {
  const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ['id', 'title', 'agent', 'endpoint', 'user', 'severity', 'severity_reasons', 'autonomy', 'data', 'prompts', 'actions', 'built_in', 'mcp', 'risky_actions', 'denied', 'blocked', 'warned', 'channels', 'started_at', 'last_activity_at'];
  const lines = rows.map(r => [r.id, r.title, r.agentName, r.endpoint, r.user, r.severity, r.severityReasons.join('; '), r.autonomyLabel, r.detectors.map(d => d.label).join('; '),
    r.prompts, r.actions, r.builtin, r.mcp, r.riskyActions, r.enforcement.denied, r.enforcement.blocked, r.enforcement.warned, r.channels.join(' '), r.startedAt, r.lastActivityAt].map(cell).join(','));
  return [head.join(','), ...lines].join('\r\n');
}

export function ConversationsPage() {
  const [range] = useRangeKey();
  const [params, setParams] = useSearchParams();
  const [filters, setFilter] = useFilters();
  const { data, isLoading } = useConversations(range);
  const flash = useFlashIds();
  const selectedId = params.get('c');
  const [search, setSearch] = useState(filters.q ?? '');
  const [colAnchor, setColAnchor] = useState<HTMLElement | null>(null);
  const [visibility, setVisibility] = useState<GridColumnVisibilityModel>(() => {
    try { return JSON.parse(localStorage.getItem(VIS_KEY) ?? '{}'); } catch { return {}; }
  });

  useEffect(() => {
    const id = setTimeout(() => { if ((filters.q ?? '') !== search) setFilter('q', search || null); }, 250);
    return () => clearTimeout(id);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const columns = useMemo(() => conversationColumns(), []);
  const all = data ?? [];
  const rows = useMemo(() => applyFilters(all, filters), [all, filters]);

  const open = (id: string | null) => setParams(p => {
    const n = new URLSearchParams(p);
    if (id) n.set('c', id); else n.delete('c');
    return n;
  });

  const selection: GridRowSelectionModel = { type: 'include', ids: new Set(selectedId ? [selectedId] : []) };
  const bounds = rangeBounds(range);

  return (
    <Stack spacing={2} sx={{ height: 'calc(100vh - 140px)', minHeight: 480 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <FilterBar filters={filters} rows={all} onChange={(f, v) => setFilter(f, v)} />
        <TimeRangePicker />
        <Box sx={{ flex: 1 }} />
        <TextField
          size="small"
          placeholder="Search conversations…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          sx={{ width: { xs: '100%', sm: 280 } }}
          slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 18 }} /></InputAdornment> } }}
        />
        <Tooltip title="Columns">
          <IconButton aria-label="Choose columns" onClick={e => setColAnchor(e.currentTarget)}><ViewColumnOutlinedIcon fontSize="small" /></IconButton>
        </Tooltip>
        <Menu anchorEl={colAnchor} open={!!colAnchor} onClose={() => setColAnchor(null)}>
          {columns.filter(c => c.field !== 'title').map(c => (
            <MenuItem
              key={c.field}
              dense
              onClick={() => {
                const next = { ...visibility, [c.field]: visibility[c.field] === false };
                setVisibility(next);
                localStorage.setItem(VIS_KEY, JSON.stringify(next));
              }}
            >
              <Checkbox size="small" checked={visibility[c.field] !== false} sx={{ p: 0.5, mr: 1 }} />
              <ListItemText primary={c.headerName} />
            </MenuItem>
          ))}
        </Menu>
        <ExportMenu options={[
          { label: 'Conversations (CSV)', hint: `${fmtNum(rows.length)} rows as filtered`, onClick: () => downloadText(`conversations-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows)) },
          { label: 'Activity log (CSV)', hint: 'Every event in this period', href: exportUrl('export', { ...bounds, agent: filters.agent?.join(','), format: 'csv' }) },
          { label: 'Activity log (JSON Lines)', href: exportUrl('export', { ...bounds, agent: filters.agent?.join(','), format: 'jsonl' }) },
        ]} />
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper', animation: 'am-fade-up 380ms 60ms both cubic-bezier(0.05,0.7,0.1,1)' }}>
        <DataGrid
          rows={rows}
          columns={columns}
          loading={isLoading}
          rowHeight={60}
          columnHeaderHeight={40}
          disableColumnMenu
          columnVisibilityModel={visibility}
          onColumnVisibilityModelChange={m => { setVisibility(m); localStorage.setItem(VIS_KEY, JSON.stringify(m)); }}
          initialState={{ sorting: { sortModel: [{ field: 'lastActivityAt', sort: 'desc' }] }, pagination: { paginationModel: { pageSize: 100 } } }}
          pageSizeOptions={[50, 100, 250]}
          rowSelectionModel={selection}
          onRowClick={p => open(String(p.id))}
          getRowClassName={p => (flash.has(String(p.id)) ? 'am-flash' : '')}
          slots={{
            noRowsOverlay: () => (
              <EmptyState
                icon={<ForumOutlinedIcon />}
                title={all.length ? 'No conversations match' : 'No conversations yet'}
                body={all.length ? 'Try removing a filter or widening the time range.' : 'Agent sessions appear here as soon as a source reports activity. Open Sources (top right) to connect one.'}
              />
            ),
          }}
          slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
          onCellKeyDown={(p, e) => { if (e.key === 'Enter') open(String(p.id)); }}
          sx={{ height: '100%' }}
        />
      </Box>


      <ConversationDrawer id={selectedId} onClose={() => open(null)} />
    </Stack>
  );
}
