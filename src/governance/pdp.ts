import crypto from 'crypto';
import path from 'path';
import { redactDeep, redactString } from '../analytics/redact';
import { riskRank } from '../analytics/risk';
import { DB_PATH } from '../db';
import { extractFeatures, type ActionFeatures } from './features';
import { systemGuard, type SystemGuardContext } from './system-guard';
import type { JudgeInput, RuleEvaluation } from './contracts';
import type { ActionRequest, Decision, FailMode, JudgeVerdict, Lane, LaneMode, RegisteredAgent, Verdict } from './types';
import { govConfig } from './config';
import { govBus } from './events';
import { judge } from './judge';
import { shields } from './shields';
import laneEngine, { BUILTIN_DEFAULT_LANE } from './lanes/engine';
import { registry } from './registry';
import { intentTracker } from './intent';
import { limits } from './limits';
import { approvals } from './approvals';
import { govStore } from './store';
import { canonicalJson } from './audit';

export interface DecideOptions {
  blocking: boolean;
  supportsAsk: boolean;
  deadlineMs?: number;
}

interface Candidate {
  verdict: Verdict;
  stage: Decision['stage'];
  reason: string;
  ruleIds: string[];
  judge?: JudgeVerdict[];
  approvalId?: string;
  approver?: string;
  cacheable?: boolean;
}

interface CacheEntry { candidate: Candidate; expires: number }
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, CacheEntry>();

