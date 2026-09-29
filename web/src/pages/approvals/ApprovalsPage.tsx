import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Link as MuiLink, Skeleton, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme,
} from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import HourglassEmptyRoundedIcon from '@mui/icons-material/HourglassEmptyRounded';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { errorMessage, useAllApprovals, usePendingApprovals, useResolveApproval, type Approval } from '../../api/governance';
import { useLiveStatus } from '../../api/live';
import { useCan } from '../../auth/context';
import { EmptyState, SectionCard } from '../../components/Common';
import { QueryError, RoleButton } from '../../components/gov/GovCommon';
import { ApprovalStateChip } from '../../components/gov/GovChips';
import { RelativeTime } from '../../components/Primitives';
import { fmtCountdown, useNow } from '../../lib/useNow';

type Action = 'approve' | 'deny';

function Countdown({ expiresAt }: { expiresAt: string }) {
  const now = useNow(1000);
  const t = useTheme().tokens;
  const left = Date.parse(expiresAt) - now;
  const label = fmtCountdown(expiresAt, now);
  const urgent = left < 60_000;
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', color: left <= 0 ? 'text.disabled' : urgent ? t.severity.critical.fg : 'text.secondary' }} aria-label={left <= 0 ? 'Expired' : `Expires in ${label}`}>
      <HourglassEmptyRoundedIcon sx={{ fontSize: 15 }} />
      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: urgent ? 600 : 500, color: 'inherit' }}>{left <= 0 ? 'Expired' : label}</Typography>
    </Stack>
  );
}

