import { Box, Chip, Tooltip, useTheme, type ChipProps } from '@mui/material';
import type { Channel, Severity } from '../api/types';

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];
export const severityRank = (s: Severity) => 4 - SEVERITY_ORDER.indexOf(s);

interface ToneChipProps extends Omit<ChipProps, 'color'> { tone: { fg: string; bg: string; border: string } }

/** Small chip with a semantic tone (fg/bg/border triple from the theme tokens). */
export function ToneChip({ tone, sx, ...rest }: ToneChipProps) {
  return (
    <Chip
      size="small"
      {...rest}
      sx={{ color: tone.fg, bgcolor: tone.bg, border: '1px solid', borderColor: tone.border, fontWeight: 550, ...sx }}
    />
  );
}

export function SeverityChip({ severity, size = 'small', reasons }: { severity: Severity; size?: 'small' | 'medium'; reasons?: string[] }) {
  const t = useTheme().tokens;
  const chip = (
    <ToneChip
      tone={t.severity[severity]}
      label={SEVERITY_LABEL[severity]}
      sx={size === 'medium' ? { height: 26, fontSize: 12.5, px: 0.5 } : undefined}
      aria-label={`Severity ${SEVERITY_LABEL[severity]}`}
    />
  );
  if (!reasons?.length) return chip;
  return (
    <Tooltip title={
      <Box>
        <Box component="ul" sx={{ m: 0, pl: 2 }}>{reasons.map(r => <li key={r}>{r}</li>)}</Box>
        <Box sx={{ mt: 0.75, color: 'text.disabled', fontSize: 11 }}>Advisory rating from heuristic rules</Box>
      </Box>
    }>
      {chip}
    </Tooltip>
  );
}

export function AutonomyChip({ level, label }: { level: number | null; label: string | null }) {
  const t = useTheme().tokens;
  if (!level) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  const tone = level >= 3 ? t.severity.high : level === 2 ? t.severity.medium : t.severity.info;
  const help = level >= 3
    ? 'Tools run without asking (allow-all / autopilot / bypass permissions)'
    : level === 2 ? 'Edits auto-approved; other tools ask first' : 'Agent asks before running tools';
  return (
    <Tooltip title={help}>
      <ToneChip tone={tone} label={`${level} · ${label ?? ''}`} />
    </Tooltip>
  );
}

const CHANNEL_HELP: Record<Channel, string> = {
  log: 'Captured from the agent’s local session log (events.jsonl / transcript)',
  hook: 'Captured in real time by an agent hook',
  poll: 'Pulled from a cloud API',
};

export function ChannelBadge({ channel, confirmed }: { channel: Channel; confirmed?: boolean }) {
  const t = useTheme().tokens;
  const label = confirmed ? 'log + hook' : channel;
  return (
    <Tooltip title={confirmed ? 'Seen in the session log and confirmed by a hook' : CHANNEL_HELP[channel]}>
      <ToneChip
        tone={confirmed ? t.channel.hook : t.channel[channel]}
        label={label}
        sx={{ height: 18, fontSize: 10.5, letterSpacing: '0.02em', '& .MuiChip-label': { px: 0.75 } }}
      />
    </Tooltip>
  );
}

export function CategoryChip({ category }: { category: string | null }) {
  const t = useTheme().tokens;
  if (!category) return null;
  const c = t.category[category] ?? t.textSecondary;
  return (
    <Box
      component="span"
      sx={{
        fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', px: 0.75, py: '1px', borderRadius: '5px',
        color: c, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', lineHeight: 1.6,
      }}
    >
      {category}
    </Box>
  );
}
