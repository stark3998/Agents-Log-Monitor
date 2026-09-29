import { useMemo, useState } from 'react';
import { Box, IconButton, Stack, Tooltip, useTheme } from '@mui/material';
import WrapTextRoundedIcon from '@mui/icons-material/WrapTextRounded';
import { CopyButton } from './Common';

type Tok = { t: string; c?: 'k' | 's' | 'n' | 'b' | 'x' | 'p' };

function tokenize(json: string): Tok[] {
  const out: Tok[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\b(null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) out.push({ t: json.slice(last, m.index) });
    if (m[1]) { out.push({ t: m[1], c: m[2] ? 'k' : 's' }); if (m[2]) out.push({ t: m[2] }); }
    else if (m[3]) out.push({ t: m[3], c: 'b' });
    else if (m[4]) out.push({ t: m[4], c: 'x' });
    else if (m[5]) out.push({ t: m[5], c: 'n' });
    else out.push({ t: m[6], c: 'p' });
    last = re.lastIndex;
  }
  if (last < json.length) out.push({ t: json.slice(last) });
  return out;
}

export function CodeBlock({ text, json, maxHeight = 320, wrapDefault = false }: { text: string; json?: boolean; maxHeight?: number; wrapDefault?: boolean }) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const [wrap, setWrap] = useState(wrapDefault);
  const colors = dark
    ? { k: '#93C5FD', s: '#86EFAC', n: '#FCA5A5', b: '#FDBA74', x: '#C4B5FD', p: theme.tokens.textTertiary }
    : { k: '#1D4ED8', s: '#15803D', n: '#B91C1C', b: '#C2410C', x: '#6D28D9', p: theme.tokens.textTertiary };
  const tokens = useMemo(() => (json && text.length < 200_000 ? tokenize(text) : null), [json, text]);
  return (
    <Box sx={{ position: 'relative', '&:hover .cb-actions': { opacity: 1 } }}>
      <Stack direction="row" className="cb-actions" sx={{ position: 'absolute', top: 4, right: 4, opacity: 0, transition: 'opacity 150ms', bgcolor: 'background.paper', borderRadius: 1, zIndex: 1 }}>
        <Tooltip title={wrap ? 'No wrap' : 'Wrap lines'}>
          <IconButton size="small" aria-label="Toggle wrap" onClick={() => setWrap(w => !w)}><WrapTextRoundedIcon sx={{ fontSize: 16 }} /></IconButton>
        </Tooltip>
        <CopyButton text={text} />
      </Stack>
      <Box
        component="pre"
        sx={{
          m: 0, p: 1.5, borderRadius: 2, bgcolor: dark ? '#0E0E11' : '#FAFAFA', border: '1px solid', borderColor: 'divider',
          fontFamily: theme.tokens.mono, fontSize: 11.5, lineHeight: 1.65, maxHeight, overflow: 'auto',
          whiteSpace: wrap ? 'pre-wrap' : 'pre', wordBreak: wrap ? 'break-word' : 'normal', color: 'text.primary',
        }}
      >
        {tokens ? tokens.map((tk, i) => (tk.c ? <span key={i} style={{ color: colors[tk.c] }}>{tk.t}</span> : tk.t)) : text}
      </Box>
    </Box>
  );
}