/** Explicit confirmation for approve/deny. Nothing is sent until the user clicks the confirm button. */
export function ApprovalDialog({ approval, action: initialAction, open, onClose, missing }: {
  approval: Approval | null; action: Action; open: boolean; onClose: () => void; missing?: boolean;
}) {
  const [action, setAction] = useState<Action>(initialAction);
  const [note, setNote] = useState('');
  const resolve = useResolveApproval();
  const now = useNow(1000);
  const canApprove = useCan('Approver');
  useEffect(() => { if (open) { setAction(initialAction); setNote(''); resolve.reset(); } }, [open, initialAction, approval?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const expired = !!approval && Date.parse(approval.expiresAt) <= now;
  const resolved = !!approval && approval.state !== 'pending';
  const done = resolve.isSuccess;

  return (
    <Dialog open={open} onClose={resolve.isPending ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="approval-dialog-title">
      <DialogTitle id="approval-dialog-title">{action === 'approve' ? 'Approve this action?' : 'Deny this action?'}</DialogTitle>
      <DialogContent>
        {!approval ? (
          missing ? <Alert severity="warning">This approval request was not found. It may have expired or been resolved elsewhere.</Alert>
            : <Stack spacing={1}><Skeleton width="70%" /><Skeleton variant="rounded" height={60} /></Stack>
        ) : (
          <Stack spacing={1.5}>
            <Box sx={{ p: 1.5, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>{approval.summary}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{approval.reason}</Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', rowGap: 0.5, alignItems: 'center' }}>
                {approval.toolName && <Chip size="small" variant="outlined" label={approval.toolName} sx={{ fontFamily: 'var(--am-mono)' }} />}
                <Typography variant="caption">Agent {approval.agentId} · lane {approval.laneId}</Typography>
                <Box sx={{ flex: 1 }} />
                {!resolved && <Countdown expiresAt={approval.expiresAt} />}
              </Stack>
            </Box>
            {resolved || done ? (
              <Alert severity={(done ? resolve.data?.state : approval.state) === 'approved' ? 'success' : 'info'} role="status">
                {done ? `Action ${resolve.data?.state ?? (action === 'approve' ? 'approved' : 'denied')}.` : `Already ${approval.state}${approval.resolvedBy ? ` by ${approval.resolvedBy}` : ''}.`}
              </Alert>
            ) : expired ? (
              <Alert severity="warning">This request has expired; the lane’s fail mode applied.</Alert>
            ) : (
              <>
                <ToggleButtonGroup exclusive size="small" value={action} onChange={(_, v) => v && setAction(v)} aria-label="Decision">
                  <ToggleButton value="approve"><CheckRoundedIcon sx={{ fontSize: 16, mr: 0.5 }} />Approve</ToggleButton>
                  <ToggleButton value="deny"><CloseRoundedIcon sx={{ fontSize: 16, mr: 0.5 }} />Deny</ToggleButton>
                </ToggleButtonGroup>
                <TextField label="Note (optional)" value={note} onChange={e => setNote(e.target.value)} multiline minRows={2} fullWidth />
              </>
            )}
            {!canApprove && !resolved && <Alert severity="info">You need the Approver role to resolve approvals.</Alert>}
            {resolve.isError && <Alert severity="error" role="alert">{errorMessage(resolve.error)}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={resolve.isPending}>{done || resolved ? 'Close' : 'Cancel'}</Button>
        {approval && !resolved && !done && !expired && (
          <RoleButton
            roles={['Approver']}
            variant="contained"
            color={action === 'approve' ? 'primary' : 'error'}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ id: approval.id, action, note: note.trim() || undefined })}
          >
            {resolve.isPending ? 'Sending…' : action === 'approve' ? 'Confirm approve' : 'Confirm deny'}
          </RoleButton>
        )}
      </DialogActions>
    </Dialog>
  );
}

function ApprovalCard({ a, onAct, index }: { a: Approval; onAct: (a: Approval, action: Action) => void; index: number }) {
  return (
    <Card sx={{ p: 2, animation: `am-fade-up 360ms ${Math.min(index, 8) * 40}ms both cubic-bezier(0.05, 0.7, 0.1, 1)` }} component="article" aria-label={`Approval request: ${a.summary}`}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ alignItems: { md: 'center' } }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            {a.toolName && <Chip size="small" variant="outlined" label={a.toolName} sx={{ fontFamily: 'var(--am-mono)' }} />}
            <Typography variant="subtitle2" sx={{ minWidth: 0, wordBreak: 'break-word' }}>{a.summary}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{a.reason}</Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 0.75, alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <Typography variant="caption">Agent <b>{a.agentId}</b></Typography>
            <Typography variant="caption">· Lane <MuiLink component={RouterLink} to={`/lanes/${encodeURIComponent(a.laneId)}`}>{a.laneId}</MuiLink></Typography>
            <Typography variant="caption">· <MuiLink component={RouterLink} to={`/conversations?c=${encodeURIComponent(a.sessionId)}`}>Conversation</MuiLink></Typography>
            <Typography variant="caption">· Requested <RelativeTime iso={a.requestedAt} /></Typography>
            {a.channels.map(c => <Chip key={c} size="small" variant="outlined" label={c} sx={{ height: 18, fontSize: 10.5 }} />)}
          </Stack>
        </Box>
        <Countdown expiresAt={a.expiresAt} />
        <Stack direction="row" spacing={1}>
          <RoleButton roles={['Approver']} size="small" variant="outlined" color="error" startIcon={<CloseRoundedIcon />} onClick={() => onAct(a, 'deny')} aria-label={`Deny ${a.summary}`}>Deny</RoleButton>
          <RoleButton roles={['Approver']} size="small" variant="contained" startIcon={<CheckRoundedIcon />} onClick={() => onAct(a, 'approve')} aria-label={`Approve ${a.summary}`}>Approve</RoleButton>
        </Stack>
      </Stack>
    </Card>
  );
}

export function ApprovalsPage() {
  const live = useLiveStatus() === 'live';
  // WebSocket gov.approval messages keep the queue fresh; poll faster when the socket is down.
  const pending = usePendingApprovals(live ? 30_000 : 5_000);
  const [params, setParams] = useSearchParams();
  const [history, setHistory] = useState(false);
  const deepId = params.get('id');
  const deepAction: Action = params.get('action') === 'deny' ? 'deny' : 'approve';
  const inPending = pending.data?.find(a => a.id === deepId) ?? null;
  const all = useAllApprovals(history || (!!deepId && pending.isSuccess && !inPending));
  const found = inPending ?? all.data?.find(a => a.id === deepId) ?? null;
  // Keep showing the request after it's resolved (it drops out of the pending list).
  const last = useRef<Approval | null>(null);
  if (found) last.current = found;
  const target = found ?? (last.current?.id === deepId ? last.current : null);
  const missing = !!deepId && !target && pending.isSuccess && (all.isSuccess || all.isError);

  const openDialog = (a: Approval, action: Action) => setParams(p => { const n = new URLSearchParams(p); n.set('id', a.id); n.set('action', action); return n; });
  const closeDialog = () => setParams(p => { const n = new URLSearchParams(p); n.delete('id'); n.delete('action'); return n; }, { replace: true });

  const sorted = useMemo(() => [...(pending.data ?? [])].sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)), [pending.data]);
  const resolved = useMemo(() => (all.data ?? []).filter(a => a.state !== 'pending').sort((a, b) => (b.resolvedAt ?? b.requestedAt).localeCompare(a.resolvedAt ?? a.requestedAt)).slice(0, 50), [all.data]);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Typography variant="h5" component="h2" sx={{ flex: 1 }}>Approvals</Typography>
        <Tooltip title={live ? 'Live updates via WebSocket' : 'Live updates unavailable — polling every 5s'}>
          <Typography variant="caption">{live ? 'Live' : 'Polling'}</Typography>
        </Tooltip>
        <Button size="small" variant="outlined" onClick={() => setHistory(h => !h)} aria-pressed={history}>{history ? 'Hide history' : 'Show history'}</Button>
      </Stack>

      {pending.isError ? <QueryError error={pending.error} onRetry={() => void pending.refetch()} />
        : pending.isLoading ? <Stack spacing={1}>{[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={96} />)}</Stack>
        : sorted.length === 0 ? (
          <EmptyState icon={<TaskAltRoundedIcon />} title="No pending approvals" body="Actions that a lane routes to a human show up here, soonest to expire first. Teams cards link straight to their request." />
        ) : (
          <Stack spacing={1.25} aria-live="polite" aria-label="Pending approvals">
            {sorted.map((a, i) => <ApprovalCard key={a.id} a={a} index={i} onAct={openDialog} />)}
          </Stack>
        )}

      {history && (
        <SectionCard title="Recently resolved" subtitle="Last 50 approvals">
          {all.isLoading ? <Skeleton variant="rounded" height={80} /> : resolved.length === 0 ? <Typography variant="body2" color="text.secondary">Nothing resolved yet.</Typography> : (
            <Stack spacing={0.75}>
              {resolved.map(a => (
                <Stack key={a.id} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <ApprovalStateChip state={a.state} />
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>{a.summary}</Typography>
                  <Typography variant="caption" noWrap>{a.resolvedBy ?? ''}</Typography>
                  <Typography variant="caption"><RelativeTime iso={a.resolvedAt ?? a.requestedAt} /></Typography>
                </Stack>
              ))}
            </Stack>
          )}
        </SectionCard>
      )}

      <ApprovalDialog open={!!deepId} approval={target} action={deepAction} onClose={closeDialog} missing={missing} />
    </Stack>
  );
}
