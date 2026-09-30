/**
 * Pure functions that turn Jev answers into decisions. Jev supplies calibrated evidence; the
 * verdict logic (and every threshold, from ./questions) lives here in code.
 */
import type { JudgeInput } from '../contracts';
import type { JevAnswer } from './client';
import type { JevSignals } from './types';
import {
  INJECTION_HAZARDS,
  LANE_CLAUSE_NONE,
  SESSION_DIMENSIONS,
  SESSION_DIMENSION_HIGH,
  SESSION_DIMENSION_MEDIUM,
  SESSION_SEVERITY_BUCKETS,
  SESSION_WEIGHTS,
  laneClauseLabels,
  neverRules,
  type JevPolicy,
  type SessionDimension,
} from './questions';

export type JevAnswers = Readonly<Record<string, JevAnswer | undefined>>;

const SCORE_MAX = 3;

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
function round(n: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
function noulOf(a: JevAnswers, id: string): number | undefined {
  const x = a[id];
  return x && x.type === 'noul' ? clamp01(x.noul) : undefined;
}
function scoreOf(a: JevAnswers, id: string): { score: number; confidence: number } | undefined {
  const x = a[id];
  return x && x.type === 'score' && Number.isFinite(x.score) ? { score: x.score, confidence: clamp01(x.confidence) } : undefined;
}
function choiceOf(a: JevAnswers, id: string): { choice: string; p: number; confidence: number } | undefined {
  const x = a[id];
  if (!x || x.type !== 'choice') return undefined;
  const probs = x.probabilities as Readonly<Record<string, number>> | undefined;
  return { choice: x.choice, p: clamp01(probs?.[x.choice] ?? x.confidence), confidence: clamp01(x.confidence) };
}
function short(s: string, n = 80): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ── Judge ──────────────────────────────────────────────────────────────────

export interface JevJudgeOutcome {
  verdict: 'allow' | 'deny' | 'escalate';
  confidence: number;
  rationale: string;
  laneClause?: string;
  signals: JevSignals;
}

export function combineJudge(answers: JevAnswers, input: JudgeInput, policy: JevPolicy): JevJudgeOutcome {
  const rules = neverRules(input.lane);
  const labels = laneClauseLabels(input.lane);
  const signals: JevSignals = {};

  const nevers = rules.map((rule, i) => ({ i, rule, p: noulOf(answers, `never_${i}`) ?? 0 }));
  for (const n of nevers) signals[`never_${n.i}`] = round(n.p);
  const withinPurpose = noulOf(answers, 'within_purpose');
  const servesGoal = noulOf(answers, 'serves_goal');
  const followsUntrusted = noulOf(answers, 'follows_untrusted') ?? 0;
  const harm = scoreOf(answers, 'harm');
  const clause = choiceOf(answers, 'lane_clause');
  if (withinPurpose !== undefined) signals.within_purpose = round(withinPurpose);
  if (servesGoal !== undefined) signals.serves_goal = round(servesGoal);
  signals.follows_untrusted = round(followsUntrusted);
  if (harm) { signals.harm = round(harm.score); signals.harm_confidence = round(harm.confidence); }
  let chosenRuleIdx = -1;
  if (clause) {
    chosenRuleIdx = clause.choice === LANE_CLAUSE_NONE ? -1 : labels.indexOf(clause.choice);
    signals.lane_clause = chosenRuleIdx >= 0 ? `never_${chosenRuleIdx}` : LANE_CLAUSE_NONE;
    signals.lane_clause_p = round(clause.p);
  }

  const topNever = nevers.reduce<{ i: number; rule: string; p: number } | undefined>((best, n) => (!best || n.p > best.p ? n : best), undefined);
  const maxNever = topNever?.p ?? 0;
  const harmScore = harm?.score ?? 0;
  const hasGoal = !!(input.goal && input.goal.trim());

  const denyNevers = nevers.filter(n => n.p >= policy.deny);
  const reviewNevers = nevers.filter(n => n.p >= policy.review);
  const harmDeny = harmScore >= policy.harmBlock;
  const harmReview = harmScore >= policy.harmReview;
  const untrustedReview = input.tainted && followsUntrusted >= policy.review;
  const offGoal = hasGoal && servesGoal !== undefined && servesGoal < policy.offGoal
    && (withinPurpose ?? 1) < policy.offPurpose;

  const reasons: string[] = [];
  const neverReason = (n: { i: number; rule: string; p: number }): string => `never[${n.i}] '${short(n.rule)}' p=${n.p.toFixed(2)}`;
  const harmReason = `harm=${harmScore.toFixed(1)}/${SCORE_MAX}`;

  let verdict: JevJudgeOutcome['verdict'];
  let confidence: number;
  if (denyNevers.length || harmDeny) {
    verdict = 'deny';
    denyNevers.sort((x, y) => y.p - x.p).forEach(n => reasons.push(neverReason(n)));
    if (harmDeny || harm) reasons.push(harmReason);
    confidence = Math.max(...denyNevers.map(n => n.p), harmDeny ? clamp01(harmScore / SCORE_MAX) : 0);
  } else if (reviewNevers.length || untrustedReview || offGoal || harmReview) {
    verdict = 'escalate';
    reviewNevers.sort((x, y) => y.p - x.p).forEach(n => reasons.push(neverReason(n)));
    if (untrustedReview) reasons.push(`tainted session; follows_untrusted p=${followsUntrusted.toFixed(2)}`);
    if (offGoal) reasons.push(`off-goal: serves_goal p=${(servesGoal ?? 0).toFixed(2)}, within_purpose p=${(withinPurpose ?? 0).toFixed(2)}`);
    if (harmReview || harm) reasons.push(harmReason);
    const strongest = Math.max(maxNever, untrustedReview ? followsUntrusted : 0, harmReview ? harmScore / SCORE_MAX : 0, offGoal ? 0.5 : 0);
    // Escalations are by definition uncertain: keep below the usual escalate/human cut-offs.
    confidence = Math.min(0.65, 0.4 + 0.25 * clamp01(strongest));
  } else {
    verdict = 'allow';
    const risk = Math.max(maxNever, followsUntrusted);
    confidence = Math.min(1, Math.max(0.5, 1 - 0.5 * (risk / Math.max(policy.review, 1e-6))));
    reasons.push(`no never-rule fired (max p=${maxNever.toFixed(2)})`);
    if (withinPurpose !== undefined) reasons.push(`within_purpose p=${withinPurpose.toFixed(2)}`);
    if (servesGoal !== undefined) reasons.push(`serves_goal p=${servesGoal.toFixed(2)}`);
    if (harm) reasons.push(harmReason);
  }

  let laneClause: string | undefined;
  const firedTop = verdict !== 'allow' ? (denyNevers[0] ?? reviewNevers[0]) : undefined;
  if (firedTop) laneClause = firedTop.rule;
  else if (chosenRuleIdx >= 0) laneClause = rules[chosenRuleIdx];
  if (chosenRuleIdx >= 0 && clause && !firedTop) reasons.push(`lane_clause '${short(rules[chosenRuleIdx])}' p=${clause.p.toFixed(2)}`);

  return { verdict, confidence: round(clamp01(confidence)), rationale: `Jev: ${reasons.join('; ')}`, laneClause, signals };
}

// ── Injection ──────────────────────────────────────────────────────────────

export interface JevInjectionOutcome {
  verdict: 'attack' | 'review' | 'clean';
  /** 0..1 strongest hazard probability. */
  score: number;
  confidence: number;
  rationale: string;
  signals: JevSignals;
}

export function combineInjection(answers: JevAnswers, policy: JevPolicy): JevInjectionOutcome {
  const signals: JevSignals = {};
  const addressesAi = noulOf(answers, 'addresses_ai') ?? 0;
  signals.addresses_ai = round(addressesAi);
  const hazards = INJECTION_HAZARDS.map(id => ({ id, p: noulOf(answers, id) ?? 0 }));
  for (const h of hazards) signals[h.id] = round(h.p);
  const sev = scoreOf(answers, 'severity');
  if (sev) { signals.severity = round(sev.score); signals.severity_confidence = round(sev.confidence); }
  const severity = sev?.score ?? 0;

  const top = hazards.reduce((b, h) => (h.p > b.p ? h : b), hazards[0]);
  const aiSupported = addressesAi >= policy.injectionReview;
  const fired = hazards.filter(h => h.p >= policy.injectionReview).sort((x, y) => y.p - x.p);

  let verdict: JevInjectionOutcome['verdict'];
  if (top.p >= policy.injectionAttack && aiSupported) verdict = 'attack';
  else if (fired.length && aiSupported && severity >= policy.injectionSeverityBlock) verdict = 'attack';
  else if (fired.length) verdict = 'review';
  else verdict = 'clean';

  const score = clamp01(top.p);
  const confidence = verdict === 'attack'
    ? Math.max(top.p, severity / SCORE_MAX)
    : verdict === 'clean' ? 1 - score : Math.min(0.65, 0.4 + 0.25 * score);
  const reasons = fired.map(h => `${h.id} p=${h.p.toFixed(2)}`);
  reasons.push(`addresses_ai p=${addressesAi.toFixed(2)}`);
  if (sev) reasons.push(`severity=${severity.toFixed(1)}/${SCORE_MAX}`);
  return {
    verdict,
    score: round(score),
    confidence: round(clamp01(confidence)),
    rationale: `Jev: ${verdict}${fired.length ? '' : ' (no hazard fired)'}; ${reasons.join('; ')}`,
    signals,
  };
}

// ── Session ────────────────────────────────────────────────────────────────

export type JevSessionSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
const SEVERITY_RANK: Record<JevSessionSeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export interface JevSessionOutcome {
  severity: JevSessionSeverity;
  /** 0..1 weighted mean of dimension/3. */
  composite: number;
  intent: string;
  dimensions: Record<string, number>;
  confidence: number;
  signals: JevSignals;
}

export function combineSession(answers: JevAnswers): JevSessionOutcome {
  const dimensions: Record<string, number> = {};
  const signals: JevSignals = {};
  const confidences: number[] = [];
  let weighted = 0;
  let weightSum = 0;
  let maxDim = 0;
  for (const d of SESSION_DIMENSIONS) {
    const s = scoreOf(answers, d);
    if (!s) continue;
    const v = Math.min(SCORE_MAX, Math.max(0, s.score));
    dimensions[d] = round(v);
    signals[d] = round(v);
    confidences.push(s.confidence);
    const w = SESSION_WEIGHTS[d as SessionDimension];
    weighted += w * (v / SCORE_MAX);
    weightSum += w;
    maxDim = Math.max(maxDim, v);
  }
  const composite = weightSum ? weighted / weightSum : 0;

  let severity: JevSessionSeverity = SESSION_SEVERITY_BUCKETS.find(b => composite >= b.min)?.severity ?? 'info';
  const floor: JevSessionSeverity = maxDim >= SESSION_DIMENSION_HIGH ? 'high' : maxDim >= SESSION_DIMENSION_MEDIUM ? 'medium' : 'info';
  if (SEVERITY_RANK[floor] > SEVERITY_RANK[severity]) severity = floor;

  const intentAns = choiceOf(answers, 'intent');
  const intent = intentAns?.choice ?? 'unknown';
  signals.intent = intent;
  if (intentAns) signals.intent_p = round(intentAns.p);
  signals.composite = round(composite);

  const confidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0;
  return { severity, composite: round(composite), intent, dimensions, confidence: round(confidence), signals };
}
