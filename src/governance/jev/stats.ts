// src/governance/jev/stats.ts
/**
 * Pure aggregation of Jev shadow records into per-kind comparison summaries (agreement, confusion
 * matrix, stricter/looser disagreements, latency percentiles, tokens and estimated cost).
 */
import { JEV_PRICE_PER_MTOK_INPUT, jevConfig } from './config';
import type { JevKindSummary, JevShadowKind, JevShadowRecord, LatencyStats } from './types';

/** Fleet kinds (posted by the Python AgentMon Fleet), in canonical display order. */
export const JEV_FLEET_SHADOW_KINDS = [
  'fleet_realtime', 'fleet_intent', 'fleet_alignment', 'fleet_evasion', 'fleet_injection', 'fleet_code',
] as const satisfies readonly JevShadowKind[];

/** Every shadow kind in canonical order: in-process kinds, Guardian triage, then the Fleet kinds. */
export const JEV_SHADOW_KINDS = [
  'judge', 'injection', 'guardian_triage', 'session_score', ...JEV_FLEET_SHADOW_KINDS,
] as const satisfies readonly JevShadowKind[];

const RANKS: Record<string, number> = {
  // 0 — permissive / benign
  allow: 0, clean: 0, info: 0, low: 0, none: 0, safe: 0, benign: 0,
  // fleet: in-scope intent, aligned action, a genuinely different retry, a necessary script
  in_scope: 0, aligned: 0, different: 0, necessary: 0,
  // 1 — needs a human / moderate
  review: 1, escalate: 1, ask: 1, medium: 1, flag: 1, suspicious: 1,
  // fleet: intent could not be classified either way
  ambiguous: 1,
  // 2 — block / malicious / severe
  deny: 2, attack: 2, high: 2, critical: 2, block: 2, malicious: 2,
  // fleet: out-of-scope intent, misaligned action, an evasive same-effect retry, an unnecessary script
  out_of_scope: 2, misaligned: 2, same: 2, unnecessary: 2,
  // fleet code baseline from static analysis only (no LLM): risky ↔ benign
  risky: 2,
};

/**
 * Strictness rank of a categorical verdict across decision kinds:
 * allow/clean/info/low/in_scope/aligned/different/necessary (0)
 * < review/escalate/ask/medium/ambiguous (1)
 * < deny/block/attack/high/critical/out_of_scope/misaligned/same/unnecessary (2).
 * Labels are matched case-insensitively; `-` and spaces are treated as `_` (so `out-of-scope`
 * ranks like `out_of_scope`). Returns undefined for unknown labels.
 */
export function verdictRank(verdict: string | undefined): number | undefined {
  if (!verdict) return undefined;
  const key = verdict.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return Object.prototype.hasOwnProperty.call(RANKS, key) ? RANKS[key] : undefined;
}

/** Nearest-rank percentiles + mean (values rounded to 0.1 ms). */
export function latencyStats(values: number[]): LatencyStats {
  const v = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!v.length) return { count: 0, p50: 0, p95: 0, p99: 0, mean: 0 };
  const pick = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))];
  const r = (n: number) => Math.round(n * 10) / 10;
  return { count: v.length, p50: r(pick(0.5)), p95: r(pick(0.95)), p99: r(pick(0.99)), mean: r(v.reduce((s, n) => s + n, 0) / v.length) };
}

function norm(v: string | undefined): string | undefined {
  const s = v?.trim().toLowerCase();
  return s ? s : undefined;
}

/** Agreement for one record: the stored flag when present, else categorical equality when both verdicts exist. */
function agreementOf(r: JevShadowRecord): boolean | undefined {
  if (typeof r.agree === 'boolean') return r.agree;
  if (r.jev.error) return undefined;
  const b = norm(r.baseline.verdict);
  const j = norm(r.jev.verdict);
  return b && j ? b === j : undefined;
}

