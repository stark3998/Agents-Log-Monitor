import { useMemo } from 'react';
import { Box, Typography, useTheme } from '@mui/material';
import { diffLines, sideBySide } from '../../lib/diff';

/** Side-by-side line diff of two lane YAML versions. */
export function LaneDiff({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const t = useTheme().tokens;
  const rows = useMemo(() => sideBySide(diffLines(before, after)), [before, after]);
  const changed = rows.filter(r => r.left?.changed || r.right?.changed).length;
  const cell = (c: { n: number; text: string; changed: boolean } | undefined, side: 'l' | 'r') => {
    const bg = c?.changed ? (side === 'l' ? t.severity.critical.bg : 'rgba(34,197,94,0.14)') : undefined;
    return (
      <>
        <Box sx={{ px: 1, color: 'text.disabled', textAlign: 'right', userSelect: 'none', bgcolor: bg, borderRight: '1px solid', borderColor: 'divider' }}>{c?.n ?? ''}</Box>
        <Box sx={{ px: 1, whiteSpace: 'pre', bgcolor: bg ?? (c ? undefined : 'action.hover'), overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c ? <><Box component="span" aria-hidden sx={{ color: 'text.disabled', mr: 0.5 }}>{c.changed ? (side === 'l' ? '−' : '+') : ' '}</Box>{c.text}</> : ''}
        </Box>
      </>
    );
  };
  return (
    <Box>
      <Typography variant="caption" component="div" sx={{ mb: 1 }} role="status">{changed ? `${changed} changed line${changed === 1 ? '' : 's'}` : 'No differences'}</Typography>
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'auto', maxHeight: 560 }} role="table" aria-label={`Diff ${beforeLabel} → ${afterLabel}`}>
        <Box sx={{ display: 'grid', gridTemplateColumns: '44px minmax(0,1fr) 44px minmax(0,1fr)', fontFamily: 'var(--am-mono)', fontSize: 12, lineHeight: '20px', minWidth: 640 }}>
          <Box role="columnheader" sx={{ gridColumn: '1 / 3', px: 1, py: 0.5, fontWeight: 600, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider' }}>{beforeLabel}</Box>
          <Box role="columnheader" sx={{ gridColumn: '3 / 5', px: 1, py: 0.5, fontWeight: 600, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider', borderLeft: '1px solid' }}>{afterLabel}</Box>
          {rows.map((r, i) => (
            <Box key={i} role="row" sx={{ display: 'contents' }}>
              {cell(r.left, 'l')}
              <Box sx={{ display: 'contents', '& > :first-of-type': { borderLeft: '1px solid', borderColor: 'divider' } }}>{cell(r.right, 'r')}</Box>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
