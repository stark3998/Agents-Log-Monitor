"""One monitoring cycle: collect → redact → store → profile → detect → correlate → deliver."""
from __future__ import annotations

import base64
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from .collectors.base import CollectResult, Collector
from .config import Settings, get_settings
from .detectors.action import ActionAnalyst
from .detectors.base import Context, Detector
from .detectors.controlplane import ControlPlaneAuditor
from .detectors.correlator import Correlator
from .detectors.evasion import EvasionMonitor
from .detectors.inference import InferenceNetworkSentinel
from .detectors.intent import IntentAnalyst
from .detectors.loop import RunawayLoopDetector
from .detectors.payload import UserPayloadDetector
from .detectors.profiler import Profiler
from . import jev_shadow
from .jev import get_jev
from .llm import LLM, get_llm
from .models import AgentProfile, Alert, CanonicalEvent, Platform
from .redact import redact_event
from .sinks.base import Sink, build_sinks, severity_ok
from .state import State

log = logging.getLogger(__name__)


@dataclass
class CycleReport:
    started: float = field(default_factory=time.time)
    collected: dict[str, int] = field(default_factory=dict)
    new_events: int = 0
    profiles: int = 0
    changed_profiles: int = 0
    alerts: int = 0
    incidents: int = 0
    llm_calls: int = 0
    jev_calls: int = 0  # shadow-mode Jev comparisons scheduled this cycle
    errors: list[str] = field(default_factory=list)
    duration_s: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if k != "started"}


def build_collectors(settings: Settings, only: list[str] | None = None) -> list[Collector]:
    from .collectors.dataverse import DataverseCollector
    from .collectors.foundry import FoundryCollector
    from .collectors.law import LogAnalyticsCollector
    from .collectors.storage import StorageDiagnosticsCollector
    cols: list[Collector] = []

    def want(n: str) -> bool:
        return not only or n in only

    if settings.law_workspace_id and want("law"):
        cols.append(LogAnalyticsCollector(settings))
    if (settings.foundry_project_endpoint or settings.subscription_id or settings.foundry_projects) and want("foundry"):
        cols.append(FoundryCollector(settings))
    if settings.dataverse_org_url and want("dataverse"):
        cols.append(DataverseCollector(settings))
    # Storage archives duplicate LAW diagnostics; use them only when LAW is absent or explicitly requested.
    if settings.storage_account and (want("storage") if only else not settings.law_workspace_id):
        cols.append(StorageDiagnosticsCollector(settings))
    try:
        from .collectors.tenant import tenant_collectors
        cols.extend(c for c in tenant_collectors(settings) if want(c.name))
    except ImportError:
        pass
    return cols


def _token_oid(token: str) -> str | None:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload)).get("oid")
    except Exception:
        return None


