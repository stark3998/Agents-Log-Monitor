import { useState, type ReactNode } from 'react';
import { Box, Button, Card, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import AccessTimeRoundedIcon from '@mui/icons-material/AccessTimeRounded';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import { RANGES, rangeOption, useRangeKey } from '../lib/range';

export function SectionCard({ title, subtitle, action, children, sx, delay = 0 }: {
  title?: ReactNode; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; sx?: object; delay?: number;
}) {
  return (
    <Card sx={{ p: 2.5, animation: `am-fade-up 420ms ${delay}ms both cubic-bezier(0.05, 0.7, 0.1, 1)`, ...sx }}>
      {(title || action) && (
        <Stack direction="row" spacing={2} sx={{ alignItems: 'flex-start', mb: 2 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {title && <Typography variant="h6">{title}</Typography>}
            {subtitle && <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>{subtitle}</Typography>}
          </Box>
          {action}
        </Stack>
      )}
      {children}
    </Card>
  );
}

export function EmptyState({ icon, title, body, action, compact }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <Stack spacing={1.25} sx={{ alignItems: 'center', justifyContent: 'center', py: compact ? 4 : 8, px: 3, textAlign: 'center', animation: 'am-fade-in 300ms both' }}>
      <Box sx={{ width: 48, height: 48, borderRadius: '14px', display: 'grid', placeItems: 'center', bgcolor: 'action.hover', color: 'text.secondary', '& svg': { fontSize: 24 } }}>
        {icon}
      </Box>
      <Typography variant="subtitle1">{title}</Typography>
      {body && <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 440 }}>{body}</Typography>}
      {action}
    </Stack>
  );
}

export function CopyButton({ text, size = 'small', label = 'Copy' }: { text: string; size?: 'small' | 'medium'; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? 'Copied' : label}>
      <IconButton
        size={size}
        aria-label={label}
        onClick={e => {
          e.stopPropagation();
          navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); });
        }}
      >
        {done ? <CheckRoundedIcon sx={{ fontSize: 16, color: 'success.main', animation: 'am-scale-in 200ms both' }} /> : <ContentCopyRoundedIcon sx={{ fontSize: 15 }} />}
      </IconButton>
    </Tooltip>
  );
}

export function TimeRangePicker() {
  const [key, setKey] = useRangeKey();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<AccessTimeRoundedIcon sx={{ fontSize: '16px !important' }} />}
        endIcon={<KeyboardArrowDownRoundedIcon sx={{ transition: 'transform 200ms', transform: anchor ? 'rotate(180deg)' : 'none' }} />}
        onClick={e => setAnchor(e.currentTarget)}
        aria-haspopup="menu"
      >
        {rangeOption(key).label}
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        {RANGES.map(r => (
          <MenuItem key={r.key} selected={r.key === key} onClick={() => { setKey(r.key); setAnchor(null); }}>
            {r.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export interface ExportOption { label: string; hint?: string; href?: string; onClick?: () => void }

export function ExportMenu({ options, label, icon = true }: { options: ExportOption[]; label?: string; icon?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const trigger = label
    ? <Button variant="outlined" size="small" startIcon={icon ? <FileDownloadOutlinedIcon sx={{ fontSize: '17px !important' }} /> : undefined} onClick={e => setAnchor(e.currentTarget)}>{label}</Button>
    : <Tooltip title="Export"><IconButton size="small" aria-label="Export" onClick={e => setAnchor(e.currentTarget)}><FileDownloadOutlinedIcon fontSize="small" /></IconButton></Tooltip>;
  return (
    <>
      {trigger}
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} transformOrigin={{ vertical: 'top', horizontal: 'right' }}>
        {options.map(o => (
          <MenuItem
            key={o.label}
            component={o.href ? 'a' : 'li'}
            href={o.href}
            download={o.href ? '' : undefined}
            onClick={() => { o.onClick?.(); setAnchor(null); }}
          >
            <ListItemIcon><FileDownloadOutlinedIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary={o.label} secondary={o.hint} slotProps={{ secondary: { sx: { fontSize: 11.5 } } }} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/** Download text generated in the browser. */
export function downloadText(filename: string, text: string, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
