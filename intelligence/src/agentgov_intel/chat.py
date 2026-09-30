from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import quote, unquote

from .af_adapter import AgentRunner, default_runner
from .config import Settings
from .models import ChatMessage
from .tools import chat_allowed_tools


CHAT_INSTRUCTIONS = """You are Ask the Monitor, the assistant for Agent Logs Monitor, a monitoring and governance platform for AI agents.

Ground every answer in the project documentation:
- Use the documentation excerpts attached to the question. Call the search_docs tool for anything they don't cover and get_doc to read a whole page or section.
- Answer questions about how the platform works, is configured, deployed or operated only from the documentation. If it doesn't cover something, say so and point to the closest pages. Never guess configuration names, environment variables, commands, API paths, roles or defaults.
- Cite the pages you used as Markdown links to their in-app link exactly as given (for example [Fleet: Alert taxonomy](/docs/fleet#alert-taxonomy)), inline next to the claims they support.

For live activity (agents, sessions, decisions, incidents, lanes) use the read-only monitor MCP tools and refer to records as decision-<id>, incident-<id> or session-<id>; explain them using the documentation.
Use only read-only tools. Never propose or perform writes."""

CONTEXT_HITS = 6
EXCERPT_CHARS = 1800


def sse(event: dict[str, Any]) -> str:
    return "data: " + json.dumps(event, separators=(",", ":")) + "\n\n"


def chunk_text(chunk: Any) -> str:
    if isinstance(chunk, str):
        return chunk
    if isinstance(chunk, dict):
        return str(chunk.get("text") or "")
    return str(getattr(chunk, "text", "") or "")


def chunk_tool_event(chunk: Any) -> dict[str, Any] | None:
    if isinstance(chunk, dict) and chunk.get("type") == "tool":
        return {"type": "tool", "name": chunk.get("name"), "args": chunk.get("args", {})}
    name = getattr(chunk, "tool_name", None) or getattr(chunk, "name", None)
    if name and getattr(chunk, "type", "") == "tool":
        return {"type": "tool", "name": name, "args": getattr(chunk, "args", {})}
    return None


DOC_LINK = re.compile(r"\]\(\s*<?/docs/([^)\s>]+)>?\s*\)")


def doc_link(doc_id: str, anchor: str | None = None) -> str:
    return "/docs/" + quote(doc_id, safe="/") + (f"#{anchor}" if anchor else "")


def citations_from_text(text: str, doc_titles: dict[str, str] | None = None) -> list[dict[str, str]]:
    doc_titles = doc_titles or {}
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for match in DOC_LINK.finditer(text):
        raw_id, _, anchor = match.group(1).partition("#")
        doc_id = unquote(raw_id)
        key = f"{doc_id}#{anchor}" if anchor else doc_id
        if ("doc", key) in seen:
            continue
        seen.add(("doc", key))
        citation = {"type": "citation", "kind": "doc", "id": key}
        title = doc_titles.get(key) or doc_titles.get(doc_id)
        if title:
            citation["title"] = title
        out.append(citation)
    # Record ids are matched outside link targets so `/docs/…#session-state` isn't read as a session.
    prose = DOC_LINK.sub("]", text)
    patterns = [
        ("decision", r"\bdecision[-_: ]([A-Za-z0-9-]+)"),
        ("incident", r"\binc(?:ident)?[-_: ]([A-Za-z0-9-]+)"),
        ("session", r"\bsession[-_: ]([A-Za-z0-9-]+)"),
    ]
    for kind, pattern in patterns:
        for match in re.finditer(pattern, prose, flags=re.IGNORECASE):
            item = (kind, match.group(1))
            if item not in seen:
                seen.add(item)
                out.append({"type": "citation", "kind": kind, "id": item[1]})
    return out


def retrieval_query(messages: list[ChatMessage]) -> str:
    """The latest question, plus the previous one when the latest is a short follow-up."""
    users = [m.content for m in messages if m.role == "user"]
    if not users:
        return ""
    last = users[-1].strip()
    if len(last.split()) < 5 and len(users) > 1:
        return f"{users[-2].strip()} {last}"
    return last


def docs_context(hits: list[dict[str, Any]]) -> str:
    if not hits:
        return "<documentation_excerpts>No sections matched; use search_docs with other keywords.</documentation_excerpts>"
    parts = []
    for i, hit in enumerate(hits, 1):
        where = f"{hit.get('title')} › {hit['heading']}" if hit.get("heading") else str(hit.get("title"))
        link = hit.get("link") or doc_link(str(hit.get("id", "")), hit.get("anchor"))
        text = str(hit.get("text") or hit.get("snippet") or "")
        if len(text) > EXCERPT_CHARS:
            text = text[:EXCERPT_CHARS] + "\n…(truncated)"
        parts.append(f"[{i}] {where}\nlink: {link}\n{text}")
    return "<documentation_excerpts>\n" + "\n\n".join(parts) + "\n</documentation_excerpts>"


class MonitorChat:
    def __init__(self, settings: Settings, runner: AgentRunner | None = None, monitor: Any | None = None) -> None:
        self.settings = settings
        self.runner = runner or default_runner(settings)
        self.monitor = monitor

    async def _search_docs(self, query: str) -> list[dict[str, Any]]:
        search = getattr(self.monitor, "search_docs", None)
        if not query or search is None:
            return []
        try:
            result = await search(query, limit=CONTEXT_HITS)
        except Exception:
            return []
        hits = result.get("hits") if isinstance(result, dict) else None
        return [h for h in hits or [] if isinstance(h, dict)]

    async def stream_events(self, messages: list[ChatMessage], conversation_id: str | None = None) -> AsyncIterator[str]:
        query = retrieval_query(messages)
        hits: list[dict[str, Any]] = []
        if query and getattr(self.monitor, "search_docs", None) is not None:
            yield sse({"type": "tool", "name": "search_docs", "args": {"query": query}})
            hits = await self._search_docs(query)
        doc_titles: dict[str, str] = {}
        for hit in hits:
            doc_id = str(hit.get("id", ""))
            doc_titles.setdefault(doc_id, str(hit.get("title", doc_id)))
            if hit.get("anchor") and hit.get("heading"):
                doc_titles.setdefault(f"{doc_id}#{hit['anchor']}", f"{hit.get('title')} › {hit['heading']}")

        prompt = "\n".join(f"{m.role}: {m.content}" for m in messages)
        if conversation_id:
            prompt = f"conversationId: {conversation_id}\n{prompt}"
        prompt = f"{prompt}\n\n{docs_context(hits)}"
        accumulated: list[str] = []
        async for chunk in self.runner.stream(
            prompt,
            model=self.settings.chat_deployment,
            instructions=CHAT_INSTRUCTIONS,
            tools=chat_allowed_tools(),
        ):
            tool = chunk_tool_event(chunk)
            if tool:
                yield sse(tool)
                continue
            text = chunk_text(chunk)
            if text:
                accumulated.append(text)
                yield sse({"type": "delta", "text": text})
        for citation in citations_from_text("".join(accumulated), doc_titles):
            yield sse(citation)
        yield sse({"type": "done"})
