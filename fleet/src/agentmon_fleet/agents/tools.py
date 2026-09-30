"""Tools the fleet's LLM agents use. All read paths return redacted, size-bounded JSON; the only write is
`propose_containment`, which records a *proposed* action that a human must approve."""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any

from agent_framework import tool
from pydantic import Field

from ..models import Severity, utcnow
from ..pipeline import Fleet

_MAX = 12000
_KQL_DENY = re.compile(r"(?i)(^\s*\.|\bexternaldata\b|\bexternal_table\b|\bevaluate\s+http_request|\bingest\b)")
CONTAINMENT = ("disable_agent_version", "revoke_connection", "enforce_session", "block_user", "tighten_charter",
               "rotate_credentials", "review_transcript")


def _j(v: Any) -> str:
    s = json.dumps(v, default=str, ensure_ascii=False)
    return s if len(s) <= _MAX else s[:_MAX] + '…"[truncated]"'


def _profile_brief(p) -> dict:
    return {"agent_key": p.agent_key, "name": p.name, "platform": p.platform.value, "purpose": p.purpose,
            "use_cases": [u.description for u in p.use_cases], "allowed": [c.value for c in p.allowed_capabilities],
            "forbidden": [c.value for c in p.forbidden_capabilities], "destinations": p.allowed_destinations,
            "enforce": p.enforce, "derived_by": p.derived_by}


class FleetTools:
    def __init__(self, fleet: Fleet) -> None:
        self.fleet = fleet
        self.state = fleet.state

    # Each method below is wrapped with @tool in `build()` so the closure keeps access to the fleet.
    def build(self) -> dict[str, Any]:
        st, fleet = self.state, self.fleet

        @tool(description="List monitored agents with their charter (purpose, use cases, allowed/forbidden capabilities).")
        def list_agents(platform: Annotated[str | None, Field(description="foundry | copilot_studio | azure_openai")] = None) -> str:
            return _j([_profile_brief(p) for p in st.list_profiles() if not platform or p.platform.value == platform])

        @tool(description="Get the full charter of one agent by name or agent_key.")
        def get_charter(agent: str) -> str:
            for p in st.list_profiles():
                if agent.lower() in (p.name.lower(), p.agent_key.lower(), (p.agent_id or "").lower()):
                    return _j({**_profile_brief(p), "instructions_excerpt": p.instructions[:1500],
                               "tools": p.tools[:30], "out_of_scope": p.out_of_scope})
            return "not found"

        @tool(description="List recent fleet alerts, newest first, optionally filtered.")
        def list_alerts(severity_at_least: Annotated[str, Field(description="informational|low|medium|high|critical")] = "low",
                        agent: str | None = None, session_id: str | None = None, alert_type: str | None = None,
                        hours: int = 72, limit: int = 40) -> str:
            since = utcnow() - timedelta(hours=hours)
            floor = Severity(severity_at_least).rank
            out = []
            for a in st.all_alerts(2000):
                if a.created_at < since or a.severity.rank < floor:
                    continue
                if agent and agent.lower() not in ((a.agent_name or "") + (a.agent_id or "")).lower():
                    continue
                if session_id and a.session_id != session_id:
                    continue
                if alert_type and a.alert_type != alert_type:
                    continue
                out.append({"id": a.alert_id, "type": a.alert_type, "severity": a.severity.value, "score": a.score,
                            "agent": a.agent_name or a.agent_id, "session": a.session_id, "at": a.created_at.isoformat(),
                            "summary": a.summary[:400], "incident": a.incident_id})
                if len(out) >= limit:
                    break
            return _j(out)

        @tool(description="Get a session: intent ledger (goal, use case, scope, drift, taint) and redacted event timeline.")
        def get_session(session_id: str, max_events: int = 60) -> str:
            ledger = st.get_session(session_id)
            events = st.session_events(session_id, limit=max_events)
            timeline = [{"at": e.occurred_at.isoformat(), "kind": e.kind.value, "decision": e.decision,
                         "action": e.action_text(600) if e.kind.value != "user_message" else f"user: {(e.text or '')[:600]}",
                         "reason": e.decision_reason} for e in events]
            return _j({"ledger": ledger, "timeline": timeline})

        @tool(description="List blocked/refused actions recorded in a session (the denial ledger used for workaround detection).")
        def get_denials(session_id: str) -> str:
            rows = st._exec("SELECT occurred_at, actor, action_text, reason, source FROM denials WHERE session_id=? "
                            "ORDER BY occurred_at", (session_id,)).fetchall()
            return _j([dict(r) for r in rows])

        @tool(description="List incidents raised by the fleet.")
        def list_incidents(limit: int = 20) -> str:
            return _j([{k: i.get(k) for k in ("id", "title", "severity", "state", "session_id", "agent_names",
                                              "alert_types", "fused_score", "updated_at")} for i in st.list_incidents(limit)])

        @tool(description="Get one incident with its report and recommendations.")
        def get_incident(incident_id: str) -> str:
            return _j(st.get_incident(incident_id) or "not found")

        @tool(description="Direct model-inference inventory: which identities call which model resources, tokens, "
                          "whether they are registered agents.")
        def inference_inventory() -> str:
            inv = st.get_baseline("inference_inventory")
            rows = sorted(({"caller|resource": k, **v} for k, v in inv.items()), key=lambda r: -r.get("tokens", 0))
            return _j(rows[:60])

        @tool(description="Run a read-only KQL query against the monitoring Log Analytics workspace "
                          "(AzureDiagnostics, AzureActivity, AppDependencies, AppEvents, NTANetAnalytics, SecurityAlert, "
                          "AgentMonAlerts_CL...). Returns at most 50 rows.")
        def run_kql(query: str, hours: int = 24) -> str:
            if _KQL_DENY.search(query):
                return "rejected: management commands and external data are not allowed"
            if not fleet.settings.law_workspace_id:
                return "no workspace configured"
            from ..collectors.law import LogAnalyticsCollector
            law = LogAnalyticsCollector(fleet.settings)
            end = datetime.now(timezone.utc)
            try:
                rows = law.run_query(query.replace("{", "{{").replace("}", "}}"), end - timedelta(hours=hours), end)
            except Exception as exc:
                return f"query failed: {str(exc).splitlines()[0][:300]}"
            return _j(rows[:50])

        @tool(description="Propose a containment action on an incident. It is NOT executed: it is queued for human "
                          "approval in the governance dashboard.")
        def propose_containment(incident_id: str,
                                action: Annotated[str, Field(description="|".join(CONTAINMENT))],
                                target: str, rationale: str) -> str:
            if action not in CONTAINMENT:
                return f"invalid action; choose one of {CONTAINMENT}"
            inc = st.get_incident(incident_id)
            if not inc:
                return "incident not found"
            recs = inc.setdefault("recommendations", [])
            if not any(r["action"] == action and r["target"] == target for r in recs):
                recs.append({"action": action, "target": target, "rationale": rationale[:600], "status": "proposed"})
                inc["updated_at"] = utcnow().isoformat()
                st.put_incident(inc)
            return "proposed (awaiting human approval)"

        return {f.name: f for f in (list_agents, get_charter, list_alerts, get_session, get_denials, list_incidents,
                                    get_incident, inference_inventory, run_kql, propose_containment)}
