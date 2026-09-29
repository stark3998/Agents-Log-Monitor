import { lazy, Suspense, useState } from 'react';
import { Box, Drawer, IconButton, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded';
import { useNavigate } from 'react-router-dom';

// Loaded on first open so the chat code isn't in the initial bundle.
const ChatPanel = lazy(() => import('./ChatPanel').then(m => ({ default: m.ChatPanel })));

/** Top-bar button + slide-over drawer hosting the "Ask the monitor" chat (kept mounted after first open). */
export function AskDrawerButton() {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Tooltip title="Ask the monitor">
        <IconButton aria-label="Ask the monitor" aria-haspopup="dialog" aria-expanded={open} onClick={() => { setUsed(true); setOpen(true); }}>
          <AutoAwesomeOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        keepMounted
        slotProps={{ paper: { sx: { width: { xs: '100vw', sm: 460 }, bgcolor: 'background.default' }, 'aria-label': 'Ask the monitor' } as object }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <AutoAwesomeOutlinedIcon sx={{ fontSize: 18, color: 'primary.main' }} />
          <Typography variant="subtitle1" component="h2" sx={{ flex: 1 }}>Ask the monitor</Typography>
          <Tooltip title="Open full page"><IconButton size="small" aria-label="Open chat page" onClick={() => { setOpen(false); navigate('/ask'); }}><OpenInFullRoundedIcon fontSize="small" /></IconButton></Tooltip>
          <Tooltip title="Close (Esc)"><IconButton size="small" aria-label="Close chat" onClick={() => setOpen(false)}><CloseRoundedIcon fontSize="small" /></IconButton></Tooltip>
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {used && <Suspense fallback={<LinearProgress aria-label="Loading chat" />}><ChatPanel dense onNavigate={() => setOpen(false)} /></Suspense>}
        </Box>
      </Drawer>
    </>
  );
}
