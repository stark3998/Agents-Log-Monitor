"""Canonical data model shared by collectors, detectors, hooks and sinks.

CanonicalEvent loosely follows OpenTelemetry GenAI semantic conventions (gen_ai.*) with an
``effects`` extension (capability/resource/destination) used for charter and evasion checks.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Platform(StrEnum):
    FOUNDRY = "foundry"
    COPILOT_STUDIO = "copilot_studio"
    AZURE_OPENAI = "azure_openai"  # direct model inference (no agent)
    NETWORK = "network"
    AZURE_CONTROL_PLANE = "azure_control_plane"
    CUSTOM = "custom"


class EventKind(StrEnum):
    SESSION_START = "session_start"
    SESSION_END = "session_end"
    USER_MESSAGE = "user_message"
    ASSISTANT_MESSAGE = "assistant_message"
    PLAN = "plan"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    INFERENCE = "inference"
    NETWORK_FLOW = "network_flow"
    CONTROL_PLANE = "control_plane"
    POLICY_DECISION = "policy_decision"
    ERROR = "error"


class Decision(StrEnum):
    ALLOWED = "allowed"
    BLOCKED = "blocked"  # denied by policy/guardrail/hook/approver/DLP
    FAILED = "failed"  # tool error that was not a policy block
    PENDING = "pending"


class Capability(StrEnum):
    READ_DATA = "read_data"
    WRITE_DATA = "write_data"
    DELETE_DATA = "delete_data"
    EXEC_CODE = "exec_code"
    EXEC_SHELL = "exec_shell"
    NET_EGRESS = "net_egress"
    DOWNLOAD_EXEC = "download_exec"
    EXFIL = "exfil"
    CRED_ACCESS = "cred_access"
    PERSISTENCE = "persistence"
    PRIV_ESC = "priv_esc"
    DEFENSE_EVASION = "defense_evasion"
    DESTRUCTIVE = "destructive"
    RECON = "recon"
    SEND_MESSAGE = "send_message"
    IDENTITY_ADMIN = "identity_admin"
    CLOUD_ADMIN = "cloud_admin"
    SEARCH = "search"
    KNOWLEDGE = "knowledge"
    AGENT_DELEGATION = "agent_delegation"
    MODEL_INFERENCE = "model_inference"
    UNKNOWN = "unknown"


class Effect(BaseModel):
    """What an action actually does, independent of which tool/interpreter performs it."""

    capability: Capability
    resource: str = ""  # canonical path / table / mailbox / secret name
    destination: str = ""  # canonical host (eTLD+1-ish) or IP
    data_class: str = ""  # e.g. credential, pii, financial
    executor: str = ""  # tool / interpreter / binary that performs it
    evidence: str = ""  # short snippet that produced this effect

    def key(self) -> str:
        return f"{self.capability}|{self.resource}|{self.destination}"


class CanonicalEvent(BaseModel):
    id: str
    platform: Platform
    source: str  # collector or hook id, e.g. law.appdeps, dataverse.transcripts, hook.copilot_studio
    kind: EventKind
    occurred_at: datetime
    tenant_id: str | None = None
    resource_id: str | None = None  # ARM id of the Foundry account/project, env id, etc.
    agent_id: str | None = None
    agent_name: str | None = None
    agent_version: str | None = None
    session_id: str | None = None
    turn_id: str | None = None
    user_id: str | None = None
    caller_object_id: str | None = None
    caller_ip: str | None = None
    tool_name: str | None = None
    tool_type: str | None = None
    tool_call_id: str | None = None
    arguments: Any = None
    result: Any = None
    text: str | None = None
    thought: str | None = None
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    status: str | None = None
    decision: Decision | None = None
    decision_reason: str | None = None
    error: str | None = None
    src_ip: str | None = None
    dest_ip: str | None = None
    dest_port: int | None = None
    dest_host: str | None = None
    bytes_out: int | None = None
    trace_id: str | None = None
    span_id: str | None = None
    effects: list[Effect] = Field(default_factory=list)
    attributes: dict[str, Any] = Field(default_factory=dict)

    @property
    def agent_key(self) -> str:
        return f"{self.platform}:{self.agent_id or self.agent_name or 'unknown'}"

    def action_text(self, limit: int = 2000) -> str:
        """Compact, human-readable rendering used for embeddings and LLM prompts."""
        parts = [self.kind.value]
        if self.tool_name:
            parts.append(self.tool_name)
        if self.arguments is not None:
            parts.append(_short(self.arguments, limit))
        elif self.text:
            parts.append(self.text[:limit])
        if self.dest_host or self.dest_ip:
            parts.append(f"-> {self.dest_host or self.dest_ip}:{self.dest_port or ''}")
        return " ".join(parts)[:limit]


class UseCase(BaseModel):
    id: str
    description: str
    expected_capabilities: list[Capability] = Field(default_factory=list)


class AgentProfile(BaseModel):
    """The agent's charter: what it is for and what it may do (derived from its definition)."""

    agent_key: str
    platform: Platform
    agent_id: str | None = None
    name: str
    resource_id: str | None = None
    description: str = ""
    instructions: str = ""
    tools: list[dict[str, Any]] = Field(default_factory=list)
    knowledge: list[str] = Field(default_factory=list)
    purpose: str = ""
    use_cases: list[UseCase] = Field(default_factory=list)
    allowed_capabilities: list[Capability] = Field(default_factory=list)
    forbidden_capabilities: list[Capability] = Field(default_factory=list)
    allowed_destinations: list[str] = Field(default_factory=list)
    out_of_scope: list[str] = Field(default_factory=list)
    derived_by: str = "heuristic"  # heuristic | llm | lane | manual
    definition_hash: str = ""
    updated_at: datetime = Field(default_factory=utcnow)

    @staticmethod
    def hash_definition(*parts: Any) -> str:
        blob = json.dumps(parts, sort_keys=True, default=str)
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


