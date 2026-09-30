from __future__ import annotations

import json

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


class DocsRunner:
    def __init__(self):
        self.prompt = ""
        self.tools = ()

    async def run(self, *args, **kwargs):  # pragma: no cover
        return ""

    async def stream(self, prompt, *, model, instructions, tools=()):
        self.prompt = prompt
        self.tools = tuple(tools)
        yield "Alerts are mapped to OWASP ([Fleet: Alert taxonomy](/docs/fleet#alert-taxonomy)). "
        yield "See [Fleet](/docs/fleet) and the [state](/docs/architecture/agents#session-state) notes."


class DocsMonitor:
    def __init__(self):
        self.queries = []

    async def search_docs(self, query, *, limit=6):
        self.queries.append((query, limit))
        return {"hits": [{
            "id": "fleet", "title": "AgentMon Fleet", "heading": "Alert taxonomy", "anchor": "alert-taxonomy",
            "link": "/docs/fleet#alert-taxonomy", "text": "Every alert maps to OWASP LLM, ASI and MITRE ATLAS.",
        }]}

    async def aclose(self):
        pass


def test_chat_is_grounded_in_docs_and_cites_pages():
    runner, monitor = DocsRunner(), DocsMonitor()
    app = create_app(Settings(guardian_enabled=False), runner=runner, monitor=monitor)
    with TestClient(app) as client:
        with client.stream("POST", "/chat", json={"messages": [{"role": "user", "content": "How are fleet alerts classified?"}]}) as resp:
            body = "".join(resp.iter_text())
    assert monitor.queries == [("How are fleet alerts classified?", 6)]
    assert body.startswith('data: {"type":"tool","name":"search_docs","args":{"query":"How are fleet alerts classified?"}}')
    assert "<documentation_excerpts>" in runner.prompt and "link: /docs/fleet#alert-taxonomy" in runner.prompt
    assert "Every alert maps to OWASP LLM" in runner.prompt
    assert {"search_docs", "get_doc"} <= set(runner.tools)
    events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ")]
    citations = [e for e in events if e["type"] == "citation"]
    assert {"type": "citation", "kind": "doc", "id": "fleet#alert-taxonomy", "title": "AgentMon Fleet › Alert taxonomy"} in citations
    assert {"type": "citation", "kind": "doc", "id": "fleet", "title": "AgentMon Fleet"} in citations
    assert {"type": "citation", "kind": "doc", "id": "architecture/agents#session-state"} in citations
    # Anchors inside doc links aren't mistaken for session ids.
    assert not [c for c in citations if c["kind"] == "session"]
    assert events[-1] == {"type": "done"}


def test_chat_survives_docs_search_failure():
    class BrokenMonitor(DocsMonitor):
        async def search_docs(self, query, *, limit=6):
            raise RuntimeError("monitor down")

    runner = DocsRunner()
    app = create_app(Settings(guardian_enabled=False), runner=runner, monitor=BrokenMonitor())
    with TestClient(app) as client:
        with client.stream("POST", "/chat", json={"messages": [{"role": "user", "content": "What is a lane?"}]}) as resp:
            body = "".join(resp.iter_text())
    assert resp.status_code == 200
    assert "No sections matched" in runner.prompt
    assert body.rstrip().endswith('data: {"type":"done"}')
