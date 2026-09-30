/**
 * Reads the offline benchmark results written by `npm run eval:compare` (judge / injection:
 * `<dir>/<run>/metrics.json` + `cases.jsonl`) and `intelligence/scripts/eval_triage.py --json`
 * (`<dir>/*.json`) so the dashboard can show them next to live shadow data.
 *
 * The directory is `JEV_EVAL_RESULTS_DIR`, else `<repo>/eval/results`. Only server-side paths are read;
 * callers can pick a run by its directory/file name, which is validated against the listing.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export type BenchmarkDataset = 'judge' | 'injection' | 'triage';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_CASE_ROWS = 300;
const MAX_RUNS = 50;

export interface BenchmarkLatency { count: number; p50: number; p95: number; p99: number; mean: number }

export interface BenchmarkVariant {
  variant: string;
  provider: string;
  models: string[];
  total: number;
  n: number;
  errors: number;
  accuracy: number;
  macroF1: number;
  positiveRecall: number;
  positivePrecision: number;
  falseAllowRate: number;
  escalationRate: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; support: number; predicted: number }>;
  confusion: Record<string, Record<string, number>>;
  calibration?: { brier: number; ece: number; n: number } | null;
  latency: BenchmarkLatency;
  tokens: { input: number; output: number };
  costUsd?: number | null;
  costPer1kUsd?: number | null;
  selfConsistency?: number | null;
  perTag: Record<string, { n: number; correct: number; accuracy: number }>;
}

export interface BenchmarkCaseRow {
  id: string;
  expected: string;
  tags: string[];
  jev?: { verdict?: string; confidence?: number; error?: string };
  baseline?: { verdict?: string; confidence?: number; error?: string };
  jevCorrect: boolean;
  baselineCorrect: boolean;
}

export interface CompareBenchmarkRun {
  id: string;
  dataset: 'judge' | 'injection';
  generatedAt: string;
  cases: number;
  repeat: number;
  /** "positive" (safety-critical) class: deny for judge, attack for injection. */
  positiveLabel: string;
  providers: { id: string; variants: string[] }[];
  skipped: { id: string; reason: string }[];
  variants: BenchmarkVariant[];
  agreement: Record<string, Record<string, { agree: number; compared: number; rate: number }>>;
  headline?: {
    jev: string;
    baseline: string;
    accuracyDelta?: number;
    positiveRecallDelta?: number;
    falseAllowDelta?: number;
    p95Speedup?: number;
    costRatio?: number;
  } | null;
  sweep?: {
    base: string;
    constraintMet: boolean;
    minPositiveRecall?: number;
    minPositiveRecallSource?: string;
    best?: { params: Record<string, number>; accuracy: number; macroF1: number; positiveRecall: number; falseAllowRate: number; escalationRate: number } | null;
    points: number;
  } | null;
  /** Cases where the headline Jev variant or the baseline disagreed with the label (capped). */
  misses: BenchmarkCaseRow[];
}

export interface TriageBenchmarkRun {
  id: string;
  dataset: 'triage';
  generatedAt: string;
  model: string;
  questionsVersion?: string;
  metrics: Record<string, number>;
  misses: { id: string; expected: Record<string, unknown>; got: Record<string, unknown> }[];
}

export interface BenchmarkRunRef { id: string; dataset: BenchmarkDataset; generatedAt: string }

export interface JevBenchmarks {
  /** False when the results directory does not exist on this server. */
  available: boolean;
  runs: BenchmarkRunRef[];
  judge?: CompareBenchmarkRun;
  injection?: CompareBenchmarkRun;
  triage?: TriageBenchmarkRun;
}

export function benchmarkDir(): string {
  const env = process.env.JEV_EVAL_RESULTS_DIR?.trim();
  if (env) return resolve(env);
  // src/governance/jev (ts-node) and dist/governance/jev (build) are both three levels below the repo root.
  const fromModule = resolve(__dirname, '..', '..', '..', 'eval', 'results');
  return existsSync(fromModule) ? fromModule : resolve(process.cwd(), 'eval', 'results');
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const numOr = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const strOr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);

async function readJson(file: string): Promise<unknown> {
  const s = await stat(file);
  if (!s.isFile() || s.size > MAX_FILE_BYTES) return undefined;
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; }
}

interface Listing {
  compare: { id: string; dataset: 'judge' | 'injection'; generatedAt: string; dir: string }[];
  triage: { id: string; generatedAt: string; file: string }[];
}

