from __future__ import annotations

import asyncio
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

from .af_adapter import AgentRunner, default_runner
from .config import Settings
from .models import Decision
from .monitor_client import MonitorClient
from .tools import GUARDIAN_SELF_LANE_ID, guardian_allowed_tools


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _host_from_decision(d: Decision) -> str | None:
    meta = d.meta or {}
    for value in (meta.get("domain"), meta.get("host"), d.reason):
        if not isinstance(value, str):
            continue
        match = re.search(r"(?:https?://)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|169\.254\.169\.254)", value)
        if match:
            return match.group(1).lower()
    return None


@dataclass(frozen=True)
class GuardianTrigger:
    trigger: str
    severity: str
    confidence: float
    title: str
    agent_ids: list[str] = field(default_factory=list)
    session_ids: list[str] = field(default_factory=list)
    decision_ids: list[str] = field(default_factory=list)
    summary: str = ""


def detect_guardian_triggers(decisions: list[dict[str, Any]], now: datetime | None = None) -> list[GuardianTrigger]:
    parsed = [Decision.model_validate(d) for d in decisions]
    if not parsed:
        return []
    now = now or max(_parse_ts(d.createdAt) for d in parsed)
    ten_min = now - timedelta(minutes=10)
    recent = [d for d in parsed if _parse_ts(d.createdAt) >= ten_min]
    out: list[GuardianTrigger] = []

    by_agent_denies: dict[str, list[Decision]] = defaultdict(list)
    by_agent_would: dict[str, list[Decision]] = defaultdict(list)
    for d in recent:
        eff = d.effectiveVerdict or d.verdict
        if eff == "deny" or d.verdict == "deny":
            by_agent_denies[d.agentId].append(d)
        if d.wouldDeny and d.mode == "observe":
            by_agent_would[d.agentId].append(d)
        if d.tainted and eff == "deny":
            out.append(GuardianTrigger(
                trigger="taint_risky",
                severity="high",
                confidence=0.8,
                title=f"Deny after tainted session for {d.agentId}",
                agent_ids=[d.agentId],
                session_ids=[d.sessionId],
                decision_ids=[d.id],
                summary=d.reason,
            ))
        if d.stage in {"kill_switch", "limits"}:
            out.append(GuardianTrigger(
                trigger=d.stage,
                severity="critical" if d.stage == "kill_switch" else "high",
                confidence=0.9,
                title=f"{d.stage} decision for {d.agentId}",
                agent_ids=[d.agentId],
                session_ids=[d.sessionId],
                decision_ids=[d.id],
                summary=d.reason,
            ))

    for agent_id, ds in by_agent_denies.items():
        if len(ds) >= 5:
            out.append(GuardianTrigger(
                trigger="deny_burst",
                severity="high",
                confidence=0.85,
                title=f"Burst of denied actions for {agent_id}",
                agent_ids=[agent_id],
                session_ids=sorted({d.sessionId for d in ds}),
                decision_ids=[d.id for d in ds],
                summary=f"{len(ds)} denies in 10 minutes",
            ))

    for agent_id, ds in by_agent_would.items():
        if len(ds) >= 5:
            out.append(GuardianTrigger(
                trigger="lane_gap",
                severity="medium",
                confidence=0.75,
                title=f"Repeated observe-mode would-deny for {agent_id}",
                agent_ids=[agent_id],
                session_ids=sorted({d.sessionId for d in ds}),
                decision_ids=[d.id for d in ds],
                summary=f"{len(ds)} would-deny decisions in observe mode",
            ))

    by_host: dict[str, list[Decision]] = defaultdict(list)
    for d in recent:
        host = _host_from_decision(d)
        if host:
            by_host[host].append(d)
    for host, ds in by_host.items():
        agents = sorted({d.agentId for d in ds})
        if len(agents) >= 3:
            out.append(GuardianTrigger(
                trigger="coordination_host",
                severity="high",
                confidence=0.7,
                title=f"Multiple agents contacted {host}",
                agent_ids=agents,
                session_ids=sorted({d.sessionId for d in ds}),
                decision_ids=[d.id for d in ds],
                summary=f"{len(agents)} agents referenced {host} in 10 minutes",
            ))
    return out


