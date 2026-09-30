"""Copilot Studio external threat-detection webhook protocol (api-version 2025-05-01).

Docs: https://learn.microsoft.com/microsoft-copilot-studio/external-security-webhooks-interface-developers
  POST {base}/validate                  -> {"isSuccessful": true, "status": "OK"}
  POST {base}/analyze-tool-execution    -> {"blockAction": bool, "reasonCode": int, "reason": str, "diagnostics": str}
Unknown fields and newer api-versions must be tolerated.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ..collectors.base import parse_json, stable_id, to_dt
from ..models import CanonicalEvent, EventKind, Platform, Verdict


def _meta(body: dict[str, Any]) -> dict[str, Any]:
    return body.get("conversationMetadata") or {}


def to_events(body: dict[str, Any]) -> tuple[CanonicalEvent, list[CanonicalEvent]]:
    """(pending tool-call event, context events: user turns + previous tool outputs)."""
    meta = _meta(body)
    agent = meta.get("agent") or {}
    user = meta.get("user") or {}
    planner = body.get("plannerContext") or {}
    tool = body.get("toolDefinition") or {}
    conv = meta.get("conversationId") or "unknown"
    now = datetime.now(timezone.utc)
    base = dict(platform=Platform.COPILOT_STUDIO, source="hook.copilot_studio", agent_id=agent.get("id"),
                agent_name=agent.get("name") or agent.get("displayName") or agent.get("id"), session_id=conv,
                user_id=user.get("id") or user.get("objectId"), tenant_id=agent.get("tenantId") or user.get("tenantId"),
                resource_id=agent.get("environmentId"), agent_version=str(agent.get("version") or "") or None)
    ctx: list[CanonicalEvent] = []
    for m in planner.get("chatHistory") or []:
        if str(m.get("role", "")).lower() != "user" or not m.get("content"):
            continue
        ctx.append(CanonicalEvent(id=stable_id("cs-hook-msg", conv, m.get("id") or m.get("content")[:120]),
                                  kind=EventKind.USER_MESSAGE, text=str(m["content"]),
                                  occurred_at=to_dt(m.get("timestamp")) if m.get("timestamp") else now, **base))
    if planner.get("userMessage"):
        ctx.append(CanonicalEvent(id=stable_id("cs-hook-msg", conv, str(planner["userMessage"])[:120]),
                                  kind=EventKind.USER_MESSAGE, text=str(planner["userMessage"]), occurred_at=now, **base))
    # Documented schema: ToolExecutionOutput {toolId, toolName, outputs: ExecutionOutput[] {name, value, ...}, timestamp}.
    # The sample payload spells the list "previousToolOutputs" and the schema table "previousToolsOutputs": accept both.
    prev_outputs = planner.get("previousToolOutputs") or planner.get("previousToolsOutputs") or []
    for i, out in enumerate(prev_outputs):
        o = out if isinstance(out, dict) else {"outputs": out}
        outs = o.get("outputs", o.get("output"))
        if isinstance(outs, dict):
            outs = [outs]
        if isinstance(outs, list):
            values = {str(x.get("name") or j): parse_json(x.get("value")) if isinstance(x, dict) else x
                      for j, x in enumerate(outs)}
            result: Any = next(iter(values.values())) if len(values) == 1 else values
        else:
            result = parse_json(outs)
        ctx.append(CanonicalEvent(
            id=stable_id("cs-hook-out", conv, meta.get("planId"), o.get("toolId") or i, str(result)[:200]),
            kind=EventKind.TOOL_RESULT, tool_name=o.get("toolName") or o.get("toolId"), tool_call_id=o.get("toolId"),
            result=result, occurred_at=to_dt(o["timestamp"]) if o.get("timestamp") else now, **base))
    call_id = f"{meta.get('planId')}:{meta.get('planStepId')}" if meta.get("planStepId") else None
    pending = CanonicalEvent(
        id=stable_id("cs-hook-call", conv, meta.get("planId"), meta.get("planStepId"), tool.get("id"),
                     str(body.get("inputValues"))[:500]),
        kind=EventKind.TOOL_CALL, tool_name=tool.get("name") or tool.get("id"), tool_type=tool.get("type"),
        tool_call_id=call_id, arguments=body.get("inputValues"), thought=planner.get("thought"), occurred_at=now,
        attributes={"tool_description": tool.get("description"), "trigger": meta.get("trigger"),
                    "published": agent.get("isPublished"), "parent_component": meta.get("parentAgentComponentId")},
        **base)
    return pending, ctx


def to_response(v: Verdict, correlation_id: str | None) -> dict[str, Any]:
    out: dict[str, Any] = {"blockAction": v.block}
    if v.block:
        out["reasonCode"] = v.reason_code
        out["reason"] = "Blocked by the organization's AI agent monitoring policy."
    out["diagnostics"] = f"agentmon score={v.score} mode={v.mode} latency_ms={v.latency_ms} corr={correlation_id or '-'}"
    return out
