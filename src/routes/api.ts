import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { all, get, DB_PATH } from '../db';
import { rules, thresholds, DEFAULT_THRESHOLDS } from '../analytics/rules';
import { listRiskRules } from '../analytics/risk';
import { listDetectors } from '../analytics/detectors';
import { REDACTION_MODE } from '../analytics/redact';
import { maintenance } from '../pipeline';
import { replayTranscript } from '../transcript-watcher';
import { buildTimeline, EventRow, FindingRow, TimelineItem, toolPreview } from '../timeline';
import { parseRange, listConversations, overview, topAgents, connections, enforcements, ConversationRow } from '../queries';
import { collectorStatuses } from '../collectors/registry';
import { config } from '../config';

const router = Router();

function list(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function parsePayload(p: unknown): unknown {
  if (typeof p !== 'string') return p ?? {};
  try { return JSON.parse(p); } catch { return {}; }
}

// ── Dashboard ────────────────────────────────────────────────────────────

router.get('/overview', (req: Request, res: Response) => {
  res.json(overview(parseRange(req.query)));
});

router.get('/agents', (req: Request, res: Response) => {
  res.json(topAgents(parseRange(req.query)));
});

router.get('/connections', (req: Request, res: Response) => {
  res.json(connections(parseRange(req.query), Math.min(Number(req.query.top) || 12, 50)));
});

router.get('/conversations', (req: Request, res: Response) => {
  const rows = listConversations(parseRange(req.query), { agents: list(req.query.agent), limit: Number(req.query.limit) || 2000 });
  res.json(rows);
});

function loadConversation(id: string) {
  const conv = listConversations(null, { ids: [id] })[0];
  if (!conv) return null;
  const events = all<EventRow>('SELECT * FROM events WHERE session_id = ? ORDER BY created_at, id', [id]);
  const findings = all<FindingRow>('SELECT * FROM findings WHERE session_id = ?', [id]);
  const agents = all<Record<string, unknown>>('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at', [id]);
  const timeline = buildTimeline(events, findings);
  const names = new Map<string, string>();
  for (const it of timeline) if (it.kind === 'subagent' && it.phase === 'start') names.set(it.agentId, it.name);
  return {
    conversation: conv,
    agents: agents.map(a => ({
      id: a.id, name: names.get(String(a.id)) ?? (a.id === 'main' ? 'Main agent' : String(a.id).slice(0, 8)),
      type: a.agent_type, status: a.status, parentId: a.parent_agent_id, startedAt: a.started_at, endedAt: a.ended_at,
    })),
    timeline,
  };
}

router.get('/conversations/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = get<Record<string, unknown>>('SELECT transcript_path, agent_key FROM sessions WHERE id = ?', [id]);
  if (!session) { res.status(404).json({ error: 'conversation not found' }); return; }
  if (typeof session.transcript_path === 'string' && session.transcript_path && session.agent_key === 'claude-code') {
    const tp = session.transcript_path;
    setImmediate(() => replayTranscript(id, tp));
  }
  res.json(loadConversation(id));
});

function toMarkdown(conv: ConversationRow, timeline: TimelineItem[]): string {
  const lines: string[] = [
    `# ${conv.title ?? conv.id}`, '',
    `- **Agent:** ${conv.agentName}`,
    `- **Conversation:** \`${conv.id}\``,
    `- **User / endpoint:** ${conv.user ?? '—'} / ${conv.endpoint ?? '—'}`,
    `- **Severity:** ${conv.severity} (${conv.severityReasons.join('; ')})`,
    `- **Prompts / actions:** ${conv.prompts} / ${conv.actions}`, '',
  ];
  for (const it of timeline) {
    const t = new Date(it.t).toISOString();
    switch (it.kind) {
      case 'prompt': lines.push(`## 🧑 User — ${t}`, '', it.text, ''); break;
      case 'assistant': lines.push(`## 🤖 Assistant — ${t}`, '', it.text, ''); break;
      case 'thinking': lines.push(`<details><summary>Thinking — ${t}</summary>`, '', it.text, '', '</details>', ''); break;
      case 'tool': lines.push(`- \`${it.name}\` ${it.status === 'error' ? '✗' : '✓'} ${it.preview ? '— ' + it.preview.replace(/\n/g, ' ') : ''}`); break;
      case 'subagent': lines.push('', `### ${it.phase === 'start' ? '▶ Subagent started' : '■ Subagent finished'}: ${it.name}`, ''); break;
      case 'policy': lines.push(`> **${it.outcome}** — ${it.label}`, ''); break;
      case 'notification': lines.push(`> ${it.text}`, ''); break;
      default: break;
    }
  }
  return lines.join('\n');
}

