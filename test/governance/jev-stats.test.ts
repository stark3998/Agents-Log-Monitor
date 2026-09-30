import { afterEach, describe, expect, it } from 'vitest';
import { JEV_PRICE_PER_MTOK_INPUT } from '../../src/governance/jev/config';
import { latencyStats, summarizeShadow, verdictRank } from '../../src/governance/jev/stats';
import type { JevShadowRecord } from '../../src/governance/jev/types';

let n = 0;
function rec(p: { kind?: JevShadowRecord['kind']; b?: string; j?: string; agree?: boolean; at?: string; jevMs?: number; baseMs?: number; error?: string; jIn?: number; bIn?: number; bOut?: number; provider?: JevShadowRecord['baseline']['provider']; model?: string }): JevShadowRecord {
  n++;
  return {
    id: `r${n}`, kind: p.kind ?? 'judge', createdAt: p.at ?? `2026-05-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`,
    baseline: { provider: p.provider ?? 'foundry', model: p.model, verdict: p.b, latencyMs: p.baseMs, inputTokens: p.bIn, outputTokens: p.bOut },
    jev: { model: 'jev-1.13.0', verdict: p.error ? undefined : p.j, latencyMs: p.jevMs ?? 10, inputTokens: p.jIn, signals: {}, error: p.error },
    agree: p.agree,
  };
}

afterEach(() => {
  delete process.env.FOUNDRY_PRICE_INPUT_PER_MTOK;
  delete process.env.FOUNDRY_PRICE_OUTPUT_PER_MTOK;
});

describe('verdictRank', () => {
  it('orders permissive < review < block across vocabularies', () => {
    for (const v of ['allow', 'clean', 'info', 'low']) expect(verdictRank(v)).toBe(0);
    for (const v of ['review', 'escalate', 'medium', 'ask']) expect(verdictRank(v)).toBe(1);
    for (const v of ['deny', 'attack', 'high', 'critical', 'DENY ']) expect(verdictRank(v)).toBe(2);
    expect(verdictRank('???')).toBeUndefined();
    expect(verdictRank(undefined)).toBeUndefined();
  });

  it('ranks the fleet verdict labels (allow-ish < ambiguous/review < block-ish)', () => {
    for (const v of ['allow', 'in_scope', 'aligned', 'different', 'clean', 'necessary']) expect(verdictRank(v)).toBe(0);
    for (const v of ['ambiguous', 'review']) expect(verdictRank(v)).toBe(1);
    for (const v of ['block', 'out_of_scope', 'misaligned', 'same', 'attack', 'unnecessary', 'risky']) expect(verdictRank(v)).toBe(2);
    expect(verdictRank('benign')).toBe(0); // fleet static-analysis code baseline: benign ↔ risky
    // case / separator tolerant; prototype keys are not verdicts
    expect(verdictRank('Out-of-Scope')).toBe(2);
    expect(verdictRank(' In Scope ')).toBe(0);
    expect(verdictRank('constructor')).toBeUndefined();
    expect(verdictRank('toString')).toBeUndefined();
  });
});

describe('summarizeShadow — fleet kinds', () => {
  it('counts stricter/looser disagreements with fleet vocabularies and orders fleet kinds after the core kinds', () => {
    const records = [
      rec({ kind: 'fleet_code', b: 'necessary', j: 'unnecessary', agree: false, provider: 'rules' }),   // stricter
      rec({ kind: 'fleet_evasion', b: 'same', j: 'different', agree: false }),                          // looser
      rec({ kind: 'fleet_evasion', b: 'same', j: 'same', agree: true }),
      rec({ kind: 'fleet_intent', b: 'in_scope', j: 'ambiguous', agree: false }),                       // stricter
      rec({ kind: 'fleet_intent', b: 'out_of_scope', j: 'ambiguous', agree: false }),                   // looser
      rec({ kind: 'fleet_alignment', b: 'aligned', j: 'misaligned', agree: false }),                    // stricter
      rec({ kind: 'fleet_realtime', b: 'block', j: 'allow', agree: false, provider: 'rules' }),         // looser
      rec({ kind: 'fleet_injection', b: 'clean', j: 'review', agree: false }),                          // stricter
      rec({ kind: 'judge', b: 'allow', j: 'allow', agree: true }),
    ];
    const out = summarizeShadow(records);
    expect(out.map(k => k.kind)).toEqual([
      'judge', 'fleet_realtime', 'fleet_intent', 'fleet_alignment', 'fleet_evasion', 'fleet_injection', 'fleet_code',
    ]);
    const by = Object.fromEntries(out.map(k => [k.kind, k]));
    expect(by.fleet_realtime).toMatchObject({ jevStricter: 0, jevLooser: 1 });
    expect(by.fleet_intent).toMatchObject({ compared: 2, agreed: 0, jevStricter: 1, jevLooser: 1 });
    expect(by.fleet_alignment).toMatchObject({ jevStricter: 1, jevLooser: 0 });
    expect(by.fleet_evasion).toMatchObject({ compared: 2, agreed: 1, agreementRate: 0.5, jevStricter: 0, jevLooser: 1 });
    expect(by.fleet_injection).toMatchObject({ jevStricter: 1, jevLooser: 0 });
    expect(by.fleet_code).toMatchObject({ jevStricter: 1, jevLooser: 0 });
    expect(by.fleet_code.confusion).toEqual({ necessary: { unnecessary: 1 } });
  });
});

