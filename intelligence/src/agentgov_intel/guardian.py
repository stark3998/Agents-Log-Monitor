from __future__ import annotations

import asyncio
import re
import time
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
End the report with exactly one line of the form `Severity: <low|medium|high|critical>` giving your
own assessment of the incident after investigating (ignore any severity pre-filled on the incident).
Do not modify the lane id monitor-guardian. Activation of proposed lanes is always human-owned."""

# Anchored to the dedicated `Severity: <level>` line so quoted incident dicts ('severity': 'high') don't match.
_REPORT_SEVERITY_RE = re.compile(
    r"^[\s>*_#-]*severity[*_]*\s*:[\s*_`]*(critical|high|medium|low|info(?:rmational)?)\b",
    re.IGNORECASE | re.MULTILINE,
)
_SEVERITY_TO_LABEL = {"info": "low", "informational": "low", "low": "low", "medium": "medium", "high": "high", "critical": "critical"}
_JEV_POST_TIMEOUT_S = 5.0


def guardian_baseline_severity(incident: dict[str, Any] | None, report: str | None = None) -> str | None:
    """Map the Guardian LLM's own assessment onto Jev's severity labels (low|medium|high|critical).

    Only the explicit ``Severity: <level>`` line the Guardian LLM is instructed to emit counts. The
    incident's ``severity`` field is NOT used: it is pre-filled by the heuristic trigger detector, so
    comparing Jev against it would mislabel a lookup table as the LLM baseline. ``info`` folds into
    ``low``. Returns ``None`` (not comparable) when the report has no severity line.
    """
    del incident  # kept for call-site compatibility; see docstring
    if report:
        matches = _REPORT_SEVERITY_RE.findall(report)
        if matches:
            return _SEVERITY_TO_LABEL.get(matches[-1].lower())
    return None


class GuardianService:
    def __init__(
        self,
        settings: Settings,
        monitor: MonitorClient,
        runner: AgentRunner | None = None,
        *,
        jev: Any | None = None,
    ) -> None:
        self.settings = settings
        self.monitor = monitor
        self.runner = runner or default_runner(settings)
        self._cursor: str | None = None
        self._stop = asyncio.Event()
        self._jev = jev
        self._shadow_tasks: set[asyncio.Task[Any]] = set()

    async def run_once(self) -> list[dict[str, Any]]:
        page = await self.monitor.list_decisions(cursor=self._cursor, limit=500)
        self._cursor = page.get("cursor") or self._cursor
        items = page.get("items", [])
        triggers = detect_guardian_triggers(items)
        incidents: list[dict[str, Any]] = []
        for trigger in triggers:
            incidents.append(await self.investigate_trigger(trigger, decisions=items))
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

    async def investigate_trigger(self, trigger: GuardianTrigger, decisions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        # Jev shadow triage starts now and runs concurrently with the Guardian LLM investigation.
        jev_task = self._start_jev_shadow(trigger, decisions)
        started = time.perf_counter()
        try:
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
            result = await self.investigate_incident(incident)
        except BaseException:
            if jev_task is not None:
                self._schedule_shadow_post(trigger, jev_task, None, time.perf_counter() - started, decisions)
            raise
        if jev_task is not None:
            self._schedule_shadow_post(trigger, jev_task, result, time.perf_counter() - started, decisions)
        return result

    # -- Jev shadow (never affects Guardian behaviour) -----------------------------------------
    def _jev_triager(self) -> Any | None:
        if not self.settings.jev_guardian_enabled:
            return None
        if self._jev is None:
            from .jev_triage import JevTriage

            self._jev = JevTriage(self.settings)
        return self._jev

    def _start_jev_shadow(self, trigger: GuardianTrigger, decisions: list[dict[str, Any]] | None) -> asyncio.Task[Any] | None:
        try:
            triager = self._jev_triager()
            if triager is None:
                return None
            return asyncio.create_task(self._run_jev(triager, trigger, decisions))
        except Exception:
            return None

    async def _run_jev(self, triager: Any, trigger: GuardianTrigger, decisions: list[dict[str, Any]] | None) -> Any:
        if decisions is None:
            # Manual investigations carry ids only; fetch at most the last 20 referenced decisions.
            fetched = await asyncio.gather(
                *(self.monitor.get_decision(i) for i in trigger.decision_ids[-20:]), return_exceptions=True
            )
            decisions = [d for d in fetched if isinstance(d, dict)]
        return await triager.triage(trigger, decisions)

    def _schedule_shadow_post(
        self,
        trigger: GuardianTrigger,
        jev_task: asyncio.Task[Any],
        result: dict[str, Any] | None,
        guardian_elapsed_s: float,
        decisions: list[dict[str, Any]] | None,
    ) -> None:
        try:
            task = asyncio.create_task(self._post_shadow(trigger, jev_task, result, guardian_elapsed_s, decisions))
            self._shadow_tasks.add(task)
            task.add_done_callback(self._shadow_tasks.discard)
        except Exception:
            jev_task.cancel()

    async def _post_shadow(
        self,
        trigger: GuardianTrigger,
        jev_task: asyncio.Task[Any],
        result: dict[str, Any] | None,
        guardian_elapsed_s: float,
        decisions: list[dict[str, Any]] | None,
    ) -> None:
        try:
            budget = self.settings.jev_timeout_ms / 1000.0 + 5.0
            jev = await asyncio.wait_for(jev_task, timeout=budget)
            record = build_guardian_shadow_record(self.settings, trigger, jev, result, guardian_elapsed_s, decisions)
            await self.monitor.post_jev_shadow(record, timeout=_JEV_POST_TIMEOUT_S)
        except asyncio.CancelledError:
            jev_task.cancel()
        except Exception:
            # Shadow mode: Jev / monitor failures are swallowed (no prompt/response logging).
            if not jev_task.done():
                jev_task.cancel()

    async def drain_shadow(self, timeout: float | None = None) -> None:
        """Wait for in-flight shadow posts (tests / graceful shutdown)."""
        pending = list(self._shadow_tasks)
        if pending:
            await asyncio.wait(pending, timeout=timeout)

    async def aclose(self) -> None:
        await self.drain_shadow(timeout=1.0)
        for task in list(self._shadow_tasks):
            task.cancel()
        if self._jev is not None and hasattr(self._jev, "aclose"):
            try:
                await self._jev.aclose()
            except Exception:
                pass

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


def build_guardian_shadow_record(
    settings: Settings,
    trigger: GuardianTrigger,
    jev: Any,
    result: dict[str, Any] | None,
    guardian_elapsed_s: float,
    decisions: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build the camelCase ``JevShadowInput`` body for ``POST /api/gov/jev/shadow``.

    ``baseline.verdict`` is the Guardian severity label (see :func:`guardian_baseline_severity`),
    ``'investigated'`` when Guardian finished but produced no severity, or ``'skipped'`` when the
    investigation failed. ``agree`` is present only when both sides produced a severity label.
    """
    baseline_sev = guardian_baseline_severity(result, (result or {}).get("report")) if result is not None else None
    baseline_verdict = baseline_sev or ("investigated" if result is not None else "skipped")
    lane_id: str | None = None
    if decisions:
        wanted = set(trigger.decision_ids)
        scoped = [d for d in decisions if d.get("id") in wanted] or decisions
        lanes = [str(d.get("laneId")) for d in scoped if d.get("laneId")]
        lane_id = max(set(lanes), key=lanes.count) if lanes else None

    signals = dict(getattr(jev, "signals", None) or {})
    if getattr(jev, "investigate", None) is not None:
        signals["investigate"] = 1 if jev.investigate else 0
    try:
        from .jev_triage import TRIAGE_QUESTIONS_VERSION

        signals["questions_version"] = TRIAGE_QUESTIONS_VERSION
    except Exception:  # pragma: no cover
        pass

    jev_body: dict[str, Any] = {
        "model": getattr(jev, "model", None) or settings.jev_model,
        "verdict": getattr(jev, "severity", None),
        "score": getattr(jev, "severity_score", None),
        "confidence": getattr(jev, "confidence", None),
        "latencyMs": getattr(jev, "latency_ms", None) or 0,
        "inputTokens": getattr(jev, "input_tokens", None),
        "outputTokens": getattr(jev, "output_tokens", None),
        "signals": signals,
        "rationale": getattr(jev, "rationale", None) or None,
        "error": getattr(jev, "error", None),
    }
    record: dict[str, Any] = {
        "kind": "guardian_triage",
        "sessionId": trigger.session_ids[0] if trigger.session_ids else None,
        "agentId": trigger.agent_ids[0] if trigger.agent_ids else None,
        "laneId": lane_id,
        "baseline": {
            "provider": "guardian",
            "model": settings.guardian_deployment,
            "verdict": baseline_verdict,
            "latencyMs": round(guardian_elapsed_s * 1000.0, 1),
        },
        "jev": {k: v for k, v in jev_body.items() if v is not None and v != ""},
    }
    jev_sev = getattr(jev, "severity", None)
    if baseline_sev and jev_sev and not getattr(jev, "error", None):
        record["agree"] = jev_sev == baseline_sev
    return {k: v for k, v in record.items() if v is not None}
