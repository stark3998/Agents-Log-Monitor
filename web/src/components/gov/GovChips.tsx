import { alpha, useTheme, type Theme } from '@mui/material';
import type { AgentStatus, ApprovalState, Decision, DecisionStage, IncidentState, LaneMode, LaneStatus, Verdict } from '../../api/governance';
import { ToneChip } from '../Chips';

type Tone = { fg: string; bg: string; border: string };

export function successTone(t: Theme['tokens']): Tone {
  return { fg: t.success, bg: alpha(t.success, 0.12), border: alpha(t.success, 0.32) };
}

export const STAGE_LABEL: Record<DecisionStage, string> = {
  kill_switch: 'Kill switch', limits: 'Runaway limits', rules_deny: 'Deny rule', rules_allow: 'Allow rule', default: 'Lane default',
  judge_fast: 'Judge (fast)', judge_escalation: 'Judge (escalation)', human: 'Human approval', fail_mode: 'Fail mode', cache: 'Decision cache',
  not_governed: 'Not governed',
};

export const VERDICT_LABEL: Record<Verdict, string> = { allow: 'Allowed', deny: 'Denied', ask: 'Asked user', escalate: 'Pending approval' };

/** Display verdict: observe-mode suppressed denies read as "Would deny". */
export function decisionLabel(d: Pick<Decision, 'verdict' | 'wouldDeny'>): string {
  return d.wouldDeny ? 'Would deny' : VERDICT_LABEL[d.verdict] ?? d.verdict;
}

export function verdictTone(t: Theme['tokens'], verdict: Verdict, wouldDeny = false): Tone {
  if (wouldDeny) return t.severity.medium;
  if (verdict === 'deny') return t.severity.critical;
  if (verdict === 'escalate') return t.severity.high;
  if (verdict === 'ask') return t.severity.low;
  return successTone(t);
}

export function VerdictChip({ verdict, wouldDeny, size }: { verdict: Verdict; wouldDeny?: boolean; size?: 'small' | 'tiny' }) {
  const t = useTheme().tokens;
  const label = wouldDeny ? 'Would deny' : VERDICT_LABEL[verdict] ?? verdict;
  return (
    <ToneChip
      tone={verdictTone(t, verdict, wouldDeny)}
      label={label}
      aria-label={`Verdict ${label}`}
      sx={size === 'tiny' ? { height: 20, fontSize: 11 } : undefined}
    />
  );
}

export function LaneModeChip({ mode }: { mode: LaneMode }) {
  const t = useTheme().tokens;
  const tone = mode === 'observe' ? t.severity.info : mode === 'enforce' ? t.severity.low : t.severity.medium;
  const label = mode === 'enforce+approval' ? 'Enforce + approval' : mode === 'observe' ? 'Observe' : 'Enforce';
  return <ToneChip tone={tone} label={label} aria-label={`Mode ${label}`} />;
}

export function LaneStatusChip({ status }: { status: LaneStatus }) {
  const t = useTheme().tokens;
  const tone = status === 'active' ? successTone(t) : status === 'proposed' ? t.severity.medium : t.severity.info;
  return <ToneChip tone={tone} label={status[0].toUpperCase() + status.slice(1)} aria-label={`Status ${status}`} />;
}

export function AgentStatusChip({ status }: { status: AgentStatus }) {
  const t = useTheme().tokens;
  const tone = status === 'active' ? successTone(t) : status === 'paused' ? t.severity.medium : status === 'quarantined' ? t.severity.critical : t.severity.info;
  return <ToneChip tone={tone} label={status[0].toUpperCase() + status.slice(1)} aria-label={`Agent ${status}`} />;
}

export function IncidentStateChip({ state }: { state: IncidentState }) {
  const t = useTheme().tokens;
  const tone = state === 'open' ? t.severity.high : state === 'investigating' ? t.severity.medium : state === 'contained' ? t.severity.low : state === 'resolved' ? successTone(t) : t.severity.info;
  return <ToneChip tone={tone} label={state[0].toUpperCase() + state.slice(1)} aria-label={`Incident ${state}`} />;
}

export function ApprovalStateChip({ state }: { state: ApprovalState }) {
  const t = useTheme().tokens;
  const tone = state === 'approved' ? successTone(t) : state === 'denied' ? t.severity.critical : state === 'pending' ? t.severity.medium : t.severity.info;
  return <ToneChip tone={tone} label={state[0].toUpperCase() + state.slice(1)} aria-label={`Approval ${state}`} />;
}
