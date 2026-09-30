"""Log Analytics collector: inference diagnostics, GenAI traces, Copilot Studio telemetry, activity, network, Defender."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import Any, Callable

from azure.monitor.query import LogsQueryClient, LogsQueryStatus

from ..auth import credential
from ..config import Settings
from ..models import CanonicalEvent, Decision, EventKind, Platform
from ..state import State
from . import law_queries as Q
from .base import CollectResult, parse_json, stable_id, to_dt, window
from .genai import assistant_text, detect_block, last_user_text, tool_calls_in

log = logging.getLogger(__name__)
Row = dict[str, Any]


class LogAnalyticsCollector:
    name = "law"

    def __init__(self, settings: Settings, client: LogsQueryClient | None = None) -> None:
        self.settings = settings
        self.client = client or LogsQueryClient(credential())
        self.queries: list[tuple[str, str, Callable[[Row], list[CanonicalEvent]]]] = [
            ("inference", Q.INFERENCE, self._inference),
            ("genai_spans", Q.GENAI_SPANS, self._span),
            ("cs_events", Q.CS_EVENTS, self._cs_event),
            ("activity", Q.ACTIVITY, self._activity),
            ("network", Q.NETWORK, self._network),
            ("defender", Q.DEFENDER, self._defender),
        ]

    def run_query(self, kql: str, start: datetime, end: datetime) -> list[Row]:
        text = kql.format(start=start.isoformat(), end=end.isoformat())
        resp = self.client.query_workspace(self.settings.law_workspace_id, text,
                                           timespan=(start - timedelta(minutes=15), end), server_timeout=180)
        tables = resp.tables if resp.status == LogsQueryStatus.SUCCESS else resp.partial_data  # type: ignore[union-attr]
        rows: list[Row] = []
        for t in tables or []:
            cols = [c if isinstance(c, str) else getattr(c, "name", str(c)) for c in t.columns]
            rows.extend(dict(zip(cols, r)) for r in t.rows)
        return rows

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        if not self.settings.law_workspace_id:
            return out
        for name, kql, mapper in self.queries:
            key = f"law.{name}"
            start, end = window(state, key, self.settings.lookback_minutes, self.settings.overlap_minutes)
            try:
                rows = self.run_query(kql, start, end)
            except Exception as exc:
                msg = str(exc).split("\n")[0][:300]
                if any(s in str(exc) for s in ("Failed to resolve table", "SEM0100", "SemanticError")):
                    log.debug("%s: table not present yet", key)
                else:
                    out.errors.append(f"{key}: {msg}")
                continue
            for r in rows:
                try:
                    out.events.extend(mapper(r))
                except Exception as exc:  # keep going on malformed rows
                    log.debug("map error %s: %s", key, exc)
            state.set_cursor(key, end.isoformat())
        return out

    # ── mappers ─────────────────────────────────────────────────────────────
    def _inference(self, r: Row) -> list[CanonicalEvent]:
        caller = r.get("objectId") or r.get("callerObjectId") or None
        status = str(r.get("ResultSignature") or "")
        op = str(r.get("OperationName", ""))
        decision, reason = None, None
        if status == "400" and "filter" in op.lower():
            decision, reason = Decision.BLOCKED, "content_filter"
        elif status in ("401", "403"):
            decision, reason = Decision.BLOCKED, f"access denied ({status})"
        if r.get("Category") == "Audit":
            # Data-plane audit on the account (e.g. ListKey) is a control-plane signal, not inference.
            return [CanonicalEvent(
                id=stable_id("aud", r.get("CorrelationId"), r.get("TimeGenerated"), op, caller),
                platform=Platform.AZURE_CONTROL_PLANE, source="law.audit", kind=EventKind.CONTROL_PLANE,
                occurred_at=to_dt(r["TimeGenerated"]), resource_id=r.get("ResourceId"), caller_object_id=caller,
                caller_ip=r.get("CallerIPAddress") or None, tool_name=op, status=status or None,
                decision=Decision.ALLOWED, attributes={"category": "Audit", "resource": r.get("Resource")})]
        return [CanonicalEvent(
            id=stable_id("inf", r.get("CorrelationId"), r.get("Category"), r.get("TimeGenerated"), op),
            platform=Platform.AZURE_OPENAI, source="law.inference", kind=EventKind.INFERENCE, decision_reason=reason,
            occurred_at=to_dt(r["TimeGenerated"]), resource_id=r.get("ResourceId"),
            caller_object_id=caller, caller_ip=r.get("CallerIPAddress") or None,
            model=r.get("deployment") or r.get("model") or None,
            tokens_in=r.get("promptTokens"), tokens_out=r.get("completionTokens"), status=status or None,
            decision=decision,
            attributes={"category": r.get("Category"), "operation": op, "api": r.get("apiName"),
                        "duration_ms": r.get("DurationMs"), "correlation_id": r.get("CorrelationId"),
                        "stream": r.get("streamType"), "resource": r.get("Resource"),
                        "cached_tokens": r.get("cachedTokens"), "request_bytes": r.get("requestLength"),
                        "response_bytes": r.get("responseLength")},
        )]

    def _span(self, r: Row) -> list[CanonicalEvent]:
        p = parse_json(r.get("Properties")) or {}
        op = str(p.get("gen_ai.operation.name") or r.get("Name") or "").lower()
        is_cs = "A365ObservabilitySDK" in str(p.get("telemetry.sdk.name", "")) or r.get("Name") in (
            "InvokeAgent", "ExecuteTool", "OutputMessages")
        platform = Platform.COPILOT_STUDIO if is_cs else Platform.FOUNDRY

        def content(col: str, attr: str) -> Any:
            v = r.get(col)
            return parse_json(v) if v not in (None, "") else parse_json(p.get(attr))

        base = dict(
            platform=platform, source="law.genai", occurred_at=to_dt(r["TimeGenerated"]),
            resource_id=r.get("_ResourceId"), agent_id=p.get("gen_ai.agent.id") or None,
            agent_name=p.get("gen_ai.agent.name") or r.get("AppRoleName") or None,
            agent_version=p.get("gen_ai.agent.version"), session_id=p.get("gen_ai.conversation.id") or r.get("TraceId"),
            turn_id=r.get("TraceId"), user_id=p.get("user.id") or p.get("user.email") or p.get("enduser.id"),
            model=p.get("gen_ai.request.model") or p.get("gen_ai.response.model"),
            trace_id=r.get("TraceId"), span_id=r.get("SpanId"),
            tenant_id=p.get("microsoft.tenant.id"),
        )
        events: list[CanonicalEvent] = []
        sid = r.get("SpanId")
        if op in ("execute_tool", "executetool"):
            args = content("ToolCallArguments", "gen_ai.tool.call.arguments")
            result = content("ToolCallResult", "gen_ai.tool.call.result")
            ok = r.get("Success") not in (False, "False", "false", 0)
            block = detect_block(result, p.get("error.type"), p.get("error.message"))
            events.append(CanonicalEvent(
                id=stable_id("span", sid), kind=EventKind.TOOL_CALL, tool_name=p.get("gen_ai.tool.name"),
                tool_type=p.get("gen_ai.tool.type"), tool_call_id=p.get("gen_ai.tool.call.id"), arguments=args,
                result=result, status="success" if ok else "error",
                decision=Decision.BLOCKED if block else (Decision.ALLOWED if ok else Decision.FAILED),
                decision_reason=block, error=None if ok else str(p.get("error.type") or r.get("ResultCode")),
                attributes={"tool_description": p.get("gen_ai.tool.description")}, **base))
        elif op in ("invoke_agent", "invokeagent", "chat", "text_completion", "generate_content", "outputmessages"):
            inp = content("InputMessages", "gen_ai.input.messages")
            outp = content("OutputMessages", "gen_ai.output.messages")
            instr = content("SystemInstructions", "gen_ai.system_instructions")
            user = last_user_text(inp)
            if user and op != "chat":
                events.append(CanonicalEvent(id=stable_id("span-user", r.get("TraceId"), user[:200]),
                                             kind=EventKind.USER_MESSAGE, text=user, **base))
            said = assistant_text(outp)
            if said:
                events.append(CanonicalEvent(id=stable_id("span-out", sid), kind=EventKind.ASSISTANT_MESSAGE, text=said,
                                             attributes={"system_instructions": instr} if instr else {}, **base))
            for i, tc in enumerate(tool_calls_in(outp)):
                if op == "chat":  # client-side instrumentation: tool requested by the model
                    events.append(CanonicalEvent(id=stable_id("span-tc", sid, i), kind=EventKind.TOOL_CALL,
                                                 tool_name=tc["name"], tool_call_id=tc["id"], arguments=tc["arguments"],
                                                 decision=Decision.PENDING, **base))
            if op == "chat":
                events.append(CanonicalEvent(
                    id=stable_id("span-inf", sid), kind=EventKind.INFERENCE,
                    tokens_in=_int(p.get("gen_ai.usage.input_tokens")), tokens_out=_int(p.get("gen_ai.usage.output_tokens")),
                    **base))
        return events

    def _cs_event(self, r: Row) -> list[CanonicalEvent]:
        p = parse_json(r.get("Properties")) or {}
        if str(p.get("designMode", "")).lower() == "true":
            return []
        name = r.get("Name")
        conv = p.get("conversationId") or r.get("SessionId")
        base = dict(platform=Platform.COPILOT_STUDIO, source="law.cs_events", occurred_at=to_dt(r["TimeGenerated"]),
                    resource_id=r.get("_ResourceId"), agent_id=p.get("botId") or p.get("BotId") or r.get("AppRoleName"),
                    agent_name=p.get("botName") or p.get("BotName") or r.get("AppRoleName"), session_id=conv,
                    user_id=p.get("fromId") if name == "BotMessageReceived" else (p.get("recipientId") or r.get("UserId")),
                    attributes={"event": name, "topic": p.get("TopicName"), "kind": p.get("Kind"), "channel": p.get("channelId")})
        eid = stable_id("cs", conv, name, r.get("TimeGenerated"), p.get("text", "")[:80] if p.get("text") else p.get("TopicName"))
        text = p.get("text") or p.get("Message") or p.get("Summary")
        if name == "BotMessageReceived":
            return [CanonicalEvent(id=eid, kind=EventKind.USER_MESSAGE, text=text, **base)]
        if name in ("BotMessageSend", "GenerativeAnswers"):
            block = detect_block(text)
            return [CanonicalEvent(id=eid, kind=EventKind.ASSISTANT_MESSAGE, text=text,
                                   decision=Decision.BLOCKED if block else None, decision_reason=block, **base)]
        if name == "TopicAction" and p.get("Kind") in ("InvokeFlowAction", "InvokeConnectorAction", "HttpRequestAction",
                                                        "InvokeSkillAction", "InvokeAIBuilderModelAction"):
            return [CanonicalEvent(id=eid, kind=EventKind.TOOL_CALL, tool_name=p.get("ActionId") or p.get("Kind"),
                                   tool_type=p.get("Kind"), arguments={k: v for k, v in p.items() if k not in ("text",)}, **base)]
        if name == "OnErrorLog":
            return [CanonicalEvent(id=eid, kind=EventKind.ERROR, error=str(p.get("ErrorMessage") or p)[:2000], **base)]
        return []

    def _activity(self, r: Row) -> list[CanonicalEvent]:
        claims = parse_json(r.get("Claims_d")) or {}
        oid = claims.get("http://schemas.microsoft.com/identity/claims/objectidentifier") if isinstance(claims, dict) else None
        return [CanonicalEvent(
            id=stable_id("act", r.get("CorrelationId"), r.get("OperationNameValue"), r.get("ResourceId"), r.get("TimeGenerated")),
            platform=Platform.AZURE_CONTROL_PLANE, source="law.activity", kind=EventKind.CONTROL_PLANE,
            occurred_at=to_dt(r["TimeGenerated"]), resource_id=r.get("ResourceId"), caller_object_id=oid,
            user_id=r.get("Caller"), caller_ip=r.get("CallerIpAddress"), tool_name=r.get("OperationNameValue"),
            status=r.get("ActivityStatusValue"),
            decision=Decision.BLOCKED if "fail" in str(r.get("ActivityStatusValue", "")).lower() else Decision.ALLOWED,
            attributes={"correlation_id": r.get("CorrelationId")})]

    def _network(self, r: Row) -> list[CanonicalEvent]:
        statuses = {str(s).lower()[:1] for s in (parse_json(r.get("Statuses")) or [])}  # "Allowed"/"Denied" or "A"/"D"
        direction = str(r.get("FlowDirection") or "").lower()
        return [CanonicalEvent(
            id=stable_id("net", r.get("SrcIp"), r.get("DestIp"), r.get("DestPort"), direction, r.get("TimeGenerated")),
            platform=Platform.NETWORK, source="law.network", kind=EventKind.NETWORK_FLOW,
            occurred_at=to_dt(r["TimeGenerated"]), resource_id=r.get("TargetResourceId"), src_ip=r.get("SrcIp") or None,
            dest_ip=r.get("DestIp") or None, dest_port=_int(r.get("DestPort")), bytes_out=_int(r.get("Bytes")),
            decision=Decision.BLOCKED if "d" in statuses and "a" not in statuses else Decision.ALLOWED,
            attributes={"flow_type": r.get("FlowType"), "direction": direction or None, "l7": r.get("L7Protocol"),
                        "subnet": r.get("SrcSubnet") if direction != "inbound" else r.get("DestSubnet"),
                        "flows": r.get("Flows"), "country": r.get("Country")})]

    def _defender(self, r: Row) -> list[CanonicalEvent]:
        return [CanonicalEvent(
            id=stable_id("mdc", r.get("SystemAlertId")), platform=Platform.FOUNDRY, source="law.defender",
            kind=EventKind.POLICY_DECISION, occurred_at=to_dt(r["TimeGenerated"]), resource_id=r.get("ResourceId"),
            text=r.get("Description"), tool_name=r.get("AlertType"), decision=Decision.BLOCKED
            if "Blocked" in str(r.get("AlertType")) else None,
            attributes={"defender_alert": r.get("AlertName"), "severity": r.get("AlertSeverity"),
                        "entity": r.get("CompromisedEntity"), "extended": parse_json(r.get("ExtendedProperties"))})]


def _int(v: Any) -> int | None:
    try:
        return int(float(v)) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None
