export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Channel = 'log' | 'hook' | 'poll';

export interface DetectorSummary { key: string; label: string; count: number; cls: 'secret' | 'pii' }

export interface Conversation {
  id: string;
  agentKey: string;
  agentName: string;
  agentKind: string;
  title: string | null;
  projectPath: string | null;
  user: string | null;
  endpoint: string | null;
  model: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  endedAt: string | null;
  live: boolean;
  prompts: number;
  actions: number;
  builtin: number;
  mcp: number;
  riskyActions: number;
  severity: Severity;
  severityReasons: string[];
  autonomyLevel: number | null;
  autonomyLabel: string | null;
  detectors: DetectorSummary[];
  domains: number;
  mcpServers: number;
  domainKeys: string[];
  mcpKeys: string[];
  enforcement: { blocked: number; denied: number; warned: number; prompted: number };
  channels: Channel[];
}

export interface Kpi { value: number; previous: number; series: number[] }

export interface Overview {
  range: { from: string; to: string };
  bucket: 'hour' | 'day';
  buckets: string[];
  kpis: Record<'activeAgents' | 'totalSessions' | 'sensitiveSessions' | 'riskyActions' | 'blockedWarned', Kpi>;
  totalActions: number;
  trend: { agentKey: string; agentName: string; data: number[] }[];
}

export interface AgentRow {
  agentKey: string;
  agentName: string;
  agentKind: string;
  actions: number;
  sessions: number;
  riskyActions: number;
  detectors: number;
  mcps: number;
  domains: number;
  enforcedEndpoints: number;
  users: number;
  endpoints: number;
}

export interface Matrix {
  columns: { key: string; total: number }[];
  totalColumns: number;
  cells: Record<string, Record<string, { count: number; last: string }>>;
}

export interface Connections {
  agents: { agentKey: string; agentName: string }[];
  mcp: Matrix;
  domains: Matrix;
}

export interface FindingLite { kind: string; key: string; label: string; severity: string | null; sample?: string | null }

export type TimelineItem =
  | { kind: 'prompt' | 'assistant' | 'thinking'; id: number; t: string; agentId: string; text: string; truncated: boolean; channel: Channel; hook?: boolean; findings?: FindingLite[] }
  | { kind: 'tool'; id: number; resultId: number | null; t: string; agentId: string; name: string; mcpServer: string | null; category: string | null;
      status: string; durationMs: number | null; preview: string; risk: string | null; channel: Channel; hook: boolean; error: string | null; findings: FindingLite[];
      /** Surface tool-call id (e.g. Claude `tool_use_id`) when the server exposes it; matches Decision.requestId. */
      toolUseId?: string | null }
  | { kind: 'subagent'; id: number; t: string; agentId: string; phase: 'start' | 'end'; name: string; agentType: string | null; status: string | null }
  | { kind: 'lifecycle'; id: number; t: string; agentId: string; label: string; detail: string | null; model: string | null; tokens: number | null }
  | { kind: 'notification'; id: number; t: string; agentId: string; text: string }
  | { kind: 'policy'; id: number; t: string; agentId: string; outcome: string; label: string };

export type ToolItem = Extract<TimelineItem, { kind: 'tool' }>;
export type TextItem = Extract<TimelineItem, { kind: 'prompt' | 'assistant' | 'thinking' }>;

export interface ConversationDetail {
  conversation: Conversation;
  agents: { id: string; name: string; type: string | null; status: string | null; parentId: string | null; startedAt: string | null; endedAt: string | null }[];
  timeline: TimelineItem[];
}

export type LiveUpdate =
  | { op: 'append'; item: TimelineItem }
  | { op: 'tool_result'; callId: number; resultId: number; status: string; durationMs: number | null; error: string | null; findings: FindingLite[] };

export interface RawEvent {
  id: number;
  session_id: string;
  agent_id: string;
  event_type: string;
  raw_event_name: string | null;
  tool_name: string | null;
  status: string | null;
  duration_ms: number | null;
  error_text: string | null;
  model: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  capture_channel: Channel | null;
  category: string | null;
  mcp_server: string | null;
  risk_level: string | null;
}

export interface EventDetail { event: RawEvent; result: RawEvent | null; findings: FindingLite[] }

export interface EnforcementRow {
  id: number;
  eventId: number;
  outcome: 'blocked' | 'denied' | 'warned' | 'prompted' | 'approved';
  label: string;
  severity: string | null;
  t: string;
  tool: string | null;
  channel: Channel | null;
  sessionId: string;
  title: string | null;
  agentKey: string;
  agentName: string;
  user: string | null;
  endpoint: string | null;
}

export interface Source {
  id: string;
  agentKey: string;
  name: string;
  channel: Channel;
  enabled: boolean;
  configured: boolean;
  setup: string;
  lastEventAt: string | null;
  events: number;
  lastPollAt: string | null;
  lastError: string | null;
  backlog: boolean;
}

export interface RiskRuleInfo {
  rule: string;
  label: string;
  defaultLevel: 'critical' | 'high' | 'medium' | 'low' | null;
  level: 'critical' | 'high' | 'medium' | 'low' | 'off';
  source: 'built-in' | 'custom';
  appliesTo: string;
  pattern?: string;
}

export interface SeverityThresholds {
  criticalHighActionsWithSecrets: number;
  highSecretDetections: number;
  mediumRiskActions: number;
}

export interface Settings {
  database: { path: string; engine: string };
  redaction: { mode: 'off' | 'secrets' | 'all'; env: string };
  maintenance: { running: boolean; processed: number; startedAt: string | null };
  rules: {
    path: string;
    exists: boolean;
    error: string | null;
    risk: RiskRuleInfo[];
    detectors: { key: string; label: string; cls: 'secret' | 'pii'; enabled: boolean }[];
    domainsIgnored: string[];
    severity: SeverityThresholds;
    severityDefaults: SeverityThresholds;
  };
}