describe('latencyStats', () => {
  it('computes nearest-rank percentiles and mean', () => {
    const s = latencyStats(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, mean: 50.5 });
  });
  it('returns zeros for no samples and ignores invalid values', () => {
    expect(latencyStats([])).toEqual({ count: 0, p50: 0, p95: 0, p99: 0, mean: 0 });
    expect(latencyStats([Number.NaN, -1, 7]).count).toBe(1);
  });
});

describe('summarizeShadow', () => {
  it('computes agreement, confusion and stricter/looser per kind', () => {
    const records = [
      rec({ b: 'allow', j: 'allow', agree: true }),
      rec({ b: 'allow', j: 'deny', agree: false }),       // stricter
      rec({ b: 'allow', j: 'escalate', agree: false }),   // stricter
      rec({ b: 'deny', j: 'allow', agree: false }),       // looser
      rec({ b: 'deny', error: 'timeout', jevMs: 2000 }),  // jev error, not compared
      rec({ kind: 'injection', b: 'attack', j: 'clean', agree: false, provider: 'prompt-shields' }), // looser
      rec({ kind: 'injection', b: 'clean', j: 'clean', provider: 'prompt-shields' }), // agree derived from verdicts
    ];
    const out = summarizeShadow(records);
    expect(out.map(k => k.kind)).toEqual(['judge', 'injection']);
    const judge = out[0];
    expect(judge).toMatchObject({ total: 5, compared: 4, agreed: 1, agreementRate: 0.25, jevErrors: 1, jevStricter: 2, jevLooser: 1 });
    expect(judge.confusion).toEqual({ allow: { allow: 1, deny: 1, escalate: 1 }, deny: { allow: 1 } });
    const inj = out[1];
    expect(inj).toMatchObject({ total: 2, compared: 2, agreed: 1, agreementRate: 0.5, jevStricter: 0, jevLooser: 1 });
    expect(inj.baselineModels).toEqual(['prompt-shields']);
  });

  it('computes latency for jev and baseline where present', () => {
    const out = summarizeShadow([rec({ b: 'allow', j: 'allow', jevMs: 20, baseMs: 500 }), rec({ b: 'allow', j: 'allow', jevMs: 40 })]);
    expect(out[0].latency.jev).toMatchObject({ count: 2, p50: 20, mean: 30 });
    expect(out[0].latency.baseline).toMatchObject({ count: 1, p50: 500 });
  });

  it('sums tokens, prices Jev input and prices baseline only when configured', () => {
    const records = [
      rec({ b: 'allow', j: 'allow', jIn: 600_000, bIn: 1_000_000, bOut: 100_000, model: 'gpt-4.1-mini' }),
      rec({ b: 'allow', j: 'allow', jIn: 400_000, bIn: 0, provider: 'rules' }),
    ];
    const noPrice = summarizeShadow(records)[0];
    expect(noPrice.tokens).toEqual({ jevInput: 1_000_000, baselineInput: 1_000_000, baselineOutput: 100_000 });
    expect(noPrice.estCostUsd.jev).toBeCloseTo(JEV_PRICE_PER_MTOK_INPUT, 6);
    expect(noPrice.estCostUsd.baseline).toBeUndefined();
    expect(noPrice.baselineModels).toEqual(['foundry/gpt-4.1-mini', 'rules']);
    expect(noPrice.jevModels).toEqual(['jev-1.13.0']);

    process.env.FOUNDRY_PRICE_INPUT_PER_MTOK = '0.4';
    process.env.FOUNDRY_PRICE_OUTPUT_PER_MTOK = '1.6';
    const priced = summarizeShadow(records)[0];
    expect(priced.estCostUsd.baseline).toBeCloseTo(0.4 + 0.16, 6);
  });

  it('applies the since (inclusive) / until (exclusive) window', () => {
    const records = [
      rec({ b: 'allow', j: 'allow', at: '2026-06-01T00:00:00.000Z' }),
      rec({ b: 'allow', j: 'allow', at: '2026-06-02T00:00:00.000Z' }),
      rec({ b: 'allow', j: 'allow', at: '2026-06-03T00:00:00.000Z' }),
    ];
    expect(summarizeShadow(records, { since: '2026-06-02T00:00:00.000Z', until: '2026-06-03T00:00:00.000Z' })[0].total).toBe(1);
    expect(summarizeShadow(records, { since: '2027-01-01T00:00:00.000Z' })).toEqual([]);
  });

  it('returns zero agreement rate when nothing is comparable', () => {
    const out = summarizeShadow([rec({ kind: 'session_score', b: undefined, j: 'high' })]);
    expect(out[0]).toMatchObject({ compared: 0, agreementRate: 0, confusion: {} });
  });
});
