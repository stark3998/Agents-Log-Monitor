import { useEffect, useState } from 'react';
import { Alert, Box, Dialog, DialogContent, IconButton, Skeleton, Tooltip, useTheme } from '@mui/material';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import CloseIcon from '@mui/icons-material/Close';

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

let seq = 0;
// mermaid keeps global config, so renders are serialised to keep each one's theme intact.
let queue: Promise<unknown> = Promise.resolve();

async function renderSvg(source: string, dark: boolean, fontFamily: string): Promise<string> {
  const mermaid = await loadMermaid();
  const run = queue.then(async () => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily,
      flowchart: { htmlLabels: true, useMaxWidth: true },
      sequence: { useMaxWidth: true },
    });
    const { svg } = await mermaid.render(`mermaid-diagram-${++seq}`, source);
    return svg;
  });
  queue = run.catch(() => undefined);
  return run;
}

/** Renders a ```mermaid fenced block as an SVG diagram; falls back to the source on parse errors. */
export function MermaidDiagram({ source }: { source: string }) {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const fontFamily = String(theme.typography.fontFamily ?? 'sans-serif');
  const [state, setState] = useState<{ svg?: string; error?: string }>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({});
    renderSvg(source.trim(), dark, fontFamily)
      .then((svg) => { if (!cancelled) setState({ svg }); })
      .catch((e: unknown) => { if (!cancelled) setState({ error: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [source, dark, fontFamily]);

  if (state.error) {
    return (
      <Box sx={{ my: 1.5 }}>
        <Alert severity="warning" variant="outlined" sx={{ mb: 1, py: 0 }}>Diagram could not be rendered: {state.error.split('\n')[0]}</Alert>
        <pre><code>{source}</code></pre>
      </Box>
    );
  }
  if (!state.svg) return <Skeleton variant="rounded" height={220} sx={{ my: 1.5 }} aria-label="Loading diagram" />;
  const naturalWidth = Number(/viewBox="[^"]*?\s[^\s"]+\s([\d.]+)\s/.exec(state.svg)?.[1]) || undefined;
  return (
    <Box sx={{ position: 'relative', my: 2, '&:hover .mermaid-expand, & .mermaid-expand:focus-visible': { opacity: 1 } }}>
      <Box
        className="mermaid-diagram"
        role="img"
        aria-label="Diagram"
        sx={{
          p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper',
          overflowX: 'auto', textAlign: 'center',
          '& svg': { maxWidth: '100%', height: 'auto' },
        }}
        dangerouslySetInnerHTML={{ __html: state.svg }}
      />
      <Tooltip title="Expand diagram">
        <IconButton
          className="mermaid-expand"
          size="small"
          aria-label="Expand diagram"
          onClick={() => setOpen(true)}
          sx={{ position: 'absolute', top: 6, right: 6, opacity: 0.6, transition: 'opacity 120ms', bgcolor: 'background.paper', '&:hover': { bgcolor: 'action.hover' } }}
        >
          <OpenInFullIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth={false} slotProps={{ paper: { sx: { height: 'calc(100% - 64px)' } } }}>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 0.5 }}>
          <IconButton aria-label="Close diagram" onClick={() => setOpen(false)}><CloseIcon fontSize="small" /></IconButton>
        </Box>
        <DialogContent
          sx={{
            pt: 0, textAlign: 'center',
            '& svg': { width: naturalWidth ? `${naturalWidth}px !important` : 'auto', maxWidth: 'none !important', height: 'auto' },
          }}
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      </Dialog>
    </Box>
  );
}
