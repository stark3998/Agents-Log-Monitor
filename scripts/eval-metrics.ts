/**
 * Pure metric helpers for `scripts/eval-compare.ts` (offline benchmark only — lives outside src/ so it
 * never ships). No I/O, no randomness: every function is deterministic and unit-tested in
 * test/eval-metrics.test.ts.
 */

// ── Basics ─────────────────────────────────────────────────────────────────

export function round(n: number, digits = 4): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** Safe ratio: `fallback` when the denominator is 0. */
export function ratio(num: number, den: number, fallback = 0): number {
  return den ? num / den : fallback;
}

/** Nearest-rank percentile (same definition as scripts/eval-judge.ts). 0 for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export interface LatencySummary { count: number; p50: number; p95: number; p99: number; mean: number }

export function latencySummary(values: readonly number[]): LatencySummary {
  const count = values.length;
  const mean = count ? values.reduce((a, b) => a + b, 0) / count : 0;
  return { count, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), mean: round(mean, 1) };
}

/** Inclusive float range with a stable decimal representation (e.g. 0.5, 0.55, …, 0.95). */
export function range(start: number, end: number, step: number): number[] {
  if (step <= 0) throw new Error('range: step must be > 0');
  const out: number[] = [];
  const n = Math.floor((end - start) / step + 1e-9);
  for (let i = 0; i <= n; i++) out.push(round(start + i * step, 6));
  return out;
}

// ── Classification ─────────────────────────────────────────────────────────

/** One scored prediction. `predicted` undefined = provider error (excluded from classification metrics). */
export interface Scored {
  expected: string;
  predicted?: string;
  /** Pre-normalization label (e.g. Jev injection `review`) used for the escalation/review rate. */
  rawPredicted?: string;
  /** Confidence for the predicted class, 0..1, when the provider reports one. */
  confidence?: number;
}

/** confusion[expected][predicted] = count (every label pre-populated with 0). */
export type Confusion = Record<string, Record<string, number>>;

export function confusionMatrix(items: readonly Scored[], labels: readonly string[]): Confusion {
  const all = new Set(labels);
  for (const i of items) {
    all.add(i.expected);
    if (i.predicted !== undefined) all.add(i.predicted);
  }
  const keys = [...all];
  const m: Confusion = {};
  for (const e of keys) {
    m[e] = {};
    for (const p of keys) m[e][p] = 0;
  }
  for (const i of items) if (i.predicted !== undefined) m[i.expected][i.predicted] += 1;
  return m;
}

export function accuracy(items: readonly Scored[]): number {
  const scored = items.filter(i => i.predicted !== undefined);
  return ratio(scored.filter(i => i.predicted === i.expected).length, scored.length);
}

export interface ClassPRF { precision: number; recall: number; f1: number; support: number; predicted: number }

/**
 * Precision/recall/F1 for one class from a confusion matrix. Conventions: precision = 0 when the class
 * was never predicted, recall = 0 when it has no support, F1 = 0 when P+R = 0.
 */
export function classPRF(m: Confusion, label: string): ClassPRF {
  const keys = Object.keys(m);
  const tp = m[label]?.[label] ?? 0;
  const support = keys.reduce((s, p) => s + (m[label]?.[p] ?? 0), 0);
  const predicted = keys.reduce((s, e) => s + (m[e]?.[label] ?? 0), 0);
  const precision = ratio(tp, predicted);
  const recall = ratio(tp, support);
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, support, predicted };
}

export function perClassPRF(m: Confusion, labels: readonly string[]): Record<string, ClassPRF> {
  const out: Record<string, ClassPRF> = {};
  for (const l of labels) out[l] = classPRF(m, l);
  return out;
}

/** Unweighted mean F1 over classes that have support. */
export function macroF1(prf: Record<string, ClassPRF>): number {
  const withSupport = Object.values(prf).filter(c => c.support > 0);
  return ratio(withSupport.reduce((s, c) => s + c.f1, 0), withSupport.length);
}

// ── Calibration ────────────────────────────────────────────────────────────

export interface CalibrationItem { confidence: number; correct: boolean }

