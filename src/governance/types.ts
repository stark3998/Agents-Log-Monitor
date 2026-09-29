/**
 * Governance domain model — the shared contract between enforcement points (hooks, MCP gateway,
 * SDKs), the Policy Decision Point (PDP), storage, the MCP server and the intelligence service.
 *
 * Wire format: every type here is JSON-serialisable. `packages/sdk-*` and `intelligence/` mirror
 * these shapes; keep them in sync (see docs/governance.md).
 */
import type { ToolCategory } from '../analytics/classify';
import type { RiskLevel } from '../analytics/risk';

export type { ToolCategory, RiskLevel };

// ── Surfaces & checkpoints ─────────────────────────────────────────────────

/** Where the action came from (enforcement point / platform). */
export type Surface =
  | 'claude-code'
  | 'copilot-cli'
  | 'copilot-cloud-agent'
  | 'vscode'
  | 'mcp-gateway'
  | 'sdk'
  | 'foundry'
  | 'copilot-studio'
  | 'monitor'          // the monitor's own agents (Guardian, chat) and MCP server callers
  | 'unknown';

/** The seam in an agent run where the check happens. */
export type Checkpoint =
  | 'goal'             // user prompt / task intake — updates session intent, normally allowed
  | 'pre_tool'         // before a tool call executes — the main enforcement point
  | 'tool_result'      // after a tool returns — prompt-injection scanning / tainting
  | 'spawn'            // subagent start
  | 'response'         // agent final response / stop
  | 'admin';           // privileged governance action (approve, pause, lane change) via MCP/API

// ── Identity ───────────────────────────────────────────────────────────────

export interface AgentIdentity {
  /** Stable registry id. Resolved by the registry; enforcers may send a hint. */
  agentId?: string;
  /** Platform-native agent id / name (e.g. Foundry asst_…, Copilot Studio bot id, SDK agent name). */
  externalId?: string;
  name?: string;
  surface: Surface;
  /** Microsoft Entra Agent ID object id, when known. */
  entraAgentId?: string;
  /** Human on whose behalf the agent acts (UPN / email / OS user). */
  user?: string;
  /** Machine / host / container that ran the agent. */
  endpoint?: string;
  /** Subagent chain: parent agent id and depth (0 = top-level). */
  parentAgentId?: string;
  depth?: number;
  /** Repository / working directory the agent operates in. */
  cwd?: string;
  repo?: string;
}

// ── Action request (input to the PDP) ─────────────────────────────────────

export interface ActionRequest {
  /** Client-generated id for idempotency and correlation (e.g. tool_use_id). */
  requestId: string;
  sessionId: string;
  checkpoint: Checkpoint;
  agent: AgentIdentity;
  /** Tool name as reported by the surface (e.g. `Bash`, `mcp__github__create_issue`, `powershell`). */
  toolName?: string;
  /** Normalised category; the PDP derives it via analytics/classify when absent. */
  category?: ToolCategory;
  /** MCP server name for MCP tool calls. */
  mcpServer?: string;
  /** Tool arguments / input (untrusted). */
  args?: unknown;
  /** Tool result text for `tool_result` checkpoints (untrusted). */
  result?: string;
  /** Prompt text for `goal` checkpoints / response text for `response`. */
  text?: string;
  /** Token usage reported with this checkpoint (for budgets). */
  tokens?: { input?: number; output?: number };
  /** ISO timestamp from the source; the PDP uses server time when absent. */
  occurredAt?: string;
  /** Surface-specific extras (permission_mode, model, …). Not trusted for decisions. */
  meta?: Record<string, unknown>;
}

// ── Decision (output of the PDP) ──────────────────────────────────────────

/**
 * - allow     — proceed
 * - deny      — block with reason
 * - ask       — defer to the agent's native permission prompt (user at the keyboard decides)
 * - escalate  — pending human approval (only returned by non-blocking APIs; blocking hooks wait)
 */
export type Verdict = 'allow' | 'deny' | 'ask' | 'escalate';

/** Which stage produced the final verdict. */
export type DecisionStage =
  | 'kill_switch'
  | 'limits'
  | 'rules_deny'
  | 'rules_allow'
  | 'default'          // no rule matched and judge not required → lane default
  | 'judge_fast'
  | 'judge_escalation'
  | 'human'
  | 'fail_mode'        // timeout / error → lane fail mode
  | 'cache'
  | 'not_governed';    // checkpoint not subject to enforcement (e.g. goal)

