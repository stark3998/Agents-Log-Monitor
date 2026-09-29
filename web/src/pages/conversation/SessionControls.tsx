import { useState } from 'react';
import { Stack, Tooltip, Typography, useTheme } from '@mui/material';
import PauseCircleOutlineRoundedIcon from '@mui/icons-material/PauseCircleOutlineRounded';
import PlayCircleOutlineRoundedIcon from '@mui/icons-material/PlayCircleOutlineRounded';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import { useSessionAction, useSessionIntent, type AgentAction } from '../../api/governance';
import { ToneChip } from '../../components/Chips';
import { ReasonDialog, RoleButton } from '../../components/gov/GovCommon';

const COPY: Record<AgentAction, { title: string; body: string; confirm: string }> = {
  pause: { title: 'Pause this session?', body: 'Every further tool call in this session will be denied until it is resumed.', confirm: 'Pause session' },
  quarantine: { title: 'Quarantine this session?', body: 'The session is isolated: all tool calls are denied and an incident trail is kept. Use for suspected compromise.', confirm: 'Quarantine' },
  resume: { title: 'Resume this session?', body: 'Tool calls will be evaluated against the lane again.', confirm: 'Resume' },
};

/** Session kill switch (pause / quarantine / resume) + governance status for the open conversation. */
export function SessionControls({ sessionId }: { sessionId: string }) {
  const t = useTheme().tokens;
  const intent = useSessionIntent(sessionId);
  const action = useSessionAction();
  const [pending, setPending] = useState<AgentAction | null>(null);
  if (!intent.data) return null; // not governed (404) or governance disabled
  const i = intent.data;
  const stopped = i.status !== 'active';
  return (
    <>
      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mt: 1, flexWrap: 'wrap', rowGap: 0.75 }}>
        {i.status === 'paused' && <ToneChip tone={t.severity.medium} label="Session paused" />}
        {i.status === 'quarantined' && <ToneChip tone={t.severity.critical} label="Session quarantined" />}
        {i.taint && (
          <Tooltip title={`${i.taint.reason} (source: ${i.taint.source}; ${i.taint.remainingActions} actions remaining)`}>
            <ToneChip tone={t.severity.high} icon={<WarningAmberRoundedIcon sx={{ fontSize: '14px !important', color: `${t.severity.high.fg} !important` }} />} label="Tainted" />
          </Tooltip>
        )}
        {i.goal && <Typography variant="caption" noWrap sx={{ flex: 1, minWidth: 0 }} title={i.goal}>Goal: {i.goal}</Typography>}
        {!i.goal && <span style={{ flex: 1 }} />}
        {stopped ? (
          <RoleButton roles={['PolicyAdmin']} size="small" variant="outlined" startIcon={<PlayCircleOutlineRoundedIcon />} onClick={() => setPending('resume')}>Resume</RoleButton>
        ) : (
          <>
            <RoleButton roles={['PolicyAdmin']} size="small" variant="outlined" startIcon={<PauseCircleOutlineRoundedIcon />} onClick={() => setPending('pause')} aria-label="Kill switch: pause session">Pause</RoleButton>
            <RoleButton roles={['PolicyAdmin']} size="small" variant="outlined" color="error" startIcon={<BlockRoundedIcon />} onClick={() => setPending('quarantine')}>Quarantine</RoleButton>
          </>
        )}
      </Stack>
      <ReasonDialog
        open={!!pending}
        title={pending ? COPY[pending].title : ''}
        body={pending ? COPY[pending].body : undefined}
        confirmLabel={pending ? COPY[pending].confirm : ''}
        danger={pending !== 'resume'}
        requireReason={pending !== 'resume'}
        onClose={() => setPending(null)}
        onConfirm={reason => action.mutateAsync({ sessionId, action: pending!, reason })}
      />
    </>
  );
}
