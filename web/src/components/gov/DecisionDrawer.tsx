import type { ReactNode } from 'react';
import { Box, Button, Divider, Drawer, IconButton, LinearProgress, Link as MuiLink, Skeleton, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import { Link as RouterLink } from 'react-router-dom';
import { useDecision, type Decision, type JudgeVerdict } from '../../api/governance';
import { CategoryChip, ToneChip } from '../Chips';
import { CopyButton } from '../Common';
import { fmtDateTime, fmtDuration, fmtNum } from '../../lib/format';
import { QueryError } from './GovCommon';
import { STAGE_LABEL, VerdictChip, verdictTone } from './GovChips';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="overline" color="text.secondary" component="div">{label}</Typography>
      <Box sx={{ fontSize: 13, minWidth: 0, wordBreak: 'break-word' }}>{children ?? <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}</Box>
    </Box>
  );
}

function Mono({ text }: { text: string }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', minWidth: 0 }}>
      <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{text}</Box>
      <CopyButton text={text} label="Copy" />
    </Stack>
  );
}

export function JudgeCard({ j }: { j: JudgeVerdict }) {
  const t = useTheme().tokens;
  const pct = Math.round(j.confidence * 100);
  return (
    <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }} data-testid="judge-verdict">
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
        <GavelRoundedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        <ToneChip tone={j.tier === 'escalation' ? t.severity.medium : t.severity.info} label={j.tier === 'escalation' ? 'Escalation judge' : 'Fast judge'} sx={{ height: 20, fontSize: 11 }} />
        <ToneChip tone={verdictTone(t, j.verdict)} label={j.verdict} sx={{ height: 20, fontSize: 11, textTransform: 'capitalize' }} />
        <Box component="code" sx={{ fontFamily: 'var(--am-mono)', fontSize: 11.5, color: 'text.secondary' }}>{j.model}</Box>
        {j.provider && <ToneChip tone={t.severity.info} label={j.provider === 'jev' ? 'Jev' : 'Foundry'} aria-label={`Provider ${j.provider}`} sx={{ height: 20, fontSize: 11 }} />}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption">{fmtDuration(j.latencyMs)}</Typography>
      </Stack>
      {j.usage && (
        <Typography variant="caption" component="div" sx={{ mt: 0.5, fontVariantNumeric: 'tabular-nums' }} data-testid="judge-tokens">
          {fmtNum(j.usage.inputTokens)} input / {fmtNum(j.usage.outputTokens)} output tokens
        </Typography>
      )}
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mt: 1 }}>
        <Typography variant="caption" sx={{ flexShrink: 0 }}>Confidence</Typography>
        <LinearProgress variant="determinate" value={pct} aria-label={`Confidence ${pct}%`} sx={{ flex: 1, height: 6, borderRadius: 3 }} />
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, color: 'text.primary', fontWeight: 600 }}>{pct}%</Typography>
      </Stack>
      <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>{j.rationale}</Typography>
      {j.laneClause && (
        <Box sx={{ mt: 1, pl: 1.25, borderLeft: '3px solid', borderColor: 'divider', color: 'text.secondary', fontSize: 12.5 }}>
          <Typography variant="overline" component="div" sx={{ lineHeight: 1.6 }}>Lane clause</Typography>
          {j.laneClause}
        </Box>
      )}
    </Box>
  );
}

