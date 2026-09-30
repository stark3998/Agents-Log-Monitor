import { lazy, Suspense } from 'react';
import { Box, LinearProgress, Stack, Typography } from '@mui/material';
import { useSearchParams } from 'react-router-dom';

// Loaded on first open so the chat code isn't in the initial bundle.
const ChatPanel = lazy(() => import('./ChatPanel').then(m => ({ default: m.ChatPanel })));

export function AskPage() {
  // `/ask?q=…` (e.g. from Docs search) asks that question straight away.
  const [params] = useSearchParams();
  const q = params.get('q') ?? undefined;
  return (
    <Stack spacing={1.5} sx={{ height: 'calc(100vh - 150px)', minHeight: 420, maxWidth: 920, mx: 'auto' }}>
      <Typography variant="h5" component="h2">Ask the monitor</Typography>
      <Box sx={{ flex: 1, minHeight: 0 }}><Suspense fallback={<LinearProgress aria-label="Loading chat" />}><ChatPanel initialQuestion={q} /></Suspense></Box>
    </Stack>
  );
}