class Severity(StrEnum):
    INFORMATIONAL = "informational"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"

    @property
    def rank(self) -> int:
        return ["informational", "low", "medium", "high", "critical"].index(self.value)

    @classmethod
    def from_score(cls, score: float) -> "Severity":
        if score >= 85:
            return cls.CRITICAL
        if score >= 65:
            return cls.HIGH
        if score >= 40:
            return cls.MEDIUM
        if score >= 15:
            return cls.LOW
        return cls.INFORMATIONAL


class Alert(BaseModel):
    alert_id: str
    alert_type: str
    severity: Severity
    score: float
    title: str
    summary: str
    detector: str
    platform: Platform
    agent_id: str | None = None
    agent_name: str | None = None
    session_id: str | None = None
    user_id: str | None = None
    lane_id: str | None = None
    action: str = "alert"  # alert | block | escalate
    owasp_llm: list[str] = Field(default_factory=list)
    owasp_agentic: list[str] = Field(default_factory=list)
    mitre_atlas: list[str] = Field(default_factory=list)
    evidence: dict[str, Any] = Field(default_factory=dict)
    source_event_ids: list[str] = Field(default_factory=list)
    incident_id: str | None = None
    created_at: datetime = Field(default_factory=utcnow)

    @property
    def fingerprint(self) -> str:
        basis = "|".join([self.alert_type, self.agent_id or self.agent_name or "", self.session_id or "",
                          str(self.evidence.get("fingerprint_basis", self.title))])
        return hashlib.sha256(basis.encode()).hexdigest()[:24]


class Verdict(BaseModel):
    """Real-time decision for a pending tool call."""

    block: bool
    score: float
    reason: str
    reason_code: int = 0
    alerts: list[Alert] = Field(default_factory=list)
    latency_ms: float = 0.0
    mode: str = "enforce"


def _short(value: Any, limit: int) -> str:
    if isinstance(value, str):
        return value[:limit]
    try:
        return json.dumps(value, default=str, ensure_ascii=False)[:limit]
    except Exception:
        return str(value)[:limit]
