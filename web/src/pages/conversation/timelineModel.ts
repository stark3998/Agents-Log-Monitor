import type { TextItem, TimelineItem, ToolItem } from '../../api/types';
import { fmtGap } from '../../lib/format';

export type ViewFilter = 'all' | 'messages' | 'tools' | 'findings';

export type Block =
  | { type: 'text'; key: string; item: TextItem; sub: boolean }
  | { type: 'tools'; key: string; items: ToolItem[]; entries: (ToolItem | TextItem)[]; sub: boolean }
  | { type: 'subagent'; key: string; item: Extract<TimelineItem, { kind: 'subagent' }>; sub: boolean }
  | { type: 'policy'; key: string; item: Extract<TimelineItem, { kind: 'policy' }>; sub: boolean }
  | { type: 'lifecycle'; key: string; item: Extract<TimelineItem, { kind: 'lifecycle' }>; sub: boolean }
  | { type: 'notification'; key: string; item: Extract<TimelineItem, { kind: 'notification' }>; sub: boolean }
  | { type: 'gap'; key: string; label: string };

const GAP_MS = 10 * 60_000;
const QUIET_LIFECYCLE = new Set(['PreToolUse', 'PostToolUse', 'Stop', 'ModelChange', 'Abort']);

export function isFinding(it: TimelineItem): boolean {
  if (it.kind === 'policy') return true;
  if (it.kind === 'tool') return (it.risk != null && it.risk !== 'low') || it.findings.some(f => f.kind === 'detector' || f.kind === 'risk' || f.kind === 'policy') || it.status === 'error';
  if (it.kind === 'prompt') return !!it.findings?.length;
  return false;
}

function include(it: TimelineItem, f: ViewFilter): boolean {
  switch (f) {
    case 'messages': return it.kind === 'prompt' || it.kind === 'assistant' || it.kind === 'thinking';
    case 'tools': return it.kind === 'tool' || it.kind === 'subagent' || it.kind === 'policy';
    case 'findings': return isFinding(it);
    default:
      return !(it.kind === 'lifecycle' && QUIET_LIFECYCLE.has(it.label) && !it.tokens);
  }
}

/**
 * Turn a flat timeline into render blocks: consecutive tool calls per agent are grouped, and in the
 * "all" view the short reasoning notes emitted between tool calls are folded into the same group.
 */
export function buildBlocks(items: TimelineItem[], filter: ViewFilter): Block[] {
  const blocks: Block[] = [];
  let prevT: number | null = null;
  let pending: TextItem[] = [];
  const flush = () => {
    for (const th of pending) blocks.push({ type: 'text', key: `thinking-${th.id}`, item: th, sub: th.agentId !== 'main' });
    pending = [];
  };
  for (const it of items) {
    if (!include(it, filter)) continue;
    const t = Date.parse(it.t);
    if (filter === 'all' && prevT != null && t - prevT > GAP_MS) {
      flush();
      blocks.push({ type: 'gap', key: `gap-${it.kind}-${it.id}`, label: fmtGap(t - prevT) });
    }
    prevT = t;
    const sub = it.agentId !== 'main';
    if (it.kind === 'thinking' && filter === 'all') {
      if (pending.length && pending[0].agentId !== it.agentId) flush();
      pending.push(it);
      continue;
    }
    if (it.kind === 'tool') {
      const last = blocks[blocks.length - 1];
      const thoughts = pending.filter(p => p.agentId === it.agentId);
      if (thoughts.length !== pending.length) flush();
      pending = [];
      if (filter !== 'findings' && last?.type === 'tools' && last.items[0].agentId === it.agentId) {
        last.items.push(it);
        last.entries.push(...thoughts, it);
      } else {
        blocks.push({ type: 'tools', key: `g-${it.id}`, items: [it], entries: [...thoughts, it], sub });
      }
      continue;
    }
    flush();
    const key = `${it.kind}-${it.id}`;
    switch (it.kind) {
      case 'prompt': case 'assistant': case 'thinking':
        blocks.push({ type: 'text', key, item: it, sub }); break;
      case 'subagent': blocks.push({ type: 'subagent', key, item: it, sub: false }); break;
      case 'policy': blocks.push({ type: 'policy', key, item: it, sub }); break;
      case 'lifecycle': blocks.push({ type: 'lifecycle', key, item: it, sub }); break;
      case 'notification': blocks.push({ type: 'notification', key, item: it, sub }); break;
    }
  }
  flush();
  return blocks;
}

export interface Match { block: number; itemId: number }

function itemText(it: TimelineItem): string {
  switch (it.kind) {
    case 'prompt': case 'assistant': case 'thinking': return it.text;
    case 'tool': return `${it.name} ${it.mcpServer ?? ''} ${it.preview} ${it.error ?? ''}`;
    case 'policy': return it.label;
    case 'notification': return it.text;
    case 'subagent': return it.name;
    case 'lifecycle': return `${it.label} ${it.detail ?? ''}`;
  }
}

export function findMatches(blocks: Block[], query: string): Match[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: Match[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'gap') return;
    const items = b.type === 'tools' ? b.entries : [b.item];
    for (const it of items) if (itemText(it).toLowerCase().includes(q)) out.push({ block: i, itemId: it.id });
  });
  return out;
}

export function toolSummary(items: ToolItem[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) m.set(it.name, (m.get(it.name) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}
