/**
 * Jev-backed implementations of the governance decision points (shadow/eval only for now).
 * `jevJudge` implements the same `Judge` contract as the Foundry judge, so the eval harness and a
 * future cascade can swap it in; shadow mode calls these without ever changing a verdict.
 */
import type { Judge, JudgeInput } from '../contracts';
import type { JudgeVerdict } from '../types';
import { jevAsk, type JevCallResult } from './client';
import { combineInjection, combineJudge, combineSession, type JevSessionSeverity } from './combine';
import { jevConfig, type JevPolicyName } from './config';
import { JEV_POLICIES, injectionQuestions, judgeQuestions, sessionQuestions } from './questions';
import { injectionState, judgeState, sessionState, type SessionDigest } from './state';
import type { JevSignals } from './types';

export interface JevRunOptions {
  policy?: JevPolicyName;
  timeoutMs?: number;
  signal?: AbortSignal;
}

function policyOf(opts?: JevRunOptions): JevPolicyName {
  return opts?.policy ?? jevConfig.policy;
}

function askOpts(opts?: JevRunOptions): { timeoutMs?: number; signal?: AbortSignal } {
  const o: { timeoutMs?: number; signal?: AbortSignal } = {};
  if (opts?.timeoutMs !== undefined) o.timeoutMs = opts.timeoutMs;
  if (opts?.signal) o.signal = opts.signal;
  return o;
}

// ── Judge ──────────────────────────────────────────────────────────────────

/** Raw judge-battery answers (lets the eval harness re-combine under many thresholds without re-calling). */
export async function askJudgeRaw(input: JudgeInput, opts?: JevRunOptions): Promise<JevCallResult> {
  return jevAsk(judgeState(input), judgeQuestions(input), askOpts(opts));
}

/** Combine raw judge answers into a `JudgeVerdict` under a named policy. */
export function judgeVerdictFromRaw(raw: JevCallResult, input: JudgeInput, tier: 'fast' | 'escalation', policy: JevPolicyName): JudgeVerdict {
  const c = combineJudge(raw.answers, input, JEV_POLICIES[policy]);
  const verdict: JudgeVerdict = {
    verdict: c.verdict,
    confidence: c.confidence,
    rationale: c.rationale,
    model: raw.model,
    tier,
    latencyMs: raw.latencyMs,
    provider: 'jev',
    usage: { ...raw.usage },
    signals: { ...c.signals, policy },
  };
  if (c.laneClause !== undefined) verdict.laneClause = c.laneClause;
  return verdict;
}

export async function evaluateJudgeWithJev(input: JudgeInput, opts?: JevRunOptions & { tier?: 'fast' | 'escalation' }): Promise<JudgeVerdict> {
  const raw = await askJudgeRaw(input, opts);
  return judgeVerdictFromRaw(raw, input, opts?.tier ?? 'fast', policyOf(opts));
}

export const jevJudge: Judge = {
  get available(): boolean {
    return jevConfig.available;
  },
  async evaluate(input: JudgeInput, tier: 'fast' | 'escalation', timeoutMs: number): Promise<JudgeVerdict> {
    return evaluateJudgeWithJev(input, { tier, timeoutMs });
  },
};

// ── Injection ──────────────────────────────────────────────────────────────

export interface InjectionAssessment {
  verdict: 'attack' | 'review' | 'clean';
  score: number;
  confidence: number;
  rationale: string;
  signals: JevSignals;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export interface InjectionSubject {
  toolOutput: string;
  goal?: string;
  tool?: string;
  category?: string;
}

export async function askInjectionRaw(i: InjectionSubject, opts?: JevRunOptions): Promise<JevCallResult> {
  return jevAsk(injectionState(i), injectionQuestions(), askOpts(opts));
}

export async function assessInjection(i: InjectionSubject, opts?: JevRunOptions): Promise<InjectionAssessment> {
  const raw = await askInjectionRaw(i, opts);
  const policy = policyOf(opts);
  const c = combineInjection(raw.answers, JEV_POLICIES[policy]);
  return { ...c, signals: { ...c.signals, policy }, model: raw.model, latencyMs: raw.latencyMs, usage: { ...raw.usage } };
}

// ── Session ────────────────────────────────────────────────────────────────

export interface SessionAssessment {
  severity: JevSessionSeverity;
  composite: number;
  intent: string;
  dimensions: Record<string, number>;
  confidence: number;
  signals: JevSignals;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number };
}

export async function askSessionRaw(d: SessionDigest, opts?: JevRunOptions): Promise<JevCallResult> {
  return jevAsk(sessionState(d), sessionQuestions(), askOpts(opts));
}

export async function assessSession(d: SessionDigest, opts?: JevRunOptions): Promise<SessionAssessment> {
  const raw = await askSessionRaw(d, opts);
  const c = combineSession(raw.answers);
  return { ...c, model: raw.model, latencyMs: raw.latencyMs, usage: { ...raw.usage } };
}