async function list(dir: string): Promise<Listing> {
  const out: Listing = { compare: [], triage: [] };
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  await Promise.all(entries.map(async e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const m = await readJson(join(p, 'metrics.json')).catch(() => undefined);
      if (!isObj(m) || (m.dataset !== 'judge' && m.dataset !== 'injection')) return;
      out.compare.push({ id: e.name, dataset: m.dataset, generatedAt: strOr(m.generatedAt), dir: p });
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
      const j = await readJson(p).catch(() => undefined);
      if (!isObj(j) || !isObj(j.metrics) || typeof (j.metrics as Obj).severityExact !== 'number') return;
      const generatedAt = strOr(j.generatedAt) || (await stat(p)).mtime.toISOString();
      out.triage.push({ id: e.name, generatedAt, file: p });
    }
  }));
  const byDate = (a: { generatedAt: string }, b: { generatedAt: string }) => b.generatedAt.localeCompare(a.generatedAt);
  out.compare.sort(byDate);
  out.triage.sort(byDate);
  return out;
}

function variant(key: string, v: Obj): BenchmarkVariant {
  const lat = isObj(v.latency) ? v.latency : {};
  const tok = isObj(v.tokens) ? v.tokens : {};
  const cal = isObj(v.calibration) ? v.calibration : null;
  return {
    variant: key,
    provider: strOr(v.provider, key),
    models: Array.isArray(v.models) ? v.models.map(String) : [],
    total: numOr(v.total),
    n: numOr(v.n),
    errors: numOr(v.errors),
    accuracy: numOr(v.accuracy),
    macroF1: numOr(v.macroF1),
    positiveRecall: numOr(v.positiveRecall),
    positivePrecision: numOr(v.positivePrecision),
    falseAllowRate: numOr(v.falseAllowRate),
    escalationRate: numOr(v.escalationRate),
    perClass: (isObj(v.perClass) ? v.perClass : {}) as BenchmarkVariant['perClass'],
    confusion: (isObj(v.confusion) ? v.confusion : {}) as BenchmarkVariant['confusion'],
    calibration: cal ? { brier: numOr(cal.brier), ece: numOr(cal.ece), n: numOr(cal.n) } : null,
    latency: { count: numOr(lat.count), p50: numOr(lat.p50), p95: numOr(lat.p95), p99: numOr(lat.p99), mean: numOr(lat.mean) },
    tokens: { input: numOr(tok.input), output: numOr(tok.output) },
    costUsd: optNum(v.costUsd) ?? null,
    costPer1kUsd: optNum(v.costPer1kUsd) ?? null,
    selfConsistency: isObj(v.selfConsistency) ? optNum(v.selfConsistency.rate) ?? null : optNum(v.selfConsistency) ?? null,
    perTag: (isObj(v.perTag) ? v.perTag : {}) as BenchmarkVariant['perTag'],
  };
}

type Pred = { verdict?: string; confidence?: number; error?: string };

function firstPred(providers: Obj, key: string | undefined): Pred | undefined {
  if (!key) return undefined;
  const arr = providers[key];
  if (!Array.isArray(arr) || !arr.length) return undefined;
  const ok = arr.find(p => isObj(p) && typeof p.verdict === 'string') ?? arr[0];
  if (!isObj(ok)) return undefined;
  return {
    verdict: typeof ok.verdict === 'string' ? ok.verdict : undefined,
    confidence: optNum(ok.confidence),
    error: typeof ok.error === 'string' ? ok.error.slice(0, 300) : undefined,
  };
}

async function readMisses(dir: string, jevKey?: string, baseKey?: string): Promise<BenchmarkCaseRow[]> {
  const file = join(dir, 'cases.jsonl');
  let text: string;
  try {
    const s = await stat(file);
    if (s.size > MAX_FILE_BYTES) return [];
    text = await readFile(file, 'utf8');
  } catch { return []; }
  const rows: BenchmarkCaseRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let c: unknown;
    try { c = JSON.parse(line); } catch { continue; }
    if (!isObj(c) || !isObj(c.providers)) continue;
    const expected = strOr(c.expected);
    const jev = firstPred(c.providers, jevKey);
    const baseline = firstPred(c.providers, baseKey);
    const jevCorrect = !!jev?.verdict && jev.verdict === expected;
    const baselineCorrect = !!baseline?.verdict && baseline.verdict === expected;
    if (jevCorrect && (baselineCorrect || !baseline)) continue;
    rows.push({ id: strOr(c.id), expected, tags: Array.isArray(c.tags) ? c.tags.map(String) : [], jev, baseline, jevCorrect, baselineCorrect });
    if (rows.length >= MAX_CASE_ROWS) break;
  }
  return rows;
}

