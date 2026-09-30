"""Monitoring-fleet (agentmon-fleet) hooks for custom and Foundry agents.

* ``FleetClient`` – async client for the fleet hook server (``/evaluate`` pre-tool gate, ``/events`` telemetry).
* ``create_fleet_middleware`` – Microsoft Agent Framework agent + function middleware: every tool call is checked by
  the fleet before it runs (observe or enforce per agent charter), tool outputs are reported so indirect prompt
  injection taints the session, and user turns are tracked for intent analysis.
* ``mcp_approval_responses`` – approval controller for Foundry MCP tools configured with ``require_approval``:
  turns ``mcp_approval_request`` output items into ``mcp_approval_response`` input items using fleet verdicts.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx

TokenProvider = Callable[[], str | Awaitable[str]]


class FleetClient:
    def __init__(self, base_url: str, *, token: str | None = None, token_provider: TokenProvider | None = None,
                 timeout_s: float = 1.5, fail_open: bool = True) -> None:
        self.base = base_url.rstrip("/")
        self._token, self._provider = token, token_provider
        self.fail_open = fail_open
        self._http = httpx.AsyncClient(timeout=timeout_s)

    async def _headers(self) -> dict[str, str]:
        tok = self._token
        if self._provider is not None:
            v = self._provider()
            tok = await v if hasattr(v, "__await__") else v  # type: ignore[assignment]
        return {"Authorization": f"Bearer {tok}"} if tok else {}

    async def evaluate(self, *, agent_name: str, session_id: str, tool_name: str, arguments: Any = None,
                       user_message: str | None = None, tool_outputs: list[dict[str, Any]] | None = None,
                       tool_type: str | None = None, tool_call_id: str | None = None, user_id: str | None = None,
                       thought: str | None = None, platform: str = "foundry") -> dict[str, Any]:
        body = {"platform": platform, "agent_name": agent_name, "session_id": session_id, "tool_name": tool_name,
                "tool_type": tool_type, "tool_call_id": tool_call_id, "arguments": arguments, "user_id": user_id,
                "user_message": user_message, "tool_outputs": tool_outputs or [], "thought": thought}
        try:
            r = await self._http.post(f"{self.base}/evaluate", json=body, headers=await self._headers())
            r.raise_for_status()
            return r.json()
        except httpx.HTTPError as exc:
            if not self.fail_open:
                return {"block": True, "score": 100, "reason": f"monitor unavailable: {exc}", "mode": "enforce"}
            return {"block": False, "score": 0, "reason": f"monitor unavailable: {exc}", "mode": "observe"}

    async def push_events(self, events: list[dict[str, Any]]) -> None:
        try:
            await self._http.post(f"{self.base}/events", content=json.dumps(events, default=str),
                                  headers={**await self._headers(), "Content-Type": "application/json"})
        except httpx.HTTPError:
            pass  # telemetry is best effort

    async def aclose(self) -> None:
        await self._http.aclose()


def _event(kind: str, *, agent_name: str, session_id: str, platform: str = "foundry", **fields: Any) -> dict[str, Any]:
    return {"id": fields.pop("id", None) or uuid.uuid4().hex, "platform": platform, "source": "sdk.agent_framework",
            "kind": kind, "occurred_at": datetime.now(timezone.utc).isoformat(), "agent_id": agent_name,
            "agent_name": agent_name, "session_id": session_id, **{k: v for k, v in fields.items() if v is not None}}


def create_fleet_middleware(client: FleetClient, *, agent_name: str,
                            session_id: Callable[[Any], str] | None = None,
                            blocked_result: Callable[[dict[str, Any]], Any] | None = None) -> list[Any]:
    """Returns ``[agent_middleware, function_middleware]`` for ``Agent(..., middleware=[...])``."""
    try:
        from agent_framework import AgentMiddleware, FunctionMiddleware  # type: ignore
    except ImportError as exc:  # pragma: no cover
        raise ImportError("Install agent-governance[agent-framework] to use this integration") from exc

    state: dict[str, dict[str, Any]] = {}

    def sid_of(ctx: Any) -> str:
        if session_id is not None:
            return session_id(ctx)
        sess = getattr(ctx, "session", None)
        return getattr(sess, "session_id", None) or "default"

    class FleetAgentMiddleware(AgentMiddleware):  # type: ignore[misc,valid-type]
        async def process(self, context: Any, call_next: Callable[[], Awaitable[None]]) -> None:
            sid = sid_of(context)
            msgs = getattr(context, "messages", None) or []
            user_text = next((getattr(m, "text", None) for m in reversed(msgs)
                              if str(getattr(m, "role", "")).lower().endswith("user") and getattr(m, "text", None)), None)
            st = state.setdefault(sid, {"outputs": []})
            if user_text:
                st["user"] = user_text
                await client.push_events([_event("user_message", agent_name=agent_name, session_id=sid, text=user_text)])
            await call_next()
            result = getattr(context, "result", None)
            text = getattr(result, "text", None) if result is not None else None
            if text:
                await client.push_events([_event("assistant_message", agent_name=agent_name, session_id=sid, text=text)])

    class FleetFunctionMiddleware(FunctionMiddleware):  # type: ignore[misc,valid-type]
        async def process(self, context: Any, call_next: Callable[[], Awaitable[None]]) -> None:
            sid = sid_of(context)
            fn = getattr(context, "function", None)
            name = getattr(fn, "name", None) or "function"
            args = getattr(context, "arguments", None)
            if hasattr(args, "model_dump"):
                args = args.model_dump()
            st = state.setdefault(sid, {"outputs": []})
            verdict = await client.evaluate(agent_name=agent_name, session_id=sid, tool_name=name, arguments=args,
                                            user_message=st.pop("user", None), tool_outputs=st["outputs"][-5:],
                                            tool_type="function")
            st["outputs"] = []
            if verdict.get("block"):
                context.result = blocked_result(verdict) if blocked_result else {
                    "error": "This action was blocked by the organization's AI monitoring policy.",
                    "reason_code": verdict.get("reason_code")}
                return
            await call_next()
            out = getattr(context, "result", None)
            if out is not None:
                st["outputs"].append({"tool_name": name, "output": str(out)[:4000]})
                await client.push_events([_event("tool_result", agent_name=agent_name, session_id=sid, tool_name=name,
                                                 result=str(out)[:8000])])

    return [FleetAgentMiddleware(), FleetFunctionMiddleware()]


async def mcp_approval_responses(client: FleetClient, response: Any, *, agent_name: str, session_id: str,
                                 user_message: str | None = None) -> list[dict[str, Any]]:
    """For each ``mcp_approval_request`` in a Responses API result, ask the fleet and build the approval reply.

    Send the returned items as ``input`` with ``previous_response_id=response.id`` to continue the run. Approval is
    granted unless the fleet blocks (enforce mode) — observe mode still records alerts.
    """
    items = getattr(response, "output", None) or (response.get("output") if isinstance(response, dict) else []) or []
    replies: list[dict[str, Any]] = []
    for it in items:
        get = it.get if isinstance(it, dict) else (lambda k, _it=it: getattr(_it, k, None))
        if get("type") != "mcp_approval_request":
            continue
        args = get("arguments")
        try:
            args = json.loads(args) if isinstance(args, str) else args
        except ValueError:
            pass
        v = await client.evaluate(agent_name=agent_name, session_id=session_id,
                                  tool_name=f"{get('server_label')}.{get('name')}", tool_type="mcp", arguments=args,
                                  tool_call_id=get("id"), user_message=user_message)
        reply = {"type": "mcp_approval_response", "approval_request_id": get("id"), "approve": not v.get("block")}
        if v.get("block"):
            reply["reason"] = "Blocked by the organization's AI monitoring policy."
        replies.append(reply)
    return replies
