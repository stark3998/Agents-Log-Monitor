import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge, Box, Button, Collapse, Fab, IconButton, InputAdornment, Skeleton, Stack, TextField, ToggleButton, ToggleButtonGroup,
  Tooltip, Typography, useTheme, Zoom,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInFullRoundedIcon from '@mui/icons-material/OpenInFullRounded';
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import ArrowDownwardRoundedIcon from '@mui/icons-material/ArrowDownwardRounded';
import SearchRoundedIcon from '@mui/icons-material/SearchRounded';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import ComputerRoundedIcon from '@mui/icons-material/ComputerRounded';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import SearchOffRoundedIcon from '@mui/icons-material/SearchOffRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { exportUrl, useConversation } from '../../api/client';
import type { ConversationDetail } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { AutonomyChip, ChannelBadge, SeverityChip, ToneChip } from '../../components/Chips';
import { EmptyState, ExportMenu } from '../../components/Common';
import { Ellipsis, LiveDot } from '../../components/Primitives';
import { useOpenSettings } from '../../components/SettingsDialog';
import { cleanTitle, fmtNum, shortId } from '../../lib/format';
import { buildBlocks, findMatches, type Block, type ViewFilter } from './timelineModel';
import {
  AssistantMessage, GapDivider, LifecycleRule, NotificationRow, PolicyNotice, PromptBubble, SubagentMarker, ThinkingBlock, ToolGroup,
} from './TimelineBlocks';
import { DecisionMatchProvider } from './DecisionBadge';
import { SessionControls } from './SessionControls';

const SEV_WORD: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