router.get('/conversations/:id/export', (req: Request, res: Response) => {
  const data = loadConversation(req.params.id);
  if (!data) { res.status(404).json({ error: 'conversation not found' }); return; }
  const base = `conversation-${req.params.id.slice(0, 8)}`;
  if (req.query.format === 'md') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.md"`);
    res.send(toMarkdown(data.conversation, data.timeline));
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename="${base}.json"`);
  res.json(data);
});

// Full detail for one event (payloads are omitted from the timeline to keep it small).
router.get('/events/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const ev = get<EventRow>('SELECT * FROM events WHERE id = ?', [id]);
  if (!ev) { res.status(404).json({ error: 'event not found' }); return; }
  const resultId = Number(req.query.result) || null;
  const result = resultId
    ? get<EventRow>('SELECT * FROM events WHERE id = ?', [resultId])
    : get<EventRow>(`SELECT * FROM events WHERE parent_event_id = ? AND event_type = 'tool_result' LIMIT 1`, [id]);
  const ids = [id, result?.id].filter((x): x is number => x != null);
  const findings = all<FindingRow>(`SELECT * FROM findings WHERE event_id IN (${ids.map(() => '?').join(',')})`, ids);
  res.json({
    event: { ...ev, payload: parsePayload(ev.payload) },
    result: result ? { ...result, payload: parsePayload(result.payload) } : null,
    findings: findings.map(f => ({ kind: f.kind, key: f.key, label: f.label, severity: f.severity, sample: f.masked_sample })),
  });
});

router.get('/enforcements', (req: Request, res: Response) => {
  res.json(enforcements(parseRange(req.query)));
});

// ── Export activity logs ─────────────────────────────────────────────────

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/export', (req: Request, res: Response) => {
  const r = parseRange(req.query);
  const format = req.query.format === 'jsonl' ? 'jsonl' : 'csv';
  const agents = list(req.query.agent);
  const params: (string | number)[] = [r.from, r.to];
  let agentSql = '';
  if (agents?.length) {
    agentSql = ` AND COALESCE(s.agent_key, s.source) IN (${agents.map(() => '?').join(',')})`;
    params.push(...agents);
  }
  const rows = all<EventRow & { title: string | null; agent_key: string; user: string | null; endpoint: string | null; findings: string | null }>(
    `SELECT e.*, s.title, COALESCE(s.agent_key, s.source) AS agent_key, s.user, s.endpoint,
       (SELECT GROUP_CONCAT(f.label, '; ') FROM findings f WHERE f.event_id = e.id) AS findings
     FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE e.created_at >= ? AND e.created_at <= ? AND e.event_type != 'terminal_chunk'
       AND NOT (e.capture_channel = 'hook' AND e.correlated_event_id IS NOT NULL)${agentSql}
     ORDER BY e.created_at`, params);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="agent-activity-${stamp}.${format}"`);
  const fields = ['created_at', 'session_id', 'title', 'agent_key', 'user', 'endpoint', 'agent_id', 'event_type', 'tool_name',
    'category', 'mcp_server', 'status', 'risk_level', 'duration_ms', 'capture_channel', 'model', 'findings', 'preview'];
  const preview = (e: EventRow) => {
    const p = parsePayload(e.payload) as Record<string, unknown>;
    if (e.event_type === 'tool_call') return toolPreview(p.tool_input);
    const t = p.prompt ?? p.text ?? p.message;
    return typeof t === 'string' ? t.slice(0, 300) : '';
  };
  if (format === 'jsonl') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.send(rows.map(e => JSON.stringify(Object.fromEntries(fields.map(f => [f, f === 'preview' ? preview(e) : (e as unknown as Record<string, unknown>)[f]])))).join('\n'));
    return;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const out = [fields.join(',')];
  for (const e of rows) out.push(fields.map(f => csvCell(f === 'preview' ? preview(e) : (e as unknown as Record<string, unknown>)[f])).join(','));
  res.send(out.join('\r\n'));
});

// ── Sources ──────────────────────────────────────────────────────────────

function fileContains(file: string, needle: string): boolean {
  try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
}

