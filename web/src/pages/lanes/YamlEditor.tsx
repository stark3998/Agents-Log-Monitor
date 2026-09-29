import { useMemo, useRef } from 'react';
import { Box, Typography, useTheme } from '@mui/material';

/** Extract 1-based line numbers mentioned in validation errors ("line 12", "at line 3, column 5"). */
export function errorLines(errors: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const e of errors) for (const m of e.matchAll(/line\s+(\d+)/gi)) out.add(Number(m[1]));
  return out;
}

/**
 * Lightweight code editor: monospace textarea with a synced line-number gutter.
 * Tab inserts two spaces; press Esc then Tab to move focus out (keyboard trap avoidance).
 */
export function YamlEditor({ value, onChange, errors = [], readOnly, label = 'Lane YAML', minRows = 24 }: {
  value: string; onChange: (v: string) => void; errors?: readonly string[]; readOnly?: boolean; label?: string; minRows?: number;
}) {
  const theme = useTheme();
  const t = theme.tokens;
  const gutter = useRef<HTMLDivElement>(null);
  const escaped = useRef(false);
  const lines = value.split('\n').length;
  const bad = useMemo(() => errorLines(errors), [errors]);
  const lineHeight = 20;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { escaped.current = true; return; }
    if (e.key === 'Tab' && !escaped.current && !readOnly) {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: s, selectionEnd: end } = el;
      const next = `${value.slice(0, s)}  ${value.slice(end)}`;
      onChange(next);
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = s + 2; });
      return;
    }
    escaped.current = false;
  };

  return (
    <Box>
      <Box sx={{
        display: 'flex', border: '1px solid', borderColor: errors.length ? 'error.main' : 'divider', borderRadius: 2, overflow: 'hidden',
        bgcolor: theme.palette.mode === 'dark' ? '#0E0E11' : '#FAFAFA',
        '&:focus-within': { borderColor: errors.length ? 'error.main' : 'primary.main', boxShadow: `0 0 0 2px rgba(${t.accentRgb}, 0.25)` },
      }}>
        <Box
          ref={gutter}
          aria-hidden
          sx={{
            py: 1.25, px: 1, textAlign: 'right', userSelect: 'none', overflow: 'hidden', flexShrink: 0, minWidth: 44,
            fontFamily: t.mono, fontSize: 12, lineHeight: `${lineHeight}px`, color: 'text.disabled', borderRight: '1px solid', borderColor: 'divider',
            height: Math.max(minRows, 1) * lineHeight + 20, bgcolor: 'action.hover',
          }}
        >
          {Array.from({ length: lines }, (_, i) => (
            <div key={i} style={bad.has(i + 1) ? { color: t.danger, fontWeight: 700 } : undefined}>{i + 1}</div>
          ))}
        </Box>
        <Box
          component="textarea"
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          aria-label={label}
          aria-invalid={errors.length > 0}
          aria-describedby="yaml-editor-help"
          wrap="off"
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e: React.UIEvent<HTMLTextAreaElement>) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          sx={{
            flex: 1, minWidth: 0, resize: 'none', border: 0, outline: 0, py: 1.25, px: 1.5, m: 0, bgcolor: 'transparent', color: 'text.primary',
            fontFamily: t.mono, fontSize: 12, lineHeight: `${lineHeight}px`, height: Math.max(minRows, 1) * lineHeight + 20, whiteSpace: 'pre', overflow: 'auto',
            tabSize: 2,
          }}
        />
      </Box>
      <Typography id="yaml-editor-help" variant="caption" component="div" sx={{ mt: 0.5 }}>
        Tab inserts two spaces · Esc then Tab moves focus out of the editor
      </Typography>
    </Box>
  );
}
