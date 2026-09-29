import { Fragment, memo, useState, type ReactNode } from 'react';
import { Box, ButtonBase, Chip, CircularProgress, Collapse, Skeleton, Stack, Tooltip, Typography, useTheme, type Theme } from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import ElectricalServicesRoundedIcon from '@mui/icons-material/ElectricalServicesRounded';
import ExpandMoreRoundedIcon from '@mui/icons-material/ExpandMoreRounded';
import PsychologyAltOutlinedIcon from '@mui/icons-material/PsychologyAltOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import HorizontalRuleRoundedIcon from '@mui/icons-material/HorizontalRuleRounded';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { useEventDetail } from '../../api/client';
import type { FindingLite, TextItem, ToolItem, TimelineItem } from '../../api/types';
import { CategoryChip, ChannelBadge, ToneChip } from '../../components/Chips';
import { CodeBlock } from '../../components/CodeBlock';
import { CopyButton } from '../../components/Common';
import { markdownSx } from '../../components/Markdown';
import { DecisionBadge, useDecisionMap, useToolDecision } from './DecisionBadge';
import { fmtDateTime, fmtDuration, fmtNum } from '../../lib/format';
import { toolSummary } from './timelineModel';

// ── Helpers ──────────────────────────────────────────────────────────────

export function Highlight({ text, q }: { text: string; q?: string }) {
  const query = q?.trim();
  if (!query || query.length < 2) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const j = lower.indexOf(needle, i);
    if (j === -1) break;
    parts.push(text.slice(i, j), <mark key={k++}>{text.slice(j, j + needle.length)}</mark>);
    i = j + needle.length;
  }
  parts.push(text.slice(i));
  return <>{parts.map((p, n) => <Fragment key={n}>{p}</Fragment>)}</>;
}

function Stamp({ iso, align = 'left' }: { iso: string; align?: 'left' | 'right' }) {
  return <Typography variant="caption" component="div" sx={{ mt: 0.5, textAlign: align }}>{fmtDateTime(iso)}</Typography>;
}

function FindingChips({ findings }: { findings?: FindingLite[] }) {
  const t = useTheme().tokens;
  const shown = (findings ?? []).filter(f => f.kind === 'detector' || f.kind === 'risk' || f.kind === 'policy');
  if (!shown.length) return null;
  const uniq = [...new Map(shown.map(f => [`${f.kind}:${f.key}`, f])).values()];
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
      {uniq.map(f => {
        const tone = f.kind === 'detector'
          ? (f.severity === 'high' ? t.severity.high : t.severity.medium)
          : t.severity[(f.severity as keyof typeof t.severity) ?? 'info'] ?? t.severity.info;
        return (
          <Tooltip key={`${f.kind}:${f.key}`} title={f.sample ? `Sample: ${f.sample}` : f.kind === 'risk' ? 'Risk rule matched' : f.label}>
            <ToneChip tone={tone} label={f.label} sx={{ height: 20, fontSize: 11 }} />
          </Tooltip>
        );
      })}
    </Stack>
  );
}

// ── Text items ───────────────────────────────────────────────────────────

export const PromptBubble = memo(function PromptBubble({ item, q }: { item: TextItem; q?: string }) {
  const [more, setMore] = useState(false);
  const long = item.text.length > 700 || item.text.split('\n').length > 10;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', pl: { xs: 2, sm: 8 } }}>
      <Box sx={{
        maxWidth: '100%', px: 2, py: 1.25, borderRadius: '16px 16px 4px 16px', bgcolor: 'action.selected',
        border: '1px solid', borderColor: 'divider', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13.5, lineHeight: 1.6,
      }}>
        <Box sx={long && !more ? { display: '-webkit-box', WebkitLineClamp: 10, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : undefined}>
          <Highlight text={item.text} q={q} />
        </Box>
        {long && (
          <ButtonBase onClick={() => setMore(m => !m)} sx={{ mt: 0.75, fontSize: 12, fontWeight: 600, color: 'primary.main', borderRadius: 1, px: 0.5 }}>
            {more ? 'Show less' : 'Show more'}
          </ButtonBase>
        )}
      </Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 0.5 }}>
        <FindingChips findings={item.findings} />
        {item.hook && <ChannelBadge channel="log" confirmed />}
      </Stack>
      <Stamp iso={item.t} align="right" />
    </Box>
  );
});

