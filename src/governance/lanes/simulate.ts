import { all } from '../../db';
import { extractFeatures } from '../features';
import type { ActionRequest, Lane } from '../types';
import laneEngine from './engine';

export interface LaneSimulationResult {
  evaluated: number;
  wouldAllow: number;
  wouldDeny: number;
  wouldJudge: number;
  wouldApprove: number;
  samples: { eventId: number; sessionId: string; tool?: string; summary: string; verdict: string; ruleIds: string[] }[];
}

function payloadArgs(payload: string | null): unknown {
  if (!payload) return undefined;
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    return p.tool_input ?? p.input ?? p.args ?? p;
  } catch { return undefined; }
}

function payloadWorkspace(payload: string | null): string | undefined {
  if (!payload) return undefined;
  try {
    const p = JSON.parse(payload) as Record<string, unknown>;
    for (const key of ['cwd', 'project_path', 'workspace']) {
      const value = p[key];
      if (typeof value === 'string' && value) return value;
    }
    const session = p.session;
    if (session && typeof session === 'object') {
      const value = (session as Record<string, unknown>).project_path ?? (session as Record<string, unknown>).cwd;
      if (typeof value === 'string' && value) return value;
    }
    for (const key of ['tool_input', 'input', 'args']) {
      const nested = p[key];
      if (nested && typeof nested === 'object') {
        const value = (nested as Record<string, unknown>).cwd;
        if (typeof value === 'string' && value) return value;
      }
    }
  } catch { /* ignore malformed historical payloads */ }
  return undefined;
}

export async function simulateLane(lane: Lane, opts: { from?: string; to?: string; agentId?: string; limit?: number } = {}): Promise<LaneSimulationResult> {
  const where = [`tool_name IS NOT NULL`];
  const params: (string | number)[] = [];
  if (opts.from) { where.push('created_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('created_at < ?'); params.push(opts.to); }
  if (opts.agentId) { where.push('agent_id = ?'); params.push(opts.agentId); }
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 10000);
  const rows = all<{ id: number; session_id: string; agent_id: string; tool_name: string; category: string | null; mcp_server: string | null; payload: string | null; created_at: string; project_path: string | null }>(
    `SELECT e.id, e.session_id, e.agent_id, e.tool_name, e.category, e.mcp_server, e.payload, e.created_at, s.project_path
       FROM events e LEFT JOIN sessions s ON s.id = e.session_id
      WHERE ${where.join(' AND ')} ORDER BY e.created_at DESC LIMIT ?`,
    [...params, limit],
  );
  const out: LaneSimulationResult = { evaluated: 0, wouldAllow: 0, wouldDeny: 0, wouldJudge: 0, wouldApprove: 0, samples: [] };
  for (const r of rows) {
    const workspace = r.project_path ?? payloadWorkspace(r.payload);
    const req: ActionRequest = {
      requestId: `event-${r.id}`, sessionId: r.session_id, checkpoint: 'pre_tool',
      agent: { surface: 'unknown', agentId: r.agent_id, cwd: workspace }, toolName: r.tool_name,
      category: r.category as ActionRequest['category'], mcpServer: r.mcp_server ?? undefined,
      args: payloadArgs(r.payload), occurredAt: r.created_at,
    };
    const f = extractFeatures(req);
    const ev = laneEngine.evaluate(lane, req, f, { tainted: false, workspace });
    out.evaluated++;
    const judgeRuleIds = ev.judge.map(m => m.ruleId);
    if (lane.defaultVerdict === 'judge') judgeRuleIds.push('default-judge');
    const ruleIds = [ev.deny, ...ev.approve, ...ev.judge, ...ev.allow].filter(Boolean).map(m => m!.ruleId);
    let verdict: 'allow' | 'deny' | 'judge' | 'approve' = 'allow';
    if (ev.deny) { out.wouldDeny++; verdict = 'deny'; }
    else if (ev.approve.length) { out.wouldApprove++; verdict = 'approve'; }
    else if (judgeRuleIds.length) { out.wouldJudge++; verdict = 'judge'; }
    else if (ev.allow.length) { out.wouldAllow++; verdict = 'allow'; }
    else if (lane.defaultVerdict === 'deny') { out.wouldDeny++; verdict = 'deny'; }
    else out.wouldAllow++;
    const verdictRuleIds = verdict === 'judge' ? judgeRuleIds : ruleIds.length ? ruleIds : verdict === 'deny' ? ['default-deny'] : [];
    if (out.samples.length < 25 && verdict !== 'allow') out.samples.push({ eventId: r.id, sessionId: r.session_id, tool: r.tool_name, summary: f.summary, verdict, ruleIds: verdictRuleIds });
  }
  return out;
}