export type LaneMode = 'observe' | 'enforce' | 'enforce+approval';

export interface JudgeVerdict {
  verdict: 'allow' | 'deny' | 'escalate';
  /** 0..1 */
  confidence: number;
  rationale: string;
  /** Which lane clause (purpose / do / never) the verdict relies on. */
  laneClause?: string;
  /** Deployment name actually used. */
  model: string;
  tier: 'fast' | 'escalation';
  latencyMs: number;
}

export interface Decision {
  /** Server-assigned decision id (uuid). */
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  laneId: string;
  laneVersion: number;
  mode: LaneMode;
  checkpoint: Checkpoint;
  toolName?: string;
  category?: ToolCategory;
  /** Verdict returned to the enforcement point (observe mode: never deny). */
  verdict: Verdict;
  /** What enforcement would have returned; differs from `verdict` only in observe mode. */
  effectiveVerdict: Verdict;
  /** True when observe mode suppressed a deny. */
  wouldDeny: boolean;
  stage: DecisionStage;
  /** Short human-readable reason; surfaced to the agent on deny. */
  reason: string;
  /** Deterministic rule ids that matched (lane rules, risk rules, limit ids). */
  ruleIds: string[];
  riskLevel?: RiskLevel | null;
  judge?: JudgeVerdict[];
  /** Approval record id when a human was involved. */
  approvalId?: string;
  approver?: string;
  /** Session was tainted by untrusted content at decision time. */
  tainted: boolean;
  latencyMs: number;
  createdAt: string;
  /** Hash chain (audit): sha256(prevHash + canonical(decision without seq/prevHash/hash)). */
  seq?: number;
  prevHash?: string;
  hash?: string;
}

// ── Lanes ──────────────────────────────────────────────────────────────────

/** A deterministic rule condition. All present fields must match (AND); list values are OR. */
export interface LaneCondition {
  id?: string;
  category?: ToolCategory[];
  /** Tool name globs, matched against both raw and canonical names. */
  tool?: string[];
  mcpServer?: string[];
  /** Built-in or custom risk rule ids (analytics/risk.ts), or risk levels (`high`, `critical`…). */
  risk?: string[];
  /** Path globs; `${workspace}` and `~` are expanded. */
  path?: string[];
  /** Domain globs (`*.contoso.com`, `169.254.169.254`). */
  domain?: string[];
  /** Regexes tested against the shell command text. */
  command?: string[];
  /** Detector keys (analytics/detectors.ts) found in the args. */
  detector?: string[];
  /** Match only when the session is tainted. */
  tainted?: boolean;
  /** Free text shown in decisions. */
  description?: string;
}

export type FailMode = 'open' | 'closed';
export type DataPolicy = 'redacted' | 'full' | 'metadata-only';
export type ApprovalChannel = 'native' | 'dashboard' | 'teams';
export type AlertChannel = 'teams' | 'webhook' | 'email';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Lane {
  id: string;
  version: number;
  name?: string;
  appliesTo: {
    /** Surfaces, or `['*']` for all. */
    surfaces?: (Surface | '*')[];
    /** Registry agent ids / external ids / name globs. */
    agents?: string[];
    repos?: string[];
    users?: string[];
  };
  /** Higher wins when several lanes apply. Default 0; the built-in default lane is -1000. */
  priority?: number;
  purpose: string;
  dos: string[];
  never: string[];
  rules: {
    deny?: LaneCondition[];
    allow?: LaneCondition[];
    /** Conditions that require the LLM judge. */
    judge?: LaneCondition[];
    /** Conditions that always require human approval (when mode allows). */
    approve?: LaneCondition[];
  };
  /** Verdict when nothing matched and the judge wasn't required. Default `allow`. */
  defaultVerdict?: 'allow' | 'deny' | 'judge';
  mode: LaneMode;
  failMode: { default: FailMode } & Partial<Record<ToolCategory, FailMode>>;
  approval: {
    channels: ApprovalChannel[];
    timeoutSec: number;
    approvers?: string[];
  };
  judge: {
    /** `fast` | `escalation` | explicit deployment name. */
    model?: string;
    /** Escalate to the stronger model below this confidence. */
    escalateBelow: number;
    /** Escalate to a human below this confidence after the escalation judge. */
    humanBelow?: number;
    dataPolicy: DataPolicy;
    timeoutMs?: number;
  };
  limits?: {
    actionsPerMin?: number;
    maxSubagents?: number;
    maxDepth?: number;
    tokenBudget?: number;
    loopThreshold?: number;
    maxSessionMinutes?: number;
  };
  promptShields?: {
    enabled?: boolean;
    scan?: ToolCategory[];
    /** Number of subsequent actions a taint lasts. */
    taintTtlActions?: number;
  };
  alerts?: Partial<Record<Severity, AlertChannel[]>>;
  /** Data sent from local enforcers to the cloud control plane. */
  sync?: { dataPolicy: DataPolicy };
  /** Guardian authority for agents governed by this lane. */
  guardian?: { authority: GuardianAuthority };
  meta?: { owner?: string; createdBy?: string; source?: 'file' | 'ui' | 'ai-draft'; notes?: string };
}