function Header({ data, onClose, onExpand }: { data: ConversationDetail; onClose?: () => void; onExpand?: () => void }) {
  const c = data.conversation;
  const t = useTheme().tokens;
  const openSettings = useOpenSettings();
  const [why, setWhy] = useState(false);
  const sep = <Box component="span" sx={{ color: 'text.disabled' }}>·</Box>;
  return (
    <Box sx={{ px: 2.5, pt: 2, pb: 1.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
        <Tooltip title={cleanTitle(c.title) ?? ''} placement="bottom-start" enterDelay={500}>
          <Typography variant="h5" component="h2" sx={{ flex: 1, minWidth: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.35 }}>
            {cleanTitle(c.title) ?? 'Untitled conversation'}
          </Typography>
        </Tooltip>
        <ExportMenu options={[
          { label: 'Markdown transcript', href: exportUrl(`conversations/${c.id}/export`, { format: 'md' }) },
          { label: 'JSON', hint: 'Conversation summary and full timeline', href: exportUrl(`conversations/${c.id}/export`, { format: 'json' }) },
        ]} />
        {onExpand && <Tooltip title="Open full page"><IconButton size="small" aria-label="Open full page" onClick={onExpand}><OpenInFullRoundedIcon fontSize="small" /></IconButton></Tooltip>}
        {onClose && <Tooltip title="Close (Esc)"><IconButton size="small" aria-label="Close" onClick={onClose}><CloseRoundedIcon fontSize="small" /></IconButton></Tooltip>}
      </Stack>

      <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', mt: 1.25, flexWrap: 'wrap', rowGap: 0.75 }}>
        <SeverityChip severity={c.severity} size="medium" />
        <AutonomyChip level={c.autonomyLevel} label={c.autonomyLabel} />
        {c.channels.map(ch => <ChannelBadge key={ch} channel={ch} />)}
        {c.live && <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', pl: 0.5 }}><LiveDot /><Typography variant="caption" sx={{ color: 'success.main', fontWeight: 600 }}>Live</Typography></Stack>}
        <Button size="small" onClick={() => setWhy(w => !w)} sx={{ color: 'text.secondary', minWidth: 0, px: 1 }}>
          Why {SEV_WORD[c.severity]}?
        </Button>
      </Stack>
      <Collapse in={why} timeout={220}>
        <Box component="ul" sx={{ m: 0, mt: 1, pl: 2.5, color: 'text.secondary', fontSize: 12.5, '& li': { my: 0.25 } }}>
          {c.severityReasons.map(r => <li key={r}>{r}</li>)}
        </Box>
        <Typography variant="caption" component="div" sx={{ mt: 0.75, pl: 0.5 }}>
          Advisory rating from heuristic rules.{' '}
          <Box component="button" type="button" onClick={() => openSettings('rules')}
            sx={{ all: 'unset', cursor: 'pointer', color: 'primary.main', fontWeight: 600, '&:hover': { textDecoration: 'underline' } }}>
            Review or tune the rules
          </Box>
        </Typography>
      </Collapse>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1.25, color: 'text.secondary', fontSize: 12.5, flexWrap: 'wrap', rowGap: 0.5 }}>
        <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center' }}><AgentAvatar agentKey={c.agentKey} size={18} /><span>{c.agentName}</span></Stack>
        {sep}
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0, maxWidth: 220 }}><PersonOutlineRoundedIcon sx={{ fontSize: 15 }} /><Ellipsis text={c.user} /></Stack>
        {sep}
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0, maxWidth: 200 }}><ComputerRoundedIcon sx={{ fontSize: 15 }} /><Ellipsis text={c.endpoint} /></Stack>
        {sep}<span>{fmtNum(c.prompts)} prompts</span>
        {sep}<span>{fmtNum(c.actions)} actions</span>
        {c.mcp > 0 && <>{sep}<span>{fmtNum(c.mcp)} MCP</span></>}
      </Stack>
      {(c.projectPath || c.model) && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5, color: 'text.disabled', fontSize: 12, minWidth: 0 }}>
          {c.projectPath && <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0, flex: 1 }}><FolderOutlinedIcon sx={{ fontSize: 14 }} /><Ellipsis text={c.projectPath} mono sx={{ fontSize: 11.5 }} /></Stack>}
          {c.model && <Box component="span" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5, flexShrink: 0 }}>{c.model}</Box>}
          <Box component="span" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5, flexShrink: 0 }}>{shortId(c.id)}</Box>
        </Stack>
      )}
      {(c.detectors.length > 0 || c.riskyActions > 0) && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 1.25, flexWrap: 'wrap', rowGap: 0.5 }}>
          {c.riskyActions > 0 && <ToneChip tone={t.severity.critical} label={`${fmtNum(c.riskyActions)} risky actions`} />}
          {c.detectors.map(d => (
            <Tooltip key={d.key} title={`${fmtNum(d.count)} detection${d.count === 1 ? '' : 's'}`}>
              <ToneChip tone={d.cls === 'secret' ? t.severity.high : t.severity.medium} label={`${d.label} · ${fmtNum(d.count)}`} />
            </Tooltip>
          ))}
        </Stack>
      )}
      <SessionControls sessionId={c.id} />
    </Box>
  );
}

