from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

ToolCategory = Literal['READ', 'WRITE', 'EXEC', 'NETWORK', 'AGENT', 'MCP', 'OTHER']
RiskLevel = Literal['critical', 'high', 'medium', 'low']
Surface = Literal['claude-code', 'copilot-cli', 'copilot-cloud-agent', 'vscode', 'mcp-gateway', 'sdk', 'foundry', 'copilot-studio', 'monitor', 'unknown']
Checkpoint = Literal['goal', 'pre_tool', 'tool_result', 'spawn', 'response', 'admin']
Verdict = Literal['allow', 'deny', 'ask', 'escalate']
DecisionStage = Literal['kill_switch', 'limits', 'rules_deny', 'rules_allow', 'default', 'judge_fast', 'judge_escalation', 'human', 'fail_mode', 'cache', 'not_governed']
LaneMode = Literal['observe', 'enforce', 'enforce+approval']
FailMode = Literal['open', 'closed']
ApprovalState = Literal['pending', 'approved', 'denied', 'expired', 'cancelled']

class AgentIdentity(TypedDict, total=False):
    agentId: str
    externalId: str
    name: str
    surface: Surface
    entraAgentId: str
    user: str
    endpoint: str
    parentAgentId: str
    depth: int
    cwd: str
    repo: str

class ActionRequest(TypedDict, total=False):
    requestId: str
    sessionId: str
    checkpoint: Checkpoint
    agent: AgentIdentity
    toolName: str
    category: ToolCategory
    mcpServer: str
    args: Any
    result: str
    text: str
    tokens: dict[str, int]
    occurredAt: str
    meta: dict[str, Any]

class JudgeVerdict(TypedDict, total=False):
    verdict: Literal['allow', 'deny', 'escalate']
    confidence: float
    rationale: str
    laneClause: str
    model: str
    tier: Literal['fast', 'escalation']
    latencyMs: int

class Decision(TypedDict):
    id: str
    requestId: str
    sessionId: str
    agentId: str
    laneId: str
    laneVersion: int
    mode: LaneMode
    checkpoint: Checkpoint
    verdict: Verdict
    effectiveVerdict: Verdict
    wouldDeny: bool
    stage: DecisionStage
    reason: str
    ruleIds: list[str]
    tainted: bool
    latencyMs: int
    createdAt: str
    toolName: NotRequired[str]
    category: NotRequired[ToolCategory]
    riskLevel: NotRequired[RiskLevel | None]
    judge: NotRequired[list[JudgeVerdict]]
    approvalId: NotRequired[str]
    approver: NotRequired[str]
    seq: NotRequired[int]
    prevHash: NotRequired[str]
    hash: NotRequired[str]

class Approval(TypedDict, total=False):
    id: str
    requestId: str
    sessionId: str
    agentId: str
    laneId: str
    toolName: str
    summary: str
    reason: str
    channels: list[Literal['native', 'dashboard', 'teams']]
    state: ApprovalState
    requestedAt: str
    expiresAt: str
    resolvedAt: str
    resolvedBy: str
    resolutionNote: str

class GoalResponse(TypedDict, total=False):
    ok: bool
    goal: Any

class ResultResponse(TypedDict, total=False):
    tainted: bool
    reason: str