export const AssistantMessage = memo(function AssistantMessage({ item, q }: { item: TextItem; q?: string }) {
  const searching = !!q && q.trim().length >= 2 && item.text.toLowerCase().includes(q.trim().toLowerCase());
  return (
    <Box sx={{ pr: { xs: 1, sm: 6 } }}>
      {searching ? (
        <Box sx={{ ...markdownSx, whiteSpace: 'pre-wrap' }}><Highlight text={item.text} q={q} /></Box>
      ) : (
        <Box sx={markdownSx}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{item.text}</ReactMarkdown>
        </Box>
      )}
      {item.truncated && <Typography variant="caption">Message truncated</Typography>}
      <Stamp iso={item.t} />
    </Box>
  );
});

export const ThinkingBlock = memo(function ThinkingBlock({ item, q, open, onToggle }: { item: TextItem; q?: string; open: boolean; onToggle: () => void }) {
  const detail = useEventDetail(open && item.truncated ? item.id : null);
  const full = (detail.data?.event.payload as { thinking?: string } | undefined)?.thinking ?? item.text;
  return (
    <Box sx={{ pr: { xs: 1, sm: 6 } }}>
      <ButtonBase
        onClick={onToggle}
        aria-expanded={open}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, py: 0.5, px: 1, ml: -1, borderRadius: 1.5, color: 'text.secondary', '&:hover': { bgcolor: 'action.hover' } }}
      >
        <PsychologyAltOutlinedIcon sx={{ fontSize: 16 }} />
        <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>Thinking</Typography>
        {!open && <Typography variant="body2" noWrap sx={{ color: 'text.disabled', minWidth: 0 }}>{item.text.replace(/\s+/g, ' ')}</Typography>}
        <ExpandMoreRoundedIcon sx={{ fontSize: 18, ml: 'auto', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'none' }} />
      </ButtonBase>
      <Collapse in={open} timeout={220} unmountOnExit>
        <Box sx={{ mt: 0.5, pl: 1.5, borderLeft: '2px solid', borderColor: 'divider', color: 'text.secondary', fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {detail.isLoading ? <Skeleton width="80%" /> : <Highlight text={full} q={q} />}
        </Box>
      </Collapse>
    </Box>
  );
});

// ── Tools ────────────────────────────────────────────────────────────────

function StatusIcon({ status, live }: { status: string; live?: boolean }) {
  if (status === 'error') return <CloseRoundedIcon sx={{ fontSize: 15, color: 'error.main' }} aria-label="Failed" />;
  if (status === 'pending') {
    return live
      ? <CircularProgress size={12} thickness={5} aria-label="Running" />
      : <HorizontalRuleRoundedIcon sx={{ fontSize: 15, color: 'text.disabled' }} aria-label="No result recorded" />;
  }
  return <CheckRoundedIcon sx={{ fontSize: 15, color: 'success.main' }} aria-label="Succeeded" />;
}

function riskTone(risk: string | null, t: Theme['tokens']) {
  if (risk === 'critical') return t.severity.critical;
  if (risk === 'high') return t.severity.high;
  if (risk === 'medium') return t.severity.medium;
  return null;
}

