import { lazy, Suspense } from 'react';
import { Box, LinearProgress, Stack } from '@mui/material';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/PageHeader';
import { FILL_HEIGHT } from '../../components/layout';

// Loaded on first open so the chat code isn't in the initial bundle.
const ChatPanel = lazy(() => import('./ChatPanel').then(m => ({ default: m.ChatPanel })));

export function AskPage() {
  // `/ask?q=…` (e.g. from Docs search) asks that question straight away.
  const [params] = useSearchParams();
  const q = params.get('q') ?? undefined;
  return (
    <Stack spacing={1.5} sx={{ height: FILL_HEIGHT, minHeight: 520, maxWidth: 920, mx: 'auto' }}>
      <PageHeader title="Ask the monitor" />
      <Box sx={{ flex: 1, minHeight: 0 }}><Suspense fallback={<LinearProgress aria-label="Loading chat" />}><ChatPanel initialQuestion={q} /></Suspense></Box>
    </Stack>
  );
}
