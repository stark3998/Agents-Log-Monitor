/**
 * Jev shadow runner. Called by the PDP *after* an authoritative decision has been made and stored:
 * every entry point returns synchronously, schedules work on the bounded `shadowQueue` and swallows
 * all errors, so a shadow run can never change, delay or fail a governance decision.
 */
import crypto from 'crypto';
import { redactString } from '../../analytics/redact';
import type { JudgeInput, ShieldResult } from '../contracts';
import type { DataPolicy, Decision, JudgeVerdict, Verdict } from '../types';
import { govStore } from '../store';
import { jevConfig } from './config';
import { emitShadow } from './events';
import { assessInjection, evaluateJudgeWithJev } from './judge';
import { shadowQueue } from './runtime';
import { EGRESS_REDACTION } from './state';
import type { JevShadowBaseline, JevShadowOutcome, JevShadowRecord } from './types';

/**
 * Upper bound on tool output held in the queue: the state builder keeps at most 40k chars, plus
 * slack so secrets straddling the cut are still recognized and masked before truncation.
 */
const MAX_QUEUED_OUTPUT_CHARS = 48_000;
const MAX_ERROR_CHARS = 300;

/**
 * Copy the prefix into a fresh string. A plain `slice` can be a V8 sliced string that keeps the
 * whole (possibly multi-MB) parent tool result alive while the task waits in the queue.
 */
function detachedPrefix(s: string, max: number): string {
  return Buffer.from(s.length > max ? s.slice(0, max) : s, 'utf8').toString('utf8');
}

function sampled(): boolean {
  const rate = jevConfig.shadow.sampleRate;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/** Cheap pre-check so callers can skip building shadow inputs on the hot path. */
export function shouldShadowJudge(): boolean {
  return jevConfig.shadow.enabled && sampled();
}

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactString(msg || 'unknown error', EGRESS_REDACTION).slice(0, MAX_ERROR_CHARS);
}

/**
 * Hard ceiling for one shadow call (per-attempt timeout × 2 attempts + slack), so a transport that
 * ignores its timeout can't pin a queue slot forever.
 */
function shadowDeadlineMs(): number {
  return jevConfig.timeoutMs * 2 + 500;
}

