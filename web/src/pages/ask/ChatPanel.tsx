import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, Chip, IconButton, Stack, TextField, Tooltip, Typography } from '@mui/material';
import SendRoundedIcon from '@mui/icons-material/SendRounded';
import StopRoundedIcon from '@mui/icons-material/StopRounded';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { useQuery } from '@tanstack/react-query';
import { Link as RouterLink } from 'react-router-dom';
import { Markdown } from '../../components/Markdown';
import { api } from '../../api/client';
import { ChatUnavailableError, citationHref, streamChat, type ChatEvent } from '../../lib/sse';

type Citation = Extract<ChatEvent, { type: 'citation' }>;
interface Turn {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  tools: { name: string; args?: unknown }[];
  citations: Citation[];
  error?: string;
  pending?: boolean;
}

interface AskStatus { available: boolean; engine?: 'foundry' | 'intelligence'; model?: string; grounding?: string }

const SUGGESTIONS = [
  'How do lanes, policies and the PDP fit together?',
  'What do I need to configure to monitor Foundry and Copilot Studio agents?',
  'What is the difference between observe and enforce mode?',
];

const CITE_ICON = { session: <ForumOutlinedIcon />, decision: <GavelRoundedIcon />, incident: <HealthAndSafetyOutlinedIcon />, doc: <DescriptionOutlinedIcon /> };

let seq = 0;
const newConversationId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function engineLabel(s: { engine?: string; model?: string } | undefined): string | null {
  if (s?.engine === 'foundry') return `Microsoft Foundry${s.model ? ` · ${s.model}` : ''}`;
  if (s?.engine === 'intelligence') return 'Intelligence service · Microsoft Foundry';
  return null;
}

/**
 * "Ask the monitor" chat: streams SSE from POST /api/gov/intelligence/chat. Answers are grounded in
 * the project documentation (and, with the intelligence service, live monitor data) and cite pages.
 */
