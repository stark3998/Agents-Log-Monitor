import { useMemo, useState, type ReactNode } from 'react';
import {
  Alert, Box, Chip, MenuItem, Skeleton, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography, alpha, useTheme, type Theme,
} from '@mui/material';
import ScienceRoundedIcon from '@mui/icons-material/ScienceRounded';
import TrendingUpRoundedIcon from '@mui/icons-material/TrendingUpRounded';
import TrendingDownRoundedIcon from '@mui/icons-material/TrendingDownRounded';
import TrendingFlatRoundedIcon from '@mui/icons-material/TrendingFlatRounded';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import ErrorOutlineRoundedIcon from '@mui/icons-material/ErrorOutlineRounded';
import {
  useJevBenchmarks, type BenchmarkCaseRow, type BenchmarkDataset, type BenchmarkVariant, type CompareBenchmarkRun, type TriageBenchmarkRun,
} from '../../api/governance';
import { EmptyState, SectionCard } from '../../components/Common';
import { RelativeTime } from '../../components/Primitives';
import { QueryError, StatCard } from '../../components/gov/GovCommon';
import { successTone } from '../../components/gov/GovChips';
import { OutcomeChip, fmtPct, fmtUsd } from '../../components/gov/JevCommon';
import { fmtDuration, fmtNum } from '../../lib/format';

type Tokens = Theme['tokens'];
const dur = (ms: number) => fmtDuration(ms) || '0ms';
const isJev = (v: string) => v === 'jev' || v.startsWith('jev:');

const DATASET_LABEL: Record<BenchmarkDataset, string> = { judge: 'Judge', injection: 'Prompt injection', triage: 'Guardian triage' };
const DATASET_BLURB: Record<BenchmarkDataset, string> = {
  judge: 'Allow / escalate / deny verdicts on labelled agent actions, against the Foundry LLM judge tiers.',
  injection: 'Attack / clean verdicts on labelled tool outputs, against Azure Prompt Shields.',
  triage: 'Severity, incident type and "needs investigation" on labelled Guardian triggers.',
};

export function variantLabel(v: string): string {
  if (v === 'foundry-fast') return 'Foundry fast';
  if (v === 'foundry-escalation') return 'Foundry escalation';
  if (v === 'prompt-shields') return 'Prompt Shields';
  if (v.startsWith('jev:')) return `Jev · ${v.slice(4)}`;
  return v;
}

function variantColor(t: Tokens, v: string): string {
  if (v.startsWith('jev:')) return v.endsWith(':strict') || v === 'jev' ? t.accent : alpha(t.accent, 0.55);
  if (v === 'foundry-fast') return t.category.READ ?? t.textSecondary;
  if (v === 'foundry-escalation') return t.category.MCP ?? t.textSecondary;
  if (v === 'prompt-shields') return t.category.NETWORK ?? t.textSecondary;
  return t.textTertiary;
}

// ── Headline: Jev vs baseline ──────────────────────────────────────────────

function VersusTile({ label, jev, base, baseLabel, delta, good, up, testId }: {
  label: string; jev: string; base: string; baseLabel: string; delta?: string; good?: boolean | null; up?: boolean; testId?: string;
}) {
  const t = useTheme().tokens;
  const tone = good == null ? t.textSecondary : good ? t.success : t.danger;
  const rising = up ?? !!good;
  return (
    <Box
      data-testid={testId}
      role="group"
      aria-label={`${label}: Jev ${jev}, ${baseLabel} ${base}${delta ? `, ${delta}` : ''}`}
      sx={{ p: 2, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', minWidth: 0 }}
    >
      <Typography variant="caption" component="div" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mt: 0.5 }}>
        <Typography sx={{ fontSize: 28, fontWeight: 700, color: t.accent, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{jev}</Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>vs {base}</Typography>
      </Stack>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5, minHeight: 20 }}>
        {delta && good != null && (/^[+-]?0\.0 pp$/.test(delta)
          ? <TrendingFlatRoundedIcon sx={{ fontSize: 16, color: tone }} />
          : rising ? <TrendingUpRoundedIcon sx={{ fontSize: 16, color: tone }} /> : <TrendingDownRoundedIcon sx={{ fontSize: 16, color: tone }} />)}
        <Typography variant="caption" sx={{ color: tone, fontWeight: 600 }}>{delta ?? '\u00a0'}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>· baseline {baseLabel}</Typography>
      </Stack>
    </Box>
  );
}