router.get('/sources', (_req: Request, res: Response) => {
  const statuses = new Map(collectorStatuses().map(s => [s.id, s]));
  const stat = (agent: string, channel: string) => get<{ last: string | null; c: number }>(
    `SELECT MAX(e.created_at) AS last, COUNT(*) AS c FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE COALESCE(s.agent_key, s.source) = ? AND e.capture_channel = ?`, [agent, channel]) ?? { last: null, c: 0 };
  const copilotHome = config.copilotCli.home ?? path.join(os.homedir(), '.copilot');
  const sources = [
    { id: 'claude-code', agentKey: 'claude-code', name: 'Claude Code', channel: 'hook',
      enabled: statuses.has('claude-code'),
      configured: fileContains(path.join(os.homedir(), '.claude', 'settings.json'), '/ingest/claude-code'),
      setup: 'Run .\\install.ps1 to add HTTP hooks to ~/.claude/settings.json, then restart Claude Code.' },
    { id: 'copilot-cli', agentKey: 'copilot-cli', name: 'Copilot CLI', channel: 'log',
      enabled: statuses.has('copilot-cli'),
      configured: fs.existsSync(path.join(copilotHome, 'session-state')),
      setup: `Tails ${path.join(copilotHome, 'session-state')}\\*\\events.jsonl automatically (last ${config.copilotCli.importDays} days on first run). Disable with COPILOT_CLI_ENABLED=false.` },
    { id: 'copilot-cli-hooks', agentKey: 'copilot-cli', name: 'Copilot CLI', channel: 'hook',
      enabled: statuses.has('copilot-cli-hooks'),
      configured: fs.existsSync(path.join(copilotHome, 'hooks', 'agent-monitor.json')),
      setup: 'Optional real-time channel. Run .\\install.ps1 -CopilotHooks to register the forwarder in ~/.copilot/hooks.' },
    { id: 'foundry', agentKey: 'foundry', name: 'Azure AI Foundry', channel: 'poll',
      enabled: statuses.has('foundry'), configured: config.foundry.enabled,
      setup: 'Set FOUNDRY_ENDPOINT and Entra ID credentials (AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_TENANT_ID).' },
    { id: 'copilot-studio', agentKey: 'copilot-studio', name: 'Copilot Studio', channel: 'poll',
      enabled: statuses.has('copilot-studio'), configured: config.copilotStudio.enabled,
      setup: 'Set DATAVERSE_ORG_URL and Entra ID credentials; the app user needs the Bot Transcript Viewer role.' },
  ].map(s => {
    const st = statuses.get(s.id);
    const ev = stat(s.agentKey, s.channel);
    return { ...s, lastEventAt: ev.last, events: ev.c, lastPollAt: st?.lastPollAt ?? null, lastError: st?.lastError ?? null, backlog: st?.backlog ?? false };
  });
  res.json(sources);
});

// ── Settings: storage, privacy and tunable rules ─────────────────────────

router.get('/settings', (_req: Request, res: Response) => {
  const r = rules();
  res.json({
    database: { path: DB_PATH, engine: 'node:sqlite (WAL)' },
    redaction: { mode: REDACTION_MODE, env: 'REDACT_PAYLOADS' },
    maintenance: { ...maintenance },
    rules: {
      path: r.path,
      exists: r.exists,
      error: r.error,
      risk: listRiskRules(),
      detectors: listDetectors(),
      domainsIgnored: r.config.domains?.ignore ?? [],
      severity: thresholds(),
      severityDefaults: DEFAULT_THRESHOLDS,
    },
  });
});

// ── Legacy endpoints (kept for compatibility) ────────────────────────────

router.get('/sessions', (_req: Request, res: Response) => {
  const rows = all(`
    SELECT s.id, s.source, s.project_path, s.title, s.started_at, s.ended_at,
           COUNT(e.id) as event_count
    FROM sessions s
    LEFT JOIN events e ON e.session_id = s.id
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 100
  `);
  res.json(rows);
});

router.get('/sessions/:id/tree', (req: Request, res: Response) => {
  const { id } = req.params;
  const session = get<Record<string, unknown>>('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!session) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  if (typeof session.transcript_path === 'string' && session.transcript_path) {
    const tp = session.transcript_path;
    setImmediate(() => replayTranscript(id, tp));
  }
  const agents = all('SELECT * FROM agents WHERE session_id = ? ORDER BY started_at', [id]);
  const events = all('SELECT * FROM events WHERE session_id = ? ORDER BY created_at', [id]);
  res.json({ session, agents, events });
});

router.get('/events', (req: Request, res: Response) => {
  const { session, agent, tool, since } = req.query;
  const limit = Math.min(Number(req.query.limit) || 200, 1000);

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];

  if (session) { conditions.push('session_id = ?'); params.push(session as string); }
  if (agent)   { conditions.push('agent_id = ?');   params.push(agent as string); }
  if (tool)    { conditions.push('tool_name = ?');   params.push(tool as string); }
  if (since)   { conditions.push('created_at > ?');  params.push(since as string); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = all(
    `SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`,
    [...params, limit],
  );

  res.json(rows);
});

export default router;