function ToolDetail({ item }: { item: ToolItem }) {
  const { data, isLoading, isError } = useEventDetail(item.id, item.resultId);
  if (isLoading) return <Stack spacing={1} sx={{ p: 1.5 }}><Skeleton width="40%" /><Skeleton variant="rounded" height={64} /></Stack>;
  if (isError || !data) return <Typography variant="body2" color="error" sx={{ p: 1.5 }}>Could not load tool details.</Typography>;
  const input = (data.event.payload as Record<string, unknown>).tool_input;
  const resPayload = (data.result?.payload ?? (data.event.event_type === 'tool_result' ? data.event.payload : {})) as Record<string, unknown>;
  const output = resPayload.tool_result ?? resPayload.tool_response ?? resPayload.output;
  const outText = output == null ? '' : typeof output === 'string' ? output : JSON.stringify(output, null, 2);
  const error = data.result?.error_text ?? data.event.error_text;
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <Typography sx={{ fontFamily: 'var(--am-mono)', fontSize: 12.5, fontWeight: 600 }}>{item.name}</Typography>
        <CategoryChip category={item.category} />
        {item.mcpServer && <Chip size="small" variant="outlined" icon={<ElectricalServicesRoundedIcon sx={{ fontSize: '14px !important' }} />} label={item.mcpServer} />}
        <ChannelBadge channel={item.channel} confirmed={item.hook} />
        <Box sx={{ flex: 1 }} />
        {item.durationMs != null && <Typography variant="caption">{fmtDuration(item.durationMs)}</Typography>}
        <Typography variant="caption">{fmtDateTime(item.t)}</Typography>
      </Stack>
      {input !== undefined && (
        <Box>
          <Typography variant="overline" color="text.secondary">Request</Typography>
          <CodeBlock text={typeof input === 'string' ? input : JSON.stringify(input, null, 2)} json={typeof input !== 'string'} maxHeight={260} />
        </Box>
      )}
      <Box>
        <Typography variant="overline" color="text.secondary">Response</Typography>
        <Typography variant="body2" sx={{ color: item.status === 'error' ? 'error.main' : item.status === 'pending' ? 'text.secondary' : 'success.main', fontWeight: 500, mb: outText || error ? 0.75 : 0 }}>
          {item.status === 'error' ? 'Failed' : item.status === 'pending' ? 'No result recorded' : 'Succeeded'}
        </Typography>
        {error && <CodeBlock text={error} maxHeight={160} wrapDefault />}
        {outText && <CodeBlock text={outText} maxHeight={260} wrapDefault />}
      </Box>
      {data.findings.length > 0 && (
        <Box>
          <Typography variant="overline" color="text.secondary">Findings</Typography>
          <FindingChips findings={data.findings} />
        </Box>
      )}
    </Box>
  );
}

export const ToolRow = memo(function ToolRow({ item, open, onToggle, live, q, current }: {
  item: ToolItem; open: boolean; onToggle: () => void; live?: boolean; q?: string; current?: boolean;
}) {
  const t = useTheme().tokens;
  const tone = riskTone(item.risk, t);
  const decision = useToolDecision(item.id);
  return (
    <Box sx={{
      border: '1px solid', borderColor: open ? 'text.disabled' : 'divider', borderRadius: 2, bgcolor: 'background.paper',
      transition: 'border-color 150ms', overflow: 'hidden',
      animation: current ? 'am-match 900ms ease-out 2' : undefined,
    }}>
      <Stack direction="row" sx={{ alignItems: 'center' }}>
      <ButtonBase
        onClick={onToggle}
        aria-expanded={open}
        sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.75, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}
      >
        <StatusIcon status={item.status} live={live} />
        {item.mcpServer ? <ElectricalServicesRoundedIcon sx={{ fontSize: 14, color: 'text.disabled' }} /> : <BuildOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled' }} />}
        <Typography component="span" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12.5, fontWeight: 600, flexShrink: 0 }}>
          <Highlight text={item.name} q={q} />
        </Typography>
        <CategoryChip category={item.category} />
        <Typography component="span" variant="body2" noWrap sx={{ color: 'text.secondary', minWidth: 0, flex: 1, fontSize: 12.5 }}>
          <Highlight text={item.error ?? item.preview} q={q} />
        </Typography>
        {tone && <ToneChip tone={tone} label={item.findings.find(f => f.kind === 'risk')?.label ?? `${item.risk} risk`} sx={{ height: 20, fontSize: 11, maxWidth: 200 }} />}
        {item.findings.some(f => f.kind === 'detector') && <ToneChip tone={t.severity.high} label="sensitive" sx={{ height: 20, fontSize: 11 }} />}
        {(item.channel !== 'log' || item.hook) && item.channel !== 'poll' && <ChannelBadge channel={item.channel} confirmed={item.hook} />}
        {item.durationMs != null && <Typography variant="caption" sx={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{fmtDuration(item.durationMs)}</Typography>}
        <ExpandMoreRoundedIcon sx={{ fontSize: 18, color: 'text.disabled', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'none' }} />
      </ButtonBase>
      {decision && <Box sx={{ pr: 1, flexShrink: 0 }}><DecisionBadge decision={decision} /></Box>}
      </Stack>
      <Collapse in={open} timeout={220} unmountOnExit>
        <Box sx={{ borderTop: '1px solid', borderColor: 'divider' }}><ToolDetail item={item} /></Box>
      </Collapse>
    </Box>
  );
});

