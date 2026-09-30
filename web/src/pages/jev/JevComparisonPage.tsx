import { Fragment, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Chip, Collapse, IconButton, Link as MuiLink, Skeleton, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow,
  Tabs, Tooltip, Typography, alpha, useTheme,
} from '@mui/material';
import CompareArrowsRoundedIcon from '@mui/icons-material/CompareArrowsRounded';
import BoltRoundedIcon from '@mui/icons-material/BoltRounded';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import {
  useJevShadowInfinite, useJevSummary, type JevKindSummary, type JevShadowKind, type JevShadowRecord, type JevShadowSummary, type LatencyStats,
} from '../../api/governance';
import { ApiError } from '../../api/client';
import { EmptyState, SectionCard, TimeRangePicker } from '../../components/Common';
import { CodeBlock } from '../../components/CodeBlock';
import { Ellipsis, RelativeTime } from '../../components/Primitives';
import { QueryError, StatCard } from '../../components/gov/GovCommon';
import { successTone } from '../../components/gov/GovChips';
import {
  JEV_KIND_BASELINE, JEV_KIND_DESCRIPTION, JEV_KIND_LABEL, JEV_KINDS, OutcomeChip, fmtPct, fmtUsd, isFleetKind, outcomeLabel,
} from '../../components/gov/JevCommon';
import { useRangeKey } from '../../lib/range';
import { fmtDuration, fmtNum, shortId } from '../../lib/format';
import { ConversationDrawer } from '../conversation/ConversationDrawer';

const dur = (ms: number) => fmtDuration(ms) || '0ms';
const isKind = (v: string | null): v is JevShadowKind => !!v && (JEV_KINDS as string[]).includes(v);
const visuallyHidden = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const;

/** Canonical ordering for confusion-matrix labels: safe → middle → risky → anything else (alphabetical). */
const LABEL_ORDER = ['allow', 'clean', 'benign', 'none', 'info', 'low', 'ask', 'escalate', 'suspicious', 'medium', 'deny', 'attack', 'high', 'critical'];
const labelRank = (l: string) => { const i = LABEL_ORDER.indexOf(l.toLowerCase()); return i === -1 ? LABEL_ORDER.length : i; };
const sortLabels = (ls: Iterable<string>) => [...new Set(ls)].sort((a, b) => labelRank(a) - labelRank(b) || a.localeCompare(b));

// ── Disabled state ─────────────────────────────────────────────────────────

function JevDisabledCard({ model }: { model?: string }) {
  return (
    <SectionCard>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ alignItems: { sm: 'flex-start' } }} data-testid="jev-disabled">
        <Box sx={{ width: 48, height: 48, flexShrink: 0, borderRadius: '14px', display: 'grid', placeItems: 'center', bgcolor: 'action.hover', color: 'text.secondary' }}>
          <BoltRoundedIcon />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle1" component="h3">Jev shadow mode is off</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 680 }}>
            TypeSafe Jev{model ? <> (<code>{model}</code>)</> : null} is a fast structured-decision model that can run next to the Foundry LLM judge,
            Prompt Shields, Guardian and heuristic session severity so you can compare agreement, latency and cost before relying on it.
          </Typography>
          <Box component="ol" sx={{ mt: 1.5, mb: 0, pl: 2.5, fontSize: 13.5, '& li': { mb: 0.5 } }}>
            <li>Set <code>TYPESAFE_API_KEY</code> in the monitor server environment (<code>.env</code> or the Container App secret).</li>
            <li>Restart the monitor. New decisions are shadowed in the background as they happen.</li>
            <li>Come back here to compare Jev with the current decision makers.</li>
          </Box>
          <Alert severity="info" variant="outlined" sx={{ mt: 1.5, maxWidth: 680 }}>
            Shadow only: Jev never changes a verdict, blocks an action or delays the authoritative decision.
          </Alert>
        </Box>
      </Stack>
    </SectionCard>
  );
}

// ── KPIs ───────────────────────────────────────────────────────────────────