export function ConversationView({ id, onClose, onExpand }: { id: string; onClose?: () => void; onExpand?: () => void }) {
  const { data, isLoading, isError } = useConversation(id);
  const theme = useTheme();
  const [filter, setFilter] = useState<ViewFilter>('all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cursor, setCursor] = useState(0);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());
  const [openThinking, setOpenThinking] = useState<Set<number>>(new Set());
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const virtuoso = useRef<VirtuosoHandle>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => { const t = setTimeout(() => setDebounced(query), 180); return () => clearTimeout(t); }, [query]);

  const blocks = useMemo(() => (data ? buildBlocks(data.timeline, filter) : []), [data, filter]);
  const matches = useMemo(() => findMatches(blocks, debounced), [blocks, debounced]);
  const agentNames = useMemo(() => new Map((data?.agents ?? []).map(a => [a.id, a.name])), [data]);
  const current = matches.length ? matches[Math.min(cursor, matches.length - 1)] : null;
  const live = !!data?.conversation.live;

  // Track new blocks while the user is scrolled up (drives the "jump to latest" badge).
  const prevLen = useRef(0);
  useEffect(() => {
    if (!atBottom && blocks.length > prevLen.current && prevLen.current > 0) setUnseen(n => n + blocks.length - prevLen.current);
    prevLen.current = blocks.length;
  }, [blocks.length, atBottom]);
  useEffect(() => { if (atBottom) setUnseen(0); }, [atBottom]);

  useEffect(() => { setCursor(0); }, [debounced, filter]);

  // Reveal the current match: expand its tool group and scroll it into view.
  useEffect(() => {
    if (!current) return;
    const b = blocks[current.block];
    if (b?.type === 'tools' && b.items.length > 1) setOpenGroups(s => (s.has(b.key) ? s : new Set(s).add(b.key)));
    virtuoso.current?.scrollToIndex({ index: current.block, align: 'center', behavior: 'smooth' });
  }, [current, blocks]);

  const step = useCallback((d: number) => {
    if (!matches.length) return;
    setCursor(c => (c + d + matches.length) % matches.length);
  }, [matches.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && root.current?.isConnected) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggle = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>, v: T) =>
    set(s => { const n = new Set(s); if (n.has(v)) n.delete(v); else n.add(v); return n; });

  const renderBlock = (b: Block) => {
    const q = debounced;
    let el: React.ReactNode;
    switch (b.type) {
      case 'text':
        el = b.item.kind === 'prompt' ? <PromptBubble item={b.item} q={q} />
          : b.item.kind === 'assistant' ? <AssistantMessage item={b.item} q={q} />
          : <ThinkingBlock item={b.item} q={q} open={openThinking.has(b.item.id) || (!!q && current?.itemId === b.item.id)} onToggle={() => toggle(setOpenThinking, b.item.id)} />;
        break;
      case 'tools':
        el = (
          <ToolGroup
            items={b.items}
            entries={b.entries}
            groupOpen={openGroups.has(b.key) || filter === 'findings'}
            onToggleGroup={() => toggle(setOpenGroups, b.key)}
            openTools={openTools}
            onToggleTool={id => toggle(setOpenTools, id)}
            openThinking={openThinking}
            onToggleThinking={id => toggle(setOpenThinking, id)}
            live={live}
            q={q}
            currentItem={current?.itemId ?? null}
          />
        );
        break;
      case 'subagent': el = <SubagentMarker item={b.item} agentName={agentNames.get(b.item.agentId) ?? b.item.name} />; break;
      case 'policy': el = <PolicyNotice item={b.item} />; break;
      case 'lifecycle': el = <LifecycleRule item={b.item} />; break;
      case 'notification': el = <NotificationRow item={b.item} />; break;
      case 'gap': return <GapDivider label={b.label} />;
    }
    const isCurrent = current && blocks[current.block] === b && b.type === 'text';
    const sub = 'sub' in b && b.sub;
    return (
      <Box sx={{
        ...(sub ? { ml: 1.5, pl: 2, borderLeft: '2px solid', borderColor: 'divider' } : null),
        borderRadius: 2,
        animation: isCurrent ? 'am-match 900ms ease-out 2' : undefined,
      }}>
        {el}
      </Box>
    );
  };

  if (isError) {
    return <Box ref={root} sx={{ p: 3 }}><EmptyState icon={<ErrorOutlineRoundedIcon />} title="Conversation not found" body="It may have been removed or is outside the stored history." /></Box>;
  }

  return (
    <DecisionMatchProvider sessionId={id} timeline={data?.timeline}>
    <Box ref={root} sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, position: 'relative' }}>
      {data ? <Header data={data} onClose={onClose} onExpand={onExpand} /> : (
        <Box sx={{ px: 2.5, pt: 2.5, pb: 2 }}>
          <Skeleton width="80%" height={32} />
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}><Skeleton variant="rounded" width={60} height={24} /><Skeleton variant="rounded" width={110} height={24} /></Stack>
          <Skeleton width="60%" sx={{ mt: 1 }} />
        </Box>
      )}

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 2.5, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap', rowGap: 1 }}>
        <TextField
          inputRef={searchRef}
          size="small"
          placeholder="Search in conversation…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
          sx={{ flex: 1, minWidth: 200 }}
          slotProps={{
            input: {
              startAdornment: <InputAdornment position="start"><SearchRoundedIcon sx={{ fontSize: 18 }} /></InputAdornment>,
              endAdornment: debounced.trim().length >= 2 ? (
                <InputAdornment position="end">
                  <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', mr: 0.5 }}>
                    {matches.length ? `${Math.min(cursor, matches.length - 1) + 1} / ${fmtNum(matches.length)}` : 'No matches'}
                  </Typography>
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
        <Tooltip title="Previous match (Shift+Enter)"><span><IconButton size="small" aria-label="Previous match" disabled={!matches.length} onClick={() => step(-1)}><KeyboardArrowUpRoundedIcon /></IconButton></span></Tooltip>
        <Tooltip title="Next match (Enter)"><span><IconButton size="small" aria-label="Next match" disabled={!matches.length} onClick={() => step(1)}><KeyboardArrowDownRoundedIcon /></IconButton></span></Tooltip>
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} aria-label="Show">
          <ToggleButton value="all">All</ToggleButton>
          <ToggleButton value="messages">Messages</ToggleButton>
          <ToggleButton value="tools">Tools</ToggleButton>
          <ToggleButton value="findings">Findings</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {isLoading ? (
          <Stack spacing={1.5} sx={{ p: 2.5 }}>
            <Skeleton variant="rounded" height={72} sx={{ ml: 'auto', width: '70%' }} />
            {[0, 1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={34} width={`${55 + i * 8}%`} />)}
            <Skeleton variant="rounded" height={90} width="85%" />
          </Stack>
        ) : blocks.length === 0 ? (
          <EmptyState icon={<SearchOffRoundedIcon />} title={filter === 'findings' ? 'No findings' : 'Nothing to show'} body={filter === 'findings' ? 'No risky actions, sensitive data or policy events in this conversation.' : 'This conversation has no events of this type yet.'} />
        ) : (
          <Virtuoso
            ref={virtuoso}
            data={blocks}
            computeItemKey={(_, b) => b.key}
            initialTopMostItemIndex={live ? blocks.length - 1 : 0}
            followOutput={live && atBottom ? 'smooth' : false}
            atBottomStateChange={setAtBottom}
            atBottomThreshold={120}
            increaseViewportBy={{ top: 400, bottom: 600 }}
            itemContent={(_, b) => <Box sx={{ px: 2.5, py: 0.6 }}>{renderBlock(b)}</Box>}
            components={{ Header: () => <Box sx={{ height: 12 }} />, Footer: () => <Box sx={{ height: 72 }} /> }}
            style={{ height: '100%' }}
          />
        )}
        <Zoom in={!atBottom && blocks.length > 0}>
          <Fab
            size="small"
            aria-label="Jump to latest"
            onClick={() => virtuoso.current?.scrollToIndex({ index: blocks.length - 1, align: 'end', behavior: 'smooth' })}
            sx={{ position: 'absolute', right: 20, bottom: 20, bgcolor: theme.tokens.containerHigh, color: 'text.primary', border: '1px solid', borderColor: 'divider', boxShadow: '0 8px 24px rgba(0,0,0,.3)', '&:hover': { bgcolor: theme.tokens.container } }}
          >
            <Badge color="primary" badgeContent={unseen} max={99} invisible={!unseen}>
              <ArrowDownwardRoundedIcon fontSize="small" />
            </Badge>
          </Fab>
        </Zoom>
      </Box>
    </Box>
    </DecisionMatchProvider>
  );
}
