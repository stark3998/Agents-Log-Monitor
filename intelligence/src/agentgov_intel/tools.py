from __future__ import annotations

from collections.abc import Collection
from typing import Any

from .config import Settings

READ_ONLY_TOOLS: tuple[str, ...] = (
    "list_agents",
    "get_agent",
    "list_sessions",
    "get_session_timeline",
    "search_actions",
    "list_decisions",
    "get_decision",
    "list_blocked_actions",
    "list_pending_approvals",
    "list_incidents",
    "get_incident",
    "list_lanes",
    "get_lane",
    "simulate_lane",
    "verify_audit_chain",
    "get_overview_stats",
)

CONTAINMENT_TOOLS: tuple[str, ...] = ("pause_agent", "quarantine_session", "update_incident", "create_incident")
AUTONOMOUS_TOOLS: tuple[str, ...] = ("propose_lane_change",)
GUARDIAN_SELF_LANE_ID = "monitor-guardian"


def guardian_allowed_tools(authority: str) -> tuple[str, ...]:
    if authority == "contain":
        return (*READ_ONLY_TOOLS, *CONTAINMENT_TOOLS)
    if authority == "autonomous":
        return (*READ_ONLY_TOOLS, *CONTAINMENT_TOOLS, *AUTONOMOUS_TOOLS)
    return READ_ONLY_TOOLS


def chat_allowed_tools() -> tuple[str, ...]:
    return READ_ONLY_TOOLS


def reject_guardian_self_lane(lane_id: str | None) -> None:
    if lane_id == GUARDIAN_SELF_LANE_ID:
        raise ValueError("Guardian cannot modify lane 'monitor-guardian'")


class MonitorMCPToolFactory:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._credential: Any | None = None

    def headers(self, _: dict[str, Any] | None = None) -> dict[str, str]:
        if self.settings.monitor_token:
            return {"Authorization": f"Bearer {self.settings.monitor_token}"}
        if not self.settings.entra_api_audience:
            return {}
        if self._credential is None:
            from azure.identity import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        scope = self.settings.entra_api_audience
        if not scope.endswith("/.default"):
            scope = scope.rstrip("/") + "/.default"
        token = self._credential.get_token(scope).token
        return {"Authorization": f"Bearer {token}"}

    def streamable_http_tool(self, *, name: str, description: str, allowed_tools: Collection[str]) -> Any:
        from agent_framework import MCPStreamableHTTPTool

        return MCPStreamableHTTPTool(
            name=name,
            description=description,
            url=self.settings.monitor_mcp_url,
            header_provider=self.headers,
            allowed_tools=tuple(allowed_tools),
        )
