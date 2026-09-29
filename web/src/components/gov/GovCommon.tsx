import { useEffect, useState, type ReactNode } from 'react';
import {
  Alert, Box, Button, Card, CardActionArea, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle, IconButton, Skeleton,
  TextField, Tooltip, Typography, type ButtonProps, type IconButtonProps,
} from '@mui/material';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { useCan } from '../../auth/context';
import { errorMessage, type Role } from '../../api/governance';
import { CountUp, InfoTip } from '../Primitives';
import { EmptyState } from '../Common';

const roleHint = (roles: Role[]) => `Requires the ${roles.join(' or ')} role`;

/** Button hidden-in-plain-sight: rendered disabled with an explanatory tooltip when the user lacks the role. */
export function RoleButton({ roles, children, disabled, ...rest }: ButtonProps & { roles: Role[] }) {
  const allowed = useCan(...roles);
  const btn = <Button {...rest} disabled={disabled || !allowed}>{children}</Button>;
  if (allowed) return btn;
  return <Tooltip title={roleHint(roles)}><span>{btn}</span></Tooltip>;
}

export function RoleIconButton({ roles, title, disabled, children, ...rest }: IconButtonProps & { roles: Role[]; title: string }) {
  const allowed = useCan(...roles);
  return (
    <Tooltip title={allowed ? title : `${title} — ${roleHint(roles).toLowerCase()}`}>
      <span>
        <IconButton size="small" aria-label={title} {...rest} disabled={disabled || !allowed}>{children}</IconButton>
      </span>
    </Tooltip>
  );
}

/** Confirmation dialog that collects a reason / note before a governed action. */
export function ReasonDialog({ open, title, body, confirmLabel, danger, requireReason = true, label = 'Reason', onClose, onConfirm, children }: {
  open: boolean; title: string; body?: ReactNode; confirmLabel: string; danger?: boolean; requireReason?: boolean; label?: string;
  onClose: () => void; onConfirm: (reason: string) => Promise<unknown>; children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setError(null); setBusy(false); } }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const invalid = requireReason && !reason.trim();
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xs" fullWidth aria-labelledby="reason-dialog-title">
      <DialogTitle id="reason-dialog-title">{title}</DialogTitle>
      <DialogContent>
        {body && <DialogContentText component="div" sx={{ mb: 2, fontSize: 13 }}>{body}</DialogContentText>}
        {children}
        <TextField
          autoFocus
          fullWidth
          multiline
          minRows={2}
          label={requireReason ? label : `${label} (optional)`}
          value={reason}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !invalid && !busy) void submit(); }}
          required={requireReason}
          sx={{ mt: 1 }}
        />
        {error && <Alert severity="error" sx={{ mt: 2 }} role="alert">{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" color={danger ? 'error' : 'primary'} disabled={invalid || busy} onClick={() => void submit()}>
          {busy ? 'Working…' : confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Compact KPI card (value + label) used on governance pages. */
export function StatCard({ label, value, info, format, tone, onClick, index = 0, suffix, ariaLabel }: {
  label: string; value: number | null | undefined; info?: string; format?: (n: number) => string; tone?: string; onClick?: () => void;
  index?: number; suffix?: string; ariaLabel?: string;
}) {
  return (
    <Card sx={{ animation: `am-fade-up 420ms ${index * 45}ms both cubic-bezier(0.05, 0.7, 0.1, 1)`, transition: 'transform 250ms cubic-bezier(0.2,0,0,1)', '&:hover': onClick ? { transform: 'translateY(-1px)' } : undefined }}>
      <CardActionArea onClick={onClick} disabled={!onClick} aria-label={ariaLabel ?? label} sx={{ p: 2, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start' }}>
        <Typography variant="body2" color="text.secondary" sx={{ display: 'flex', alignItems: 'center' }}>
          {label}{info && <InfoTip title={info} />}
        </Typography>
        <Typography sx={{ mt: 1, fontSize: 28, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums', color: tone }}>
          {value == null ? <Skeleton width={60} /> : <><CountUp value={value} format={format} />{suffix && <Box component="span" sx={{ fontSize: 15, fontWeight: 500, ml: 0.5, color: 'text.secondary' }}>{suffix}</Box>}</>}
        </Typography>
      </CardActionArea>
    </Card>
  );
}

/** Error state with the server message and a retry button. */
export function QueryError({ error, onRetry, title = 'Could not load data' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <EmptyState
      compact
      icon={<ErrorOutlineRoundedIcon />}
      title={title}
      body={errorMessage(error)}
      action={onRetry ? <Button variant="outlined" size="small" onClick={onRetry}>Retry</Button> : undefined}
    />
  );
}