function pp(d: number | undefined): string | undefined {
  if (d == null) return undefined;
  const v = d * 100;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)} pp`;
}

function Headline({ run }: { run: CompareBenchmarkRun }) {
  const byKey = new Map(run.variants.map(v => [v.variant, v]));
  const jevKey = run.headline?.jev ?? run.variants.find(v => isJev(v.variant))?.variant;
  const baseKey = run.headline?.baseline ?? run.variants.find(v => !isJev(v.variant))?.variant;
  const jev = jevKey ? byKey.get(jevKey) : undefined;
  const base = baseKey ? byKey.get(baseKey) : undefined;
  if (!jev) {
    return <Alert severity="info">Jev did not run in this benchmark ({run.skipped.map(s => s.reason).join('; ') || 'no Jev provider'}).</Alert>;
  }
  const baseLabel = base ? variantLabel(base.variant) : 'n/a';
  const pos = run.positiveLabel;
  const recallDelta = base ? jev.positiveRecall - base.positiveRecall : undefined;
  const accDelta = base ? jev.accuracy - base.accuracy : undefined;
  const faDelta = base ? jev.falseAllowRate - base.falseAllowRate : undefined;
  const speed = base && jev.latency.p95 > 0 && base.latency.count ? base.latency.p95 / jev.latency.p95 : undefined;
  const cheaper = base?.costPer1kUsd && jev.costPer1kUsd ? base.costPer1kUsd / jev.costPer1kUsd : undefined;
  const gateRecall = !base || jev.positiveRecall >= base.positiveRecall;
  const gateFalseAllow = !base || jev.falseAllowRate <= base.falseAllowRate;
  return (
    <Stack spacing={1.5} data-testid="bench-headline">
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(5, 1fr)' } }}>
        <VersusTile testId="bench-tile-accuracy" label="Accuracy" jev={fmtPct(jev.accuracy, 1)} base={base ? fmtPct(base.accuracy, 1) : '—'} baseLabel={baseLabel}
          delta={pp(accDelta)} good={accDelta == null ? null : accDelta >= 0} up={accDelta == null ? undefined : accDelta >= 0} />
        <VersusTile testId="bench-tile-recall" label={`${pos} recall`} jev={fmtPct(jev.positiveRecall, 1)} base={base ? fmtPct(base.positiveRecall, 1) : '—'} baseLabel={baseLabel}
          delta={pp(recallDelta)} good={recallDelta == null ? null : recallDelta >= 0} up={recallDelta == null ? undefined : recallDelta >= 0} />
        <VersusTile testId="bench-tile-false-allow" label="False-allow" jev={fmtPct(jev.falseAllowRate, 1)} base={base ? fmtPct(base.falseAllowRate, 1) : '—'} baseLabel={baseLabel}
          delta={pp(faDelta)} good={faDelta == null ? null : faDelta <= 0} up={faDelta == null ? undefined : faDelta > 0} />
        <VersusTile testId="bench-tile-latency" label="p95 latency" jev={dur(jev.latency.p95)} base={base?.latency.count ? dur(base.latency.p95) : '—'} baseLabel={baseLabel}
          delta={speed != null ? `${speed.toFixed(1)}× faster` : undefined} good={speed == null ? null : speed >= 1} />
        <VersusTile testId="bench-tile-cost" label="Cost / 1k decisions" jev={fmtUsd(jev.costPer1kUsd ?? null)} base={base?.costPer1kUsd != null ? fmtUsd(base.costPer1kUsd) : 'n/a'} baseLabel={baseLabel}
          delta={cheaper != null ? `${cheaper.toFixed(1)}× cheaper` : undefined} good={cheaper == null ? null : cheaper >= 1} />
      </Box>
      {base && (
        <Alert
          severity={gateRecall && gateFalseAllow ? 'success' : 'warning'}
          variant="outlined"
          icon={gateRecall && gateFalseAllow ? <CheckCircleRoundedIcon /> : <ErrorOutlineRoundedIcon />}
          data-testid="bench-gate"
        >
          {gateRecall && gateFalseAllow
            ? <>Offline safety gate met: {variantLabel(jev.variant)} matches {baseLabel} on {pos} recall and false-allow. Promotion still needs two weeks of live shadow data.</>
            : <>Offline safety gate not met: {variantLabel(jev.variant)} has {fmtPct(jev.positiveRecall, 1)} {pos} recall vs {fmtPct(base.positiveRecall, 1)} for {baseLabel}
              {gateFalseAllow ? '' : ` and a higher false-allow rate`}. Jev stays shadow-only.</>}
        </Alert>
      )}
    </Stack>
  );
}

// ── Metric bars ────────────────────────────────────────────────────────────

interface MetricDef { key: string; label: string; get: (v: BenchmarkVariant) => number | null | undefined; fmt: (n: number) => string; lowerIsBetter?: boolean; hint?: string }

function metricDefs(run: CompareBenchmarkRun): MetricDef[] {
  const pos = run.positiveLabel;
  const Pos = pos.charAt(0).toUpperCase() + pos.slice(1);
  return [
    { key: 'accuracy', label: 'Accuracy', get: v => v.accuracy, fmt: n => fmtPct(n, 1) },
    { key: 'macroF1', label: 'Macro-F1', get: v => v.macroF1, fmt: n => n.toFixed(3), hint: 'Mean F1 across all classes; punishes never predicting a class' },
    { key: 'recall', label: `${Pos} recall`, get: v => v.positiveRecall, fmt: n => fmtPct(n, 1), hint: `Share of true ${pos} cases caught (safety-critical)` },
    { key: 'precision', label: `${Pos} precision`, get: v => v.positivePrecision, fmt: n => fmtPct(n, 1), hint: `Share of ${pos} predictions that were right (over-blocking)` },
    { key: 'falseAllow', label: 'False-allow', get: v => v.falseAllowRate, fmt: n => fmtPct(n, 1), lowerIsBetter: true, hint: `True ${pos} cases that were allowed / passed` },
    { key: 'p95', label: 'p95 latency', get: v => (v.latency.count ? v.latency.p95 : null), fmt: dur, lowerIsBetter: true },
    { key: 'cost', label: 'Cost / 1k', get: v => v.costPer1kUsd, fmt: n => fmtUsd(n), lowerIsBetter: true },
    { key: 'ece', label: 'Calibration error (ECE)', get: v => v.calibration?.ece, fmt: n => n.toFixed(3), lowerIsBetter: true, hint: 'How far stated confidence is from actual accuracy' },
  ];
}

function MetricBars({ run }: { run: CompareBenchmarkRun }) {
  const t = useTheme().tokens;
  const defs = metricDefs(run);
  return (
    <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }} data-testid="bench-bars">
      {defs.map(d => {
        const vals = run.variants.map(v => ({ v, x: d.get(v) }));
        const present = vals.filter((e): e is { v: BenchmarkVariant; x: number } => e.x != null && Number.isFinite(e.x));
        if (!present.length) return null;
        const max = Math.max(...present.map(e => e.x), d.key === 'p95' || d.key === 'cost' ? 0 : 1e-9);
        const scaleMax = ['accuracy', 'macroF1', 'recall', 'precision', 'falseAllow'].includes(d.key) ? 1 : max || 1;
        const best = d.lowerIsBetter ? Math.min(...present.map(e => e.x)) : Math.max(...present.map(e => e.x));
        return (
          <Box key={d.key} role="group" aria-label={`${d.label}: ${present.map(e => `${variantLabel(e.v.variant)} ${d.fmt(e.x)}`).join(', ')}`}>
            <Stack direction="row" spacing={0.75} sx={{ alignItems: 'baseline', mb: 0.75 }}>
              <Typography variant="subtitle2" component="h4" aria-hidden>{d.label}</Typography>
              {d.lowerIsBetter && <Typography variant="caption" color="text.secondary" aria-hidden>lower is better</Typography>}
              {d.hint && <Tooltip title={d.hint}><Typography variant="caption" color="text.secondary" sx={{ cursor: 'help' }} aria-hidden>ⓘ</Typography></Tooltip>}
            </Stack>
            <Stack spacing={0.6} aria-hidden>
              {vals.map(({ v, x }) => (
                <Stack key={v.variant} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Typography variant="caption" sx={{ width: 128, flexShrink: 0, fontWeight: isJev(v.variant) ? 700 : 500 }} noWrap>{variantLabel(v.variant)}</Typography>
                  <Box sx={{ flex: 1, height: 12, borderRadius: 99, bgcolor: 'action.hover', overflow: 'hidden' }}>
                    {x != null && (
                      <Box sx={{
                        height: '100%', borderRadius: 99, bgcolor: variantColor(t, v.variant),
                        width: `${Math.max(1.5, (x / scaleMax) * 100)}%`, transition: 'width 500ms cubic-bezier(0.2,0,0,1)',
                      }} />
                    )}
                  </Box>
                  <Typography variant="caption" sx={{
                    width: 64, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums',
                    fontWeight: x === best ? 700 : 400, color: x === best ? successTone(t).fg : 'text.primary',
                  }}>
                    {x == null ? '—' : d.fmt(x)}
                  </Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Leaderboard table ──────────────────────────────────────────────────────

function Leaderboard({ run }: { run: CompareBenchmarkRun }) {
  const t = useTheme().tokens;
  const defs = metricDefs(run);
  const bestOf = (d: MetricDef) => {
    const xs = run.variants.map(d.get).filter((x): x is number => x != null && Number.isFinite(x));
    return xs.length ? (d.lowerIsBetter ? Math.min(...xs) : Math.max(...xs)) : undefined;
  };
  const bests = new Map(defs.map(d => [d.key, bestOf(d)]));
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Provider comparison" data-testid="bench-leaderboard" sx={{ '& td, & th': { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow>
            <TableCell>Provider</TableCell>
            <TableCell>Model</TableCell>
            <TableCell align="right">Scored</TableCell>
            {defs.map(d => <TableCell key={d.key} align="right">{d.label}</TableCell>)}
            <TableCell align="right">Escalation rate</TableCell>
            <TableCell align="right">Tokens in / out</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {run.variants.map(v => (
            <TableRow key={v.variant} hover sx={isJev(v.variant) ? { bgcolor: alpha(t.accent, 0.05) } : undefined}>
              <TableCell component="th" scope="row">
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: variantColor(t, v.variant), flexShrink: 0 }} />
                  <Typography variant="body2" sx={{ fontWeight: isJev(v.variant) ? 700 : 500 }}>{variantLabel(v.variant)}</Typography>
                </Stack>
              </TableCell>
              <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{v.models.join(', ') || '—'}</TableCell>
              <TableCell align="right">
                {fmtNum(v.n)}{v.errors ? <Tooltip title={`${v.errors} call(s) errored and are excluded`}><Box component="span" sx={{ color: t.danger, ml: 0.5 }}>({v.errors} err)</Box></Tooltip> : null}
              </TableCell>
              {defs.map(d => {
                const x = d.get(v);
                const best = x != null && x === bests.get(d.key);
                return (
                  <TableCell key={d.key} align="right" sx={{ fontWeight: best ? 700 : 400, color: best ? successTone(t).fg : undefined }}>
                    {x == null ? '—' : d.fmt(x)}
                  </TableCell>
                );
              })}
              <TableCell align="right">{fmtPct(v.escalationRate, 1)}</TableCell>
              <TableCell align="right">{fmtNum(v.tokens.input)} / {fmtNum(v.tokens.output)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

// ── Confusion matrices ─────────────────────────────────────────────────────

const ORDER = ['allow', 'clean', 'escalate', 'review', 'deny', 'attack'];
const sortLabels = (ls: Iterable<string>) => [...new Set(ls)].sort((a, b) => {
  const ia = ORDER.indexOf(a); const ib = ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
});

function LabelConfusion({ v }: { v: BenchmarkVariant }) {
  const t = useTheme().tokens;
  const rows = Object.keys(v.confusion);
  const labels = sortLabels([...rows, ...rows.flatMap(r => Object.keys(v.confusion[r] ?? {}))]);
  const max = Math.max(1, ...rows.flatMap(r => Object.values(v.confusion[r] ?? {})));
  const agree = successTone(t);
  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.75 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: variantColor(t, v.variant) }} />
        <Typography variant="subtitle2" component="h4">{variantLabel(v.variant)}</Typography>
        <Typography variant="caption" color="text.secondary">{fmtPct(v.accuracy, 1)} correct</Typography>
      </Stack>
      <Table size="small" aria-label={`${variantLabel(v.variant)} confusion matrix: expected rows by predicted columns`} sx={{ '& td, & th': { fontVariantNumeric: 'tabular-nums', px: 1 } }}>
        <TableHead>
          <TableRow>
            <TableCell component="td" sx={{ color: 'text.secondary', fontSize: 11 }}>Label ↓ · Predicted →</TableCell>
            {labels.map(c => <TableCell key={c} align="right" sx={{ textTransform: 'capitalize', fontSize: 12 }}>{c}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {labels.map(r => (
            <TableRow key={r}>
              <TableCell component="th" scope="row" sx={{ textTransform: 'capitalize', fontWeight: 600, fontSize: 12 }}>{r}</TableCell>
              {labels.map(c => {
                const n = v.confusion[r]?.[c] ?? 0;
                const diag = r === c;
                return (
                  <TableCell key={c} align="right" title={`Label ${r}, predicted ${c}: ${n}`} sx={{
                    fontWeight: n ? 600 : 400,
                    color: n === 0 ? 'text.disabled' : diag ? agree.fg : t.severity.medium.fg,
                    bgcolor: diag ? agree.bg : n ? alpha(t.severity.medium.fg, 0.06 + 0.2 * (n / max)) : undefined,
                  }}>
                    {fmtNum(n)}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

// ── Agreement / sweep / per-tag ────────────────────────────────────────────

function AgreementMatrix({ run }: { run: CompareBenchmarkRun }) {
  const t = useTheme().tokens;
  const keys = run.variants.map(v => v.variant);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Pairwise agreement between providers" data-testid="bench-agreement" sx={{ '& td, & th': { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow>
            <TableCell component="td" />
            {keys.map(k => <TableCell key={k} align="right">{variantLabel(k)}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {keys.map(r => (
            <TableRow key={r}>
              <TableCell component="th" scope="row" sx={{ fontWeight: 600 }}>{variantLabel(r)}</TableCell>
              {keys.map(c => {
                const a = run.agreement[r]?.[c];
                const self = r === c;
                return (
                  <TableCell key={c} align="right" title={a ? `${a.agree} of ${a.compared}` : undefined} sx={{
                    color: self ? 'text.disabled' : undefined,
                    bgcolor: !self && a ? alpha(t.accent, 0.04 + 0.22 * Math.max(0, (a.rate - 0.5) * 2)) : undefined,
                  }}>
                    {a ? fmtPct(a.rate, 0) : '—'}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function SweepCard({ run }: { run: CompareBenchmarkRun }) {
  const s = run.sweep;
  if (!s?.best) return <Typography variant="body2" color="text.secondary">No threshold sweep in this run (use <code>--sweep</code>).</Typography>;
  const b = s.best;
  return (
    <Stack spacing={1.25} data-testid="bench-sweep">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip size="small" color={s.constraintMet ? 'success' : 'warning'} variant="outlined"
          label={s.constraintMet ? 'Recall floor met' : 'Recall floor not met'} />
        <Typography variant="caption" color="text.secondary">
          {fmtNum(s.points)} threshold points over the <b>{s.base}</b> policy
          {s.minPositiveRecall != null ? <> · floor {fmtPct(s.minPositiveRecall, 1)} ({s.minPositiveRecallSource})</> : null}
        </Typography>
      </Stack>
      <Box sx={{ display: 'grid', gap: 1, gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
        {Object.entries(b.params).map(([k, x]) => <Kv key={k} k={`${k} threshold`} v={x.toFixed(2)} />)}
        <Kv k="Accuracy" v={fmtPct(b.accuracy, 1)} />
        <Kv k={`${run.positiveLabel} recall`} v={fmtPct(b.positiveRecall, 1)} />
        <Kv k="False-allow" v={fmtPct(b.falseAllowRate, 1)} />
        <Kv k="Escalation" v={fmtPct(b.escalationRate, 1)} />
      </Box>
      <Typography variant="caption" color="text.secondary">
        Best operating point from re-combining the same Jev answers under different thresholds (no extra calls). Tune <code>JEV_POLICIES</code> in
        {' '}<code>src/governance/jev/questions.ts</code>.
      </Typography>
    </Stack>
  );
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <Box sx={{ p: 1, borderRadius: 1.5, bgcolor: 'action.hover' }}>
      <Typography variant="caption" component="div" color="text.secondary" sx={{ textTransform: 'capitalize' }}>{k}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{v}</Typography>
    </Box>
  );
}

function PerTag({ run }: { run: CompareBenchmarkRun }) {
  const t = useTheme().tokens;
  const tags = useMemo(() => {
    const all = new Set(run.variants.flatMap(v => Object.keys(v.perTag)));
    return [...all].sort((a, b) => {
      const spread = (tag: string) => {
        const xs = run.variants.map(v => v.perTag[tag]?.accuracy).filter((x): x is number => x != null);
        return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
      };
      return spread(b) - spread(a) || a.localeCompare(b);
    });
  }, [run]);
  if (!tags.length) return <Typography variant="body2" color="text.secondary">No tagged cases.</Typography>;
  return (
    <Box sx={{ overflowX: 'auto', maxHeight: 360 }}>
      <Table size="small" stickyHeader aria-label="Accuracy by case tag" sx={{ '& td, & th': { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow>
            <TableCell>Tag</TableCell>
            {run.variants.map(v => <TableCell key={v.variant} align="right">{variantLabel(v.variant)}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {tags.map(tag => (
            <TableRow key={tag} hover>
              <TableCell component="th" scope="row" sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{tag}</TableCell>
              {run.variants.map(v => {
                const p = v.perTag[tag];
                return (
                  <TableCell key={v.variant} align="right" sx={{ color: p == null ? 'text.disabled' : p.accuracy >= 0.999 ? successTone(t).fg : p.accuracy < 0.6 ? t.danger : undefined }}>
                    {p ? `${fmtPct(p.accuracy, 0)} (${p.correct}/${p.n})` : '—'}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

// ── Misses ─────────────────────────────────────────────────────────────────

type MissFilter = 'all' | 'jev' | 'baseline' | 'both';

function Misses({ run }: { run: CompareBenchmarkRun }) {
  const [filter, setFilter] = useState<MissFilter>('jev');
  const jevKey = run.headline?.jev ?? 'jev';
  const baseKey = run.headline?.baseline ?? 'baseline';
  const counts = {
    all: run.misses.length,
    jev: run.misses.filter(m => !m.jevCorrect).length,
    baseline: run.misses.filter(m => !m.baselineCorrect).length,
    both: run.misses.filter(m => !m.jevCorrect && !m.baselineCorrect).length,
  };
  const rows = run.misses.filter(m => filter === 'all' || (filter === 'jev' && !m.jevCorrect) || (filter === 'baseline' && !m.baselineCorrect)
    || (filter === 'both' && !m.jevCorrect && !m.baselineCorrect));
  const pred = (p: BenchmarkCaseRow['jev'], label: string) => (p?.verdict
    ? (
      <Stack spacing={0.25} sx={{ alignItems: 'flex-start' }}>
        <OutcomeChip verdict={p.verdict} label={p.verdict} ariaPrefix={label} />
        {p.confidence != null && <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>{fmtPct(p.confidence)} conf.</Typography>}
      </Stack>
    )
    : <Tooltip title={p?.error ?? 'not run'}><Typography variant="caption" color="error">error</Typography></Tooltip>);
  return (
    <Stack spacing={1.5}>
      <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v: MissFilter | null) => v && setFilter(v)} aria-label="Filter missed cases">
        <ToggleButton value="jev">Jev wrong ({counts.jev})</ToggleButton>
        <ToggleButton value="baseline">{variantLabel(baseKey)} wrong ({counts.baseline})</ToggleButton>
        <ToggleButton value="both">Both wrong ({counts.both})</ToggleButton>
        <ToggleButton value="all">All ({counts.all})</ToggleButton>
      </ToggleButtonGroup>
      {!rows.length ? <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>No cases in this view.</Typography> : (
        <Box sx={{ overflowX: 'auto', maxHeight: 420 }}>
          <Table size="small" stickyHeader aria-label="Missed cases" data-testid="bench-misses">
            <TableHead>
              <TableRow>
                <TableCell>Case</TableCell>
                <TableCell>Expected</TableCell>
                <TableCell>{variantLabel(jevKey)}</TableCell>
                <TableCell>{variantLabel(baseKey)}</TableCell>
                <TableCell>Tags</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(m => (
                <TableRow key={m.id} hover>
                  <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{m.id}</TableCell>
                  <TableCell><OutcomeChip verdict={m.expected} label={m.expected} ariaPrefix="Expected" /></TableCell>
                  <TableCell>{pred(m.jev, 'Jev')}</TableCell>
                  <TableCell>{pred(m.baseline, 'Baseline')}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                      {m.tags.map(tag => <Chip key={tag} size="small" variant="outlined" label={tag} sx={{ height: 20, fontSize: 11 }} />)}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      )}
    </Stack>
  );
}

// ── Dataset panels ─────────────────────────────────────────────────────────

function CompareRunPanel({ run }: { run: CompareBenchmarkRun }) {
  const t = useTheme().tokens;
  return (
    <Stack spacing={2}>
      <Headline run={run} />
      {run.skipped.length > 0 && (
        <Alert severity="info" variant="outlined">Skipped: {run.skipped.map(s => `${variantLabel(s.id)} — ${s.reason}`).join('; ')}</Alert>
      )}
      <SectionCard title="Head to head" subtitle="Every provider on the same labelled cases; the best value per metric is highlighted" delay={60}>
        <Stack direction="row" spacing={2} sx={{ mb: 2, flexWrap: 'wrap', gap: 1 }} aria-hidden>
          {run.variants.map(v => (
            <Stack key={v.variant} direction="row" spacing={0.75} sx={{ alignItems: 'center', fontSize: 12, color: 'text.secondary' }}>
              <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: variantColor(t, v.variant) }} />
              <span>{variantLabel(v.variant)}{v.models.length ? ` (${v.models.join(', ')})` : ''}</span>
            </Stack>
          ))}
        </Stack>
        <MetricBars run={run} />
      </SectionCard>
      <SectionCard title="Leaderboard" subtitle="All metrics per provider" delay={90}>
        <Leaderboard run={run} />
      </SectionCard>
      <SectionCard title="Confusion matrices" subtitle="Rows are the label, columns the prediction; the diagonal is correct" delay={120}>
        <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' } }} data-testid="bench-confusions">
          {run.variants.map(v => <LabelConfusion key={v.variant} v={v} />)}
        </Box>
      </SectionCard>
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
        <SectionCard title="Threshold sweep" subtitle="Best Jev operating point" delay={150}>
          <SweepCard run={run} />
        </SectionCard>
        <SectionCard title="Agreement" subtitle="How often two providers gave the same verdict" delay={170}>
          <AgreementMatrix run={run} />
        </SectionCard>
      </Box>
      <SectionCard title="Accuracy by tag" subtitle="Sorted by how much the providers differ" delay={190}>
        <PerTag run={run} />
      </SectionCard>
      <SectionCard title="Missed cases" subtitle="Cases where Jev or the baseline disagreed with the label" delay={210}>
        <Misses run={run} />
      </SectionCard>
    </Stack>
  );
}

function TriagePanel({ run }: { run: TriageBenchmarkRun }) {
  const t = useTheme().tokens;
  const m = run.metrics;
  const pct = (k: string) => (m[k] == null ? null : Math.round(m[k] * 1000));
  const fmt1 = (n: number) => `${(n / 10).toFixed(1)}%`;
  const tone = (k: string) => (m[k] == null ? undefined : m[k] >= 0.9 ? t.success : m[k] >= 0.75 ? t.severity.medium.fg : t.danger);
  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }} data-testid="bench-triage">
        <StatCard index={0} label="Severity exact" value={pct('severityExact')} format={fmt1} tone={tone('severityExact')} ariaLabel={`Severity exact ${fmtPct(m.severityExact, 1)}`} />
        <StatCard index={1} label="Severity ±1 level" value={pct('severityWithinOne')} format={fmt1} tone={tone('severityWithinOne')} ariaLabel={`Severity within one ${fmtPct(m.severityWithinOne, 1)}`} />
        <StatCard index={2} label="Incident type" value={pct('incidentTypeAccuracy')} format={fmt1} tone={tone('incidentTypeAccuracy')} ariaLabel={`Incident type accuracy ${fmtPct(m.incidentTypeAccuracy, 1)}`} />
        <StatCard index={3} label="Investigate precision" value={pct('investigatePrecision')} format={fmt1} tone={tone('investigatePrecision')} ariaLabel={`Investigate precision ${fmtPct(m.investigatePrecision, 1)}`} />
        <StatCard index={4} label="Investigate recall" value={pct('investigateRecall')} format={fmt1} tone={tone('investigateRecall')} ariaLabel={`Investigate recall ${fmtPct(m.investigateRecall, 1)}`} />
        <StatCard index={5} label="Latency (p50)" value={m.latencyP50Ms ?? null} format={dur} suffix={m.latencyP95Ms != null ? `p95 ${dur(m.latencyP95Ms)}` : undefined} ariaLabel={`Latency p50 ${dur(m.latencyP50Ms ?? 0)}`} />
        <StatCard index={6} label="Cases" value={m.cases ?? null} suffix={m.errors ? `${m.errors} errors` : 'no errors'} ariaLabel={`Cases ${fmtNum(m.cases ?? 0)}`} />
        <StatCard index={7} label="Avg input tokens" value={m.avgInputTokens != null ? Math.round(m.avgInputTokens) : null} ariaLabel={`Average input tokens ${fmtNum(m.avgInputTokens ?? 0)}`} />
      </Box>
      <Alert severity="info" variant="outlined">
        Guardian's investigation report is generative, so there is no LLM baseline here: Jev is scored against the labels. Live shadow runs compare it with the Guardian's own <code>Severity:</code> line.
      </Alert>
      <SectionCard title="Missed cases" subtitle="Triggers where any triage field differed from the label" delay={120}>
        {!run.misses.length ? <Typography variant="body2" color="text.secondary">No misses.</Typography> : (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Missed triage cases" data-testid="bench-triage-misses">
              <TableHead>
                <TableRow>
                  <TableCell>Case</TableCell>
                  <TableCell>Severity (label → Jev)</TableCell>
                  <TableCell>Incident type (label → Jev)</TableCell>
                  <TableCell>Investigate (label → Jev)</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {run.misses.map(r => {
                  const cell = (k: string) => {
                    const e = String(r.expected[k] ?? '—'); const g = String(r.got[k] ?? '—');
                    return <Box component="span" sx={{ color: e === g ? 'text.secondary' : t.severity.medium.fg, fontWeight: e === g ? 400 : 600 }}>{e === g ? e : `${e} → ${g}`}</Box>;
                  };
                  return (
                    <TableRow key={r.id} hover>
                      <TableCell sx={{ fontFamily: 'var(--am-mono)', fontSize: 12 }}>{r.id}</TableCell>
                      <TableCell>{cell('severity')}</TableCell>
                      <TableCell sx={{ fontSize: 12.5 }}>{cell('incident_type')}</TableCell>
                      <TableCell>{cell('investigate')}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}
      </SectionCard>
    </Stack>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────

function NoBenchmarks({ available }: { available: boolean }) {
  return (
    <SectionCard>
      <EmptyState
        icon={<ScienceRoundedIcon />}
        title="No benchmark results yet"
        body={available
          ? 'Run the offline benchmark to compare Jev with the LLM judge, Prompt Shields and labelled triage cases:'
          : 'The results folder (eval/results or JEV_EVAL_RESULTS_DIR) was not found on this server. Run:'}
        action={(
          <Box component="pre" sx={{ m: 0, p: 1.5, borderRadius: 1.5, bgcolor: 'action.hover', fontSize: 12.5, textAlign: 'left' }}>
            {'npm run eval:compare -- --dataset judge --policy all --sweep\nnpm run eval:compare -- --dataset injection --policy all --sweep\npython intelligence/scripts/eval_triage.py --json'}
          </Box>
        )}
      />
    </SectionCard>
  );
}

/** Offline benchmark results (eval:compare / eval_triage) — Jev vs the LLM judge, Prompt Shields and triage labels. */
export function JevBenchmarkPanel() {
  const [sel, setSel] = useState<Partial<Record<BenchmarkDataset, string>>>({});
  const q = useJevBenchmarks(sel);
  const b = q.data;
  const datasets = (['judge', 'injection', 'triage'] as const).filter(d => b?.[d]);
  const [dataset, setDataset] = useState<BenchmarkDataset | null>(null);
  const active = dataset && datasets.includes(dataset) ? dataset : datasets[0];

  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  if (!b) {
    return (
      <Stack spacing={1.5} aria-busy="true" aria-label="Loading benchmarks">
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} variant="rounded" height={104} />)}</Box>
        <Skeleton variant="rounded" height={320} />
      </Stack>
    );
  }
  if (!active) return <NoBenchmarks available={b.available} />;

  const run = b[active];
  const runsForDataset = b.runs.filter(r => r.dataset === active);
  const count = (d: BenchmarkDataset) => {
    const r = b[d];
    return r ? (r.dataset === 'triage' ? r.metrics.cases ?? 0 : r.cases) : 0;
  };
  const models = run
    ? run.dataset === 'triage' ? [run.model] : [...new Set(run.variants.flatMap(v => v.models))]
    : [];

  return (
    <Stack spacing={2} data-testid="jev-benchmarks">
      <Tabs
        value={active}
        onChange={(_, v: BenchmarkDataset) => setDataset(v)}
        aria-label="Benchmark dataset"
        variant="scrollable"
        allowScrollButtonsMobile
        sx={{ borderBottom: '1px solid', borderColor: 'divider' }}
      >
        {datasets.map(d => <Tab key={d} value={d} id={`bench-tab-${d}`} aria-controls="bench-tabpanel" label={`${DATASET_LABEL[d]} (${fmtNum(count(d))})`} />)}
      </Tabs>
      <Box role="tabpanel" id="bench-tabpanel" aria-labelledby={`bench-tab-${active}`}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ alignItems: { md: 'center' } }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" color="text.secondary">{DATASET_BLURB[active]}</Typography>
              {run && (
                <Typography variant="caption" component="div" sx={{ mt: 0.25 }}>
                  Run <b>{run.id}</b> · <RelativeTime iso={run.generatedAt} />
                  {run.dataset !== 'triage' ? <> · {fmtNum(run.cases)} cases × {run.repeat}</> : null}
                  {models.length ? <> · models <code>{models.join(', ')}</code></> : null}
                </Typography>
              )}
            </Box>
            {runsForDataset.length > 1 && (
              <TextField
                select size="small" label="Run" value={run?.id ?? ''} sx={{ minWidth: 240 }}
                onChange={e => setSel(s => ({ ...s, [active]: e.target.value }))}
              >
                {runsForDataset.map(r => <MenuItem key={r.id} value={r.id}>{r.id} · {new Date(r.generatedAt).toLocaleString()}</MenuItem>)}
              </TextField>
            )}
          </Stack>
          {run && (run.dataset === 'triage' ? <TriagePanel run={run} /> : <CompareRunPanel run={run} />)}
        </Stack>
      </Box>
    </Stack>
  );
}