function KindKpis({ k }: { k: JevKindSummary }) {
  const t = useTheme().tokens;
  const { jev, baseline } = k.latency;
  const speedup50 = jev.count && baseline.count && jev.p50 > 0 ? baseline.p50 / jev.p50 : null;
  const speedup95 = jev.count && baseline.count && jev.p95 > 0 ? baseline.p95 / jev.p95 : null;
  const agreeTone = k.compared === 0 ? undefined : k.agreementRate >= 0.9 ? t.success : k.agreementRate >= 0.75 ? t.severity.medium.fg : t.severity.critical.fg;
  const baseCost = k.estCostUsd.baseline;
  const tokensInfo = `Jev ${fmtNum(k.tokens.jevInput)} input tokens · baseline ${fmtNum(k.tokens.baselineInput)} in / ${fmtNum(k.tokens.baselineOutput)} out`
    + (baseCost == null ? ' · baseline cost needs FOUNDRY_PRICE_* on the server' : '');
  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }} data-testid="jev-kpis">
      <StatCard
        index={0} label="Agreement" tone={agreeTone}
        value={Math.round(k.agreementRate * 1000)} format={n => (k.compared === 0 ? '—' : `${(n / 10).toFixed(1)}%`)}
        info={k.compared === 0 ? 'No comparable decisions in this window' : `${fmtNum(k.agreed)} of ${fmtNum(k.compared)} comparable decisions agreed`}
        ariaLabel={k.compared === 0 ? 'Agreement not available' : `Agreement ${fmtPct(k.agreementRate, 1)}`}
      />
      <StatCard
        index={1} label="Compared" value={k.compared}
        info={`${fmtNum(k.total)} shadow runs; ${fmtNum(k.total - k.compared)} were not comparable`}
        ariaLabel={`Compared ${fmtNum(k.compared)}`}
      />
      <StatCard
        index={2} label="Jev latency (p50)" value={jev.p50} format={dur} suffix={`p95 ${dur(jev.p95)}`}
        ariaLabel={`Jev latency p50 ${dur(jev.p50)}, p95 ${dur(jev.p95)}`}
      />
      <StatCard
        index={3} label="Baseline latency (p50)" value={baseline.p50} format={dur} suffix={`p95 ${dur(baseline.p95)}`}
        ariaLabel={`Baseline latency p50 ${dur(baseline.p50)}, p95 ${dur(baseline.p95)}`}
      />
      <StatCard
        index={4} label="Speedup" tone={speedup50 != null && speedup50 >= 1 ? t.success : undefined}
        value={speedup50 == null ? 0 : Math.round(speedup50 * 10)}
        format={speedup50 == null ? () => '—' : n => `${(n / 10).toFixed(1)}×`}
        info={`Baseline p50 ÷ Jev p50${speedup95 != null ? ` (p95: ${speedup95.toFixed(1)}×)` : ''}`}
        ariaLabel={speedup50 == null ? 'Speedup not available' : `Speedup ${speedup50.toFixed(1)}× at p50`}
      />
      <StatCard
        index={5} label="Est. cost (Jev)" value={Math.round(k.estCostUsd.jev * 1e4)} format={n => fmtUsd(n / 1e4)}
        suffix={baseCost != null ? `vs ${fmtUsd(baseCost)}` : 'baseline n/a'} info={tokensInfo}
        ariaLabel={`Estimated cost Jev ${fmtUsd(k.estCostUsd.jev)} versus baseline ${baseCost != null ? fmtUsd(baseCost) : 'not available'}`}
      />
      <StatCard
        index={6} label="Jev stricter" value={k.jevStricter} tone={k.jevStricter ? t.severity.medium.fg : undefined}
        info="Disagreements where Jev would deny / flag but the baseline allowed"
        ariaLabel={`Jev stricter ${fmtNum(k.jevStricter)}`}
      />
      <StatCard
        index={7} label="Jev looser" value={k.jevLooser} tone={k.jevLooser ? t.severity.critical.fg : undefined}
        info="Disagreements where Jev would allow / pass but the baseline denied or flagged — review these first"
        ariaLabel={`Jev looser ${fmtNum(k.jevLooser)}`}
      />
      <StatCard
        index={8} label="Jev errors" value={k.jevErrors} tone={k.jevErrors ? t.danger : undefined}
        info="Shadow calls that failed (timeouts, API errors); they never affect the real verdict"
        ariaLabel={`Jev errors ${fmtNum(k.jevErrors)}`}
      />
    </Box>
  );
}

