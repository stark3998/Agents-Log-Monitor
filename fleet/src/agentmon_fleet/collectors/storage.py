"""Diagnostic-settings archive reader (insights-logs-* containers, JSON lines). Fallback when logs go only to storage."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from azure.storage.blob import BlobServiceClient

from ..auth import credential
from ..config import Settings
from ..state import State
from .base import CollectResult
from .law import LogAnalyticsCollector

log = logging.getLogger(__name__)
CONTAINERS = ("insights-logs-requestresponse", "insights-logs-azureopenairequestusage")


class StorageDiagnosticsCollector:
    name = "storage"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._mapper = LogAnalyticsCollector.__new__(LogAnalyticsCollector)  # reuse row mappers only

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        if not self.settings.storage_account:
            return out
        svc = BlobServiceClient(f"https://{self.settings.storage_account}.blob.core.windows.net", credential=credential())
        for cname in CONTAINERS:
            key = f"storage.{cname}"
            since = datetime.fromisoformat(state.get_cursor(key) or "1970-01-01T00:00:00+00:00")
            newest = since
            try:
                cont = svc.get_container_client(cname)
                for b in cont.list_blobs():
                    if b.last_modified <= since:
                        continue
                    offset_key = f"{key}:{b.name}"
                    offset = int(state.get_cursor(offset_key) or 0)
                    if b.size <= offset:
                        continue
                    data = cont.download_blob(b.name, offset=offset).readall().decode("utf-8", "ignore")
                    for line in data.splitlines():
                        if line.strip():
                            try:
                                out.events.extend(self._mapper._inference(_row(json.loads(line))))
                            except (ValueError, KeyError):
                                continue
                    state.set_cursor(offset_key, str(b.size))
                    newest = max(newest, b.last_modified)
            except Exception as exc:
                if "ContainerNotFound" not in str(exc):
                    out.errors.append(f"{key}: {str(exc)[:200]}")
                continue
            if newest > since:
                state.set_cursor(key, newest.astimezone(timezone.utc).isoformat())
        return out


def _row(rec: dict) -> dict:
    p = rec.get("properties") or {}
    if isinstance(p, str):
        p = json.loads(p)
    gen = p.get("generatedTokens")
    return {"TimeGenerated": rec.get("time"), "ResourceId": rec.get("resourceId"), "Category": rec.get("category"),
            "OperationName": rec.get("operationName"), "ResultSignature": rec.get("resultSignature"),
            "DurationMs": rec.get("durationMs"), "CallerIPAddress": rec.get("callerIpAddress"),
            "CorrelationId": rec.get("correlationId"), "objectId": p.get("objectId"),
            "callerObjectId": p.get("callerObjectId"), "apiName": p.get("apiName"),
            "deployment": p.get("modelDeploymentName"), "model": p.get("modelName"),
            "promptTokens": _first(p.get("promptTokens")), "completionTokens": _first(p.get("completionTokens") or gen),
            "streamType": p.get("streamType")}


def _first(v):
    return v[0] if isinstance(v, list) and v else v
