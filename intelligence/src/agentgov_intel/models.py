from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Severity = Literal["info", "low", "medium", "high", "critical"]
IncidentState = Literal["open", "investigating", "contained", "resolved", "dismissed"]


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str


class ChatRequest(BaseModel):
    messages: list[ChatMessage]
    conversationId: str | None = None


class DraftLaneRequest(BaseModel):
    agentId: str
    description: str | None = None
    systemPrompt: str | None = None


class InvestigateRequest(BaseModel):
    incidentId: str | None = None
    trigger: str | None = None
    agentIds: list[str] = Field(default_factory=list)
    sessionIds: list[str] = Field(default_factory=list)
    decisionIds: list[str] = Field(default_factory=list)


class Decision(BaseModel):
    id: str
    requestId: str | None = None
    sessionId: str
    agentId: str
    laneId: str | None = None
    laneVersion: int | None = None
    mode: str | None = None
    checkpoint: str | None = None
    toolName: str | None = None
    category: str | None = None
    verdict: str
    effectiveVerdict: str | None = None
    wouldDeny: bool = False
    stage: str | None = None
    reason: str = ""
    ruleIds: list[str] = Field(default_factory=list)
    riskLevel: str | None = None
    tainted: bool = False
    createdAt: str
    meta: dict[str, Any] | None = None


class IncidentRecommendation(BaseModel):
    action: str
    target: str
    rationale: str
    status: Literal["proposed", "applied", "rejected"] = "proposed"


class Incident(BaseModel):
    id: str
    title: str
    severity: Severity
    state: IncidentState
    trigger: str
    agentIds: list[str] = Field(default_factory=list)
    sessionIds: list[str] = Field(default_factory=list)
    decisionIds: list[str] = Field(default_factory=list)
    summary: str | None = None
    report: str | None = None
    recommendations: list[IncidentRecommendation] | None = None
    containment: list[dict[str, Any]] | None = None
    createdAt: str
    updatedAt: str
