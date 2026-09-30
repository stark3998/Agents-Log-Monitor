"""Map OpenAI Responses / Foundry conversation items to CanonicalEvents."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from ..models import CanonicalEvent, Decision, EventKind
from .base import parse_json, stable_id
from .genai import detect_block, message_text


def _tool_event(iid: str, common: dict[str, Any], name: str, ttype: str, args: Any, result: Any,
                call_id: str | None, decision: Decision | None, reason: str | None, **extra: Any) -> CanonicalEvent:
    return CanonicalEvent(id=stable_id("item", iid), kind=EventKind.TOOL_CALL, tool_name=name, tool_type=ttype,
                          tool_call_id=call_id, arguments=args, result=result, decision=decision,
                          decision_reason=reason, **common, **extra)


def items_to_events(items: list[dict[str, Any]], *, base: dict[str, Any], occurred_at: datetime,
                    id_prefix: str) -> list[CanonicalEvent]:
    """`items` must be chronological. `base` carries platform/source/agent/session fields."""
    outputs: dict[str, Any] = {}
    approvals: dict[str, dict[str, Any]] = {}
    for it in items:
        if it.get("type") == "function_call_output":
            outputs[it.get("call_id", "")] = it.get("output")
        elif it.get("type") == "mcp_approval_response":
            approvals[it.get("approval_request_id", "")] = it

    events: list[CanonicalEvent] = []
    call_names = {it.get("call_id"): it.get("name") for it in items if it.get("type") == "function_call"}
    request_names = {it.get("id"): f"{it.get('server_label', 'mcp')}.{it.get('name')}" for it in items
                     if it.get("type") == "mcp_approval_request"}
    for i, it in enumerate(items):
        t = it.get("type") or ("message" if "role" in it else "")
        iid = it.get("id") or f"{id_prefix}:{i}"
        common = dict(base, occurred_at=occurred_at)
        if t == "message":
            role = it.get("role")
            text = message_text(it).strip()
            if not text:
                continue
            if role == "user":
                events.append(CanonicalEvent(id=stable_id("item", iid), kind=EventKind.USER_MESSAGE, text=text, **common))
            elif role in ("system", "developer"):
                continue
            else:
                block = detect_block(text)
                events.append(CanonicalEvent(id=stable_id("item", iid), kind=EventKind.ASSISTANT_MESSAGE, text=text,
                                             attributes={"refusal_or_block": block} if block else {}, **common))
        elif t == "reasoning":
            summary = " ".join(s.get("text", "") for s in it.get("summary") or [] if isinstance(s, dict)).strip()
            if summary and events:
                events[-1].thought = (events[-1].thought or "") + summary
        elif t == "function_call":
            # The call and its output usually arrive in different responses; the output is emitted as its own
            # TOOL_RESULT (below) so it is analysed even when the call was already stored in an earlier cycle.
            out = outputs.get(it.get("call_id", ""))
            block = detect_block(out)
            events.append(_tool_event(iid, common, it.get("name", "function"), "function", parse_json(it.get("arguments")),
                                      None, it.get("call_id"),
                                      Decision.BLOCKED if block else (Decision.ALLOWED if out is not None else Decision.PENDING),
                                      block))
        elif t == "mcp_call":
            err = it.get("error")
            block = detect_block(err, it.get("output"))
            events.append(_tool_event(iid, common, f"{it.get('server_label', 'mcp')}.{it.get('name')}", "mcp",
                                      parse_json(it.get("arguments")), it.get("output"), it.get("id"),
                                      Decision.BLOCKED if block else (Decision.FAILED if err else Decision.ALLOWED), block,
                                      attributes={"mcp_server": it.get("server_label")}))
        elif t == "mcp_approval_request":
            resp = approvals.get(it.get("id", ""))
            decision, reason = Decision.PENDING, None
            if resp is not None:
                decision = Decision.ALLOWED if resp.get("approve") else Decision.BLOCKED
                reason = resp.get("reason") or ("approval denied" if not resp.get("approve") else None)
            events.append(_tool_event(iid, common, f"{it.get('server_label', 'mcp')}.{it.get('name')}", "mcp",
                                      parse_json(it.get("arguments")), None, it.get("id"), decision, reason,
                                      attributes={"mcp_server": it.get("server_label"), "approval_request": True}))
        elif t == "code_interpreter_call":
            outs = it.get("outputs") or []
            logs = "\n".join(str(o.get("logs", "")) for o in outs if isinstance(o, dict))
            events.append(_tool_event(iid, common, "code_interpreter", "code_interpreter", it.get("code") or "",
                                      logs or None, it.get("id"),
                                      Decision.FAILED if it.get("status") == "failed" else Decision.ALLOWED, None))
        elif t == "function_call_output":
            out = it.get("output")
            block = detect_block(out)
            call_id = it.get("call_id")
            events.append(CanonicalEvent(id=stable_id("item", iid, "output"), kind=EventKind.TOOL_RESULT,
                                         tool_call_id=call_id, tool_name=call_names.get(call_id), result=out,
                                         decision=Decision.BLOCKED if block else Decision.ALLOWED, decision_reason=block,
                                         **common))
        elif t == "mcp_approval_response":
            req = it.get("approval_request_id")
            approved = bool(it.get("approve"))
            events.append(CanonicalEvent(
                id=stable_id("item", iid, "approval"), kind=EventKind.TOOL_RESULT, tool_call_id=req,
                tool_name=request_names.get(req), result={"approved": approved, "reason": it.get("reason")},
                decision=Decision.ALLOWED if approved else Decision.BLOCKED,
                decision_reason=None if approved else (it.get("reason") or "MCP tool approval denied"), **common))
        elif t in ("mcp_list_tools", "item_reference"):
            continue
        elif t.endswith("_call"):
            args = it.get("action") or it.get("queries") or it.get("arguments") or {
                k: v for k, v in it.items() if k not in ("id", "type", "status", "results")}
            events.append(_tool_event(iid, common, t.removesuffix("_call"), t.removesuffix("_call"), parse_json(args),
                                      it.get("results") or it.get("output"), it.get("id"),
                                      Decision.FAILED if it.get("status") == "failed" else Decision.ALLOWED, None))
    return events
