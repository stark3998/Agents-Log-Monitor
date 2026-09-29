from __future__ import annotations

import httpx
import pytest

from agentgov_intel.config import Settings
from agentgov_intel.drafter import LaneDrafter
from agentgov_intel.monitor_client import MonitorClient


class FakeRunner:
    def __init__(self) -> None:
        self.calls = 0

    async def run(self, prompt: str, *, model: str, instructions: str, tools=()) -> str:
        self.calls += 1
        if self.calls == 1:
            return "rationale\n```yaml\nid: bad\n```"
        return """fixed
```yaml
id: agent-1-lane
version: 1
appliesTo: {agents: [agent-1]}
purpose: Test
dos: []
never: []
rules: {}
mode: observe
failMode: {default: closed}
approval: {channels: [dashboard], timeoutSec: 300}
judge: {escalateBelow: 0.7, dataPolicy: redacted}
```"""


@pytest.mark.asyncio
async def test_drafter_retries_validate_then_simulates_and_proposes():
    calls: list[tuple[str, str]] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path))
        if req.url.path == "/api/gov/agents":
            return httpx.Response(200, json=[{"id": "agent-1", "name": "Agent One", "surface": "sdk"}])
        if req.url.path == "/api/gov/decisions":
            return httpx.Response(200, json={"items": [{"id": "d1", "sessionId": "s1", "agentId": "agent-1", "toolName": "read", "category": "READ", "verdict": "allow", "effectiveVerdict": "allow", "wouldDeny": False, "stage": "rules_allow", "reason": "", "tainted": False, "createdAt": "2026-09-29T17:00:00Z"}]})
        if req.url.path == "/api/gov/lanes/validate":
            ok = len([p for _, p in calls if p == "/api/gov/lanes/validate"]) > 1
            return httpx.Response(200, json={"ok": ok, "errors": [] if ok else ["missing fields"], "lane": {"id": "agent-1-lane"} if ok else None})
        if req.url.path == "/api/gov/lanes/simulate":
            return httpx.Response(200, json={"evaluated": 1, "wouldAllow": 1, "samples": []})
        if req.url.path == "/api/gov/lanes":
            return httpx.Response(201, json={"lane": {"id": "agent-1-lane"}, "status": "proposed", "updatedAt": "now"})
        return httpx.Response(404)

    settings = Settings(monitor_api_url="http://monitor")
    monitor = MonitorClient(settings, transport=httpx.MockTransport(handler))
    result = await LaneDrafter(settings, monitor, FakeRunner()).draft("agent-1")
    assert result["lane"]["status"] == "proposed"
    assert result["simulation"]["evaluated"] == 1
    assert calls.count(("POST", "/api/gov/lanes/validate")) == 2
    await monitor.aclose()
