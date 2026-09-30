import { useId, useState } from 'react';
import { Box, Button, Collapse, Stack, Typography, useTheme, type Theme } from '@mui/material';
import KeyboardArrowDownRoundedIcon from '@mui/icons-material/KeyboardArrowDownRounded';
import { useSessionJevShadow, type Decision, type JevShadowBaseline, type JevShadowKind, type JevShadowOutcome, type JudgeVerdict } from '../../api/governance';
import { fmtDuration, fmtNum } from '../../lib/format';
import { ToneChip } from '../Chips';
import { successTone } from './GovChips';

type Tone = { fg: string; bg: string; border: string };

export const JEV_FLEET_KINDS: JevShadowKind[] = [
  'fleet_realtime', 'fleet_intent', 'fleet_alignment', 'fleet_evasion', 'fleet_injection', 'fleet_code',
];

/** All kinds in tab order: monitor / intelligence kinds first, then the Fleet group. */
export const JEV_KINDS: JevShadowKind[] = ['judge', 'injection', 'guardian_triage', 'session_score', ...JEV_FLEET_KINDS];

export const isFleetKind = (k: JevShadowKind): boolean => k.startsWith('fleet_');

/** Tab / table label. Fleet kinds carry a "Fleet · " prefix so they read as one group in the tab strip. */
export const JEV_KIND_LABEL: Record<JevShadowKind, string> = {
  judge: 'LLM judge',
  injection: 'Prompt injection',
  guardian_triage: 'Guardian triage',
  session_score: 'Session severity',
  fleet_realtime: 'Fleet · Real-time gate',
  fleet_intent: 'Fleet · Intent scope',
  fleet_alignment: 'Fleet · Goal alignment',
  fleet_evasion: 'Fleet · Evasion',
  fleet_injection: 'Fleet · Injection',
  fleet_code: 'Fleet · Code necessity',
};

/** What the Jev answer is compared against (used in empty states and panel captions). */
export const JEV_KIND_BASELINE: Record<JevShadowKind, string> = {
  judge: 'Foundry LLM judge',
  injection: 'Azure Prompt Shields',
  guardian_triage: 'Guardian',
  session_score: 'heuristic session severity',
  fleet_realtime: 'Fleet real-time tool-call gate (deterministic risk score / gpt-4.1-mini triage)',
  fleet_intent: 'Fleet session intent-scope classifier',
  fleet_alignment: 'Fleet action-vs-goal alignment check',
  fleet_evasion: 'Fleet same-effect adjudication after a block',
  fleet_injection: 'Fleet tool-output / prompt injection & jailbreak detector',
  fleet_code: 'Fleet script necessity / risk analysis',
};

/** One-line description of what each kind decides and its verdict vocabulary. */
export const JEV_KIND_DESCRIPTION: Record<JevShadowKind, string> = {
  judge: 'Governed tool calls escalated to the LLM judge: allow / escalate / deny.',
  injection: 'Prompt-injection screening of tool inputs: attack / clean.',
  guardian_triage: 'Guardian incident triage severity and investigation need.',
  session_score: 'Background severity score of recently active sessions.',
  fleet_realtime: 'AgentMon Fleet real-time tool-call gate: allow / block (score = risk 0–100).',
  fleet_intent: 'AgentMon Fleet session intent scope: in_scope / out_of_scope / ambiguous.',
  fleet_alignment: 'AgentMon Fleet action vs session goal: aligned / misaligned.',
  fleet_evasion: 'AgentMon Fleet retry after a block — same effect or genuinely different: same / different.',
  fleet_injection: 'AgentMon Fleet tool-output / user-prompt injection or jailbreak: attack / review / clean.',
  fleet_code: 'AgentMon Fleet script necessity and risk: necessary / unnecessary (score = risk 0–100).',
};

const RISKY = new Set([
  'deny', 'attack', 'critical', 'high', 'block', 'malicious', 'flag', 'incident',
  'out_of_scope', 'misaligned', 'same', 'unnecessary', 'risky',
]);
const MIDDLE = new Set(['escalate', 'ask', 'medium', 'suspicious', 'investigate', 'review', 'ambiguous']);
const SAFE = new Set(['allow', 'clean', 'low', 'info', 'benign', 'none', 'ignore', 'in_scope', 'aligned', 'different', 'necessary']);

