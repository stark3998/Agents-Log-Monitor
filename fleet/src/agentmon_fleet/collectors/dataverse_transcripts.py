"""Parse Copilot Studio conversation transcripts (Bot Framework activities + generative-orchestration plan events)."""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from ..models import CanonicalEvent, Decision, EventKind, Platform
from .base import parse_json, stable_id, to_dt
from .genai import detect_block


def _activities(content: Any) -> list[dict[str, Any]]:
    c = parse_json(content)
    if isinstance(c, dict):
        c = c.get("activities") or []
    return [a for a in c if isinstance(a, dict)] if isinstance(c, list) else []


def transcript_events(rows: list[dict[str, Any]], bot_names: dict[str, str], env_id: str | None) -> list[CanonicalEvent]:
    groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        groups[(r.get("name", ""), r.get("conversationstarttime", ""))].append(r)
    events: list[CanonicalEvent] = []
    for (name, _start), parts in groups.items():
        parts.sort(key=lambda r: (parse_json(r.get("metadata")) or {}).get("BatchId", 0))
        meta = parse_json(parts[0].get("metadata")) or {}
        bot_id = parts[0].get("_bot_conversationtranscriptid_value") or meta.get("BotId")
        conv_id = name.split("_")[0] if name else parts[0]["conversationtranscriptid"]
        acts: list[dict[str, Any]] = []
        for p in parts:
            acts.extend(_activities(p.get("content")))
        if any((a.get("value") or {}).get("isDesignMode") for a in acts if a.get("valueType") == "ConversationInfo"):
            continue  # test-pane conversations
        events.extend(parse_activities(acts, conv_id, bot_id, bot_names.get(bot_id or "", meta.get("BotName")), env_id,
                                       meta.get("AADTenantId")))
    return events


def parse_activities(acts: list[dict[str, Any]], conv_id: str, bot_id: str | None, bot_name: str | None,
                     env_id: str | None, tenant: str | None) -> list[CanonicalEvent]:
    base = dict(platform=Platform.COPILOT_STUDIO, source="dataverse.transcripts", agent_id=bot_id, agent_name=bot_name,
                session_id=conv_id, resource_id=env_id, tenant_id=tenant)
    out: list[CanonicalEvent] = []
    steps: dict[str, dict[str, Any]] = {}
    user_id = next((a.get("from", {}).get("aadObjectId") or a.get("from", {}).get("id") for a in acts
                    if a.get("type") == "message" and a.get("from", {}).get("role") == 1), None)
    base["user_id"] = user_id
    for i, a in enumerate(acts):
        kind = a.get("valueType") or a.get("name") or ""
        v = a.get("value") if isinstance(a.get("value"), dict) else {}
        when = to_dt(a.get("timestamp") or 0)
        aid = a.get("id") or a.get("ID") or f"{conv_id}:{i}"
        if a.get("type") == "message" and a.get("text"):
            is_user = a.get("from", {}).get("role") == 1
            block = None if is_user else detect_block(a["text"])
            out.append(CanonicalEvent(id=stable_id("cs", conv_id, aid), occurred_at=when, text=a["text"],
                                      kind=EventKind.USER_MESSAGE if is_user else EventKind.ASSISTANT_MESSAGE,
                                      attributes={"refusal_or_block": block} if block else {}, **base))
        elif kind == "DynamicPlanReceived":
            out.append(CanonicalEvent(id=stable_id("cs", conv_id, aid), occurred_at=when, kind=EventKind.PLAN,
                                      text=", ".join(map(str, v.get("steps") or [])), attributes={"plan": v}, **base))
        elif kind == "DynamicPlanStepTriggered":
            key = f"{v.get('planIdentifier')}:{v.get('taskDialogId')}:{v.get('stepId', '')}"
            steps[key] = {"tool": v.get("taskDialogId"), "thought": v.get("thought"), "when": when, "aid": aid,
                          "args": None, "result": None, "state": None, "error": None, "plan": v.get("planIdentifier"),
                          "step": v.get("stepId")}
        elif kind == "DynamicPlanStepBindUpdate":
            st = _match(steps, v)
            if st is not None:
                st["args"] = v.get("arguments")
        elif kind == "DynamicPlanStepFinished":
            st = _match(steps, v)
            if st is not None:
                st["state"] = v.get("state")
                st["result"] = v.get("observation") or v.get("planUsedOutputs")
                st["error"] = v.get("error") or v.get("exception")
        elif kind in ("ErrorTraceData", "OnErrorLog") or (a.get("type") == "trace" and "error" in kind.lower()):
            out.append(CanonicalEvent(id=stable_id("cs", conv_id, aid), occurred_at=when, kind=EventKind.ERROR,
                                      error=str(v or a.get("text"))[:2000], **base))
    for key, st in steps.items():
        block = detect_block(st["error"], st["result"], st["state"])
        failed = str(st["state"] or "").lower() in ("failed", "faulted", "error", "cancelled", "blocked")
        out.append(CanonicalEvent(
            id=stable_id("cs-step", conv_id, key, st["aid"]), occurred_at=st["when"], kind=EventKind.TOOL_CALL,
            tool_name=st["tool"], tool_type=_tool_type(st["tool"]), arguments=st["args"], result=st["result"],
            tool_call_id=f"{st['plan']}:{st['step']}" if st.get("step") else None,
            thought=st["thought"], decision=Decision.BLOCKED if block else (Decision.FAILED if failed else Decision.ALLOWED),
            decision_reason=block, error=str(st["error"])[:1000] if st["error"] else None,
            attributes={"plan_id": st["plan"]}, **base))
    return sorted(out, key=lambda e: e.occurred_at)


def _match(steps: dict[str, dict[str, Any]], v: dict[str, Any]) -> dict[str, Any] | None:
    tid, plan = v.get("taskDialogId"), v.get("planIdentifier")
    for key in reversed(list(steps)):
        st = steps[key]
        if st["tool"] == tid and (plan is None or st["plan"] in (None, plan)) and st["state"] is None:
            return st
    return None


def _tool_type(schema: str | None) -> str:
    s = (schema or "").lower()
    for marker, t in ((".action.", "action"), (".topic.", "topic"), ("mcp", "mcp"), ("flow", "flow"),
                      ("knowledge", "knowledge"), ("search", "search")):
        if marker in s:
            return t
    return "action"