function calibrationItems(items: readonly Scored[]): CalibrationItem[] {
  return items
    .filter(i => i.predicted !== undefined && typeof i.confidence === 'number' && Number.isFinite(i.confidence))
    .map(i => ({ confidence: Math.min(1, Math.max(0, i.confidence as number)), correct: i.predicted === i.expected }));
}

/** Brier score of the predicted-class confidence vs correctness (lower is better); undefined when empty. */
export function brierScore(items: readonly CalibrationItem[]): number | undefined {
  if (!items.length) return undefined;
  return items.reduce((s, i) => s + (i.confidence - (i.correct ? 1 : 0)) ** 2, 0) / items.length;
}

/**
 * Expected calibration error with `bins` equal-width bins over [0,1] (confidence 1.0 falls in the last
 * bin): Σ_b (n_b / N) · |accuracy_b − meanConfidence_b|. Undefined when empty.
 */
export function expectedCalibrationError(items: readonly CalibrationItem[], bins = 10): number | undefined {
  if (!items.length) return undefined;
  const acc = Array.from({ length: bins }, () => ({ n: 0, correct: 0, conf: 0 }));
  for (const i of items) {
    const b = Math.min(bins - 1, Math.floor(i.confidence * bins));
    acc[b].n += 1;
    acc[b].conf += i.confidence;
    if (i.correct) acc[b].correct += 1;
  }
  return acc.reduce((s, b) => (b.n ? s + (b.n / items.length) * Math.abs(b.correct / b.n - b.conf / b.n) : s), 0);
}

// ── Consistency / agreement ────────────────────────────────────────────────

/**
 * Self-consistency: fraction of cases whose verdict is identical across all repeats. Cases with fewer
 * than two successful repeats (any error) are excluded. Undefined when no case qualifies.
 */
export function selfConsistency(verdictsPerCase: ReadonlyArray<ReadonlyArray<string | undefined>>): { rate: number; cases: number } | undefined {
  const eligible = verdictsPerCase.filter(v => v.length >= 2 && v.every(x => x !== undefined));
  if (!eligible.length) return undefined;
  const same = eligible.filter(v => v.every(x => x === v[0])).length;
  return { rate: same / eligible.length, cases: eligible.length };
}

export interface Agreement { agree: number; compared: number; rate: number }

/**
 * Pairwise agreement between aligned prediction vectors (index = case × repeat). Only positions where
 * both sides produced a verdict are compared. Diagonal is 1 over the provider's own scored items.
 */
export function agreementMatrix(preds: Readonly<Record<string, ReadonlyArray<string | undefined>>>): Record<string, Record<string, Agreement>> {
  const keys = Object.keys(preds);
  const out: Record<string, Record<string, Agreement>> = {};
  for (const a of keys) {
    out[a] = {};
    for (const b of keys) {
      const va = preds[a];
      const vb = preds[b];
      let agree = 0;
      let compared = 0;
      for (let i = 0; i < Math.min(va.length, vb.length); i++) {
        if (va[i] === undefined || vb[i] === undefined) continue;
        compared += 1;
        if (va[i] === vb[i]) agree += 1;
      }
      out[a][b] = { agree, compared, rate: ratio(agree, compared) };
    }
  }
  return out;
}

// ── Aggregate classification metrics ───────────────────────────────────────

export interface TaskLabels {
  /** Ground-truth label set (e.g. allow/deny/escalate). */
  labels: readonly string[];
  /** Safety-critical class (deny / attack). */
  positive: string;
  /** The "let it through" class (allow / clean): positive → negative is a false allow. */
  negative: string;
  /** Raw predicted labels that count toward the escalation/review rate. */
  escalation: readonly string[];
}

export interface ClassificationMetrics {
  /** Total predictions (including errors). */
  total: number;
  /** Predictions with a verdict (classification metrics are computed over these). */
  n: number;
  errors: number;
  accuracy: number;
  perClass: Record<string, ClassPRF>;
  macroF1: number;
  confusion: Confusion;
  positiveRecall: number;
  positivePrecision: number;
  /** expected positive → predicted negative, over expected-positive scored items. */
  falseAllowRate: number;
  /** Raw escalation/review predictions over scored items. */
  escalationRate: number;
  calibration?: { brier: number; ece: number; n: number };
}

