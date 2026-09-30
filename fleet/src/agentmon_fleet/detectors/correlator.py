"""Correlator / Incident Commander: fuses per-session alerts, escalates, and writes incident narratives."""
from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

from pydantic import BaseModel, Field

from ..llm import untrusted
from ..models import Alert, CanonicalEvent, EventKind, Severity, utcnow
from .base import Context, make_alert

log = logging.getLogger(__name__)
SEVERITY_TS = {"informational": "info", "low": "low", "medium": "medium", "high": "high", "critical": "critical"}
INCIDENT_MIN_FUSED = 65.0
ESCALATION_MIN_TYPES = 2


class Recommendation(BaseModel):
    action: Literal["disable_agent_version", "revoke_connection", "enforce_session", "block_user", "tighten_charter",
                    "rotate_credentials", "review_transcript", "no_action"]
    target: str
    rationale: str


class IncidentNarrative(BaseModel):
    title: str = Field(description="Short incident title (<= 90 chars)")
    summary: str = Field(description="2-4 sentence executive summary")
    report_markdown: str = Field(description="Investigation report: timeline, what the agent/user did, why it matters, "
                                            "confidence and open questions")
    recommendations: list[Recommendation]


COMMANDER_SYSTEM = """You are the Incident Commander of an AI-agent security monitoring fleet. You receive the alerts
raised in one agent session, the agent's charter, the session intent ledger and a redacted event timeline. Write a
precise, evidence-based incident report for a SOC analyst. Distinguish what is confirmed from what is suspected.
Recommend containment actions only when justified; every containment action requires human approval."""


def fuse(scores: list[float]) -> float:
    p = 1.0
    for s in scores:
        p *= 1 - min(max(s, 0.0), 99.0) / 100
    return round((1 - p) * 100, 1)


def fuse_alerts(alerts: list[Alert]) -> float:
    """Noisy-OR over the strongest alert of each type: many copies of one weak signal must not add up to critical."""
    best: dict[str, float] = {}
    for a in alerts:
        best[a.alert_type] = max(best.get(a.alert_type, 0.0), a.score)
    return fuse(list(best.values()))


def _group_key(a: Alert) -> str:
    if a.session_id:
        return f"s:{a.session_id}"
    who = a.agent_id or a.agent_name or str(a.evidence.get("caller") or "none")
    return f"a:{a.platform}:{who.lower()}:{a.created_at.strftime('%Y-%m-%d')}"


