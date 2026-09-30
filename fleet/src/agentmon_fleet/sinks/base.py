"""Alert/incident sinks: Log Analytics (DCR), the TS governance dashboard, and a local JSONL log."""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Protocol

import httpx

from ..config import Settings
from ..models import Alert, Severity

log = logging.getLogger(__name__)


class Sink(Protocol):
    name: str

    def send(self, alerts: list[Alert], incidents: list[dict[str, Any]]) -> list[str]:
        """Deliver; returns error strings (empty on success)."""
        ...


def alert_row(a: Alert) -> dict[str, Any]:
    return {
        "TimeGenerated": a.created_at.isoformat(), "AlertId": a.alert_id, "IncidentId": a.incident_id or "",
        "Fingerprint": a.fingerprint, "AlertType": a.alert_type, "Severity": a.severity.value, "Score": a.score,
        "Title": a.title, "Summary": a.summary, "Platform": a.platform.value, "AgentId": a.agent_id or "",
        "AgentName": a.agent_name or "", "SessionId": a.session_id or "", "UserId": a.user_id or "",
        "LaneId": a.lane_id or "", "Detector": a.detector, "Action": a.action, "OwaspLlm": a.owasp_llm,
        "OwaspAgentic": a.owasp_agentic, "MitreAtlas": a.mitre_atlas, "Evidence": a.evidence,
        "SourceEventIds": a.source_event_ids,
    }


class JsonlSink:
    name = "jsonl"

    def __init__(self, path: str) -> None:
        self.path = Path(path)

    def send(self, alerts: list[Alert], incidents: list[dict[str, Any]]) -> list[str]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as f:
            for a in alerts:
                f.write(json.dumps({"type": "alert", **alert_row(a)}, default=str) + "\n")
            for i in incidents:
                f.write(json.dumps({"type": "incident", **i}, default=str) + "\n")
        return []


class LogAnalyticsSink:
    """Writes to AgentMonAlerts_CL through the Logs Ingestion API (DCE + DCR, stream Custom-AgentMonAlerts)."""

    name = "law"

    def __init__(self, settings: Settings) -> None:
        from azure.monitor.ingestion import LogsIngestionClient

        from ..auth import credential
        self.settings = settings
        self.client = LogsIngestionClient(endpoint=settings.alerts_dce, credential=credential(), logging_enable=False)

    def send(self, alerts: list[Alert], incidents: list[dict[str, Any]]) -> list[str]:
        if not alerts:
            return []
        try:
            self.client.upload(rule_id=self.settings.alerts_dcr_id, stream_name=self.settings.alerts_stream,
                               logs=[alert_row(a) for a in alerts])
            return []
        except Exception as exc:
            return [f"law sink: {str(exc).splitlines()[0][:300]}"]


class DashboardSink:
    """Pushes alerts to /api/gov/fleet/alerts and incidents to /api/gov/incidents on the TS governance server."""

    name = "dashboard"

    def __init__(self, settings: Settings) -> None:
        self.base = (settings.monitor_url or "").rstrip("/")
        headers = {"Content-Type": "application/json"}
        if settings.monitor_token:
            headers["Authorization"] = "Bearer " + settings.monitor_token
        self.http = httpx.Client(timeout=20, headers=headers)
        self._known_incidents: set[str] = set()

    def send(self, alerts: list[Alert], incidents: list[dict[str, Any]]) -> list[str]:
        from ..detectors.correlator import to_ts_incident
        errors: list[str] = []
        try:
            if alerts:
                r = self.http.post(f"{self.base}/api/gov/fleet/alerts",
                                   content=json.dumps({"alerts": [a.model_dump(mode="json") for a in alerts]}))
                if r.status_code >= 300:
                    errors.append(f"dashboard alerts: HTTP {r.status_code} {r.text[:200]}")
            for inc in incidents:
                ts = to_ts_incident(inc)
                patch = {k: v for k, v in ts.items() if k not in ("id", "state")}  # never override analyst triage
                r = self.http.patch(f"{self.base}/api/gov/incidents/{inc['id']}", content=json.dumps(patch, default=str))
                if r.status_code == 404:
                    r = self.http.post(f"{self.base}/api/gov/incidents", content=json.dumps(ts, default=str))
                if r.status_code >= 300:
                    errors.append(f"dashboard incident {inc['id']}: HTTP {r.status_code} {r.text[:200]}")
        except httpx.HTTPError as exc:
            errors.append(f"dashboard: {exc}")
        return errors


class ConsoleSink:
    name = "console"
    COLORS = {"critical": "\033[95m", "high": "\033[91m", "medium": "\033[93m", "low": "\033[96m",
              "informational": "\033[90m"}

    def send(self, alerts: list[Alert], incidents: list[dict[str, Any]]) -> list[str]:
        for a in sorted(alerts, key=lambda x: -x.score):
            c = self.COLORS.get(a.severity.value, "")
            print(f"{c}[{a.severity.value.upper():>8}] {a.score:5.1f} {a.alert_type:<30}\033[0m "
                  f"{a.agent_name or a.agent_id or '-'} :: {a.summary[:160]}")
        for i in incidents:
            print(f"\033[1m[INCIDENT {i['severity'].upper()}] {i['id']} {i.get('title')}\033[0m")
        return []


def build_sinks(settings: Settings, console: bool = False) -> list[Sink]:
    sinks: list[Sink] = []
    if settings.alerts_jsonl:
        sinks.append(JsonlSink(settings.alerts_jsonl))
    if settings.alerts_dce and settings.alerts_dcr_id:
        try:
            sinks.append(LogAnalyticsSink(settings))
        except Exception as exc:  # pragma: no cover - environment dependent
            log.warning("LAW sink disabled: %s", exc)
    if settings.monitor_url:
        sinks.append(DashboardSink(settings))
    if console:
        sinks.append(ConsoleSink())
    return sinks


def severity_ok(a: Alert, minimum: str) -> bool:
    return a.severity.rank >= Severity(minimum).rank