export async function loadCompareRun(id: string, dir: string): Promise<CompareBenchmarkRun | undefined> {
  const m = await readJson(join(dir, 'metrics.json')).catch(() => undefined);
  if (!isObj(m) || (m.dataset !== 'judge' && m.dataset !== 'injection')) return undefined;
  const variants = isObj(m.variants) ? Object.entries(m.variants).filter(([, v]) => isObj(v)).map(([k, v]) => variant(k, v as Obj)) : [];
  const h = isObj(m.headline) ? m.headline : null;
  const sw = isObj(m.sweep) ? m.sweep : null;
  const best = sw && isObj(sw.best) ? sw.best : null;
  const headline = h && typeof h.jev === 'string' && typeof h.baseline === 'string'
    ? {
      jev: h.jev, baseline: h.baseline,
      accuracyDelta: optNum(h.accuracyDelta), positiveRecallDelta: optNum(h.positiveRecallDelta),
      falseAllowDelta: optNum(h.falseAllowDelta), p95Speedup: optNum(h.p95Speedup), costRatio: optNum(h.costRatio),
    }
    : null;
  const jevKey = headline?.jev ?? variants.find(v => v.provider === 'jev')?.variant;
  const baseKey = headline?.baseline ?? variants.find(v => v.provider !== 'jev')?.variant;
  return {
    id,
    dataset: m.dataset,
    generatedAt: strOr(m.generatedAt),
    cases: numOr(m.cases),
    repeat: numOr(m.repeat, 1),
    positiveLabel: m.dataset === 'judge' ? 'deny' : 'attack',
    providers: Array.isArray(m.providers)
      ? m.providers.filter(isObj).map(p => ({ id: strOr(p.id), variants: Array.isArray(p.variants) ? p.variants.map(String) : [] }))
      : [],
    skipped: Array.isArray(m.skipped) ? m.skipped.filter(isObj).map(s => ({ id: strOr(s.id), reason: strOr(s.reason) })) : [],
    variants,
    agreement: (isObj(m.agreement) ? m.agreement : {}) as CompareBenchmarkRun['agreement'],
    headline,
    sweep: sw
      ? {
        base: strOr(sw.base),
        constraintMet: sw.constraintMet === true,
        minPositiveRecall: optNum(sw.minPositiveRecall),
        minPositiveRecallSource: typeof sw.minPositiveRecallSource === 'string' ? sw.minPositiveRecallSource : undefined,
        best: best && isObj(best.params)
          ? {
            params: Object.fromEntries(Object.entries(best.params).filter(([, v]) => typeof v === 'number')) as Record<string, number>,
            accuracy: numOr(best.accuracy), macroF1: numOr(best.macroF1), positiveRecall: numOr(best.positiveRecall),
            falseAllowRate: numOr(best.falseAllowRate), escalationRate: numOr(best.escalationRate),
          }
          : null,
        points: Array.isArray(sw.points) ? sw.points.length : 0,
      }
      : null,
    misses: await readMisses(dir, jevKey, baseKey),
  };
}

export async function loadTriageRun(id: string, file: string, generatedAt: string): Promise<TriageBenchmarkRun | undefined> {
  const j = await readJson(file).catch(() => undefined);
  if (!isObj(j) || !isObj(j.metrics)) return undefined;
  const metrics = Object.fromEntries(Object.entries(j.metrics).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
  const misses: TriageBenchmarkRun['misses'] = [];
  if (Array.isArray(j.results)) {
    for (const r of j.results) {
      if (!isObj(r) || !isObj(r.expected)) continue;
      const e = r.expected;
      const got = { severity: r.severity, incident_type: r.incident_type, investigate: r.investigate, error: r.error ?? undefined };
      if (!r.error && e.severity === r.severity && e.incident_type === r.incident_type && e.investigate === r.investigate) continue;
      misses.push({ id: strOr(r.id), expected: e, got });
      if (misses.length >= MAX_CASE_ROWS) break;
    }
  }
  return {
    id, dataset: 'triage', generatedAt, model: strOr(j.model), questionsVersion: typeof j.questionsVersion === 'string' ? j.questionsVersion : undefined,
    metrics, misses,
  };
}

/**
 * Latest run per dataset (or the requested run ids, when they exist in the listing) plus the run history.
 */
export async function loadBenchmarks(select: Partial<Record<BenchmarkDataset, string>> = {}, dir = benchmarkDir()): Promise<JevBenchmarks> {
  if (!existsSync(dir)) return { available: false, runs: [] };
  const l = await list(dir);
  const runs: BenchmarkRunRef[] = [
    ...l.compare.map(r => ({ id: r.id, dataset: r.dataset, generatedAt: r.generatedAt })),
    ...l.triage.map(r => ({ id: r.id, dataset: 'triage' as const, generatedAt: r.generatedAt })),
  ].sort((a, b) => b.generatedAt.localeCompare(a.generatedAt)).slice(0, MAX_RUNS);

  const pick = <T extends { id: string }>(items: T[], want?: string): T | undefined =>
    (want ? items.find(i => i.id === basename(want)) : undefined) ?? items[0];

  const out: JevBenchmarks = { available: true, runs };
  for (const ds of ['judge', 'injection'] as const) {
    const r = pick(l.compare.filter(c => c.dataset === ds), select[ds]);
    if (r) {
      const run = await loadCompareRun(r.id, r.dir);
      if (run) out[ds] = run;
    }
  }
  const t = pick(l.triage, select.triage);
  if (t) {
    const run = await loadTriageRun(t.id, t.file, t.generatedAt);
    if (run) out.triage = run;
  }
  return out;
}
