import { lazy, Suspense } from 'react';
import { Box, LinearProgress, Stack, Typography } from '@mui/material';

// Loaded on first open so the chat code isn't in the initial bundle.
const ChatPanel = lazy(() => import('./ChatPanel').then(m => ({ default: m.ChatPanel })));

export function AskPage() {
  return (
    <Stack spacing={1.5} sx={{ height: 'calc(100vh - 150px)', minHeight: 420, maxWidth: 920, mx: 'auto' }}>
      <Typography variant="h5" component="h2">Ask the monitor</Typography>
      <Box sx={{ flex: 1, minHeight: 0 }}><Suspense fallback={<LinearProgress aria-label="Loading chat" />}><ChatPanel /></Suspense></Box>
    </Stack>
  );
}
