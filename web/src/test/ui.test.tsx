import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import type { ReactNode } from 'react';
import { buildTheme } from '../theme/theme';
import { SeverityChip, AutonomyChip } from '../components/Chips';
import { DetectorChips } from '../components/DetectorChips';
import { buildBlocks, findMatches } from '../pages/conversation/timelineModel';
import { applyLiveUpdate } from '../api/live';
import { applyFilters } from '../lib/filters';
import { fmtDelta } from '../lib/format';
import type { Conversation, ConversationDetail, TimelineItem, ToolItem } from '../api/types';

const wrap = (ui: ReactNode) => render(<ThemeProvider theme={buildTheme('dark')}>{ui}</ThemeProvider>);

const tool = (id: number, name: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool', id, resultId: null, t: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), agentId: 'main', name,
  mcpServer: null, category: 'READ', status: 'success', durationMs: 10, preview: `preview ${name}`, risk: null,
  channel: 'log', hook: false, error: null, findings: [], ...extra,
});

const text = (id: number, kind: 'prompt' | 'assistant' | 'thinking', body: string, t?: string): TimelineItem => ({
  kind, id, t: t ?? new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), agentId: 'main', text: body, truncated: false, channel: 'log',
});

describe('chips', () => {
  it('renders severity with an accessible label', () => {
    wrap(<SeverityChip severity="critical" />);
    expect(screen.getByLabelText('Severity Critical')).toHaveTextContent('Critical');
  });

  it('renders autonomy level and label', () => {
    wrap(<AutonomyChip level={3} label="Autonomous" />);
    expect(screen.getByText('3 · Autonomous')).toBeInTheDocument();
  });

  it('collapses extra detectors into a +N chip', () => {
    wrap(<DetectorChips detectors={[
      { key: 'a', label: 'Secret Key (GitHub)', count: 2, cls: 'secret' },
      { key: 'b', label: 'JSON Web Token', count: 1, cls: 'secret' },
      { key: 'c', label: 'Email Address', count: 9, cls: 'pii' },
      { key: 'd', label: 'Private Key', count: 1, cls: 'secret' },
    ]} />);
    expect(screen.getByText('Secret Key (GitHub)')).toBeInTheDocument();
    expect(screen.getByText('JSON Web Token')).toBeInTheDocument();
    expect(screen.queryByText('Email Address')).not.toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('shows a dash when there is no sensitive data', () => {
    wrap(<DetectorChips detectors={[]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('timeline model', () => {
  const items: TimelineItem[] = [
    text(1, 'prompt', 'Please fix the login bug'),
    tool(2, 'view'), tool(3, 'grep'), tool(4, 'view', { risk: 'high' }),
    text(5, 'assistant', 'I found the **bug** in auth.ts'),
    tool(6, 'powershell', { agentId: 'sub-1' }),
    tool(7, 'edit'),
  ];

  it('groups consecutive tool calls per agent', () => {
    const blocks = buildBlocks(items, 'all');
    expect(blocks.map(b => b.type)).toEqual(['text', 'tools', 'text', 'tools', 'tools']);
    const g = blocks[1];
    expect(g.type === 'tools' && g.items.map(i => i.id)).toEqual([2, 3, 4]);
    const sub = blocks[3];
    expect(sub.type === 'tools' && sub.sub).toBe(true);
  });

  it('folds reasoning notes between tool calls into the group', () => {
    const blocks = buildBlocks([tool(1, 'view'), text(2, 'thinking', 'hmm'), tool(3, 'grep'), text(4, 'thinking', 'done'), text(5, 'assistant', 'ok')], 'all');
    expect(blocks.map(b => b.type)).toEqual(['tools', 'text', 'text']);
    const g = blocks[0];
    expect(g.type === 'tools' && g.entries.map(e => e.id)).toEqual([1, 2, 3]);
    expect(g.type === 'tools' && g.items).toHaveLength(2);
  });

  it('filters to messages, tools and findings', () => {
    expect(buildBlocks(items, 'messages').every(b => b.type === 'text')).toBe(true);
    expect(buildBlocks(items, 'tools').every(b => b.type === 'tools')).toBe(true);
    const findings = buildBlocks(items, 'findings');
    expect(findings).toHaveLength(1);
    expect(findings[0].type === 'tools' && findings[0].items[0].id).toBe(4);
  });

  it('inserts a gap divider after long pauses', () => {
    const blocks = buildBlocks([
      text(1, 'prompt', 'a', '2026-01-01T00:00:00Z'),
      text(2, 'assistant', 'b', '2026-01-01T00:45:00Z'),
    ], 'all');
    expect(blocks[1]).toMatchObject({ type: 'gap', label: '45 min later' });
  });

  it('finds search matches across text and tool previews', () => {
    const blocks = buildBlocks(items, 'all');
    expect(findMatches(blocks, 'bug').map(m => m.itemId)).toEqual([1, 5]);
    expect(findMatches(blocks, 'preview grep').map(m => m.itemId)).toEqual([3]);
    expect(findMatches(blocks, 'x')).toEqual([]);
  });
});

describe('live updates', () => {
  const detail = { conversation: {} as Conversation, agents: [], timeline: [tool(1, 'view', { status: 'pending' })] } as ConversationDetail;

  it('patches a pending tool with its result', () => {
    const next = applyLiveUpdate(detail, { op: 'tool_result', callId: 1, resultId: 9, status: 'error', durationMs: 42, error: 'boom', findings: [] });
    expect(next.timeline[0]).toMatchObject({ status: 'error', resultId: 9, durationMs: 42, error: 'boom' });
  });

  it('appends new items once', () => {
    const item = text(2, 'assistant', 'hi');
    const once = applyLiveUpdate(detail, { op: 'append', item });
    expect(applyLiveUpdate(once, { op: 'append', item }).timeline).toHaveLength(2);
  });
});

describe('filters and formatting', () => {
  const base = {
    id: 'abc', agentKey: 'copilot-cli', agentName: 'Copilot CLI', agentKind: '', title: 'Fix login', projectPath: null, user: 'u', endpoint: 'e', model: null,
    startedAt: null, lastActivityAt: null, endedAt: null, live: false, prompts: 1, actions: 1, builtin: 1, mcp: 0, riskyActions: 0,
    severity: 'low', severityReasons: [], autonomyLevel: 3, autonomyLabel: 'Autonomous', detectors: [], domains: 0, mcpServers: 0,
    domainKeys: ['github.com'], mcpKeys: [], enforcement: { blocked: 0, denied: 0, warned: 0, prompted: 0 }, channels: ['log'],
  } as Conversation;
  const rows: Conversation[] = [base, { ...base, id: 'def', agentKey: 'claude-code', severity: 'high', title: 'Deploy', domainKeys: [], detectors: [{ key: 'jwt', label: 'JSON Web Token', count: 1, cls: 'secret' }] }];

  it('applies agent, severity, data, connect and search filters', () => {
    expect(applyFilters(rows, { agent: ['claude-code'] }).map(r => r.id)).toEqual(['def']);
    expect(applyFilters(rows, { severity: ['low'] }).map(r => r.id)).toEqual(['abc']);
    expect(applyFilters(rows, { data: ['any'] }).map(r => r.id)).toEqual(['def']);
    expect(applyFilters(rows, { connect: ['github.com'] }).map(r => r.id)).toEqual(['abc']);
    expect(applyFilters(rows, { q: 'deploy' }).map(r => r.id)).toEqual(['def']);
  });

  it('formats period deltas like the mockups', () => {
    expect(fmtDelta(2, 1)).toEqual({ label: '100%', dir: 'up' });
    expect(fmtDelta(36, 5)).toEqual({ label: '620%', dir: 'up' });
    expect(fmtDelta(300, 2).label).toBe('>999%');
    expect(fmtDelta(3, 0)).toEqual({ label: 'New', dir: 'up' });
    expect(fmtDelta(1, 2)).toEqual({ label: '50%', dir: 'down' });
  });
});
