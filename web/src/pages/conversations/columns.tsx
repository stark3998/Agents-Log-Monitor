import { Box, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import type { GridColDef } from '@mui/x-data-grid';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import ComputerRoundedIcon from '@mui/icons-material/ComputerRounded';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ElectricalServicesRoundedIcon from '@mui/icons-material/ElectricalServicesRounded';
import type { Conversation } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { AutonomyChip, ChannelBadge, SeverityChip, ToneChip, severityRank } from '../../components/Chips';
import { DetectorChips } from '../../components/DetectorChips';
import { Ellipsis, LiveDot, RelativeTime } from '../../components/Primitives';
import { cleanTitle, fmtNum, shortId } from '../../lib/format';

const iconSx = { fontSize: 14, color: 'text.disabled', flexShrink: 0 };

function ConversationCell({ row }: { row: Conversation }) {
  return (
    <Box sx={{ minWidth: 0, py: 1, lineHeight: 1.35 }}>
      <Tooltip title={cleanTitle(row.title) ?? ''} enterDelay={600} placement="bottom-start">
        <Typography variant="body2" noWrap sx={{ fontWeight: 600, color: 'text.primary' }}>
          {cleanTitle(row.title) ?? <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>Untitled conversation</Box>}
        </Typography>
      </Tooltip>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mt: 0.25, color: 'text.secondary', fontSize: 11.5, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        <Box component="span" sx={{ fontFamily: 'var(--am-mono)', color: 'text.disabled' }}>{shortId(row.id)}</Box>
        <span>·</span><span>{fmtNum(row.prompts)} prompts</span>
        <span>·</span><span>{fmtNum(row.actions)} actions</span>
        <span>·</span>
        <Stack component="span" direction="row" spacing={0.4} sx={{ alignItems: 'center' }}><BuildOutlinedIcon sx={{ fontSize: 12 }} /><span>{fmtNum(row.builtin)} built-in</span></Stack>
        {row.mcp > 0 && (<><span>·</span><Stack component="span" direction="row" spacing={0.4} sx={{ alignItems: 'center' }}><ElectricalServicesRoundedIcon sx={{ fontSize: 12 }} /><span>{fmtNum(row.mcp)} MCP</span></Stack></>)}
      </Stack>
    </Box>
  );
}

function EnforcementCell({ row }: { row: Conversation }) {
  const t = useTheme().tokens;
  const e = row.enforcement;
  const parts = [
    e.blocked && { label: `${e.blocked} blocked`, tone: t.severity.critical },
    e.denied && { label: `${e.denied} denied`, tone: t.severity.high },
    e.warned && { label: `${e.warned} warned`, tone: t.severity.medium },
  ].filter(Boolean) as { label: string; tone: typeof t.severity.info }[];
  if (!parts.length) {
    return e.prompted
      ? <Tooltip title="Permission prompts shown to the user"><Typography variant="caption">{e.prompted} prompt{e.prompted === 1 ? '' : 's'}</Typography></Tooltip>
      : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  }
  return <Stack direction="row" spacing={0.5}>{parts.slice(0, 2).map(p => <ToneChip key={p.label} tone={p.tone} label={p.label} />)}</Stack>;
}

export function conversationColumns(): GridColDef<Conversation>[] {
  return [
    { field: 'title', headerName: 'Conversation', flex: 1, minWidth: 280, sortable: false, renderCell: p => <ConversationCell row={p.row} /> },
    {
      field: 'agentName', headerName: 'Agent', width: 130,
      renderCell: p => (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', minWidth: 0 }}>
          <AgentAvatar agentKey={p.row.agentKey} size={20} />
          <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>{p.row.agentName}</Typography>
        </Stack>
      ),
    },
    {
      field: 'endpoint', headerName: 'Endpoint', width: 130,
      renderCell: p => <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}><ComputerRoundedIcon sx={iconSx} /><Ellipsis text={p.row.endpoint} /></Stack>,
    },
    {
      field: 'user', headerName: 'User', width: 150,
      renderCell: p => <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', minWidth: 0 }}><PersonOutlineRoundedIcon sx={iconSx} /><Ellipsis text={p.row.user} /></Stack>,
    },
    {
      field: 'severity', headerName: 'Severity', width: 96,
      sortComparator: (a, b) => severityRank(a) - severityRank(b),
      renderCell: p => <SeverityChip severity={p.row.severity} reasons={p.row.severityReasons} />,
    },
    { field: 'autonomyLevel', headerName: 'Autonomy', width: 128, renderCell: p => <AutonomyChip level={p.row.autonomyLevel} label={p.row.autonomyLabel} /> },
    {
      field: 'detectors', headerName: 'Data', width: 170,
      sortComparator: (a: Conversation['detectors'], b: Conversation['detectors']) => a.length - b.length,
      renderCell: p => <DetectorChips detectors={p.row.detectors} stacked />,
    },
    {
      field: 'enforcement', headerName: 'Enforcement', width: 110,
      valueGetter: (_v, row) => row.enforcement.blocked + row.enforcement.denied + row.enforcement.warned,
      renderCell: p => <EnforcementCell row={p.row} />,
    },
    {
      field: 'channels', headerName: 'Channel', width: 88, sortable: false,
      renderCell: p => <Stack direction="row" spacing={0.5}>{p.row.channels.map(c => <ChannelBadge key={c} channel={c} />)}</Stack>,
    },
    {
      field: 'lastActivityAt', headerName: 'Last activity', width: 110,
      sortComparator: (a, b) => Date.parse(a ?? 0) - Date.parse(b ?? 0),
      renderCell: p => (
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', color: 'text.secondary' }}>
          {p.row.live && <Tooltip title="Active in the last 5 minutes"><Box sx={{ display: 'flex' }}><LiveDot /></Box></Tooltip>}
          <RelativeTime iso={p.row.lastActivityAt} />
        </Stack>
      ),
    },
  ];
}

export const DEFAULT_HIDDEN: Record<string, boolean> = {};
