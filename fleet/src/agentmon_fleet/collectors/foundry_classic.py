"""Classic Foundry Agent Service (assistants-style) run steps → CanonicalEvents."""
from __future__ import annotations

from typing import TYPE_CHECKING, Any

from ..models import CanonicalEvent, Decision, EventKind, Platform
from .base import parse_json, stable_id, to_dt
from .genai import detect_block, message_text

if TYPE_CHECKING:
    from .discovery import FoundryProject


def run_steps_to_events(proj: "FoundryProject", thread_id: str, run: dict[str, Any], steps: list[dict[str, Any]],
                        messages: list[dict[str, Any]]) -> list[CanonicalEvent]:
    base = dict(platform=Platform.FOUNDRY, source="foundry.classic", resource_id=proj.resource_id or proj.endpoint,
                agent_id=run.get("assistant_id"), agent_name=run.get("assistant_id"), session_id=thread_id,
                turn_id=run["id"], model=run.get("model"))
    events: list[CanonicalEvent] = []
    for m in messages:
        if m.get("run_id") not in (None, run["id"]):
            continue
        text = message_text(m).strip()
        if not text:
            continue
        kind = EventKind.USER_MESSAGE if m.get("role") == "user" else EventKind.ASSISTANT_MESSAGE
        events.append(CanonicalEvent(id=stable_id("cmsg", m["id"]), kind=kind, text=text,
                                     occurred_at=to_dt(m.get("created_at")), **base))
    for s in steps:
        details = s.get("step_details") or {}
        if details.get("type") != "tool_calls":
            continue
        step_err = (s.get("last_error") or {}).get("message")
        for tc in details.get("tool_calls") or []:
            ttype = tc.get("type", "tool")
            body = tc.get(ttype) if isinstance(tc.get(ttype), dict) else {}
            if ttype == "function":
                name, args, result = body.get("name"), parse_json(body.get("arguments")), body.get("output")
            elif ttype == "code_interpreter":
                name, args = "code_interpreter", body.get("input") or ""
                result = "\n".join(str(o.get("logs", "")) for o in body.get("outputs") or [] if isinstance(o, dict)) or None
            elif ttype == "mcp":
                name = f"{body.get('server_label', 'mcp')}.{body.get('name')}"
                args, result = parse_json(body.get("arguments")), body.get("output")
            elif ttype == "openapi":
                name, args, result = body.get("name") or "openapi", parse_json(body.get("arguments")), body.get("output")
            else:
                name, args, result = ttype, {k: v for k, v in body.items() if k != "output"}, body.get("output")
            block = detect_block(result, step_err)
            decision = Decision.BLOCKED if block else (Decision.FAILED if s.get("status") == "failed" else Decision.ALLOWED)
            events.append(CanonicalEvent(
                id=stable_id("cstep", s["id"], tc.get("id")), kind=EventKind.TOOL_CALL, tool_name=name, tool_type=ttype,
                tool_call_id=tc.get("id"), arguments=args, result=result, decision=decision, decision_reason=block,
                error=step_err, occurred_at=to_dt(s.get("created_at")), **base))
    if run.get("status") == "failed":
        err = (run.get("last_error") or {})
        block = detect_block(err.get("message"), err.get("code"))
        events.append(CanonicalEvent(id=stable_id("crun", run["id"]), kind=EventKind.ERROR,
                                     error=f"{err.get('code')}: {err.get('message')}",
                                     decision=Decision.BLOCKED if block else None, decision_reason=block,
                                     occurred_at=to_dt(run.get("failed_at") or run.get("created_at")), **base))
    return sorted(events, key=lambda e: e.occurred_at)
