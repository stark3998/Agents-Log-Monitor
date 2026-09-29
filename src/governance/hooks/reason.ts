import type { Decision } from '../types';

/** Human/agent-facing explanation of a decision, shared by all hook adapters. */
export function decisionReason(decision: Decision): string {
  const reason = decision.reason || 'the action is outside the agent lane';
  const ref = decision.id ? ` (decision ${decision.id})` : '';
  if (decision.wouldDeny && decision.verdict === 'allow') {
    return `Governance policy is in observe mode and would have blocked this action: ${reason}${ref}`;
  }
  if (decision.verdict === 'ask') return `Approval required by governance policy: ${reason}${ref}`;
  if (decision.verdict === 'allow') return `Allowed by governance policy: ${reason}`;
  return `Blocked by governance policy: ${reason}${ref}`;
}