async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const ms = shadowDeadlineMs();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { ac.abort(); reject(new Error(`Jev shadow call timed out after ${ms}ms`)); }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([run(ac.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Maps a PDP verdict onto the judge's verdict space (`ask` is a human-routing outcome). */
function judgeSpace(v: Verdict): 'allow' | 'deny' | 'escalate' {
  return v === 'ask' ? 'escalate' : v;
}

async function save(record: JevShadowRecord): Promise<void> {
  try {
    await govStore().appendJevShadow(record);
    emitShadow(record);
  } catch { /* shadow persistence is best-effort */ }
}

function decisionRefs(d: Decision): Pick<JevShadowRecord, 'decisionId' | 'requestId' | 'sessionId' | 'agentId' | 'laneId' | 'checkpoint' | 'toolName'> {
  return {
    decisionId: d.id, requestId: d.requestId, sessionId: d.sessionId, agentId: d.agentId,
    laneId: d.laneId, checkpoint: d.checkpoint, toolName: d.toolName,
  };
}

/**
 * Baseline for a judge shadow: the LLM judge's final verdict when the decision carries judge
 * verdicts, otherwise the deterministic outcome (rules / cache / fail mode / default / human).
 */
export function judgeBaseline(decision: Decision, verdicts?: JudgeVerdict[]): JevShadowBaseline {
  const judged = verdicts?.length ? verdicts : decision.judge;
  if (judged?.length) {
    const final = judged[judged.length - 1];
    const effective = judgeSpace(decision.effectiveVerdict);
    const stage = effective === final.verdict ? decision.stage : `${decision.stage}:${decision.effectiveVerdict}`;
    const baseline: JevShadowBaseline = { provider: 'foundry', model: final.model, verdict: final.verdict, confidence: final.confidence, stage };
    // A cache hit replays earlier verdicts: no model call happened, so don't count latency/tokens again.
    if (decision.stage !== 'cache') {
      baseline.latencyMs = judged.reduce((a, v) => a + (v.latencyMs || 0), 0);
      if (judged.some(v => v.usage)) {
        baseline.inputTokens = judged.reduce((a, v) => a + (v.usage?.inputTokens ?? 0), 0);
        baseline.outputTokens = judged.reduce((a, v) => a + (v.usage?.outputTokens ?? 0), 0);
      }
    }
    return baseline;
  }
  return { provider: 'rules', verdict: judgeSpace(decision.effectiveVerdict), stage: decision.stage };
}

/**
 * Shadow the judge decision point with Jev. Returns immediately; never throws.
 * `input` may be a thunk so callers on the hot path don't pay for building (redacting and
 * serializing) the judge input when the event is sampled out; it is then built inside the queued
 * task. Pass `presampled` when the caller already checked `shouldShadowJudge()`.
 * `candidateJudge` overrides the verdicts on `decision.judge` as the Foundry baseline.
 */
export function shadowJudge(decision: Decision, input: JudgeInput | (() => JudgeInput), candidateJudge?: JudgeVerdict[], opts?: { presampled?: boolean }): void {
  try {
    if (!jevConfig.shadow.enabled) return;
    if (!opts?.presampled && !sampled()) return;
    const baseline = judgeBaseline(decision, candidateJudge);
    const policy = jevConfig.policy;
    shadowQueue.enqueue(async () => {
      const started = Date.now();
      let jev: JevShadowOutcome;
      let agree: boolean | undefined;
      try {
        const judgeIn = typeof input === 'function' ? input() : input;
        const v = await withDeadline(signal => evaluateJudgeWithJev(judgeIn, { timeoutMs: jevConfig.timeoutMs, policy, signal }));
        jev = {
          model: v.model, verdict: v.verdict, confidence: v.confidence, latencyMs: v.latencyMs,
          inputTokens: v.usage?.inputTokens, outputTokens: v.usage?.outputTokens,
          policy, rationale: v.rationale, laneClause: v.laneClause, signals: v.signals ?? {},
        };
        agree = baseline.verdict === undefined ? undefined : v.verdict === baseline.verdict;
      } catch (err) {
        jev = { model: jevConfig.model, latencyMs: Date.now() - started, policy, signals: {}, error: errorMessage(err) };
      }
      await save({ id: crypto.randomUUID(), kind: 'judge', ...decisionRefs(decision), baseline, jev, agree, createdAt: new Date().toISOString() });
    });
  } catch { /* shadow must never affect the caller */ }
}

export interface ShadowInjectionContext {
  decision: Decision;
  toolOutput: string;
  goal?: string;
  tool?: string;
  category?: string;
  /** Prompt Shields result for the same output (null/undefined when not scanned). */
  shield?: ShieldResult | null;
  laneDataPolicy: DataPolicy;
}

/** Shadow the tool_result prompt-injection check (Prompt Shields) with Jev. Returns immediately; never throws. */
export function shadowInjection(ctx: ShadowInjectionContext): void {
  try {
    if (!jevConfig.shadow.enabled || !jevConfig.shadow.injection) return;
    if (ctx.laneDataPolicy === 'metadata-only') return;
    if (typeof ctx.toolOutput !== 'string' || !ctx.toolOutput.trim()) return;
    if (!sampled()) return;
    const shield = ctx.shield?.scanned ? ctx.shield : undefined;
    const baseline: JevShadowBaseline = shield
      ? { provider: 'prompt-shields', verdict: shield.attackDetected ? 'attack' : 'clean', latencyMs: shield.latencyMs }
      : { provider: 'none' };
    const subject = { toolOutput: detachedPrefix(ctx.toolOutput, MAX_QUEUED_OUTPUT_CHARS), goal: ctx.goal, tool: ctx.tool, category: ctx.category };
    const policy = jevConfig.policy;
    const refs = decisionRefs(ctx.decision);
    shadowQueue.enqueue(async () => {
      const started = Date.now();
      let jev: JevShadowOutcome;
      let agree: boolean | undefined;
      try {
        const a = await withDeadline(signal => assessInjection(subject, { timeoutMs: jevConfig.timeoutMs, policy, signal }));
        jev = {
          model: a.model, verdict: a.verdict, score: a.score, confidence: a.confidence, latencyMs: a.latencyMs,
          inputTokens: a.usage.inputTokens, outputTokens: a.usage.outputTokens,
          policy, rationale: a.rationale, signals: a.signals,
        };
        // `review` counts as not-attack: Prompt Shields is binary.
        agree = shield ? (a.verdict === 'attack') === shield.attackDetected : undefined;
      } catch (err) {
        jev = { model: jevConfig.model, latencyMs: Date.now() - started, policy, signals: {}, error: errorMessage(err) };
      }
      await save({ id: crypto.randomUUID(), kind: 'injection', ...refs, baseline, jev, agree, createdAt: new Date().toISOString() });
    });
  } catch { /* shadow must never affect the caller */ }
}

/** Resolves once all queued shadow work has finished (tests / graceful shutdown). */
export function awaitShadowIdle(): Promise<void> {
  return shadowQueue.idle();
}