// ── Confusion matrix ───────────────────────────────────────────────────────

/** Baseline verdicts (rows) × Jev verdicts (columns); the agreeing diagonal is highlighted. */
function ConfusionMatrix({ confusion }: { confusion: JevKindSummary['confusion'] }) {
  const t = useTheme().tokens;
  const rows = Object.keys(confusion);
  const labels = sortLabels([...rows, ...rows.flatMap(r => Object.keys(confusion[r] ?? {}))]);
  const max = Math.max(1, ...rows.flatMap(r => Object.values(confusion[r] ?? {})));
  if (!labels.length) return <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No comparable decisions in this period.</Typography>;
  const agree = successTone(t);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Confusion matrix: baseline verdict rows by Jev verdict columns" data-testid="jev-confusion" sx={{ '& td, & th': { fontVariantNumeric: 'tabular-nums' } }}>
        <TableHead>
          <TableRow>
            <TableCell component="td" sx={{ color: 'text.secondary', fontSize: 11.5, whiteSpace: 'nowrap' }}>Baseline ↓ · Jev →</TableCell>
            {labels.map(c => <TableCell key={c} scope="col" align="right" sx={{ textTransform: 'capitalize' }}>{c}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {labels.map(r => (
            <TableRow key={r}>
              <TableCell component="th" scope="row" sx={{ textTransform: 'capitalize', fontWeight: 600 }}>{r}</TableCell>
              {labels.map(c => {
                const n = confusion[r]?.[c] ?? 0;
                const diag = r === c;
                return (
                  <TableCell
                    key={c}
                    align="right"
                    data-diagonal={diag ? 'true' : undefined}
                    title={`Baseline ${r}, Jev ${c}: ${n}`}
                    sx={{
                      fontWeight: diag || n ? 600 : 400,
                      color: n === 0 ? 'text.disabled' : diag ? agree.fg : t.severity.medium.fg,
                      bgcolor: diag ? agree.bg : n ? alpha(t.severity.medium.fg, 0.06 + 0.18 * (n / max)) : undefined,
                      boxShadow: diag ? `inset 0 0 0 1px ${agree.border}` : undefined,
                    }}
                  >
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

// ── Latency comparison ─────────────────────────────────────────────────────

const PCTS: (keyof Omit<LatencyStats, 'count'>)[] = ['p50', 'p95', 'p99', 'mean'];

function LatencyComparison({ latency }: { latency: JevKindSummary['latency'] }) {
  const t = useTheme().tokens;
  const hasJev = latency.jev.count > 0;
  const hasBaseline = latency.baseline.count > 0;
  const max = Math.max(1, ...PCTS.flatMap(p => [hasJev ? latency.jev[p] : 0, hasBaseline ? latency.baseline[p] : 0]));
  const series = [
    { key: 'jev', label: 'Jev', color: t.accent, stats: latency.jev, show: hasJev },
    { key: 'baseline', label: 'Baseline', color: t.textTertiary, stats: latency.baseline, show: hasBaseline },
  ];
  if (!hasJev && !hasBaseline) return <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No latency samples.</Typography>;
  const val = (show: boolean, v: number) => (show ? dur(v) : 'no samples');
  return (
    <Stack spacing={1.5} data-testid="jev-latency">
      <Stack direction="row" spacing={2} sx={{ fontSize: 12, color: 'text.secondary' }} aria-hidden>
        {series.map(s => (
          <Stack key={s.key} direction="row" spacing={0.75} sx={{ alignItems: 'center' }}>
            <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: s.color }} />
            <span>{s.label} (n={fmtNum(s.stats.count)})</span>
          </Stack>
        ))}
      </Stack>
      {PCTS.map(p => (
        <Box key={p} role="group" aria-label={`${p}: Jev ${val(hasJev, latency.jev[p])}, baseline ${val(hasBaseline, latency.baseline[p])}`}>
          <Typography variant="caption" component="div" sx={{ fontWeight: 600, mb: 0.25 }} aria-hidden>{p}</Typography>
          <Stack spacing={0.5} aria-hidden>
            {series.map(s => (
              <Stack key={s.key} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <Box sx={{ flex: 1, height: 10, borderRadius: 99, bgcolor: 'action.hover', overflow: 'hidden' }}>
                  {s.show && <Box sx={{ height: '100%', borderRadius: 99, bgcolor: s.color, width: `${Math.max(1.5, (s.stats[p] / max) * 100)}%`, transition: 'width 400ms cubic-bezier(0.2,0,0,1)' }} />}
                </Box>
                <Typography variant="caption" sx={{ width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'text.primary', flexShrink: 0 }}>
                  {s.show ? dur(s.stats[p]) : '—'}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

// ── Disagreements ──────────────────────────────────────────────────────────

function DisagreementRow({ r, convHref }: { r: JevShadowRecord; convHref: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const detailId = `jev-detail-${r.id}`;
  const baseLabel = outcomeLabel(r.baseline);
  const jevLabel = r.jev.error ? 'error' : outcomeLabel(r.jev);
  return (
    <Fragment>
      <TableRow hover sx={{ '& > td': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          <IconButton size="small" aria-label={open ? 'Hide signals' : 'Show signals'} aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(o => !o)}>
            <KeyboardArrowDownRoundedIcon fontSize="small" sx={{ transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'none' }} />
          </IconButton>
        </TableCell>
        <TableCell sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}><RelativeTime iso={r.createdAt} /></TableCell>
        <TableCell sx={{ maxWidth: 140 }}><Ellipsis text={r.laneId} mono sx={{ fontSize: 12, display: 'block' }} /></TableCell>
        <TableCell sx={{ maxWidth: 160 }}><Ellipsis text={r.toolName ?? r.checkpoint} mono sx={{ fontSize: 12, display: 'block' }} /></TableCell>
        <TableCell>
          <Stack spacing={0.25} sx={{ alignItems: 'flex-start' }}>
            <OutcomeChip verdict={r.baseline.verdict} label={baseLabel} ariaPrefix="Baseline" />
            <Typography variant="caption" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11 }}>{r.baseline.model ?? r.baseline.provider}</Typography>
          </Stack>
        </TableCell>
        <TableCell>
          <Stack spacing={0.25} sx={{ alignItems: 'flex-start' }}>
            <OutcomeChip verdict={r.jev.error ? 'deny' : r.jev.verdict} label={jevLabel} ariaPrefix="Jev" />
            <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {r.jev.confidence != null ? `${fmtPct(r.jev.confidence)} conf.` : '—'} · {dur(r.jev.latencyMs)}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell sx={{ maxWidth: 360 }}>
          <Ellipsis text={r.jev.error ?? r.jev.rationale ?? null} sx={{ display: 'block', fontSize: 12.5 }} />
          {r.jev.laneClause && <Ellipsis text={r.jev.laneClause} sx={{ display: 'block', fontSize: 11.5, color: 'text.secondary' }} />}
        </TableCell>
        <TableCell>
          {r.sessionId ? (
            <MuiLink component={RouterLink} to={convHref(r.sessionId)} sx={{ fontSize: 12, whiteSpace: 'nowrap' }} aria-label={`Open conversation ${shortId(r.sessionId)}`}>
              Conversation
            </MuiLink>
          ) : <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
          <Collapse in={open} unmountOnExit>
            <Stack spacing={1} sx={{ py: 1.5 }} id={detailId}>
              <Typography variant="caption" component="div">
                Jev <code>{r.jev.model}</code>{r.jev.policy ? <> · policy <b>{r.jev.policy}</b></> : null}
                {r.baseline.stage ? <> · baseline stage <b>{r.baseline.stage}</b></> : null}
                {r.baseline.latencyMs != null ? <> · baseline {dur(r.baseline.latencyMs)}</> : null}
                {r.decisionId ? <> · decision <MuiLink component={RouterLink} to={`/enforcements?d=${encodeURIComponent(r.decisionId)}`}>{shortId(r.decisionId)}</MuiLink></> : null}
              </Typography>
              {r.jev.rationale && <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{r.jev.rationale}</Typography>}
              <CodeBlock json text={JSON.stringify(r.jev.signals ?? {}, null, 2)} maxHeight={240} />
            </Stack>
          </Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function Disagreements({ kind, range, convHref }: { kind: JevShadowKind; range: string; convHref: (id: string) => string }) {
  const q = useJevShadowInfinite({ kind, agree: false }, range);
  const rows = useMemo(() => q.data?.pages.flatMap(p => p.items) ?? [], [q.data]);
  if (q.isError) return <QueryError error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading) return <Stack spacing={1} aria-busy="true" aria-label="Loading disagreements">{[0, 1, 2].map(i => <Skeleton key={i} variant="rounded" height={44} />)}</Stack>;
  if (!rows.length) return <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>No disagreements in this period.</Typography>;
  return (
    <Stack spacing={1.5}>
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" aria-label={`${JEV_KIND_LABEL[kind]} disagreements`} data-testid="jev-disagreements">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox"><Box component="span" sx={visuallyHidden}>Details</Box></TableCell>
              <TableCell>Time</TableCell>
              <TableCell>Lane</TableCell>
              <TableCell>Tool</TableCell>
              <TableCell>Baseline</TableCell>
              <TableCell>Jev</TableCell>
              <TableCell>Rationale</TableCell>
              <TableCell>Session</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>{rows.map(r => <DisagreementRow key={r.id} r={r} convHref={convHref} />)}</TableBody>
        </Table>
      </Box>
      {q.hasNextPage && (
        <Button size="small" variant="outlined" onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} sx={{ alignSelf: 'center' }}>
          {q.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </Stack>
  );
}

// ── Per-kind panel & queue ─────────────────────────────────────────────────

function KindPanel({ kind, k, range, convHref }: { kind: JevShadowKind; k?: JevKindSummary; range: string; convHref: (id: string) => string }) {
  // "Fleet · Intent scope" → "Fleet intent scope" for sentence use; core labels are simply lower-cased.
  const noun = JEV_KIND_LABEL[kind].replace(' · ', ' ').toLowerCase().replace(/^fleet/, 'Fleet');
  const description = (
    <Typography variant="body2" sx={{ color: 'text.secondary' }} data-testid="jev-kind-description">
      {JEV_KIND_DESCRIPTION[kind]}
    </Typography>
  );
  if (!k || k.total === 0) {
    return (
      <Stack spacing={1.5} sx={{ pt: 1.5 }}>
        {description}
        <EmptyState
          compact
          icon={<CompareArrowsRoundedIcon />}
          title={`No ${noun} comparisons yet`}
          body={`Jev hasn't shadowed any ${JEV_KIND_BASELINE[kind]} decisions in this period.`}
        />
      </Stack>
    );
  }
  return (
    <Stack spacing={2}>
      {description}
      <Typography variant="caption" component="div">
        Baseline: <b>{k.baselineModels.join(', ') || JEV_KIND_BASELINE[kind]}</b> · Jev: <b>{k.jevModels.join(', ') || '—'}</b>
      </Typography>
      <KindKpis k={k} />
      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '3fr 2fr' } }}>
        <SectionCard title="Confusion matrix" subtitle="Rows are the baseline verdict, columns Jev's; the diagonal is agreement" delay={120}>
          <ConfusionMatrix confusion={k.confusion} />
        </SectionCard>
        <SectionCard title="Latency" subtitle="Jev vs baseline percentiles" delay={160}>
          <LatencyComparison latency={k.latency} />
        </SectionCard>
      </Box>
      <SectionCard title="Disagreements" subtitle="Decisions where Jev and the baseline reached different outcomes" delay={200}>
        <Disagreements kind={kind} range={range} convHref={convHref} />
      </SectionCard>
    </Stack>
  );
}

function QueueFooter({ q }: { q: JevShadowSummary['queue'] }) {
  return (
    <Stack spacing={1} data-testid="jev-queue">
      {q.dropped > 0 && (
        <Alert severity="warning">
          {fmtNum(q.dropped)} shadow comparison{q.dropped === 1 ? ' was' : 's were'} dropped because the Jev queue was full — the numbers above undercount.
        </Alert>
      )}
      <Typography variant="caption" component="div" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        Shadow queue (since server start): {fmtNum(q.enqueued)} enqueued · {fmtNum(q.completed)} completed · {fmtNum(q.failed)} failed · {fmtNum(q.inFlight)} in flight · {fmtNum(q.queued)} queued · {fmtNum(q.dropped)} dropped
      </Typography>
    </Stack>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

/** "Jev vs LLM": shadow-mode comparison of TypeSafe Jev against the authoritative decision makers. */
export function JevComparisonPage() {
  const [range] = useRangeKey();
  const [params, setParams] = useSearchParams();
  const summary = useJevSummary(range);
  const s = summary.data;
  const kindParam = params.get('kind');
  const kind: JevShadowKind = isKind(kindParam) ? kindParam : 'judge';
  const conv = params.get('c');
  const setParam = (key: string, v: string | null) => setParams(p => {
    const n = new URLSearchParams(p);
    if (v) n.set(key, v); else n.delete(key);
    return n;
  }, { replace: true });
  const convHref = (id: string) => { const n = new URLSearchParams(params); n.set('c', id); return `?${n.toString()}`; };
  const byKind = new Map((s?.kinds ?? []).map(k => [k.kind, k]));
  const hasData = (s?.kinds ?? []).some(k => k.total > 0);

  if (summary.isError && summary.error instanceof ApiError && summary.error.status === 404) {
    return (
      <EmptyState
        icon={<CompareArrowsRoundedIcon />}
        title="Jev comparison is not available on this server"
        body="Start the monitor with the governance plane enabled (and a build that includes Jev shadow mode) to compare Jev with the LLM judge."
      />
    );
  }

  return (
    <Stack spacing={2.5}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <TimeRangePicker />
        <Box sx={{ flex: 1 }} />
        {s?.enabled && (
          <Tooltip title="Jev runs next to the real decision makers and never changes a verdict">
            <Chip size="small" variant="outlined" icon={<BoltRoundedIcon />} label={`Shadow · ${s.model}`} />
          </Tooltip>
        )}
      </Stack>

      <Box>
        <Typography variant="h5" component="h2">Jev vs LLM</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
          Agreement, latency and cost of TypeSafe Jev in shadow mode against the LLM judge, Prompt Shields, Guardian and session severity.
        </Typography>
      </Box>

      {summary.isError ? <QueryError error={summary.error} onRetry={() => void summary.refetch()} />
        : !s ? (
          <Stack spacing={1.5} aria-busy="true" aria-label="Loading comparison">
            <Skeleton variant="rounded" height={48} />
            <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>{[0, 1, 2, 3].map(i => <Skeleton key={i} variant="rounded" height={92} />)}</Box>
            <Skeleton variant="rounded" height={260} />
          </Stack>
        ) : (
          <>
            {!s.enabled && <JevDisabledCard model={s.model} />}
            {(s.enabled || hasData) && (
              <>
                <Tabs
                  value={kind}
                  onChange={(_, v: JevShadowKind) => setParam('kind', v === 'judge' ? null : v)}
                  aria-label="Decision kind"
                  variant="scrollable"
                  scrollButtons="auto"
                  allowScrollButtonsMobile
                  sx={{ borderBottom: '1px solid', borderColor: 'divider' }}
                >
                  {JEV_KINDS.map((kd, i) => {
                    // Visually separate the Fleet group (first fleet_* tab gets a divider on its left).
                    const firstFleet = isFleetKind(kd) && (i === 0 || !isFleetKind(JEV_KINDS[i - 1]));
                    return (
                      <Tab
                        key={kd}
                        value={kd}
                        id={`jev-tab-${kd}`}
                        aria-controls="jev-tabpanel"
                        data-group={isFleetKind(kd) ? 'fleet' : 'monitor'}
                        title={JEV_KIND_DESCRIPTION[kd]}
                        label={`${JEV_KIND_LABEL[kd]} (${fmtNum(byKind.get(kd)?.total ?? 0)})`}
                        sx={firstFleet ? { borderLeft: '1px solid', borderColor: 'divider', ml: 1 } : undefined}
                      />
                    );
                  })}
                </Tabs>
                <Box role="tabpanel" id="jev-tabpanel" aria-labelledby={`jev-tab-${kind}`}>
                  <KindPanel key={kind} kind={kind} k={byKind.get(kind)} range={range} convHref={convHref} />
                </Box>
              </>
            )}
            <QueueFooter q={s.queue} />
          </>
        )}

      <ConversationDrawer id={conv || null} onClose={() => setParam('c', null)} />
    </Stack>
  );
}