function roundUsd(n: number): number { return Math.round(n * 1e6) / 1e6; }

function summarizeKind(kind: JevShadowKind, records: JevShadowRecord[]): JevKindSummary {
  let compared = 0, agreed = 0, jevErrors = 0, jevStricter = 0, jevLooser = 0;
  let jevInput = 0, baselineInput = 0, baselineOutput = 0;
  const confusion: Record<string, Record<string, number>> = {};
  const jevLat: number[] = [];
  const baseLat: number[] = [];
  const baselineModels = new Set<string>();
  const jevModels = new Set<string>();

  for (const r of records) {
    if (r.jev.error) jevErrors++;
    const agree = agreementOf(r);
    if (agree !== undefined) { compared++; if (agree) agreed++; }

    const b = norm(r.baseline.verdict);
    const j = r.jev.error ? undefined : norm(r.jev.verdict);
    if (b && j) {
      const row = confusion[b] ?? (confusion[b] = {});
      row[j] = (row[j] ?? 0) + 1;
    }
    if (agree === false) {
      const rb = verdictRank(b);
      const rj = verdictRank(j);
      if (rb !== undefined && rj !== undefined) {
        if (rj > rb) jevStricter++;
        else if (rj < rb) jevLooser++;
      }
    }

    if (typeof r.jev.latencyMs === 'number') jevLat.push(r.jev.latencyMs);
    if (typeof r.baseline.latencyMs === 'number') baseLat.push(r.baseline.latencyMs);
    jevInput += r.jev.inputTokens ?? 0;
    baselineInput += r.baseline.inputTokens ?? 0;
    baselineOutput += r.baseline.outputTokens ?? 0;
    baselineModels.add(r.baseline.model ? `${r.baseline.provider}/${r.baseline.model}` : r.baseline.provider);
    if (r.jev.model) jevModels.add(r.jev.model);
  }

  const inPrice = jevConfig.foundryPrice.inputPerMtok;
  const outPrice = jevConfig.foundryPrice.outputPerMtok;
  const estCostUsd: JevKindSummary['estCostUsd'] = { jev: roundUsd(jevInput * JEV_PRICE_PER_MTOK_INPUT / 1e6) };
  if (inPrice !== undefined || outPrice !== undefined) {
    estCostUsd.baseline = roundUsd((baselineInput * (inPrice ?? 0) + baselineOutput * (outPrice ?? 0)) / 1e6);
  }

  return {
    kind,
    total: records.length,
    compared,
    agreed,
    agreementRate: compared ? Math.round((agreed / compared) * 10_000) / 10_000 : 0,
    jevErrors,
    confusion,
    jevStricter,
    jevLooser,
    latency: { jev: latencyStats(jevLat), baseline: latencyStats(baseLat) },
    tokens: { jevInput, baselineInput, baselineOutput },
    estCostUsd,
    baselineModels: [...baselineModels].sort(),
    jevModels: [...jevModels].sort(),
  };
}

/**
 * Summarise shadow records per kind. `since` is inclusive and `until` exclusive (ISO strings,
 * compared lexically like the stores do). Only kinds with at least one record are returned, in
 * the canonical order judge → injection → guardian_triage → session_score → fleet_realtime →
 * fleet_intent → fleet_alignment → fleet_evasion → fleet_injection → fleet_code.
 */
export function summarizeShadow(records: JevShadowRecord[], opts: { since?: string; until?: string } = {}): JevKindSummary[] {
  const byKind = new Map<JevShadowKind, JevShadowRecord[]>();
  for (const r of records) {
    if (opts.since && r.createdAt < opts.since) continue;
    if (opts.until && r.createdAt >= opts.until) continue;
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  const order = [...JEV_SHADOW_KINDS, ...[...byKind.keys()].filter(k => !JEV_SHADOW_KINDS.includes(k))];
  return order.filter(k => byKind.has(k)).map(k => summarizeKind(k, byKind.get(k)!));
}
