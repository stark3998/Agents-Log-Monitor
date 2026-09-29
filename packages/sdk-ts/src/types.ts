export type ToolCategory = 'READ' | 'WRITE' | 'EXEC' | 'NETWORK' | 'AGENT' | 'MCP' | 'OTHER';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export type Surface =
  | 'claude-code'
  | 'copilot-cli'
  | 'copilot-cloud-agent'
  | 'vscode'
  | 'mcp-gateway'
  | 'sdk'
  | 'foundry'
  | 'copilot-studio'
  | 'monitor'
  | 'unknown';

export type Checkpoint = 'goal' | 'pre_tool' | 'tool_result' | 'spawn' | 'response' | 'admin';

export interface AgentIdentity {
  agentId?: string;
  externalId?: string;
  name?: string;
  surface: Surface;
  entraAgentId?: string;
  user?: string;
  endpoint?: string;
  parentAgentId?: string;
  depth?: number;
  cwd?: string;
  repo?: string;
}

export interface ActionRequest {
  requestId: string;
  sessionId: string;
  checkpoint: Checkpoint;
  agent: AgentIdentity;
  toolName?: string;
  category?: ToolCategory;
  mcpServer?: string;
  args?: unknown;
  result?: string;
  text?: string;
  tokens?: { input?: number; output?: number };
  occurredAt?: string;
  meta?: Record<string, unknown>;
}

export type Verdict = 'allow' | 'deny' | 'ask' | 'escalate';
export type DecisionStage =
  | 'kill_switch'
  | 'limits'
  | 'rules_deny'
  | 'rules_allow'
  | 'default'
  | 'judge_fast'
  | 'judge_escalation'
  | 'human'
  | 'fail_mode'
  | 'cache'
  | 'not_governed';
export type LaneMode = 'observe' | 'enforce' | 'enforce+approval';

export interface JudgeVerdict {
  verdict: 'allow' | 'deny' | 'escalate';
  confidence: number;
  rationale: string;
  laneClause?: string;
  model: string;
  tier: 'fast' | 'escalation';
  latencyMs: number;
}

export interface Decision {
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
  verdict: Verdict;
  effectiveVerdict: Verdict;
  wouldDeny: boolean;
  stage: DecisionStage;
  reason: string;
  ruleIds: string[];
  riskLevel?: RiskLevel | null;
  judge?: JudgeVerdict[];
  approvalId?: string;
  approver?: string;
  tainted: boolean;
  latencyMs: number;
  createdAt: string;
  seq?: number;
  prevHash?: string;
  hash?: string;
}

export type FailMode = 'open' | 'closed';
export type DataPolicy = 'redacted' | 'full' | 'metadata-only';
export type ApprovalChannel = 'native' | 'dashboard' | 'teams';
export type AlertChannel = 'teams' | 'webhook' | 'email';
export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface LaneCondition {
  id?: string;
  category?: ToolCategory[];
  tool?: string[];
  mcpServer?: string[];
  risk?: string[];
  path?: string[];
  domain?: string[];
  command?: string[];
  detector?: string[];
  tainted?: boolean;
  description?: string;
}

export interface Lane {
  id: string;
  version: number;
  name?: string;
  appliesTo: {
    surfaces?: (Surface | '*')[];
    agents?: string[];
    repos?: string[];
    users?: string[];
  };
  priority?: number;
  purpose: string;
  dos: string[];
  never: string[];
  rules: { deny?: LaneCondition[]; allow?: LaneCondition[]; judge?: LaneCondition[]; approve?: LaneCondition[] };
  defaultVerdict?: 'allow' | 'deny' | 'judge';
  mode: LaneMode;
  failMode: { default: FailMode } & Partial<Record<ToolCategory, FailMode>>;
  approval: { channels: ApprovalChannel[]; timeoutSec: number; approvers?: string[] };
  judge: { model?: string; escalateBelow: number; humanBelow?: number; dataPolicy: DataPolicy; timeoutMs?: number };
  limits?: {
    actionsPerMin?: number;
    maxSubagents?: number;
    maxDepth?: number;
    tokenBudget?: number;
    loopThreshold?: number;
    maxSessionMinutes?: number;
  };
  promptShields?: { enabled?: boolean; scan?: ToolCategory[]; taintTtlActions?: number };
  alerts?: Partial<Record<Severity, AlertChannel[]>>;
  sync?: { dataPolicy: DataPolicy };
  guardian?: { authority: 'recommend' | 'contain' | 'autonomous' };
  meta?: { owner?: string; createdBy?: string; source?: 'file' | 'ui' | 'ai-draft'; notes?: string };
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
export interface Approval {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  laneId: string;
  toolName?: string;
  summary: string;
  reason: string;
  channels: ApprovalChannel[];
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export interface GoalResponse { ok: true; goal?: unknown }
export interface ResultResponse { tainted: boolean; reason?: string }
export interface DecideOptions { blocking?: boolean; supportsAsk?: boolean; deadlineMs?: number }
export type FailModeConfig = FailMode | ({ default?: FailMode } & Partial<Record<ToolCategory, FailMode>>);