export function ChatPanel({ onNavigate, dense, initialQuestion }: { onNavigate?: () => void; dense?: boolean; initialQuestion?: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ engine?: string; model?: string } | undefined>();
  const abort = useRef<AbortController | null>(null);
  const conversationId = useRef(newConversationId());
  const scroller = useRef<HTMLDivElement>(null);
  const askedInitial = useRef(false);
  const status = useQuery({ queryKey: ['ask-status'], queryFn: () => api<AskStatus>('gov/intelligence/status'), staleTime: 5 * 60_000, retry: false });
  const engine = engineLabel(meta ?? status.data);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const patchLast = (fn: (t: Turn) => Turn) => setTurns(ts => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts));

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || streaming) return;
    const history = turns.filter(t => !t.error).map(t => ({ role: t.role, content: t.content }));
    setTurns(ts => [...ts, { id: ++seq, role: 'user', content: q, tools: [], citations: [] }, { id: ++seq, role: 'assistant', content: '', tools: [], citations: [], pending: true }]);
    setInput('');
    setStreaming(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await streamChat({
        messages: [...history, { role: 'user', content: q }],
        conversationId: conversationId.current,
        signal: ctrl.signal,
        onEvent: ev => {
          if (ev.type === 'meta') setMeta({ engine: ev.engine, model: ev.model });
          else if (ev.type === 'delta') patchLast(t => ({ ...t, content: t.content + (ev.text ?? '') }));
          else if (ev.type === 'tool') patchLast(t => ({ ...t, tools: [...t.tools, { name: ev.name, args: ev.args }] }));
          else if (ev.type === 'citation') patchLast(t => (t.citations.some(c => c.kind === ev.kind && c.id === ev.id) ? t : { ...t, citations: [...t.citations, ev] }));
          else if (ev.type === 'error') patchLast(t => ({ ...t, error: ev.message }));
          else if (ev.type === 'done') patchLast(t => ({ ...t, pending: false }));
        },
      });
      patchLast(t => ({ ...t, pending: false }));
    } catch (e) {
      if (e instanceof ChatUnavailableError) {
        setUnavailable(e.message);
        setTurns(ts => ts.slice(0, -1));
      } else if ((e as Error).name === 'AbortError') {
        patchLast(t => ({ ...t, pending: false, content: t.content || '_Stopped._' }));
      } else {
        patchLast(t => ({ ...t, pending: false, error: (e as Error).message || 'Something went wrong' }));
      }
    } finally {
      setStreaming(false);
      abort.current = null;
    }
  };

  // A question handed over from elsewhere (e.g. "Ask the assistant" on the Docs search page) is sent once.
  // Deferred so a StrictMode mount/unmount cycle cancels the timer instead of aborting a live request.
  useEffect(() => {
    if (!initialQuestion?.trim() || askedInitial.current) return;
    const t = setTimeout(() => { askedInitial.current = true; void send(initialQuestion); }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box ref={scroller} sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: dense ? 2 : 0, py: 1.5 }} aria-live="polite" aria-busy={streaming} role="log" aria-label="Conversation with the monitor">
        {unavailable && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>Ask the monitor isn’t available</Typography>
            <Typography variant="body2">{unavailable} Configure a Foundry endpoint (<code>FOUNDRY_OPENAI_ENDPOINT</code>) or the intelligence service (<code>INTELLIGENCE_URL</code>) on the server to enable it.</Typography>
          </Alert>
        )}
        {turns.length === 0 && !unavailable && (
          <Stack spacing={1.5} sx={{ alignItems: 'flex-start', py: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <AutoAwesomeOutlinedIcon sx={{ color: 'primary.main' }} />
              <Typography variant="subtitle1">Ask anything about the platform</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Answers are grounded in the project <RouterLink to="/docs" onClick={onNavigate} style={{ color: 'inherit' }}>documentation</RouterLink> and cite the pages they use
              {status.data?.engine === 'intelligence' ? ', plus live sessions, decisions and incidents' : ''}.
            </Typography>
            {engine && <Chip size="small" variant="outlined" icon={<AutoAwesomeOutlinedIcon />} label={engine} aria-label={`Model: ${engine}`} sx={{ '& .MuiChip-icon': { fontSize: 14 } }} />}
            {SUGGESTIONS.map(s => <Button key={s} size="small" variant="outlined" onClick={() => void send(s)} sx={{ textAlign: 'left', justifyContent: 'flex-start' }}>{s}</Button>)}
          </Stack>
        )}
        <Stack spacing={2}>
          {turns.map(t => (t.role === 'user' ? (
            <Box key={t.id} sx={{ alignSelf: 'flex-end', maxWidth: '85%', px: 1.75, py: 1, borderRadius: '14px 14px 4px 14px', bgcolor: 'action.selected', border: '1px solid', borderColor: 'divider', whiteSpace: 'pre-wrap', fontSize: 13.5 }}>
              {t.content}
            </Box>
          ) : (
            <Box key={t.id} data-testid="assistant-turn">
              {t.tools.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mb: 1 }}>
                  {t.tools.map((tool, i) => (
                    <Tooltip key={`${tool.name}-${i}`} title={tool.args ? <Box component="pre" sx={{ m: 0, fontSize: 11, whiteSpace: 'pre-wrap' }}>{JSON.stringify(tool.args, null, 2)}</Box> : ''}>
                      <Chip size="small" variant="outlined" icon={<BuildOutlinedIcon sx={{ fontSize: '13px !important' }} />} label={tool.name} sx={{ fontFamily: 'var(--am-mono)', fontSize: 11 }} />
                    </Tooltip>
                  ))}
                </Stack>
              )}
              {t.content
                ? <Box onClick={e => { if ((e.target as HTMLElement).closest('a[href^="/"]')) onNavigate?.(); }}><Markdown>{t.content}</Markdown></Box>
                : t.pending ? <Typography variant="body2" color="text.secondary">Thinking…</Typography> : null}
              {t.error && <Alert severity="error" sx={{ mt: 1 }} role="alert">{t.error}</Alert>}
              {t.citations.length > 0 && (
                <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 1 }} aria-label="Sources">
                  {t.citations.map(c => (
                    <Chip
                      key={`${c.kind}:${c.id}`}
                      size="small"
                      clickable
                      component={RouterLink}
                      to={citationHref(c)}
                      onClick={onNavigate}
                      icon={CITE_ICON[c.kind]}
                      label={c.title ?? (c.kind === 'doc' ? c.id.replace('#', ' › ') : `${c.kind} ${c.id.slice(0, 8)}`)}
                      sx={{ '& .MuiChip-icon': { fontSize: 14 } }}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          )))}
        </Stack>
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end', pt: 1.5, px: dense ? 2 : 0, pb: dense ? 2 : 0, borderTop: '1px solid', borderColor: 'divider' }}>
        <TextField
          fullWidth
          multiline
          maxRows={6}
          size="small"
          placeholder={unavailable ? 'Chat is unavailable' : 'Ask the monitor…'}
          value={input}
          disabled={!!unavailable}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }}
          slotProps={{ htmlInput: { 'aria-label': 'Message' } }}
        />
        {streaming ? (
          <Tooltip title="Stop"><IconButton aria-label="Stop generating" onClick={() => abort.current?.abort()}><StopRoundedIcon /></IconButton></Tooltip>
        ) : (
          <Tooltip title="Send (Enter)"><span><IconButton aria-label="Send" color="primary" disabled={!input.trim() || !!unavailable} onClick={() => void send(input)}><SendRoundedIcon /></IconButton></span></Tooltip>
        )}
      </Stack>
    </Box>
  );
}
