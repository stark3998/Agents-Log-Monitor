import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, IconButton, InputLabel, ListItemIcon, ListItemText,
  Menu, MenuItem, Select, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { DataGrid, type GridColDef } from '@mui/x-data-grid';
import PauseCircleOutlineRoundedIcon from '@mui/icons-material/PauseCircleOutlineRounded';
import PlayCircleOutlineRoundedIcon from '@mui/icons-material/PlayCircleOutlineRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import MoreVertRoundedIcon from '@mui/icons-material/MoreVertRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Link as RouterLink, useNavigate, useSearchParams } from 'react-router-dom';
import {
  draftLane, errorMessage, useAgentStatus, useGovAgents, useLanes, usePatchAgent, type AgentAction, type GovAgentRow,
} from '../../api/governance';
import { useCan } from '../../auth/context';
import { AgentAvatar } from '../../components/AgentAvatar';
import { EmptyState } from '../../components/Common';
import { QueryError, ReasonDialog, RoleIconButton } from '../../components/gov/GovCommon';
import { AgentStatusChip } from '../../components/gov/GovChips';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { fmtNum } from '../../lib/format';
import { PageHeader } from '../../components/PageHeader';
import { FILL_HEIGHT } from '../../components/layout';

const STATUS_COPY: Record<AgentAction, { title: string; body: string; confirm: string }> = {
  pause: { title: 'Pause agent', body: 'Kill switch: every tool call from this agent is denied until it is resumed. Running sessions stop at their next action.', confirm: 'Pause agent' },
  quarantine: { title: 'Quarantine agent', body: 'Isolate this agent: all actions are denied, it is flagged for investigation and resuming requires a PolicyAdmin.', confirm: 'Quarantine' },
  resume: { title: 'Resume agent', body: 'Tool calls are evaluated against the agent’s lane again.', confirm: 'Resume' },
};