export function classificationMetrics(items: readonly Scored[], task: TaskLabels): ClassificationMetrics {
  const scored = items.filter(i => i.predicted !== undefined);
  const confusion = confusionMatrix(items, task.labels);
  const perClass = perClassPRF(confusion, task.labels);
  const pos = perClass[task.positive] ?? classPRF(confusion, task.positive);
  const expectedPos = scored.filter(i => i.expected === task.positive);
  const falseAllows = expectedPos.filter(i => i.predicted === task.negative).length;
  const escalations = scored.filter(i => task.escalation.includes(i.rawPredicted ?? i.predicted ?? '')).length;
  const cal = calibrationItems(items);
  const brier = brierScore(cal);
  const ece = expectedCalibrationError(cal);
  const out: ClassificationMetrics = {
    total: items.length,
    n: scored.length,
    errors: items.length - scored.length,
    accuracy: accuracy(items),
    perClass,
    macroF1: macroF1(perClass),
    confusion,
    positiveRecall: pos.recall,
    positivePrecision: pos.precision,
    falseAllowRate: ratio(falseAllows, expectedPos.length),
    escalationRate: ratio(escalations, scored.length),
  };
  if (brier !== undefined && ece !== undefined) out.calibration = { brier, ece, n: cal.length };
  return out;
}

/** Accuracy per tag (items without tags are ignored). */
export function perTagAccuracy(items: ReadonlyArray<Scored & { tags?: readonly string[] }>): Record<string, { n: number; correct: number; accuracy: number }> {
  const out: Record<string, { n: number; correct: number; accuracy: number }> = {};
  for (const i of items) {
    if (i.predicted === undefined) continue;
    for (const t of i.tags ?? []) {
      const b = (out[t] ??= { n: 0, correct: 0, accuracy: 0 });
      b.n += 1;
      if (i.predicted === i.expected) b.correct += 1;
    }
  }
  for (const b of Object.values(out)) b.accuracy = ratio(b.correct, b.n);
  return out;
}

// ── Cost ───────────────────────────────────────────────────────────────────

export interface Pricing { inputPerMtok: number; outputPerMtok: number }

export function estimateCostUsd(inputTokens: number, outputTokens: number, price: Pricing | undefined): number | undefined {
  if (!price) return undefined;
  return (inputTokens * price.inputPerMtok + outputTokens * price.outputPerMtok) / 1e6;
}

// ── Threshold sweep ────────────────────────────────────────────────────────

export interface SweepPoint<P = Record<string, number>> {
  params: P;
  accuracy: number;
  macroF1: number;
  positiveRecall: number;
  falseAllowRate: number;
  escalationRate: number;
}

export interface SweepSelection<P> {
  best: SweepPoint<P> | undefined;
  /** False when no point met the recall floor (best is then the highest-recall point). */
  constraintMet: boolean;
  minPositiveRecall: number;
}

/**
 * Pick the operating point with the highest accuracy subject to positive (deny/attack) recall ≥
 * `minPositiveRecall`. Ties: higher recall, then lower false-allow rate, then lower escalation rate,
 * then grid order. When nothing meets the floor, returns the highest-recall point (then accuracy).
 */
export function selectOperatingPoint<P>(points: ReadonlyArray<SweepPoint<P>>, minPositiveRecall: number): SweepSelection<P> {
  const eps = 1e-9;
  const feasible = points.filter(p => p.positiveRecall + eps >= minPositiveRecall);
  const byAccuracy = (a: SweepPoint<P>, b: SweepPoint<P>): number =>
    b.accuracy - a.accuracy || b.positiveRecall - a.positiveRecall || a.falseAllowRate - b.falseAllowRate || a.escalationRate - b.escalationRate;
  if (feasible.length) return { best: [...feasible].sort(byAccuracy)[0], constraintMet: true, minPositiveRecall };
  const byRecall = (a: SweepPoint<P>, b: SweepPoint<P>): number => b.positiveRecall - a.positiveRecall || byAccuracy(a, b);
  return { best: [...points].sort(byRecall)[0], constraintMet: false, minPositiveRecall };
}
