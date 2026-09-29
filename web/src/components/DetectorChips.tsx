import { Box, Stack, Tooltip, useTheme } from '@mui/material';
import type { DetectorSummary } from '../api/types';
import { ToneChip } from './Chips';
import { fmtNum } from '../lib/format';

/** Detector chips: first `max` shown, the rest collapsed into a "+N" chip with a tooltip. */
export function DetectorChips({ detectors, max = 2, stacked = false }: { detectors: DetectorSummary[]; max?: number; stacked?: boolean }) {
  const t = useTheme().tokens;
  if (!detectors.length) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  const shown = detectors.slice(0, max);
  const rest = detectors.slice(max);
  const tone = (d: DetectorSummary) => (d.cls === 'secret' ? t.severity.high : t.severity.medium);
  const more = rest.length > 0 && (
    <Tooltip title={<Box component="ul" sx={{ m: 0, pl: 2 }}>{rest.map(d => <li key={d.key}>{d.label} · {fmtNum(d.count)}</li>)}</Box>}>
      <ToneChip tone={t.severity.info} label={`+${rest.length}`} sx={{ flexShrink: 0, ...(stacked ? { height: 20, fontSize: 11 } : null) }} />
    </Tooltip>
  );
  if (stacked) {
    return (
      <Stack spacing={0.4} sx={{ minWidth: 0, width: '100%', py: 0.5 }}>
        {shown.map((d, i) => (
          <Stack key={d.key} direction="row" spacing={0.5} sx={{ minWidth: 0, alignItems: 'center' }}>
            <Tooltip title={`${d.label} · ${fmtNum(d.count)} detection${d.count === 1 ? '' : 's'}`}>
              <ToneChip tone={tone(d)} label={d.label} sx={{ height: 20, fontSize: 11, minWidth: 0, maxWidth: '100%' }} />
            </Tooltip>
            {i === shown.length - 1 && more}
          </Stack>
        ))}
      </Stack>
    );
  }
  return (
    <Stack direction="row" spacing={0.5} sx={{ minWidth: 0, flexWrap: 'nowrap', overflow: 'hidden' }}>
      {shown.map(d => (
        <Tooltip key={d.key} title={`${d.label} · ${fmtNum(d.count)} detection${d.count === 1 ? '' : 's'}`}>
          <ToneChip tone={tone(d)} label={d.label} sx={{ maxWidth: 150, minWidth: 0 }} />
        </Tooltip>
      ))}
      {more}
    </Stack>
  );
}
