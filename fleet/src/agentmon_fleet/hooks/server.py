"""FastAPI app for real-time hooks.

  GET  /health
  POST /copilot-studio/validate                 Copilot Studio threat-detection handshake
  POST /copilot-studio/analyze-tool-execution   Copilot Studio pre-tool gate (<= 1 s)
  POST /evaluate                                Generic pre-tool gate (Agent Framework middleware, MCP approval controller)
  POST /events                                  Push canonical events (post-tool results, custom agents)
"""
from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import Body, FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..collectors.base import stable_id
from ..config import get_settings
from ..models import CanonicalEvent, EventKind, Platform
from ..redact import redact_event
from . import copilot_studio as cs
from .auth import authenticate
from .realtime import RealtimeEvaluator

log = logging.getLogger(__name__)


class EvaluateRequest(BaseModel):
    platform: Platform = Platform.FOUNDRY
    agent_name: str
    agent_id: str | None = None
    session_id: str
    user_id: str | None = None
    tool_name: str
    tool_type: str | None = None
    tool_call_id: str | None = None
    arguments: Any = None
    thought: str | None = None
    user_message: str | None = None
    tool_outputs: list[dict[str, Any]] = Field(default_factory=list, description="[{tool_name, output}] since last call")


def create_app(evaluator: RealtimeEvaluator | None = None) -> FastAPI:
    settings = get_settings()
    ev = evaluator or RealtimeEvaluator(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        await ev.aclose()  # drain Jev shadow tasks (bounded) so shadow records aren't lost on shutdown

    app = FastAPI(title="agentmon-fleet hooks", docs_url=None, redoc_url=None, lifespan=lifespan)

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "mode": settings.hooks_mode, "llm": bool(ev.llm)}

    @app.post("/copilot-studio/validate")
    def cs_validate(request: Request) -> dict:
        authenticate(request, settings)
        return {"isSuccessful": True, "status": "OK"}

    @app.post("/copilot-studio/analyze-tool-execution")
    async def cs_analyze(request: Request, body: dict = Body(...)) -> JSONResponse:
        authenticate(request, settings)
        corr = request.headers.get("x-ms-correlation-id")
        try:
            pending, ctx_events = cs.to_events(body)
            verdict = await ev.evaluate(pending, ctx_events)
        except Exception as exc:  # never break the agent on our failure: allow, but say so
            log.exception("analyze-tool-execution failed")
            return JSONResponse({"blockAction": False, "diagnostics": f"agentmon error {type(exc).__name__} corr={corr}"})
        log.info("cs gate %s tool=%s score=%s block=%s %sms", pending.agent_name, pending.tool_name, verdict.score,
                 verdict.block, verdict.latency_ms)
        return JSONResponse(cs.to_response(verdict, corr))

    @app.post("/evaluate")
    async def evaluate(request: Request, req: EvaluateRequest) -> dict:
        authenticate(request, settings)
        now = datetime.now(timezone.utc)
        base = dict(platform=req.platform, source="hook.evaluate", agent_id=req.agent_id or req.agent_name,
                    agent_name=req.agent_name, session_id=req.session_id, user_id=req.user_id, occurred_at=now)
        ctx_events: list[CanonicalEvent] = []
        if req.user_message:
            ctx_events.append(CanonicalEvent(id=stable_id("hk-msg", req.session_id, req.user_message[:160]),
                                             kind=EventKind.USER_MESSAGE, text=req.user_message, **base))
        for o in req.tool_outputs:
            ctx_events.append(CanonicalEvent(
                id=stable_id("hk-out", req.session_id, o.get("tool_name"), str(o.get("output"))[:200]),
                kind=EventKind.TOOL_RESULT, tool_name=o.get("tool_name"), result=o.get("output"), **base))
        pending = CanonicalEvent(
            id=stable_id("hk-call", req.session_id, req.tool_call_id or uuid.uuid4().hex, req.tool_name),
            kind=EventKind.TOOL_CALL, tool_name=req.tool_name, tool_type=req.tool_type, tool_call_id=req.tool_call_id,
            arguments=req.arguments, thought=req.thought, **base)
        v = await ev.evaluate(pending, ctx_events)
        return {"block": v.block, "score": v.score, "reason": v.reason, "reason_code": v.reason_code, "mode": v.mode,
                "latency_ms": v.latency_ms, "alerts": [{"type": a.alert_type, "severity": a.severity.value,
                                                        "summary": a.summary} for a in v.alerts]}

    @app.post("/events")
    def push_events(request: Request, events: list[CanonicalEvent]) -> dict:
        authenticate(request, settings)
        for e in events:
            redact_event(e, settings.redact_pii)
        new = ev.state.add_events(events)
        return {"accepted": len(new), "duplicates": len(events) - len(new)}

    @app.middleware("http")
    async def timing(request: Request, call_next):
        t0 = time.perf_counter()
        resp = await call_next(request)
        resp.headers["x-agentmon-ms"] = f"{(time.perf_counter() - t0) * 1000:.1f}"
        return resp

    return app
