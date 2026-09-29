from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Any

from .af_adapter import AgentRunner, default_runner
from .config import Settings
from .models import ChatMessage
from .tools import chat_allowed_tools


CHAT_INSTRUCTIONS = """You are Ask the Monitor, a read-only governance analyst.
Use only read-only monitor MCP tools. Explain decisions, incidents, lanes and session timelines.
Never propose or perform writes."""


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


def citations_from_text(text: str) -> list[dict[str, str]]:
    patterns = [
        ("decision", r"\bdecision[-_: ]([A-Za-z0-9-]+)"),
        ("incident", r"\binc(?:ident)?[-_: ]([A-Za-z0-9-]+)"),
        ("session", r"\bsession[-_: ]([A-Za-z0-9-]+)"),
    ]
    seen: set[tuple[str, str]] = set()
    out: list[dict[str, str]] = []
    for kind, pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE):
            item = (kind, match.group(1))
            if item not in seen:
                seen.add(item)
                out.append({"type": "citation", "kind": kind, "id": item[1]})
    return out


class MonitorChat:
    def __init__(self, settings: Settings, runner: AgentRunner | None = None) -> None:
        self.settings = settings
        self.runner = runner or default_runner(settings)

    async def stream_events(self, messages: list[ChatMessage], conversation_id: str | None = None) -> AsyncIterator[str]:
        prompt = "\n".join(f"{m.role}: {m.content}" for m in messages)
        if conversation_id:
            prompt = f"conversationId: {conversation_id}\n{prompt}"
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
        for citation in citations_from_text("".join(accumulated)):
            yield sse(citation)
        yield sse({"type": "done"})