class Fleet:
    def __init__(self, settings: Settings | None = None, state: State | None = None, llm: LLM | None | bool = True,
                 sinks: list[Sink] | None = None, collectors: list[Collector] | None = None,
                 console: bool = False) -> None:
        self.settings = settings or get_settings()
        self.state = state or State(self.settings.state_db)
        self.llm: LLM | None = (get_llm() if self.settings.llm_enabled else None) if llm is True else (llm or None)
        self.sinks = sinks if sinks is not None else build_sinks(self.settings, console=console)
        self._collectors = collectors
        self.profiler = Profiler()
        self.cp_auditor = ControlPlaneAuditor()
        self.detectors: list[Detector] = [IntentAnalyst(), ActionAnalyst(), EvasionMonitor(),
                                          InferenceNetworkSentinel(), self.cp_auditor, RunawayLoopDetector(),
                                          UserPayloadDetector()]
        self.correlator = Correlator()
        self._self_registered = False

    @property
    def collectors(self) -> list[Collector]:
        if self._collectors is None:
            self._collectors = build_collectors(self.settings)
        return self._collectors

    def context(self, realtime: bool = False) -> Context:
        return Context(settings=self.settings, state=self.state, llm=self.llm,
                       llm_budget=0 if realtime else self.settings.llm_budget_per_cycle, realtime=realtime,
                       jev=None if realtime else get_jev(self.settings),
                       jev_budget=0 if realtime else self.settings.jev_budget_per_cycle)

    def _register_self(self) -> None:
        """The fleet's own identity calls models and APIs; never flag it as an unregistered caller."""
        if self._self_registered:
            return
        self._self_registered = True
        try:
            from .auth import ARM_SCOPE, bearer
            oid = _token_oid(bearer(ARM_SCOPE))
            if oid:
                self.state.put_identity(oid, "fleet", "agentmon-fleet")
        except Exception as exc:
            log.debug("could not resolve fleet identity: %s", exc)
        for oid in self.settings.known_callers:
            self.state.put_identity(oid, "allowed", "allow-listed caller")

    # ── stages ──────────────────────────────────────────────────────────────
    def collect(self, report: CycleReport | None = None) -> tuple[list[CanonicalEvent], list[AgentProfile]]:
        report = report or CycleReport()
        self._register_self()
        results: list[tuple[str, CollectResult]] = []

        def run(c: Collector) -> tuple[str, CollectResult]:
            try:
                return c.name, c.collect(self.state)
            except Exception as exc:
                log.exception("collector %s failed", c.name)
                return c.name, CollectResult(errors=[f"{c.name}: {exc}"])

        with ThreadPoolExecutor(max_workers=max(1, len(self.collectors))) as pool:
            results = list(pool.map(run, self.collectors))
        events: list[CanonicalEvent] = []
        profiles: list[AgentProfile] = []
        for name, r in results:
            report.collected[name] = len(r.events)
            report.errors.extend(r.errors)
            events.extend(r.events)
            profiles.extend(r.profiles)
        for e in events:
            redact_event(e, self.settings.redact_pii)
        events = self._drop_cross_source_duplicates(events)
        new = self.state.add_events(events)
        report.new_events = len(new)
        report.profiles = len(profiles)
        if self.settings.events_jsonl and new:
            with open(self.settings.events_jsonl, "a", encoding="utf-8") as f:
                for e in new:
                    f.write(e.model_dump_json() + "\n")
        return new, profiles

    def _drop_cross_source_duplicates(self, events: list[CanonicalEvent]) -> list[CanonicalEvent]:
        """Foundry conversations are visible both through the project API (authoritative, immediate) and as
        App Insights GenAI spans (lagging). Keep spans only for sessions the API does not cover (e.g. projects outside
        FLEET_CONTENT_PROJECTS), otherwise every message and tool call would be analysed twice."""
        span_sessions = {e.session_id for e in events
                         if e.source == "law.genai" and e.platform == Platform.FOUNDRY and e.session_id}
        if not span_sessions:
            return events
        covered = {e.session_id for e in events if e.source == "foundry.responses"}
        covered |= self.state.sessions_with_source(span_sessions - covered, "foundry.responses")
        return [e for e in events if not (e.source == "law.genai" and e.platform == Platform.FOUNDRY
                                          and e.session_id in covered)]

    def analyze(self, profiles: list[AgentProfile], report: CycleReport | None = None,
                ctx: Context | None = None) -> tuple[list[Alert], list[dict]]:
        report = report or CycleReport()
        ctx = ctx or self.context()
        budget0 = ctx.llm_budget
        jev_budget0 = ctx.jev_budget
        previous = {p.agent_key: self.state.get_profile(p.agent_key) for p in profiles}
        for p in self.state.list_profiles():
            ctx.profiles.setdefault(p.agent_key, p)
        changed = self.profiler.refresh(profiles, ctx)
        report.changed_profiles = len(changed)
        raw: list[Alert] = self.cp_auditor.definition_changes(changed, previous)
        while True:
            batch = self.state.unprocessed_events(limit=5000)
            if not batch:
                break
            for e in batch:
                for det in self.detectors:
                    try:
                        raw.extend(det.process(e, ctx))
                    except Exception as exc:
                        log.exception("detector %s failed on %s", det.name, e.id)
                        report.errors.append(f"{det.name}: {exc}")
                if e.effects or "code_analysis" in e.attributes:
                    self.state.update_event(e)
            self.state.mark_processed(e.id for e in batch)
        fresh = [a for a in raw if severity_ok(a, self.settings.min_alert_severity) and self.state.upsert_alert(a)]
        escalations, incidents = self.correlator.correlate(fresh, ctx) if fresh else ([], [])
        fresh += [a for a in escalations if self.state.upsert_alert(a)]
        for a in fresh:
            if a.incident_id:
                self.state.update_alert(a)
        report.alerts = len(fresh)
        report.incidents = len(incidents)
        report.llm_calls = budget0 - ctx.llm_budget
        report.jev_calls = jev_budget0 - ctx.jev_budget
        return fresh, incidents

    def deliver(self, report: CycleReport | None = None) -> None:
        report = report or CycleReport()
        alerts = self.state.undelivered_alerts()
        incidents = self.state.unsynced_incidents()
        if not alerts and not incidents:
            return
        ok = True
        for s in self.sinks:
            errs = s.send(alerts, incidents)
            if errs:
                report.errors.extend(errs)
                ok = ok and s.name in ("dashboard",)  # dashboard is best-effort; LAW/JSONL failures retry
        if ok:
            self.state.mark_delivered(alerts)
            for i in incidents:
                self.state.mark_incident_synced(i["id"])

    def run_cycle(self) -> CycleReport:
        report = CycleReport()
        _, profiles = self.collect(report)
        self.analyze(profiles, report)
        self.deliver(report)
        self.state.prune()
        if report.jev_calls:
            jev_shadow.drain(timeout=10.0)  # bounded: let shadow comparisons finish and their records flush
        report.duration_s = round(time.time() - report.started, 1)
        return report

    def run_forever(self, interval_s: int | None = None) -> None:
        interval = interval_s or self.settings.poll_interval_s
        while True:
            try:
                r = self.run_cycle()
                log.info("cycle: %s", r.as_dict())
            except Exception:
                log.exception("cycle failed")
            time.sleep(interval)
