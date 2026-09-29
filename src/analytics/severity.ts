import { thresholds } from './rules';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SessionSignals {
  criticalActions: number;
  highActions: number;
  mediumActions: number;
  secretDetections: number;
  piiDetections: number;
  externalDomains: number;
  policyBlocks: number;   // blocked + denied + warned
}

export interface SeverityResult {
  severity: Severity;
  reasons: string[];
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * Advisory session severity. The first matching tier wins; `reasons` always lists every
 * contributing signal so the UI can explain the rating ("Why High?").
 */
export function scoreSession(s: SessionSignals): SeverityResult {
  const reasons: string[] = [];
  if (s.criticalActions) reasons.push(plural(s.criticalActions, 'critical-risk action'));
  if (s.highActions) reasons.push(plural(s.highActions, 'high-risk action'));
  if (s.secretDetections) reasons.push(plural(s.secretDetections, 'secret detection'));
  if (s.policyBlocks) reasons.push(plural(s.policyBlocks, 'blocked/denied action'));
  if (s.mediumActions) reasons.push(plural(s.mediumActions, 'medium-risk action'));
  if (s.piiDetections) reasons.push(plural(s.piiDetections, 'personal-data detection'));
  if (s.externalDomains) reasons.push(plural(s.externalDomains, 'external domain'));

  const th = thresholds();
  let severity: Severity = 'info';
  if (s.criticalActions > 0 || (s.secretDetections > 0 && s.highActions >= th.criticalHighActionsWithSecrets)) severity = 'critical';
  else if (s.highActions > 0 || s.secretDetections >= th.highSecretDetections) severity = 'high';
  else if (s.secretDetections > 0 || s.policyBlocks > 0 || s.mediumActions >= th.mediumRiskActions) severity = 'medium';
  else if (s.mediumActions > 0 || s.piiDetections > 0 || s.externalDomains > 0) severity = 'low';

  if (!reasons.length) reasons.push('no risky actions or sensitive data observed');
  return { severity, reasons };
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