function nowIso(): string { return new Date().toISOString(); }
function failMode(lane: Lane, category: string): FailMode { return (lane.failMode as Record<string, FailMode>)[category] ?? lane.failMode.default ?? 'closed'; }
/** High/critical-risk actions always fail closed; otherwise the lane's per-category fail mode applies. */
function failVerdict(lane: Lane, category: string, riskLevel?: string | null): Verdict {
  if (riskRank(riskLevel) >= riskRank('high')) return 'deny';
  return failMode(lane, category) === 'open' ? 'allow' : 'deny';
}
function timeoutLeft(start: number, opts: DecideOptions): number {
  return Math.max(1, (opts.deadlineMs ?? 30_000) - (Date.now() - start));
}
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
function addCache(key: string, c: Candidate): void {
  if (!c.cacheable || c.approvalId) return;
  if (!(c.verdict === 'allow' || c.verdict === 'deny')) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { candidate: { ...c, stage: 'cache' }, expires: Date.now() + CACHE_TTL_MS });
}
function getCache(key: string): Candidate | undefined {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.expires < Date.now()) { cache.delete(key); return undefined; }
  return { ...e.candidate };
}
function hashCacheKey(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
function cacheKey(lane: Lane, req: ActionRequest, f: ActionFeatures, tainted: boolean, scope: 'global' | 'session'): string {
  const session = scope === 'session' ? req.sessionId : '*';
  return `${scope}:${session}|${lane.id}@${lane.version}|${hashCacheKey({
    checkpoint: req.checkpoint,
    toolName: f.toolName || req.toolName || '',
    mcpServer: f.mcpServer ?? req.mcpServer ?? null,
    workspace: req.agent.cwd ?? null,
    riskLevel: f.riskLevel ?? null,
    detections: f.detections.map(d => d.key).sort(),
    args: req.args ?? null,
    tainted,
  })}`;
}
function effectiveMode(lane: Lane): LaneMode { return govConfig.enforcementEnabled ? lane.mode : 'observe'; }
function systemGuardContext(): SystemGuardContext {
  return {
    port: Number(process.env.PORT ?? 4317),
    dbPath: DB_PATH,
    lanesDir: govConfig.lanesDir || path.join(process.cwd(), 'lanes'),
  };
}
function applyMode(c: Candidate, mode: LaneMode): { verdict: Verdict; effectiveVerdict: Verdict; wouldDeny: boolean } {
  const effectiveVerdict = c.verdict;
  if (mode === 'observe') {
    return { verdict: 'allow', effectiveVerdict, wouldDeny: effectiveVerdict === 'deny' };
  }
  return { verdict: c.verdict, effectiveVerdict, wouldDeny: false };
}
function summarizeArgs(args: unknown, dataPolicy: Lane['judge']['dataPolicy']): string | undefined {
  if (dataPolicy === 'metadata-only') return undefined;
  const v = dataPolicy === 'redacted' ? redactDeep(args) : args;
  try { return JSON.stringify(v).slice(0, 8000); } catch { return String(v).slice(0, 8000); }
}
function withReqTokens<T extends { counters: { tokens: number } }>(intent: T, req: ActionRequest): T {
  const tokens = (req.tokens?.input ?? 0) + (req.tokens?.output ?? 0);
  return tokens ? { ...intent, counters: { ...intent.counters, tokens: intent.counters.tokens + tokens } } : intent;
}
function judgeInput(lane: Lane, intent: Awaited<ReturnType<typeof intentTracker.get>>, req: ActionRequest, f: ActionFeatures, tainted: boolean, triggers: string[]): JudgeInput {
  return {
    lane,
    goal: intent.goal,
    trajectory: intentTracker.digest(intent),
    action: {
      tool: f.toolName || f.canonicalTool, category: f.category, mcpServer: f.mcpServer,
      summary: redactString(f.summary), args: summarizeArgs(req.args, lane.judge.dataPolicy),
      risk: f.risk.map(r => r.rule), hosts: f.hosts, paths: f.paths,
    },
    tainted,
    taintReason: intent.taint?.reason,
    triggers,
  };
}
async function runJudge(lane: Lane, intent: Awaited<ReturnType<typeof intentTracker.get>>, req: ActionRequest, f: ActionFeatures, tainted: boolean, triggers: string[], start: number, opts: DecideOptions): Promise<Candidate> {
  if (!judge.available) return { verdict: failVerdict(lane, f.category, f.riskLevel), stage: 'fail_mode', reason: 'Judge unavailable', ruleIds: triggers, cacheable: true };
  const timeout = Math.min(lane.judge.timeoutMs ?? govConfig.foundry.fastTimeoutMs, timeoutLeft(start, opts));
  try {
    const input = judgeInput(lane, intent, req, f, tainted, triggers);
    const fast = await withTimeout(judge.evaluate(input, 'fast', timeout), timeout, 'fast judge');
    const verdicts = [fast];
    let current = fast;
    const scrutinyBump = tainted ? 0.1 : 0;
    if (current.confidence < Math.min(0.95, lane.judge.escalateBelow + scrutinyBump)) {
      const escTimeout = Math.min(lane.judge.timeoutMs ?? govConfig.foundry.escalationTimeoutMs, timeoutLeft(start, opts));
      const esc = await withTimeout(judge.evaluate(input, 'escalation', escTimeout), escTimeout, 'escalation judge');
      verdicts.push(esc);
      current = esc;
    }
    const humanBelow = lane.judge.humanBelow == null ? undefined : Math.min(0.95, lane.judge.humanBelow + scrutinyBump);
    if (current.verdict === 'escalate' || (humanBelow != null && current.confidence < humanBelow)) {
      return { verdict: 'escalate', stage: current.tier === 'fast' ? 'judge_fast' : 'judge_escalation', reason: current.rationale || 'Judge requested human review', ruleIds: triggers, judge: verdicts };
    }
    return { verdict: current.verdict, stage: current.tier === 'fast' ? 'judge_fast' : 'judge_escalation', reason: current.rationale, ruleIds: triggers, judge: verdicts, cacheable: true };
  } catch (err) {
    return { verdict: failVerdict(lane, f.category, f.riskLevel), stage: 'fail_mode', reason: `Judge error: ${(err as Error).message}`, ruleIds: triggers, cacheable: true };
  }
}
async function human(lane: Lane, agent: RegisteredAgent, req: ActionRequest, f: ActionFeatures, reason: string, start: number, opts: DecideOptions, mode: LaneMode): Promise<Candidate> {
  const channels: Lane['approval']['channels'] = lane.approval.channels?.length ? lane.approval.channels : ['dashboard'];
  if (opts.supportsAsk && channels.includes('native') && !channels.every(c => c === 'dashboard')) {
    return { verdict: 'ask', stage: 'human', reason, ruleIds: [], cacheable: false };
  }
  // Plain `enforce` lanes have no approval workflow: anything needing a human resolves by fail mode.
  if (mode !== 'enforce+approval') {
    return { verdict: failVerdict(lane, f.category, f.riskLevel), stage: 'fail_mode', reason: `${reason} (human approval required; lane has no approval workflow)`, ruleIds: [] };
  }
  const approval = await approvals.request({ req, agent, lane, summary: f.summary, reason, channels, timeoutSec: lane.approval.timeoutSec });
  if (!opts.blocking) return { verdict: 'escalate', stage: 'human', reason, ruleIds: [], approvalId: approval.id };
  const waitMs = Math.min(lane.approval.timeoutSec * 1000, timeoutLeft(start, opts));
  const resolved = await approvals.wait(approval.id, waitMs);
  if (resolved.state === 'approved') return { verdict: 'allow', stage: 'human', reason: resolved.resolutionNote || 'Approved by human', ruleIds: [], approvalId: resolved.id, approver: resolved.resolvedBy };
  if (resolved.state === 'denied') return { verdict: 'deny', stage: 'human', reason: resolved.resolutionNote || 'Denied by human', ruleIds: [], approvalId: resolved.id, approver: resolved.resolvedBy };
  return { verdict: failVerdict(lane, f.category, f.riskLevel), stage: 'fail_mode', reason: `Approval ${resolved.state}`, ruleIds: [], approvalId: resolved.id };
}
function judgeTriggers(lane: Lane, ev: RuleEvaluation, f: ActionFeatures, tainted: boolean): string[] {
  const triggers = ev.judge.map(m => m.ruleId);
  if (tainted) triggers.push('tainted-session');
  if (riskRank(f.riskLevel) >= riskRank('medium')) triggers.push(`risk-${f.riskLevel}`);
  if (lane.defaultVerdict === 'judge') triggers.push('default-judge');
  return [...new Set(triggers)];
}
async function chooseCandidate(lane: Lane, agent: RegisteredAgent, intent: Awaited<ReturnType<typeof intentTracker.get>>, req: ActionRequest, f: ActionFeatures, mode: LaneMode, start: number, opts: DecideOptions): Promise<Candidate> {
  if (agent.status === 'paused' || agent.status === 'quarantined') return { verdict: 'deny', stage: 'kill_switch', reason: `Agent is ${agent.status}`, ruleIds: ['agent-kill-switch'] };
  if (intent.status === 'paused' || intent.status === 'quarantined') return { verdict: 'deny', stage: 'kill_switch', reason: `Session is ${intent.status}`, ruleIds: ['session-kill-switch'] };
  const limit = await limits.check(lane, intent, req, f);
  if (limit) return { verdict: 'deny', stage: 'limits', reason: limit.reason, ruleIds: [limit.limitId] };

  const tainted = !!intent.taint;
  const ev = laneEngine.evaluate(lane, req, f, { tainted, workspace: req.agent.cwd });
  if (ev.deny) return { verdict: 'deny', stage: 'rules_deny', reason: ev.deny.description, ruleIds: [ev.deny.ruleId], cacheable: true };

  const triggers = judgeTriggers(lane, ev, f, tainted);
  if (ev.approve.length) {
    const reason = ev.approve.map(m => m.description).join('; ');
    if (mode === 'observe') return { verdict: 'escalate', stage: 'human', reason, ruleIds: ev.approve.map(m => m.ruleId) };
    return human(lane, agent, req, f, reason, start, opts, mode).then(h => ({ ...h, ruleIds: ev.approve.map(m => m.ruleId) }));
  }

  const globalKey = cacheKey(lane, req, f, tainted, 'global');
  const sessionKey = cacheKey(lane, req, f, tainted, 'session');
  const cached = getCache(globalKey) ?? getCache(sessionKey);
  if (cached) return cached;

  // Without a configured judge, only elevated actions (medium+ risk or a tainted session) fall to the
  // fail mode; routine judge-gated work (e.g. `npm test`) continues to the allow rules / lane default.
  const elevated = tainted || riskRank(f.riskLevel) >= riskRank('medium');
  if (triggers.length && (judge.available || elevated)) {
    const judged = await runJudge(lane, intent, req, f, tainted, triggers, start, opts);
    if (judged.verdict === 'escalate' && mode !== 'observe') {
      return human(lane, agent, req, f, judged.reason, start, opts, mode).then(h => ({ ...h, judge: judged.judge, ruleIds: judged.ruleIds }));
    }
    addCache(sessionKey, judged);
    return judged;
  }
  if (ev.allow.length) {
    const c: Candidate = { verdict: 'allow', stage: 'rules_allow', reason: ev.allow[0].description, ruleIds: ev.allow.map(m => m.ruleId), cacheable: true };
    addCache(globalKey, c); return c;
  }
  const verdict: Verdict = lane.defaultVerdict === 'deny' ? 'deny' : lane.defaultVerdict === 'judge' ? failVerdict(lane, f.category, f.riskLevel) : 'allow';
  const noJudge = triggers.length > 0 && !judge.available;
  const c: Candidate = { verdict, stage: lane.defaultVerdict === 'judge' ? 'fail_mode' : 'default', reason: lane.defaultVerdict === 'deny' ? 'Lane default deny' : noJudge ? 'Lane default allow (judge not configured; no elevated risk)' : 'Lane default allow', ruleIds: noJudge ? triggers : [], cacheable: true };
  addCache(globalKey, c); return c;
}
async function append(req: ActionRequest, agent: RegisteredAgent, lane: Lane, f: ActionFeatures, candidate: Candidate, mode: LaneMode, tainted: boolean, start: number): Promise<Decision> {
  const applied = applyMode(candidate, mode);
  const decision: Decision = {
    id: crypto.randomUUID(), requestId: req.requestId, sessionId: req.sessionId, agentId: agent.id,
    laneId: lane.id, laneVersion: lane.version, mode, checkpoint: req.checkpoint, toolName: req.toolName,
    category: f.category, verdict: applied.verdict, effectiveVerdict: applied.effectiveVerdict, wouldDeny: applied.wouldDeny,
    stage: candidate.stage, reason: redactString(candidate.reason || ''), ruleIds: candidate.ruleIds,
    riskLevel: f.riskLevel, judge: candidate.judge, approvalId: candidate.approvalId, approver: candidate.approver,
    tainted, latencyMs: Date.now() - start, createdAt: nowIso(),
  };
  const saved = await govStore().appendDecision(decision);
  govBus.emit('decision', saved);
  return saved;
}

export async function decide(req: ActionRequest, opts: DecideOptions): Promise<Decision> {
  const start = Date.now();
  let lane: Lane = BUILTIN_DEFAULT_LANE;
  let agent: RegisteredAgent = { id: req.agent.agentId ?? 'unknown', name: req.agent.name ?? 'unknown', surface: req.agent.surface, status: 'active', discovered: true, firstSeenAt: nowIso(), lastSeenAt: nowIso() };
  let f: ActionFeatures | undefined;
  try {
    f = extractFeatures(req);
    agent = await registry.identify(req.agent);
    lane = await laneEngine.resolve(agent, req);
    const mode = effectiveMode(lane);
    let intent = await intentTracker.get(req.sessionId, agent.id);

    if (req.checkpoint === 'goal') {
      if (req.text) intent = await intentTracker.recordGoal(intent, req.text, 'heuristic');
      return append(req, agent, lane, f, { verdict: 'allow', stage: 'not_governed', reason: 'Goal recorded', ruleIds: [] }, mode, !!intent.taint, start);
    }
    if (req.checkpoint === 'tool_result') {
      const scan = lane.promptShields?.scan ?? ['NETWORK', 'MCP'];
      if ((lane.promptShields?.enabled ?? true) && scan.includes(f.category) && shields.available && req.result) {
        const res = await shields.scanDocuments([req.result], intent.goal).catch(() => null);
        if (res?.attackDetected) intent = await intentTracker.taint(intent, res.detail || 'Prompt injection detected', req.requestId, lane.promptShields?.taintTtlActions ?? 20);
      }
      const d = await append(req, agent, lane, f, { verdict: 'allow', stage: 'not_governed', reason: 'Tool result observed', ruleIds: [] }, mode, !!intent.taint, start);
      return d;
    }
    if (req.checkpoint === 'response') {
      const d = await append(req, agent, lane, f, { verdict: 'allow', stage: 'not_governed', reason: 'Response observed', ruleIds: [] }, mode, !!intent.taint, start);
      return d;
    }

    const guardHit = (req.checkpoint === 'pre_tool' || req.checkpoint === 'spawn') && req.agent.surface !== 'monitor'
      ? systemGuard(req, f, systemGuardContext())
      : null;
    if (guardHit) {
      // Tampering with the governance plane itself is denied in every lane mode (observe included).
      const c: Candidate = { verdict: 'deny', stage: 'rules_deny', reason: guardHit.reason, ruleIds: [`system:${guardHit.ruleId}`] };
      const d = await append(req, agent, lane, f, c, 'enforce', !!intent.taint, start);
      await intentTracker.recordAction(withReqTokens(intent, req), f, d.verdict);
      return d;
    }

    const candidate = await chooseCandidate(lane, agent, intent, req, f, mode, start, opts);
    const d = await append(req, agent, lane, f, candidate, mode, !!intent.taint, start);
    await intentTracker.recordAction(withReqTokens(intent, req), f, d.verdict);
    return d;
  } catch (err) {
    const feature = f ?? extractFeatures(req);
    const mode = effectiveMode(lane);
    const governedCheckpoint = req.checkpoint === 'pre_tool' || req.checkpoint === 'spawn' || req.checkpoint === 'admin';
    const verdict = riskRank(feature.riskLevel) >= riskRank('high')
      ? 'deny'
      : governedCheckpoint
        ? failVerdict(lane, feature.category, feature.riskLevel)
        : 'allow';
    const c: Candidate = { verdict, stage: 'fail_mode', reason: `PDP error: ${(err as Error).message}`, ruleIds: [] };
    try { return await append(req, agent, lane, feature, c, mode, false, start); }
    catch {
      const applied = applyMode(c, mode);
      return { id: crypto.randomUUID(), requestId: req.requestId, sessionId: req.sessionId, agentId: agent.id, laneId: lane.id, laneVersion: lane.version, mode, checkpoint: req.checkpoint, toolName: req.toolName, category: feature.category, verdict: applied.verdict, effectiveVerdict: applied.effectiveVerdict, wouldDeny: applied.wouldDeny, stage: 'fail_mode', reason: redactString(c.reason), ruleIds: [], riskLevel: feature.riskLevel, tainted: false, latencyMs: Date.now() - start, createdAt: nowIso() };
    }
  }
}
