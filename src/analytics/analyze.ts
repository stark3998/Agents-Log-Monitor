import { classifyTool, mcpFromName, ToolCategory } from './classify';
import { detect, Detection } from './detectors';
import { isDetectorEnabled } from './rules';
import { extractDomains } from './domains';
import { assessRisk, RiskHit, RiskLevel } from './risk';

/** Bump when analysis rules change so stored events get re-analyzed on startup. */
export const ANALYSIS_VERSION = 1;

export type PolicyOutcome = 'blocked' | 'denied' | 'warned' | 'prompted' | 'approved';

export interface AnalyzableEvent {
  eventType: string;
  rawEventName?: string | null;
  toolName?: string | null;
  status?: string | null;
  errorText?: string | null;
  payload: unknown;
  scanText?: string;
  cwd?: string | null;
  policy?: { outcome: PolicyOutcome; label: string };
  knownDetections?: Detection[];
}

export interface FindingDraft {
  kind: 'detector' | 'domain' | 'mcp' | 'risk' | 'policy';
  key: string;
  label: string;
  severity?: string | null;
  maskedSample?: string | null;
  /** Policy finding inferred from a tool error message rather than reported by the agent. */
  inferred?: boolean;
}

export interface Analysis {
  category: ToolCategory | null;
  mcpServer: string | null;
  riskLevel: RiskLevel | null;
  findings: FindingDraft[];
}

const DENIAL_RE = /(denied|rejected|declined|blocked)\b[^.\n]{0,40}\b(by (the )?user|by (a )?(policy|hook))|user (denied|declined|rejected)|permission (was )?denied|operation was blocked/i;

function obj(p: unknown): Record<string, unknown> {
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
}

function toText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

export function analyzeEvent(e: AnalyzableEvent): Analysis {
  const p = obj(e.payload);
  const findings: FindingDraft[] = [];
  const isTool = e.eventType === 'tool_call' || e.eventType === 'tool_result';

  let mcpServer: string | null = null;
  let category: ToolCategory | null = null;
  if (isTool) {
    const explicit = p.mcpServerName ?? p.mcp_server;
    mcpServer = typeof explicit === 'string' && explicit ? explicit : (mcpFromName(e.toolName)?.server ?? null);
    category = classifyTool(e.toolName, mcpServer);
  }

  let scan = '';
  if (e.scanText) scan = e.scanText;
  else if (e.eventType === 'tool_call') scan = toText(p.tool_input);
  else if (e.eventType === 'tool_result') scan = toText(p.tool_result ?? p.tool_response ?? p.output);
  else if (e.eventType === 'prompt') scan = toText(p.prompt ?? p.message ?? p.user_message);

  // Re-analysis of already-redacted rows passes the detections stored at ingest instead of re-scanning.
  const detections: Detection[] = e.knownDetections
    ? e.knownDetections.filter(d => isDetectorEnabled(d.key))
    : scan ? detect(scan) : [];
  for (const d of detections) {
    findings.push({ kind: 'detector', key: d.key, label: d.label, severity: d.cls === 'secret' ? 'high' : 'low', maskedSample: d.maskedSample });
  }

  let riskLevel: RiskLevel | null = null;
  if (e.eventType === 'tool_call') {
    if (mcpServer) findings.push({ kind: 'mcp', key: mcpServer, label: mcpServer });
    const input = p.tool_input;
    const domains = extractDomains(input);
    for (const d of domains) findings.push({ kind: 'domain', key: d, label: d });
    const hits: RiskHit[] = assessRisk({
      toolName: e.toolName, category: category ?? 'OTHER', input, cwd: e.cwd,
      secretDetected: detections.some(d => d.cls === 'secret'),
      externalDomains: domains,
    });
    if (hits.length) riskLevel = hits[0].level;
    const seen = new Set<string>();
    for (const h of hits) {
      if (h.level === 'low' || seen.has(h.rule)) continue;
      seen.add(h.rule);
      findings.push({ kind: 'risk', key: h.rule, label: h.label, severity: h.level });
    }
    if (hits[0]?.level === 'critical') {
      findings.push({ kind: 'policy', key: 'warned', label: `Warned: ${hits[0].label}`, severity: 'critical' });
    }
  }

  // Policy / enforcement signals
  const policy = e.policy ?? (p._policy as AnalyzableEvent['policy'] | undefined);
  if (policy && policy.outcome) {
    findings.push({ kind: 'policy', key: policy.outcome, label: policy.label, severity: policy.outcome === 'prompted' || policy.outcome === 'approved' ? 'info' : 'medium' });
  } else if (e.status === 'blocked') {
    findings.push({ kind: 'policy', key: 'blocked', label: `Blocked${e.toolName ? ': ' + e.toolName : ''}`, severity: 'medium' });
  } else if (e.eventType === 'tool_result' && e.errorText && DENIAL_RE.test(e.errorText)) {
    findings.push({ kind: 'policy', key: 'denied', label: `Denied${e.toolName ? ': ' + e.toolName : ''}`, severity: 'medium', inferred: true });
  } else if (e.eventType === 'notification') {
    const msg = toText(p.message ?? p.text);
    if (/permission/i.test(msg)) findings.push({ kind: 'policy', key: 'prompted', label: msg.slice(0, 160), severity: 'info' });
  }

  return { category, mcpServer, riskLevel, findings };
}