/** Full decision detail: verdict, stage, reason, rules, lane@version, judge verdicts, approval, audit chain. */
export function DecisionDetail({ d, onClose }: { d: Decision; onClose?: () => void }) {
  const t = useTheme().tokens;
  return (
    <Stack spacing={2} sx={{ p: 2.5 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <VerdictChip verdict={d.verdict} wouldDeny={d.wouldDeny} />
        <Typography variant="h6" component="h2" sx={{ fontFamily: 'var(--am-mono)', fontSize: 14, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {d.toolName ?? d.checkpoint}
        </Typography>
        {onClose && <Tooltip title="Close (Esc)"><IconButton size="small" aria-label="Close" onClick={onClose}><CloseRoundedIcon fontSize="small" /></IconButton></Tooltip>}
      </Stack>
      <Typography variant="caption">{fmtDateTime(d.createdAt)}</Typography>

      <Box sx={{ p: 1.5, borderRadius: 2, border: '1px solid', borderColor: verdictTone(t, d.verdict, d.wouldDeny).border, bgcolor: verdictTone(t, d.verdict, d.wouldDeny).bg }}>
        <Typography variant="overline" component="div" color="text.secondary">Reason</Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{d.reason || '—'}</Typography>
        {d.wouldDeny && (
          <Typography variant="caption" component="div" sx={{ mt: 0.75 }}>
            Observe mode: the action was allowed, but enforcement would have returned “{d.effectiveVerdict}”.
          </Typography>
        )}
      </Box>

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
        <Field label="Stage">{STAGE_LABEL[d.stage] ?? d.stage}</Field>
        <Field label="Lane">
          <MuiLink component={RouterLink} to={`/lanes/${encodeURIComponent(d.laneId)}?version=${d.laneVersion}`}>{d.laneId}@v{d.laneVersion}</MuiLink>
        </Field>
        <Field label="Mode">{d.mode}</Field>
        <Field label="Checkpoint">{d.checkpoint}</Field>
        <Field label="Category">{d.category ? <CategoryChip category={d.category} /> : null}</Field>
        <Field label="Risk">{d.riskLevel ?? null}</Field>
        <Field label="Latency">{fmtDuration(d.latencyMs)}</Field>
        <Field label="Agent"><MuiLink component={RouterLink} to={`/agents?id=${encodeURIComponent(d.agentId)}`}>{d.agentId}</MuiLink></Field>
      </Box>

      {d.tainted && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', p: 1.25, borderRadius: 2, bgcolor: t.severity.high.bg, border: '1px solid', borderColor: t.severity.high.border }}>
          <WarningAmberRoundedIcon sx={{ fontSize: 18, color: t.severity.high.fg }} />
          <Typography variant="body2">Session was <b>tainted</b> by untrusted content (possible prompt injection) at decision time.</Typography>
        </Stack>
      )}

      <Field label="Matched rules">
        {d.ruleIds.length ? (
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.25 }}>
            {d.ruleIds.map(r => <ToneChip key={r} tone={t.severity.info} label={r} sx={{ fontFamily: 'var(--am-mono)', fontSize: 11 }} />)}
          </Stack>
        ) : null}
      </Field>

      {!!d.judge?.length && (
        <Box>
          <Typography variant="overline" color="text.secondary" component="div">LLM judge</Typography>
          <Stack spacing={1}>{d.judge.map((j, i) => <JudgeCard key={`${j.tier}-${j.model}-${i}`} j={j} />)}</Stack>
        </Box>
      )}

      {(d.approvalId || d.approver) && (
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
          <Field label="Approval">{d.approvalId ? <MuiLink component={RouterLink} to={`/approvals?id=${encodeURIComponent(d.approvalId)}`}>{d.approvalId}</MuiLink> : null}</Field>
          <Field label="Approver">{d.approver ?? null}</Field>
        </Box>
      )}

      <Divider />
      <Box>
        <Typography variant="overline" color="text.secondary" component="div">Audit</Typography>
        <Stack spacing={0.75}>
          <Field label="Decision id"><Mono text={d.id} /></Field>
          <Field label="Request id"><Mono text={d.requestId} /></Field>
          {d.seq != null && <Field label="Sequence">#{d.seq}</Field>}
          {d.hash && <Field label="Hash"><Mono text={d.hash} /></Field>}
          {d.prevHash && <Field label="Previous hash"><Mono text={d.prevHash} /></Field>}
        </Stack>
      </Box>

      <Button
        variant="outlined"
        size="small"
        startIcon={<ForumOutlinedIcon />}
        component={RouterLink}
        to={`/conversations?c=${encodeURIComponent(d.sessionId)}`}
        sx={{ alignSelf: 'flex-start' }}
      >
        Open conversation
      </Button>
    </Stack>
  );
}

/** Right-side drawer showing one decision. Pass `initial` (from a list) to render instantly. */
export function DecisionDrawer({ id, initial, onClose }: { id: string | null; initial?: Decision; onClose: () => void }) {
  const q = useDecision(initial ? null : id);
  const d = initial ?? q.data;
  return (
    <Drawer
      anchor="right"
      open={!!id}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100vw', sm: 520 }, bgcolor: 'background.default' }, 'aria-label': 'Decision detail' } as object }}
    >
      {d ? <DecisionDetail d={d} onClose={onClose} />
        : q.isError ? <Box sx={{ p: 2 }}><QueryError error={q.error} onRetry={() => void q.refetch()} title="Decision not found" /></Box>
        : <Stack spacing={1.5} sx={{ p: 2.5 }}><Skeleton width="60%" height={32} /><Skeleton variant="rounded" height={80} /><Skeleton variant="rounded" height={140} /></Stack>}
    </Drawer>
  );
}
