import { all } from '../../db';
import { extractFeatures } from '../features';
import { applicablePolicies, mergePolicies } from '../policies';
import type { ActionRequest, Lane, Policy, RegisteredAgent } from '../types';
import laneEngine from './engine';

export interface LaneSimulationResult {
  evaluated: number;
  wouldAllow: number;
  wouldDeny: number;
  wouldJudge: number;
  wouldApprove: number;
  wouldAlert: number;
  /** Matches per rule id (all buckets), to see which rules carry the load. */
  ruleHits: Record<string, number>;
  samples: { eventId: number; sessionId: string; tool?: string; summary: string; verdict: string; ruleIds: string[] }[];
}

export interface SimulateOptions {
  from?: string; to?: string; agentId?: string; limit?: number;
  /** Policies to merge per event (global ones in scope plus those the lane attaches). */
  policies?: Policy[];
  /** Ignore policy scope (used when simulating one policy on its own). */
  ignoreScope?: boolean;
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

export async function simulateLane(lane: Lane, opts: SimulateOptions = {}): Promise<LaneSimulationResult> {
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
  const out: LaneSimulationResult = { evaluated: 0, wouldAllow: 0, wouldDeny: 0, wouldJudge: 0, wouldApprove: 0, wouldAlert: 0, ruleHits: {}, samples: [] };
  for (const r of rows) {
    const workspace = r.project_path ?? payloadWorkspace(r.payload);
    const req: ActionRequest = {
      requestId: `event-${r.id}`, sessionId: r.session_id, checkpoint: 'pre_tool',
      agent: { surface: 'unknown', agentId: r.agent_id, cwd: workspace }, toolName: r.tool_name,
      category: r.category as ActionRequest['category'], mcpServer: r.mcp_server ?? undefined,
      args: payloadArgs(r.payload), occurredAt: r.created_at,
    };
    const f = extractFeatures(req);
    let effective = lane;
    if (opts.policies?.length) {
      const agentStub: RegisteredAgent = { id: r.agent_id, name: r.agent_id, surface: 'unknown', status: 'active', discovered: true, firstSeenAt: r.created_at, lastSeenAt: r.created_at };
      const applicable = opts.ignoreScope
        ? opts.policies.filter(p => p.enabled !== false)
        : applicablePolicies(lane, opts.policies, agentStub, req);
      effective = mergePolicies(lane, applicable);
    }
    const raw = laneEngine.evaluate(effective, req, f, { tainted: false, workspace });
    // Mirror the PDP: observe-only policy rules never permit or gate an action.
    const ev = { ...raw, judge: raw.judge.filter(m => m.condition.modeOverride !== 'observe'), allow: raw.allow.filter(m => m.condition.modeOverride !== 'observe') };
    out.evaluated++;
    for (const m of [...(ev.deny ? [ev.deny] : []), ...ev.approve, ...ev.judge, ...ev.allow, ...ev.alert]) out.ruleHits[m.ruleId] = (out.ruleHits[m.ruleId] ?? 0) + 1;
    if (ev.alert.length) out.wouldAlert++;
    const judgeRuleIds = ev.judge.map(m => m.ruleId);
    if (lane.defaultVerdict === 'judge') judgeRuleIds.push('default-judge');
    const ruleIds = [ev.deny, ...ev.approve, ...ev.judge, ...ev.allow, ...ev.alert].filter(Boolean).map(m => m!.ruleId);
    let verdict: 'allow' | 'deny' | 'judge' | 'approve' = 'allow';
    if (ev.deny) { out.wouldDeny++; verdict = 'deny'; }
    else if (ev.approve.length) { out.wouldApprove++; verdict = 'approve'; }
    else if (judgeRuleIds.length) { out.wouldJudge++; verdict = 'judge'; }
    else if (ev.allow.length) { out.wouldAllow++; verdict = 'allow'; }
    else if (lane.defaultVerdict === 'deny') { out.wouldDeny++; verdict = 'deny'; }
    else out.wouldAllow++;
    const verdictRuleIds = verdict === 'judge' ? judgeRuleIds : ruleIds.length ? ruleIds : verdict === 'deny' ? ['default-deny'] : [];
    if (out.samples.length < 25 && (verdict !== 'allow' || ev.alert.length)) out.samples.push({ eventId: r.id, sessionId: r.session_id, tool: r.tool_name, summary: f.summary, verdict: verdict === 'allow' && ev.alert.length ? 'alert' : verdict, ruleIds: verdict === 'allow' && ev.alert.length ? ev.alert.map(m => m.ruleId) : verdictRuleIds });
  }
  return out;
}

/** Replay one policy against history on a rule-less observe lane (scope ignored). */
export async function simulatePolicy(policy: Policy, opts: Omit<SimulateOptions, 'policies' | 'ignoreScope'> = {}): Promise<LaneSimulationResult> {
  const lane: Lane = {
    id: `simulate:${policy.id}`, version: 1, purpose: 'Policy simulation', dos: [], never: [], appliesTo: {},
    rules: { deny: [], approve: [], judge: [], allow: [], alert: [] }, defaultVerdict: 'allow', mode: 'enforce',
    failMode: { default: 'open' }, approval: { channels: ['dashboard'], timeoutSec: 60 }, judge: { escalateBelow: 0.7, dataPolicy: 'metadata-only' },
  };
  return simulateLane(lane, { ...opts, policies: [{ ...policy, enabled: true }], ignoreScope: true });
}
