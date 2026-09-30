import { Box, Stack, Tooltip, useTheme, type Theme } from '@mui/material';
import type { FleetAlert, FleetSeverity } from '../../api/fleet';
import type { Severity } from '../../api/types';
import { SeverityChip, ToneChip } from '../Chips';

type Tone = { fg: string; bg: string; border: string };

/** Fleet uses "informational"; the shared chip vocabulary calls it "info". */
export const fleetSeverity = (s: FleetSeverity | string): Severity =>
  (s === 'informational' ? 'info' : (['critical', 'high', 'medium', 'low'].includes(s) ? s : 'info')) as Severity;

export const FLEET_SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, informational: 0 };

export function FleetSeverityChip({ severity }: { severity: FleetSeverity }) {
  return <SeverityChip severity={fleetSeverity(severity)} />;
}

/** Human titles for the fleet taxonomy (fleet/src/agentmon_fleet/taxonomy.py); unknown types fall back to a humanised id. */
export const FLEET_ALERT_TITLE: Record<string, string> = {
  INTENT_OUT_OF_SCOPE: "Session intent is outside the agent's use cases",
  GOAL_DRIFT: 'Agent behaviour drifted away from the session goal',
  OUT_OF_CHARTER_ACTION: "Tool use outside the agent's allowed capabilities",
  FORBIDDEN_CAPABILITY: 'Agent attempted a forbidden capability',
  OUT_OF_BOUNDS_SCRIPT: "Agent-generated script exceeds the agent's scope",
  OBFUSCATED_CODE: 'Agent produced obfuscated code or commands',
  CREDENTIAL_ACCESS: 'Agent accessed credentials or tokens',
  DATA_EXFILTRATION: 'Possible data exfiltration via agent tool',
  DESTRUCTIVE_ACTION: 'Destructive operation by agent',
  BLOCKED_ACTION_WORKAROUND: 'Agent attempted to work around a blocked action',
  BLOCKED_THEN_WORKAROUND: 'Agent attempted to work around a blocked action',
  REPEATED_BLOCKED_ATTEMPTS: 'Agent repeatedly retried blocked actions',
  USER_PERSISTENCE_AFTER_BLOCK: 'User kept pushing for a refused or blocked request',
  JAILBREAK_ATTEMPT: 'User prompt contains jailbreak or instruction-override patterns',
  SOCIAL_ENGINEERING_USER: 'Agent asked the user to perform a blocked action',
  PROMPT_INJECTION_SUSPECTED: 'Tool output or input contains injection indicators',
  UNAPPROVED_DESTINATION: 'Agent reached a destination outside its allowlist',
  SUSPICIOUS_NETWORK_FLOW: 'Suspicious network flow from agent infrastructure',
  UNREGISTERED_INFERENCE_CALLER: 'Model inference from an identity that is not a registered agent',
  INFERENCE_ANOMALY: 'Anomalous inference volume or token usage',
  CONTENT_FILTER_TRIGGERED: 'Content safety filter blocked model traffic',
  AGENT_CONFIG_CHANGE: 'Agent definition or security configuration changed',
  SENSITIVE_CONTROL_PLANE_OP: 'Sensitive control-plane operation on AI resources',
  TELEMETRY_TAMPERING: 'Monitoring or diagnostic settings on AI resources were disabled or deleted',
  ACCESS_DENIED_BURST: 'Burst of denied data-plane requests against AI resources',
  RUNAWAY_LOOP: 'Agent is looping or consuming excessive resources',
  SESSION_RISK_ESCALATION: 'Multiple risk signals in one session',
};

/** "GOAL_DRIFT" → "Goal drift". */
export const humanizeType = (t: string) => {
  const s = t.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export const PLATFORM_LABEL: Record<string, string> = {
  foundry: 'Foundry', copilot_studio: 'Copilot Studio', azure_openai: 'Azure OpenAI', network: 'Network',
  azure_control_plane: 'Azure control plane', custom: 'Custom',
};
export const platformLabel = (p: string) => PLATFORM_LABEL[p] ?? p;

/** Display key used to group alerts per agent (matches the server's summary byAgent key). */
export const agentKey = (a: Pick<FleetAlert, 'agent_name' | 'agent_id'>) => a.agent_name || a.agent_id || 'unknown';

/** Alert type as a monospace chip with the taxonomy title as tooltip. */
export function AlertTypeChip({ type }: { type: string }) {
  const t = useTheme().tokens;
  return (
    <Tooltip title={FLEET_ALERT_TITLE[type] ?? humanizeType(type)}>
      <ToneChip tone={t.severity.info} label={type} aria-label={`Alert type ${type}`} sx={{ fontFamily: 'var(--am-mono)', fontSize: 11, height: 22, color: 'text.primary' }} />
    </Tooltip>
  );
}

export type Framework = 'owasp_llm' | 'owasp_agentic' | 'mitre_atlas';

export const FRAMEWORK_LABEL: Record<Framework, string> = { owasp_llm: 'OWASP LLM', owasp_agentic: 'OWASP Agentic', mitre_atlas: 'MITRE ATLAS' };

export function frameworkTone(t: Theme['tokens'], f: Framework): Tone {
  return f === 'owasp_llm' ? t.channel.log : f === 'owasp_agentic' ? t.channel.hook : t.severity.low;
}

/** OWASP LLM Top 10 / OWASP Agentic Top 10 / MITRE ATLAS mapping chips for one alert. */
export function FrameworkChips({ alert, max }: { alert: Pick<FleetAlert, Framework>; max?: number }) {
  const t = useTheme().tokens;
  const items = (['owasp_llm', 'owasp_agentic', 'mitre_atlas'] as Framework[]).flatMap(f => (alert[f] ?? []).map(code => ({ f, code })));
  if (!items.length) return <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>;
  const shown = max != null ? items.slice(0, max) : items;
  const rest = items.length - shown.length;
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }} data-testid="framework-chips">
      {shown.map(({ f, code }) => (
        <Tooltip key={`${f}-${code}`} title={FRAMEWORK_LABEL[f]}>
          <ToneChip tone={frameworkTone(t, f)} label={code} aria-label={`${FRAMEWORK_LABEL[f]} ${code}`} data-framework={f} sx={{ height: 20, fontSize: 10.5, fontFamily: 'var(--am-mono)' }} />
        </Tooltip>
      ))}
      {rest > 0 && (
        <Tooltip title={items.slice(shown.length).map(i => `${FRAMEWORK_LABEL[i.f]} ${i.code}`).join(', ')}>
          <ToneChip tone={t.severity.info} label={`+${rest}`} aria-label={`${rest} more mappings`} sx={{ height: 20, fontSize: 10.5 }} />
        </Tooltip>
      )}
    </Stack>
  );
}

/** Risk score 0–100 with a tone that follows the fleet's severity bands. */
export function ScoreBadge({ score }: { score: number }) {
  const t = useTheme().tokens;
  const tone = score >= 85 ? t.severity.critical : score >= 65 ? t.severity.high : score >= 40 ? t.severity.medium : score >= 20 ? t.severity.low : t.severity.info;
  return (
    <Box component="span" aria-label={`Score ${Math.round(score)}`} sx={{ display: 'inline-block', minWidth: 32, px: 0.75, py: 0.1, borderRadius: 1, textAlign: 'center', fontSize: 12, fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: tone.fg, bgcolor: tone.bg, border: '1px solid', borderColor: tone.border }}>
      {Math.round(score)}
    </Box>
  );
}
