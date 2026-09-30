from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

from .af_adapter import default_runner
from .chat import MonitorChat
from .config import Settings, load_settings
from .drafter import LaneDrafter
from .guardian import GuardianService
from .models import ChatRequest, DraftLaneRequest, InvestigateRequest
from .monitor_client import MonitorClient


def configure_tracing(settings: Settings) -> None:
    if not settings.appinsights_connection_string:
        return
    try:
        from azure.monitor.opentelemetry import configure_azure_monitor

        configure_azure_monitor(connection_string=settings.appinsights_connection_string)
    except Exception:
        pass


def create_app(settings: Settings | None = None, runner: Any | None = None, monitor: MonitorClient | None = None) -> FastAPI:
    settings = settings or load_settings()
    configure_tracing(settings)
    owned_monitor = monitor is None
    monitor = monitor or MonitorClient(settings)
    runner = runner or default_runner(settings)
    guardian = GuardianService(settings, monitor, runner)
    chat = MonitorChat(settings, runner)
    drafter = LaneDrafter(settings, monitor, runner)
    bg_task: asyncio.Task[Any] | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        nonlocal bg_task
        if settings.guardian_enabled:
            bg_task = asyncio.create_task(guardian.loop())
        try:
            yield
        finally:
            guardian.stop()
            if bg_task:
                bg_task.cancel()
                try:
                    await bg_task
                except asyncio.CancelledError:
                    pass
            await guardian.aclose()
            if hasattr(runner, "aclose"):
                await runner.aclose()
            if owned_monitor:
                await monitor.aclose()

    app = FastAPI(title="AgentGov Intelligence", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {
            "ok": True,
            "guardian": {"enabled": settings.guardian_enabled, "authority": settings.guardian_authority},
            "jev": {"guardianShadow": settings.jev_guardian_enabled, "model": settings.jev_model},
        }

    @app.post("/chat")
    async def post_chat(req: ChatRequest) -> StreamingResponse:
        return StreamingResponse(
            chat.stream_events(req.messages, req.conversationId),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/lanes/draft")
    async def post_draft(req: DraftLaneRequest) -> JSONResponse:
        return JSONResponse(await drafter.draft(req.agentId, description=req.description, system_prompt=req.systemPrompt))

    @app.post("/investigate")
    async def post_investigate(req: InvestigateRequest) -> JSONResponse:
        return JSONResponse(await guardian.investigate_request(req.model_dump(exclude_none=True)))

    app.state.settings = settings
    app.state.monitor = monitor
    app.state.runner = runner
    return app


app = create_app()
