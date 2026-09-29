import { Box, Skeleton, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import type { Decision } from '../../api/governance';
import { Ellipsis, RelativeTime } from '../Primitives';
import { VerdictChip } from './GovChips';

/** Compact decisions table; rows open the decision drawer (click or Enter). */
export function DecisionsTable({ rows, loading, onOpen, empty = 'No decisions', dense }: {
  rows: Decision[]; loading?: boolean; onOpen: (d: Decision) => void; empty?: string; dense?: boolean;
}) {
  if (loading) return <Box>{[0, 1, 2, 3].map(i => <Skeleton key={i} height={36} />)}</Box>;
  if (!rows.length) return <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{empty}</Typography>;
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Decisions">
        <TableHead>
          <TableRow>
            <TableCell>Time</TableCell>
            <TableCell>Verdict</TableCell>
            <TableCell>Tool</TableCell>
            <TableCell>Reason</TableCell>
            {!dense && <TableCell>Agent</TableCell>}
            {!dense && <TableCell>Lane</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(d => (
            <TableRow
              key={d.id}
              hover
              tabIndex={0}
              onClick={() => onOpen(d)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(d); } }}
              sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
              aria-label={`Decision ${d.verdict} ${d.toolName ?? ''}`}
            >
              <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}><RelativeTime iso={d.createdAt} /></TableCell>
              <TableCell><VerdictChip verdict={d.verdict} wouldDeny={d.wouldDeny} size="tiny" /></TableCell>
              <TableCell sx={{ maxWidth: 160 }}><Ellipsis text={d.toolName ?? d.checkpoint} mono sx={{ fontSize: 12, display: 'block' }} /></TableCell>
              <TableCell sx={{ maxWidth: 320 }}><Ellipsis text={d.reason} sx={{ display: 'block' }} /></TableCell>
              {!dense && <TableCell sx={{ maxWidth: 140 }}><Ellipsis text={d.agentId} sx={{ display: 'block' }} /></TableCell>}
              {!dense && <TableCell sx={{ whiteSpace: 'nowrap', fontFamily: 'var(--am-mono)', fontSize: 12 }}>{d.laneId}@v{d.laneVersion}</TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}
