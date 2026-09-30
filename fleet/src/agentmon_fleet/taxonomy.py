"""Alert types and their mapping to OWASP LLM Top 10 (2025), OWASP Agentic Top 10 (ASI, 2026) and MITRE ATLAS."""
from __future__ import annotations

from dataclasses import dataclass, field

from .models import Severity


@dataclass(frozen=True)
class AlertTypeInfo:
    title: str
    default_severity: Severity
    owasp_llm: list[str] = field(default_factory=list)
    owasp_agentic: list[str] = field(default_factory=list)
    mitre_atlas: list[str] = field(default_factory=list)


ALERT_TYPES: dict[str, AlertTypeInfo] = {
    "INTENT_OUT_OF_SCOPE": AlertTypeInfo(
        "Session intent is outside the agent's use cases", Severity.MEDIUM, ["LLM06"], ["ASI01"], ["AML.T0051"]),
    "GOAL_DRIFT": AlertTypeInfo(
        "Agent behaviour drifted away from the session goal", Severity.HIGH, ["LLM01"], ["ASI01"],
        ["AML.T0051.001", "AML.T0080.001"]),
    "OUT_OF_CHARTER_ACTION": AlertTypeInfo(
        "Tool use outside the agent's allowed capabilities", Severity.MEDIUM, ["LLM06"], ["ASI02"], ["AML.T0053"]),
    "FORBIDDEN_CAPABILITY": AlertTypeInfo(
        "Agent attempted a forbidden capability", Severity.HIGH, ["LLM06"], ["ASI02", "ASI03"], ["AML.T0053"]),
    "OUT_OF_BOUNDS_SCRIPT": AlertTypeInfo(
        "Agent-generated script exceeds the agent's scope", Severity.HIGH, ["LLM05"], ["ASI05"],
        ["AML.T0050", "AML.T0102"]),
    "OBFUSCATED_CODE": AlertTypeInfo(
        "Agent produced obfuscated code or commands", Severity.HIGH, ["LLM05"], ["ASI05", "ASI10"],
        ["AML.T0068", "AML.T0050"]),
    "CREDENTIAL_ACCESS": AlertTypeInfo(
        "Agent accessed credentials or tokens", Severity.HIGH, ["LLM02"], ["ASI03"],
        ["AML.T0055", "AML.T0083", "AML.T0090"]),
    "DATA_EXFILTRATION": AlertTypeInfo(
        "Possible data exfiltration via agent tool", Severity.CRITICAL, ["LLM02"], ["ASI02"], ["AML.T0086", "AML.T0025"]),
    "DESTRUCTIVE_ACTION": AlertTypeInfo(
        "Destructive operation by agent", Severity.HIGH, ["LLM06"], ["ASI02", "ASI05"], ["AML.T0101"]),
    "BLOCKED_ACTION_WORKAROUND": AlertTypeInfo(
        "Agent attempted to work around a blocked action", Severity.HIGH, ["LLM06"], ["ASI10", "ASI01"],
        ["AML.T0107", "AML.T0068"]),
    "REPEATED_BLOCKED_ATTEMPTS": AlertTypeInfo(
        "Agent repeatedly retried blocked actions", Severity.MEDIUM, ["LLM06"], ["ASI10"], ["AML.T0107"]),
    "SOCIAL_ENGINEERING_USER": AlertTypeInfo(
        "Agent asked the user to perform a blocked action", Severity.HIGH, ["LLM06"], ["ASI09", "ASI10"], []),
    "PROMPT_INJECTION_SUSPECTED": AlertTypeInfo(
        "Tool output or input contains injection indicators", Severity.HIGH, ["LLM01"], ["ASI01", "ASI06"],
        ["AML.T0051.001"]),
    "UNAPPROVED_DESTINATION": AlertTypeInfo(
        "Agent reached a destination outside its allowlist", Severity.MEDIUM, ["LLM06"], ["ASI02"], ["AML.T0086"]),
    "SUSPICIOUS_NETWORK_FLOW": AlertTypeInfo(
        "Suspicious network flow from agent infrastructure", Severity.MEDIUM, [], ["ASI02"], ["AML.T0025"]),
    "UNREGISTERED_INFERENCE_CALLER": AlertTypeInfo(
        "Model inference from an identity that is not a registered agent", Severity.MEDIUM, ["LLM10"], ["ASI03"],
        ["AML.T0040"]),
    "INFERENCE_ANOMALY": AlertTypeInfo(
        "Anomalous inference volume or token usage", Severity.MEDIUM, ["LLM10"], ["ASI08"], ["AML.T0034.002"]),
    "CONTENT_FILTER_TRIGGERED": AlertTypeInfo(
        "Content safety filter blocked model traffic", Severity.MEDIUM, ["LLM01"], ["ASI01"], ["AML.T0054"]),
    "AGENT_CONFIG_CHANGE": AlertTypeInfo(
        "Agent definition or security configuration changed", Severity.LOW, ["LLM03"], ["ASI04"], ["AML.T0081"]),
    "SENSITIVE_CONTROL_PLANE_OP": AlertTypeInfo(
        "Sensitive control-plane operation on AI resources", Severity.MEDIUM, [], ["ASI03"], ["AML.T0055"]),
    "RUNAWAY_LOOP": AlertTypeInfo(
        "Agent is looping or consuming excessive resources", Severity.MEDIUM, ["LLM10"], ["ASI08"], ["AML.T0034.002"]),
    "SESSION_RISK_ESCALATION": AlertTypeInfo(
        "Multiple risk signals in one session", Severity.HIGH, [], ["ASI10"], []),
}


def info(alert_type: str) -> AlertTypeInfo:
    return ALERT_TYPES.get(alert_type, AlertTypeInfo(alert_type.replace("_", " ").title(), Severity.MEDIUM))