function EditAgentDialog({ agent, onClose }: { agent: GovAgentRow | null; onClose: () => void }) {
  const lanes = useLanes();
  const patch = usePatchAgent();
  const [form, setForm] = useState({ name: '', owner: '', purpose: '', laneId: '' });
  useEffect(() => {
    if (agent) setForm({ name: agent.name, owner: agent.owner ?? '', purpose: agent.purpose ?? '', laneId: agent.laneId ?? '' });
    patch.reset();
  }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps
  const laneIds = useMemo(() => [...new Set((lanes.data ?? []).filter(l => l.status !== 'archived').map(l => l.lane.id))].sort(), [lanes.data]);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open={!!agent} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="edit-agent-title">
      <DialogTitle id="edit-agent-title">Edit agent</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={form.name} onChange={set('name')} fullWidth />
          <TextField label="Owner" value={form.owner} onChange={set('owner')} placeholder="team or person accountable (e.g. alice@contoso.com)" fullWidth />
          <TextField label="Purpose" value={form.purpose} onChange={set('purpose')} multiline minRows={2} fullWidth />
          <FormControl fullWidth>
            <InputLabel id="agent-lane">Lane</InputLabel>
            <Select labelId="agent-lane" label="Lane" value={form.laneId} onChange={set('laneId')}>
              <MenuItem value=""><em>Resolve by lane “appliesTo”</em></MenuItem>
              {laneIds.map(id => <MenuItem key={id} value={id}>{id}</MenuItem>)}
              {form.laneId && !laneIds.includes(form.laneId) && <MenuItem value={form.laneId}>{form.laneId}</MenuItem>}
            </Select>
          </FormControl>
          {patch.isError && <Alert severity="error" role="alert">{errorMessage(patch.error)}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={patch.isPending || !form.name.trim()}
          onClick={() => agent && patch.mutate({ id: agent.id, patch: { name: form.name.trim(), owner: form.owner.trim(), purpose: form.purpose.trim(), laneId: form.laneId } }, { onSuccess: onClose })}
        >
          {patch.isPending ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DraftLaneDialog({ agent, onClose }: { agent: GovAgentRow | null; onClose: () => void }) {
  const navigate = useNavigate();
  const [description, setDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (agent) { setDescription(agent.purpose ?? ''); setSystemPrompt(''); setError(null); setBusy(false); } }, [agent]);
  const run = async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      const res = await draftLane({ agentId: agent.id, description: description.trim() || undefined, systemPrompt: systemPrompt.trim() || undefined });
      navigate(`/lanes/${encodeURIComponent(res.lane.lane.id)}?version=${res.lane.lane.version}`, { state: { draft: res } });
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!agent} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="draft-lane-title">
      <DialogTitle id="draft-lane-title">Draft a lane with AI</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The lane drafter combines this description with {agent?.name ?? 'the agent'}’s observed behaviour and proposes a lane. It is never activated automatically — you review it in the lane editor.
        </Typography>
        <Stack spacing={2}>
          <TextField label="What does this agent do?" value={description} onChange={e => setDescription(e.target.value)} multiline minRows={2} fullWidth />
          <TextField label="System prompt (optional)" value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} multiline minRows={3} fullWidth slotProps={{ htmlInput: { style: { fontFamily: 'var(--am-mono)', fontSize: 12 } } }} />
          {error && <Alert severity="error" role="alert">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" startIcon={<AutoAwesomeOutlinedIcon />} disabled={busy} onClick={() => void run()}>{busy ? 'Drafting…' : 'Draft lane'}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function AgentsPage() {
  const agents = useGovAgents();
  const status = useAgentStatus();
  const [params, setParams] = useSearchParams();
  const filter = params.get('status') === 'stopped' ? 'stopped' : params.get('status') === 'active' ? 'active' : 'all';
  const focus = params.get('id');
  const isAdmin = useCan('PolicyAdmin');
  const [pending, setPending] = useState<{ agent: GovAgentRow; action: AgentAction } | null>(null);
  const [editing, setEditing] = useState<GovAgentRow | null>(null);
  const [drafting, setDrafting] = useState<GovAgentRow | null>(null);
  const [menu, setMenu] = useState<{ el: HTMLElement; agent: GovAgentRow } | null>(null);

  const rows = useMemo(() => (agents.data ?? []).filter(a =>
    filter === 'all' ? true : filter === 'active' ? a.status === 'active' : a.status === 'paused' || a.status === 'quarantined'), [agents.data, filter]);

  const columns: GridColDef<GovAgentRow>[] = [
    {
      field: 'name', headerName: 'Agent', flex: 1.4, minWidth: 200,
      renderCell: p => (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <AgentAvatar agentKey={p.row.surface} size={22} />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{p.row.name}</Typography>
            {p.row.purpose && <Typography variant="caption" noWrap component="div">{p.row.purpose}</Typography>}
          </Box>
        </Stack>
      ),
    },
    { field: 'surface', headerName: 'Surface', width: 130 },
    { field: 'owner', headerName: 'Owner', width: 170, renderCell: p => <Ellipsis text={p.row.owner} /> },
    {
      field: 'laneId', headerName: 'Lane', width: 150,
      renderCell: p => (p.row.laneId
        ? <Box component={RouterLink} to={`/lanes/${encodeURIComponent(p.row.laneId)}`} onClick={e => e.stopPropagation()} sx={{ color: 'primary.main', fontFamily: 'var(--am-mono)', fontSize: 12 }}>{p.row.laneId}</Box>
        : <Typography variant="caption">auto</Typography>),
    },
    {
      field: 'status', headerName: 'Status', width: 130,
      renderCell: p => <Tooltip title={p.row.statusReason ?? ''}><span><AgentStatusChip status={p.row.status} /></span></Tooltip>,
    },
    { field: 'lastSeen', headerName: 'Last seen', width: 110, valueGetter: (_v, r) => r.stats?.lastSeenAt ?? r.lastSeenAt, renderCell: p => <Box sx={{ color: 'text.secondary' }}><RelativeTime iso={p.row.stats?.lastSeenAt ?? p.row.lastSeenAt} /></Box> },
    { field: 'decisions', headerName: 'Decisions', width: 100, type: 'number', valueGetter: (_v, r) => r.stats?.decisions ?? 0, valueFormatter: (v: number) => fmtNum(v) },
    {
      field: 'denies', headerName: 'Denies', width: 90, type: 'number', valueGetter: (_v, r) => r.stats?.denies ?? 0,
      renderCell: p => <Box component={RouterLink} to={`/enforcements?agent=${encodeURIComponent(p.row.id)}&verdict=deny`} onClick={e => e.stopPropagation()} sx={{ color: (p.row.stats?.denies ?? 0) > 0 ? 'error.main' : 'text.secondary', textDecoration: 'none', fontVariantNumeric: 'tabular-nums' }}>{fmtNum(p.row.stats?.denies ?? 0)}</Box>,
    },
    {
      field: 'actions', headerName: '', width: 130, sortable: false, align: 'right',
      renderCell: p => {
        const a = p.row;
        const stopped = a.status === 'paused' || a.status === 'quarantined';
        return (
          <Stack direction="row" spacing={0.25} onClick={e => e.stopPropagation()}>
            {stopped
              ? <RoleIconButton roles={['PolicyAdmin']} title={`Resume ${a.name}`} onClick={() => setPending({ agent: a, action: 'resume' })}><PlayCircleOutlineRoundedIcon fontSize="small" /></RoleIconButton>
              : <RoleIconButton roles={['PolicyAdmin']} title={`Kill switch: pause ${a.name}`} onClick={() => setPending({ agent: a, action: 'pause' })}><PauseCircleOutlineRoundedIcon fontSize="small" /></RoleIconButton>}
            <RoleIconButton roles={['PolicyAdmin']} title={`Quarantine ${a.name}`} disabled={a.status === 'quarantined'} onClick={() => setPending({ agent: a, action: 'quarantine' })}><BlockRoundedIcon fontSize="small" /></RoleIconButton>
            <Tooltip title="More actions">
              <IconButton size="small" aria-label={`More actions for ${a.name}`} aria-haspopup="menu" onClick={e => setMenu({ el: e.currentTarget, agent: a })}><MoreVertRoundedIcon fontSize="small" /></IconButton>
            </Tooltip>
          </Stack>
        );
      },
    },
  ];

  return (
    <Stack spacing={2} sx={{ height: FILL_HEIGHT, minHeight: 600 }}>
      <PageHeader />
      <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
        <ToggleButtonGroup size="small" exclusive value={filter} aria-label="Filter by status"
          onChange={(_, v) => v && setParams(p => { const n = new URLSearchParams(p); if (v === 'all') n.delete('status'); else n.set('status', v); return n; }, { replace: true })}>
          <ToggleButton value="all">All · {fmtNum(agents.data?.length ?? 0)}</ToggleButton>
          <ToggleButton value="active">Active</ToggleButton>
          <ToggleButton value="stopped">Paused / quarantined</ToggleButton>
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        {!isAdmin && <Typography variant="caption">Read-only: PolicyAdmin role required to change agents.</Typography>}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, border: '1px solid', borderColor: 'divider', borderRadius: 3, overflow: 'hidden', bgcolor: 'background.paper' }}>
        {agents.isError ? <QueryError error={agents.error} onRetry={() => void agents.refetch()} /> : (
          <DataGrid
            rows={rows}
            columns={columns}
            loading={agents.isLoading}
            rowHeight={54}
            columnHeaderHeight={40}
            disableColumnMenu
            disableRowSelectionOnClick
            getRowClassName={p => (p.row.id === focus ? 'Mui-selected' : '')}
            initialState={{ sorting: { sortModel: [{ field: 'lastSeen', sort: 'desc' }] }, pagination: { paginationModel: { pageSize: 100 } } }}
            pageSizeOptions={[50, 100]}
            slots={{ noRowsOverlay: () => <EmptyState icon={<SmartToyOutlinedIcon />} title="No agents registered" body="Agents are discovered automatically the first time an enforcement point sees them." /> }}
            slotProps={{ loadingOverlay: { variant: 'skeleton', noRowsVariant: 'skeleton' } }}
            sx={{ height: '100%' }}
          />
        )}
      </Box>

      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        <MenuItem disabled={!isAdmin} onClick={() => { setEditing(menu!.agent); setMenu(null); }}>
          <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Edit owner, purpose & lane" secondary={isAdmin ? undefined : 'Requires PolicyAdmin'} />
        </MenuItem>
        <MenuItem onClick={() => { setDrafting(menu!.agent); setMenu(null); }}>
          <ListItemIcon><AutoAwesomeOutlinedIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="Draft lane with AI" secondary="Creates a proposal for review" />
        </MenuItem>
        <MenuItem component={RouterLink} to={`/enforcements?agent=${encodeURIComponent(menu?.agent.id ?? '')}`} onClick={() => setMenu(null)}>
          <ListItemText inset primary="View decisions" />
        </MenuItem>
      </Menu>

      <ReasonDialog
        open={!!pending}
        title={pending ? `${STATUS_COPY[pending.action].title}: ${pending.agent.name}` : ''}
        body={pending ? STATUS_COPY[pending.action].body : undefined}
        confirmLabel={pending ? STATUS_COPY[pending.action].confirm : ''}
        danger={pending?.action !== 'resume'}
        onClose={() => setPending(null)}
        onConfirm={reason => status.mutateAsync({ id: pending!.agent.id, action: pending!.action, reason })}
      />
      <EditAgentDialog agent={editing} onClose={() => setEditing(null)} />
      <DraftLaneDialog agent={drafting} onClose={() => setDrafting(null)} />
    </Stack>
  );
}