/** Tone for a free-form categorical verdict (allow|deny|escalate, attack|clean, severity labels, fleet labels…). */
export function outcomeTone(t: Theme['tokens'], verdict: string | undefined): Tone {
  const v = (verdict ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (RISKY.has(v)) return t.severity.critical;
  if (MIDDLE.has(v)) return t.severity.medium;
  if (SAFE.has(v)) return successTone(t);
  return t.severity.info;
}

/** Display value of a baseline / Jev outcome: verdict label, else numeric score, else em dash. */
export function outcomeLabel(o: Pick<JevShadowBaseline | JevShadowOutcome, 'verdict' | 'score'>): string {
  if (o.verdict) return o.verdict;
  if (o.score != null) return Number.isInteger(o.score) ? String(o.score) : o.score.toFixed(2);
  return '—';
}

export function OutcomeChip({ verdict, label, ariaPrefix }: { verdict?: string; label: string; ariaPrefix: string }) {
  const t = useTheme().tokens;
  return <ToneChip tone={outcomeTone(t, verdict)} label={label} aria-label={`${ariaPrefix} ${label}`} sx={{ height: 20, fontSize: 11, textTransform: 'capitalize' }} />;
}

/** USD with precision adapted to tiny per-call costs. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${fmtNum(Math.round(n))}`;
}

export const fmtPct = (x: number | null | undefined, digits = 0) => (x == null ? '—' : `${(x * 100).toFixed(digits)}%`);

/** "foundry · 1,234 in / 56 out tokens" for a judge verdict (only the parts that are present). */
export function judgeUsageLabel(j: Pick<JudgeVerdict, 'provider' | 'usage'>): string | null {
  const parts: string[] = [];
  if (j.provider) parts.push(j.provider === 'jev' ? 'Jev' : 'Foundry');
  if (j.usage) parts.push(`${fmtNum(j.usage.inputTokens)} in / ${fmtNum(j.usage.outputTokens)} out tokens`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Collapsible, non-authoritative Jev shadow result for one decision. Fetches the session's judge
 * shadow records lazily (only while mounted) and renders nothing unless a record matches `decision.id`.
 */
export function JevShadowForDecision({ decision }: { decision: Pick<Decision, 'id' | 'sessionId'> }) {
  const t = useTheme().tokens;
  const { data } = useSessionJevShadow(decision.sessionId, 'judge');
  const [open, setOpen] = useState(false);
  const id = useId();
  const rec = data?.find(r => r.decisionId === decision.id);
  if (!rec) return null;
  const j = rec.jev;
  const label = j.error ? 'error' : outcomeLabel(j);
  const agreeTone = rec.agree == null ? t.severity.info : rec.agree ? successTone(t) : t.severity.medium;
  return (
    <Box sx={{ borderTop: '1px solid', borderColor: 'divider', pt: 0.75 }} data-testid="jev-shadow">
      <Button
        size="small"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={id}
        endIcon={<KeyboardArrowDownRoundedIcon sx={{ transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'none' }} />}
        sx={{ color: 'text.secondary', px: 0.5, minWidth: 0 }}
      >
        Jev shadow
      </Button>
      <ToneChip tone={agreeTone} label={rec.agree == null ? 'n/a' : rec.agree ? 'agrees' : 'disagrees'} sx={{ height: 18, fontSize: 10.5, ml: 0.5 }} />
      <Collapse in={open} unmountOnExit>
        <Stack spacing={0.5} id={id} sx={{ pt: 0.75 }}>
          <Stack direction="row" spacing={0.75} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}>
            <OutcomeChip verdict={j.error ? 'deny' : j.verdict} label={label} ariaPrefix="Jev" />
            <Typography variant="caption">
              {j.confidence != null ? `${fmtPct(j.confidence)} confident · ` : ''}{fmtDuration(j.latencyMs) || '0ms'} · <code>{j.model}</code>
            </Typography>
          </Stack>
          {(j.error ?? j.rationale) && <Typography variant="body2" sx={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{j.error ?? j.rationale}</Typography>}
          {j.laneClause && <Typography variant="caption" component="div">Lane clause: {j.laneClause}</Typography>}
          <Typography variant="caption" component="div" sx={{ color: 'text.secondary' }}>Shadow only — did not affect this decision.</Typography>
        </Stack>
      </Collapse>
    </Box>
  );
}