class Correlator:
    name = "incident_commander"

    def __init__(self) -> None:
        self._pending: list[tuple[dict, list[Alert]]] = []

    def correlate(self, new_alerts: list[Alert], ctx: Context) -> tuple[list[Alert], list[dict]]:
        """Returns (escalation alerts, created/updated incidents)."""
        groups: dict[str, list[Alert]] = defaultdict(list)
        for a in new_alerts:
            groups[_group_key(a)].append(a)
        escalations: list[Alert] = []
        incidents: list[dict] = []
        for key, fresh in groups.items():
            session_id = fresh[0].session_id
            history = ctx.state.session_alerts(session_id) if session_id else []
            by_fp = {a.fingerprint: a for a in history + fresh}
            alerts = [a for a in by_fp.values() if a.alert_type != "SESSION_RISK_ESCALATION"]
            types = {a.alert_type for a in alerts}
            fused = fuse_alerts(alerts)
            top = max(alerts, key=lambda a: a.score)
            if len(types) >= ESCALATION_MIN_TYPES and fused >= 70:
                esc = make_alert(
                    "SESSION_RISK_ESCALATION", self.name, None, fused,
                    f"{len(alerts)} alerts of {len(types)} types in one session ({', '.join(sorted(types))}); "
                    f"fused risk {fused}.",
                    {"alert_types": sorted(types), "alert_ids": [a.alert_id for a in alerts], "fused": fused,
                     "fingerprint_basis": f"esc|{key}|{len(types)}"}, platform=top.platform)
                esc.agent_id, esc.agent_name, esc.session_id, esc.user_id = (top.agent_id, top.agent_name, session_id,
                                                                             top.user_id)
                escalations.append(esc)
                alerts.append(esc)
            if fused < INCIDENT_MIN_FUSED and top.severity.rank < Severity.HIGH.rank:
                continue
            incidents.append(self._upsert_incident(key, session_id, alerts, fused, ctx))
        self._narrate_pending(ctx)
        return escalations, incidents

    def _narrate_pending(self, ctx: Context) -> None:
        """Incident narratives are independent LLM calls: prepare payloads here, run them concurrently, then save."""
        jobs, self._pending = self._pending, []
        prepared = [(inc, self._prepare(inc, alerts, ctx)) for inc, alerts in jobs]
        prepared = [(inc, p) for inc, p in prepared if p is not None]
        if not prepared:
            return

        def run(item: tuple[dict, tuple]) -> IncidentNarrative | None:
            _, (llm, payload) = item
            try:
                return llm.structured(COMMANDER_SYSTEM, untrusted(payload, 24000), IncidentNarrative, effort="medium")
            except Exception as exc:
                log.warning("incident narrative failed: %s", exc)
                return None

        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(run, prepared))
        for (inc, _), n in zip(prepared, results):
            if n is None:
                continue
            inc.update(title=n.title[:120], summary=n.summary, report=n.report_markdown, narrated=True,
                       recommendations=[{**r.model_dump(), "status": "proposed"} for r in n.recommendations
                                        if r.action != "no_action"])
            ctx.state.put_incident(inc)

    def _upsert_incident(self, key: str, session_id: str | None, alerts: list[Alert], fused: float,
                         ctx: Context) -> dict:
        existing = ctx.state.incident_for_session(session_id) if session_id else None
        inc_id = existing["id"] if existing else "fleet-" + hashlib.sha256(key.encode()).hexdigest()[:12]
        existing = existing or ctx.state.get_incident(inc_id)
        top = max(alerts, key=lambda a: a.score)
        sev = Severity.from_score(fused)
        if top.severity.rank > sev.rank:
            sev = top.severity
        now = utcnow().isoformat()
        inc = dict(existing or {"id": inc_id, "state": "open", "created_at": now, "recommendations": []})
        prev_sev = inc.get("severity")
        inc.update(
            session_id=session_id, agent_key=f"{top.platform}:{top.agent_id or top.agent_name}", platform=top.platform.value,
            agent_ids=sorted({a.agent_id or a.agent_name or "" for a in alerts} - {""}),
            agent_names=sorted({a.agent_name or "" for a in alerts} - {""}),
            user_ids=sorted({a.user_id or "" for a in alerts} - {""}),
            alert_ids=[a.alert_id for a in alerts], alert_types=sorted({a.alert_type for a in alerts}),
            severity=sev.value, fused_score=fused, trigger=top.alert_type.lower(),
            owasp_llm=sorted({x for a in alerts for x in a.owasp_llm}),
            owasp_agentic=sorted({x for a in alerts for x in a.owasp_agentic}),
            mitre_atlas=sorted({x for a in alerts for x in a.mitre_atlas}), updated_at=now)
        inc.setdefault("title", f"{top.title} - {top.agent_name or top.agent_id or top.evidence.get('caller') or 'unknown'}")
        inc.setdefault("summary", top.summary)
        needs_narrative = not inc.get("narrated") or (prev_sev and Severity(prev_sev).rank < sev.rank)
        if needs_narrative and not ctx.realtime:
            self._pending.append((inc, alerts))
        for a in alerts:
            a.incident_id = inc_id
        ctx.state.put_incident(inc)
        return inc

    def _prepare(self, inc: dict, alerts: list[Alert], ctx: Context) -> tuple | None:
        llm = ctx.take_llm()
        if not llm:
            return None
        session_id = inc.get("session_id")
        events: list[CanonicalEvent] = ctx.state.session_events(session_id, limit=60) if session_id else []
        prof = ctx.profiles.get(inc["agent_key"]) or ctx.state.get_profile(inc["agent_key"])
        timeline = [{"at": e.occurred_at.isoformat(), "kind": e.kind.value, "decision": e.decision,
                     "action": e.action_text(500) if e.kind != EventKind.USER_MESSAGE else f"user: {(e.text or '')[:500]}"}
                    for e in events]
        payload = {
            "agent": {"name": prof.name, "purpose": prof.purpose, "use_cases": [u.description for u in prof.use_cases],
                      "forbidden": [c.value for c in prof.forbidden_capabilities]} if prof else inc.get("agent_names"),
            "intent_ledger": {k: v for k, v in ctx.state.get_session(session_id).items()
                              if k in ("goal", "matched_use_case", "scope", "drift", "taint", "jailbreak_attempts")}
            if session_id else {},
            "alerts": [{"type": a.alert_type, "severity": a.severity.value, "score": a.score, "summary": a.summary,
                        "at": a.created_at.isoformat()} for a in sorted(alerts, key=lambda x: x.created_at)][:30],
            "timeline": timeline}
        return llm, payload


def to_ts_incident(inc: dict) -> dict:
    """Shape a fleet incident for the TS governance API (POST/PATCH /api/gov/incidents)."""
    return {
        "id": inc["id"], "title": inc.get("title", "Fleet incident"),
        "severity": SEVERITY_TS.get(inc.get("severity", "medium"), "medium"), "state": inc.get("state", "open"),
        "trigger": f"fleet:{inc.get('trigger', 'alert')}", "agentIds": inc.get("agent_ids", []),
        "sessionIds": [inc["session_id"]] if inc.get("session_id") else [], "decisionIds": [],
        "summary": inc.get("summary"), "report": inc.get("report"),
        "recommendations": inc.get("recommendations", []),
        "fleet": {k: inc.get(k) for k in ("platform", "alert_ids", "alert_types", "fused_score", "owasp_llm",
                                          "owasp_agentic", "mitre_atlas", "user_ids", "agent_names")},
    }