export function ToolGroup({ items, entries, groupOpen, onToggleGroup, openTools, onToggleTool, openThinking, onToggleThinking, live, q, currentItem }: {
  items: ToolItem[]; entries: (ToolItem | TextItem)[]; groupOpen: boolean; onToggleGroup: () => void; openTools: ReadonlySet<number>; onToggleTool: (id: number) => void;
  openThinking: ReadonlySet<number>; onToggleThinking: (id: number) => void; live?: boolean; q?: string; currentItem?: number | null;
}) {
  const t = useTheme().tokens;
  const dmap = useDecisionMap();
  const renderEntry = (e: ToolItem | TextItem) => (e.kind === 'tool'
    ? <ToolRow key={`t${e.id}`} item={e} open={openTools.has(e.id)} onToggle={() => onToggleTool(e.id)} live={live} q={q} current={currentItem === e.id} />
    : <Box key={`h${e.id}`} sx={{ px: 1 }}><ThinkingBlock item={e} q={q} open={openThinking.has(e.id) || currentItem === e.id} onToggle={() => onToggleThinking(e.id)} /></Box>);
  if (items.length === 1) {
    return <Stack spacing={0.5}>{entries.map(renderEntry)}</Stack>;
  }
  const thoughts = entries.length - items.length;
  const summary = toolSummary(items);
  const errors = items.filter(i => i.status === 'error').length;
  const running = items.filter(i => i.status === 'pending').length;
  const worst = items.find(i => i.risk === 'critical') ?? items.find(i => i.risk === 'high') ?? items.find(i => i.risk === 'medium');
  const tone = worst ? riskTone(worst.risk, t) : null;
  const sensitive = items.some(i => i.findings.some(f => f.kind === 'detector'));
  const total = items.reduce((n, i) => n + (i.durationMs ?? 0), 0);
  const govDenied = items.filter(i => { const d = dmap.get(i.id); return !!d && (d.verdict === 'deny' || d.wouldDeny); }).length;
  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper', overflow: 'hidden' }}>
      <ButtonBase
        onClick={onToggleGroup}
        aria-expanded={groupOpen}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 1, px: 1.25, py: 0.85, textAlign: 'left', '&:hover': { bgcolor: 'action.hover' } }}
      >
        {errors ? <CloseRoundedIcon sx={{ fontSize: 15, color: 'error.main' }} /> : running && live ? <CircularProgress size={12} thickness={5} /> : <CheckRoundedIcon sx={{ fontSize: 15, color: 'success.main' }} />}
        <BuildOutlinedIcon sx={{ fontSize: 13, color: 'text.disabled' }} />
        <Typography variant="body2" sx={{ fontWeight: 600, flexShrink: 0 }}>{fmtNum(items.length)} tool calls</Typography>
        <Typography variant="body2" noWrap sx={{ color: 'text.secondary', minWidth: 0, flex: 1, fontSize: 12.5 }}>
          {summary.slice(0, 4).map(s => `${s.name} ×${s.count}`).join(' · ')}{summary.length > 4 ? ` · +${summary.length - 4} more` : ''}
        </Typography>
        {thoughts > 0 && (
          <Tooltip title={`${thoughts} reasoning note${thoughts === 1 ? '' : 's'} inside`}>
            <Stack direction="row" spacing={0.25} sx={{ alignItems: 'center', color: 'text.disabled', flexShrink: 0 }}>
              <PsychologyAltOutlinedIcon sx={{ fontSize: 14 }} /><Typography variant="caption">{thoughts}</Typography>
            </Stack>
          </Tooltip>
        )}
        {errors > 0 && <ToneChip tone={t.severity.critical} label={`${errors} failed`} sx={{ height: 20, fontSize: 11 }} />}
        {govDenied > 0 && <ToneChip tone={t.severity.critical} icon={<ShieldOutlinedIcon sx={{ fontSize: '13px !important', color: `${t.severity.critical.fg} !important` }} />} label={`${govDenied} denied by policy`} sx={{ height: 20, fontSize: 11 }} />}
        {tone && <ToneChip tone={tone} label={`${worst!.risk} risk`} sx={{ height: 20, fontSize: 11 }} />}
        {sensitive && <ToneChip tone={t.severity.high} label="sensitive" sx={{ height: 20, fontSize: 11 }} />}
        {total > 0 && <Typography variant="caption" sx={{ flexShrink: 0 }}>{fmtDuration(total)}</Typography>}
        <ExpandMoreRoundedIcon sx={{ fontSize: 18, color: 'text.disabled', transition: 'transform 200ms', transform: groupOpen ? 'rotate(180deg)' : 'none' }} />
      </ButtonBase>
      <Collapse in={groupOpen} timeout={240} unmountOnExit>
        <Stack spacing={0.75} sx={{ p: 1, pt: 0.25, borderTop: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
          <Box sx={{ height: 4 }} />
          {entries.map(renderEntry)}
        </Stack>
      </Collapse>
    </Box>
  );
}

