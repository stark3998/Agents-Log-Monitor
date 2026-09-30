import { afterAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadBenchmarks } from '../../src/governance/jev/benchmarks';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-bench-'));
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function variant(provider: string, over: Record<string, unknown> = {}) {
  return {
    provider, models: [provider === 'jev' ? 'jev-1.13.0' : 'gpt-4.1-mini'], total: 3, n: 3, errors: 0, accuracy: 2 / 3,
    perClass: { deny: { precision: 1, recall: 0.5, f1: 0.67, support: 2, predicted: 1 } }, macroF1: 0.6,
    confusion: { allow: { allow: 1 }, deny: { deny: 1, escalate: 1 } }, positiveRecall: 0.5, positivePrecision: 1,
    falseAllowRate: 0, escalationRate: 1 / 3, calibration: { brier: 0.1, ece: 0.05, n: 3 },
    latency: { count: 3, p50: 90, p95: 200, p99: 210, mean: 110 }, tokens: { input: 600, output: 60 },
    perTag: { mcp: { n: 1, correct: 0, accuracy: 0 } }, costUsd: 0.00003, costPer1kUsd: 0.01,
    selfConsistency: { rate: 0.9, cases: 3 },
    ...over,
  };
}

function writeCompareRun(name: string, dataset: 'judge' | 'injection', generatedAt: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify({
    dataset, generatedAt, cases: 3, repeat: 1,
    providers: [{ id: 'foundry-fast', variants: ['foundry-fast'] }, { id: 'jev', variants: ['jev:strict'] }], skipped: [],
    variants: { 'foundry-fast': variant('foundry-fast', { accuracy: 1, positiveRecall: 1 }), 'jev:strict': variant('jev') },
    agreement: { 'jev:strict': { 'foundry-fast': { agree: 2, compared: 3, rate: 2 / 3 } } },
    sweep: { variantOf: 'jev', base: 'strict', grid: {}, minPositiveRecall: 1, minPositiveRecallSource: 'foundry-fast deny recall', constraintMet: false,
      best: { params: { deny: 0.9, review: 0.4 }, accuracy: 0.9, macroF1: 0.8, positiveRecall: 0.5, falseAllowRate: 0, escalationRate: 0.3 },
      points: [{}, {}] },
    headline: { lines: [], jev: 'jev:strict', baseline: 'foundry-fast', accuracyDelta: -1 / 3, p95Speedup: 10 },
  }));
  const cases = [
    { id: 'ok', expected: 'allow', tags: [], providers: { 'foundry-fast': [{ verdict: 'allow' }], 'jev:strict': [{ verdict: 'allow', confidence: 0.9 }] } },
    { id: 'jev-miss', expected: 'deny', tags: ['mcp'], providers: { 'foundry-fast': [{ verdict: 'deny' }], 'jev:strict': [{ verdict: 'escalate', confidence: 0.52 }] } },
    { id: 'base-error', expected: 'deny', tags: [], providers: { 'foundry-fast': [{ error: 'timed out' }], 'jev:strict': [{ verdict: 'deny' }] } },
  ];
  fs.writeFileSync(path.join(dir, 'cases.jsonl'), `${cases.map(c => JSON.stringify(c)).join('\n')}\n`);
}

writeCompareRun('old-judge', 'judge', '2026-09-01T00:00:00.000Z');
writeCompareRun('new-judge', 'judge', '2026-09-30T00:00:00.000Z');
writeCompareRun('inj', 'injection', '2026-09-30T01:00:00.000Z');
fs.mkdirSync(path.join(root, 'not-a-run'));
fs.writeFileSync(path.join(root, 'notes.json'), JSON.stringify({ hello: 'world' }));
fs.writeFileSync(path.join(root, 'triage-1.json'), JSON.stringify({
  dataset: 'triage', generatedAt: '2026-09-30T02:00:00.000Z', model: 'jev-1.13.0', questionsVersion: 'guardian-triage-v1',
  metrics: { cases: 2, severityExact: 0.5, incidentTypeAccuracy: 1, note: 'ignored' },
  results: [
    { id: 't-ok', expected: { severity: 'low', incident_type: 'x', investigate: false }, severity: 'low', incident_type: 'x', investigate: false, error: null },
    { id: 't-miss', expected: { severity: 'low', incident_type: 'x', investigate: false }, severity: 'medium', incident_type: 'x', investigate: false, error: null },
  ],
}));

describe('loadBenchmarks', () => {
  it('reports unavailable when the results folder is missing', async () => {
    expect(await loadBenchmarks({}, path.join(root, 'missing'))).toEqual({ available: false, runs: [] });
  });

  it('returns the newest run per dataset, the run history and label misses', async () => {
    const b = await loadBenchmarks({}, root);
    expect(b.available).toBe(true);
    expect(b.runs.map(r => r.id)).toEqual(['triage-1.json', 'inj', 'new-judge', 'old-judge']);
    expect(b.judge?.id).toBe('new-judge');
    expect(b.judge?.positiveLabel).toBe('deny');
    expect(b.injection?.positiveLabel).toBe('attack');
    const jev = b.judge!.variants.find(v => v.variant === 'jev:strict')!;
    expect(jev.latency.p95).toBe(200);
    expect(jev.selfConsistency).toBe(0.9);
    expect(b.judge!.sweep).toMatchObject({ constraintMet: false, points: 2, best: { params: { deny: 0.9, review: 0.4 } } });
    expect(b.judge!.headline).toMatchObject({ jev: 'jev:strict', baseline: 'foundry-fast', p95Speedup: 10 });
    expect(b.judge!.misses.map(m => [m.id, m.jevCorrect, m.baselineCorrect])).toEqual([['jev-miss', false, true], ['base-error', true, false]]);
    expect(b.judge!.misses[1].baseline?.error).toBe('timed out');
    expect(b.triage).toMatchObject({ id: 'triage-1.json', model: 'jev-1.13.0', metrics: { cases: 2, severityExact: 0.5 } });
    expect(b.triage!.metrics).not.toHaveProperty('note');
    expect(b.triage!.misses.map(m => m.id)).toEqual(['t-miss']);
  });

  it('selects an older run by id and ignores unknown or path-like ids', async () => {
    expect((await loadBenchmarks({ judge: 'old-judge' }, root)).judge?.id).toBe('old-judge');
    expect((await loadBenchmarks({ judge: '../etc' }, root)).judge?.id).toBe('new-judge');
    expect((await loadBenchmarks({ judge: 'inj' }, root)).judge?.id).toBe('new-judge');
  });
});