export type LaneStatus = 'active' | 'draft' | 'proposed' | 'archived';

export interface LaneRecord {
  lane: Lane;
  status: LaneStatus;
  updatedAt: string;
  updatedBy?: string;
  /** Raw YAML as authored (for lanes-as-code round-tripping). */
  yaml?: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'paused' | 'quarantined' | 'retired';

export interface RegisteredAgent {
  id: string;
  name: string;
  surface: Surface;
  externalId?: string;
  entraAgentId?: string;
  owner?: string;
  purpose?: string;
  /** Explicit lane assignment; otherwise resolved via lane `appliesTo`. */
  laneId?: string;
  allowedTools?: string[];
  status: AgentStatus;
  statusReason?: string;
  discovered: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

// ── Sessions / intent ─────────────────────────────────────────────────────

export interface SessionIntent {
  sessionId: string;
  agentId: string;
  /** LLM-extracted (or heuristically extracted) task goal. */
  goal?: string;
  goalSource?: 'llm' | 'heuristic' | 'sdk';
  /** Compact recent actions: `CATEGORY tool target` lines, newest last. */
  trajectory: string[];
  taint?: { reason: string; source: string; remainingActions: number; at: string } | null;
  status: 'active' | 'paused' | 'quarantined';
  counters: { actions: number; subagents: number; tokens: number };
  startedAt: string;
  updatedAt: string;
}

// ── Approvals ──────────────────────────────────────────────────────────────

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface Approval {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  laneId: string;
  toolName?: string;
  /** One-line redacted summary of the action. */
  summary: string;
  /** Why approval is needed. */
  reason: string;
  channels: ApprovalChannel[];
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

// ── Incidents (Guardian) ──────────────────────────────────────────────────

export type GuardianAuthority = 'recommend' | 'contain' | 'autonomous';
export type IncidentState = 'open' | 'investigating' | 'contained' | 'resolved' | 'dismissed';

export interface IncidentRecommendation {
  action: string;
  target: string;
  rationale: string;
  status: 'proposed' | 'applied' | 'rejected';
}

export interface Incident {
  id: string;
  title: string;
  severity: Severity;
  state: IncidentState;
  /** What triggered it (deny_burst, taint_risky, drift, swarm, limits, manual…). */
  trigger: string;
  agentIds: string[];
  sessionIds: string[];
  decisionIds: string[];
  summary?: string;
  /** Markdown report written by the Guardian. */
  report?: string;
  recommendations?: IncidentRecommendation[];
  containment?: { action: string; target: string; at: string; by: string }[];
  createdAt: string;
  updatedAt: string;
}

// ── Roles ──────────────────────────────────────────────────────────────────

export type Role = 'Viewer' | 'Approver' | 'PolicyAdmin' | 'Agent';

export interface Principal {
  id: string;
  name?: string;
  roles: Role[];
  /** 'user' for humans, 'agent' for agent identities, 'device' for local enforcers, 'local' for loopback. */
  kind: 'user' | 'agent' | 'device' | 'local';
  tenantId?: string;
}
