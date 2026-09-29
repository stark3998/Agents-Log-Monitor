from __future__ import annotations

from fastapi.testclient import TestClient

from agentgov_intel.app import create_app
from agentgov_intel.config import Settings


class FakeRunner:
    async def run(self, *args, **kwargs):  # pragma: no cover
        return ""

    async def stream(self, *args, **kwargs):
        yield {"type": "tool", "name": "list_decisions", "args": {"limit": 1}}
        yield "Decision decision-abc allowed session session-123. "
        yield "Incident incident-inc-9 remains open."


class FakeMonitor:
    async def aclose(self):
        pass


def test_chat_sse_event_format():
    app = create_app(Settings(guardian_enabled=False), runner=FakeRunner(), monitor=FakeMonitor())
    with TestClient(app) as client:
        with client.stream("POST", "/chat", json={"messages": [{"role": "user", "content": "What happened?"}]}) as resp:
            body = "".join(resp.iter_text())
    assert resp.status_code == 200
    assert 'data: {"type":"tool","name":"list_decisions","args":{"limit":1}}' in body
    assert 'data: {"type":"delta","text":"Decision decision-abc allowed session session-123. "}' in body
    assert 'data: {"type":"citation","kind":"decision","id":"decision-abc"}' in body
    assert 'data: {"type":"citation","kind":"session","id":"session-123"}' in body
    assert body.rstrip().endswith('data: {"type":"done"}')