// ── Markers ──────────────────────────────────────────────────────────────

export function SubagentMarker({ item, agentName }: { item: Extract<TimelineItem, { kind: 'subagent' }>; agentName: string }) {
  const start = item.phase === 'start';
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', py: 0.5, color: 'text.secondary' }}>
      <Box sx={{ width: 24, height: 24, borderRadius: '7px', display: 'grid', placeItems: 'center', bgcolor: 'action.hover', border: '1px solid', borderColor: 'divider' }}>
        <AccountTreeOutlinedIcon sx={{ fontSize: 14 }} />
      </Box>
      <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.primary' }}>{start ? 'Subagent started' : 'Subagent finished'}</Typography>
      <Typography variant="body2" noWrap sx={{ minWidth: 0 }}>{agentName}</Typography>
      {item.agentType && <Chip size="small" variant="outlined" label={item.agentType} />}
      {!start && item.status === 'error' && <Chip size="small" color="error" variant="outlined" label="failed / cancelled" />}
      <Box sx={{ flex: 1 }} />
      <Typography variant="caption">{fmtDateTime(item.t)}</Typography>
    </Stack>
  );
}

export function PolicyNotice({ item }: { item: Extract<TimelineItem, { kind: 'policy' }> }) {
  const t = useTheme().tokens;
  const tone = item.outcome === 'blocked' ? t.severity.critical : item.outcome === 'denied' ? t.severity.high : item.outcome === 'warned' ? t.severity.medium : t.severity.info;
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', px: 1.25, py: 0.85, borderRadius: 2, border: '1px solid', borderColor: tone.border, bgcolor: tone.bg }}>
      <ShieldOutlinedIcon sx={{ fontSize: 16, color: tone.fg }} />
      <Typography variant="body2" sx={{ color: tone.fg, fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 }}>{item.outcome}</Typography>
      <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: 1 }}>{item.label}</Typography>
      <CopyButton text={item.label} />
    </Stack>
  );
}

export function LifecycleRule({ item }: { item: Extract<TimelineItem, { kind: 'lifecycle' }> }) {
  const label = ({ SessionStart: 'Session started', SessionEnd: 'Session ended', SessionResume: 'Session resumed', ModeChange: 'Mode changed', PermissionsChange: 'Permissions changed', PermissionResult: 'Permission' } as Record<string, string>)[item.label] ?? item.label;
  const extra = [item.detail, item.model && item.model !== item.detail ? item.model : null, item.tokens ? `${fmtNum(item.tokens)} tokens` : null].filter(Boolean).join(' · ');
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 0.5, color: 'text.disabled', '&::before, &::after': { content: '""', flex: 1, height: '1px', bgcolor: 'divider' } }}>
      <Typography variant="caption" sx={{ whiteSpace: 'nowrap', maxWidth: '70%', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        <b>{label}</b>{extra ? ` · ${extra}` : ''}
      </Typography>
    </Stack>
  );
}

export function GapDivider({ label }: { label: string }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', py: 1, '&::before, &::after': { content: '""', flex: 1, height: '1px', bgcolor: 'divider' } }}>
      <Chip size="small" variant="outlined" label={label} sx={{ color: 'text.secondary', bgcolor: 'background.default' }} />
    </Stack>
  );
}

export function NotificationRow({ item }: { item: Extract<TimelineItem, { kind: 'notification' }> }) {
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-start', color: 'text.secondary', py: 0.25 }}>
      <InfoOutlinedIcon sx={{ fontSize: 15, mt: '2px' }} />
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.text}</Typography>
    </Stack>
  );
}