GUARDIAN_INSTRUCTIONS = """You are Guardian, an investigator for an AI-agent governance platform.
Use the monitor MCP tools to inspect sessions, decisions, lanes and incidents. Produce a concise
Markdown report with sections: timeline, scope, likely cause, recommendations, and containment.
Do not modify the lane id monitor-guardian. Activation of proposed lanes is always human-owned."""


class GuardianService:
    def __init__(self, settings: Settings, monitor: MonitorClient, runner: AgentRunner | None = None) -> None:
        self.settings = settings
        self.monitor = monitor
        self.runner = runner or default_runner(settings)
        self._cursor: str | None = None
        self._stop = asyncio.Event()

    async def run_once(self) -> list[dict[str, Any]]:
        page = await self.monitor.list_decisions(cursor=self._cursor, limit=500)
        self._cursor = page.get("cursor") or self._cursor
        triggers = detect_guardian_triggers(page.get("items", []))
        incidents: list[dict[str, Any]] = []
        for trigger in triggers:
            incidents.append(await self.investigate_trigger(trigger))
        return incidents

    async def loop(self) -> None:
        while not self._stop.is_set():
            try:
                await self.run_once()
            except Exception:
                # Keep the background investigator alive; request handlers surface errors normally.
                pass
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.settings.guardian_poll_seconds)
            except TimeoutError:
                continue

    def stop(self) -> None:
        self._stop.set()

    async def investigate_trigger(self, trigger: GuardianTrigger) -> dict[str, Any]:
        incident = await self.monitor.create_incident({
            "title": trigger.title,
            "severity": trigger.severity,
            "state": "investigating",
            "trigger": trigger.trigger,
            "agentIds": trigger.agent_ids,
            "sessionIds": trigger.session_ids,
            "decisionIds": trigger.decision_ids,
            "summary": trigger.summary,
        })
        return await self.investigate_incident(incident)

    async def investigate_incident(self, incident: dict[str, Any]) -> dict[str, Any]:
        if incident.get("laneId") == GUARDIAN_SELF_LANE_ID:
            raise ValueError("Guardian cannot investigate by modifying monitor-guardian")
        prompt = (
            "Investigate this governance incident using only the allowed tools.\n"
            f"Authority mode: {self.settings.guardian_authority}\n"
            f"Incident JSON:\n{incident}\n"
            "Return only the Markdown report."
        )
        tools = guardian_allowed_tools(self.settings.guardian_authority)
        report = await self.runner.run(
            prompt,
            model=self.settings.guardian_deployment,
            instructions=GUARDIAN_INSTRUCTIONS,
            tools=tools,
        )
        patch: dict[str, Any] = {"report": report, "state": "investigating"}
        if self.settings.guardian_authority in {"contain", "autonomous"} and incident.get("severity") in {"high", "critical"}:
            patch["summary"] = "Guardian investigation completed; review containment recommendations."
        return await self.monitor.patch_incident(incident["id"], patch)

    async def investigate_request(self, body: dict[str, Any]) -> dict[str, Any]:
        if body.get("incidentId"):
            return await self.investigate_incident(await self.monitor.get_incident(body["incidentId"]))
        trigger = GuardianTrigger(
            trigger=body.get("trigger") or "manual",
            severity=body.get("severity") or "medium",
            confidence=body.get("confidence") or 1.0,
            title=body.get("title") or "Manual Guardian investigation",
            agent_ids=body.get("agentIds") or [],
            session_ids=body.get("sessionIds") or [],
            decision_ids=body.get("decisionIds") or [],
            summary=body.get("summary") or "",
        )
        return await self.investigate_trigger(trigger)
