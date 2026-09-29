from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from .config import Settings


class MonitorAuth:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._credential: Any | None = None

    async def token(self) -> str | None:
        if self.settings.monitor_token:
            return self.settings.monitor_token
        if not self.settings.entra_api_audience:
            return None
        if self._credential is None:
            from azure.identity.aio import DefaultAzureCredential

            self._credential = DefaultAzureCredential()
        scope = self.settings.entra_api_audience
        if not scope.endswith("/.default"):
            scope = scope.rstrip("/") + "/.default"
        access = await self._credential.get_token(scope)
        return access.token

    async def headers(self) -> dict[str, str]:
        tok = await self.token()
        return {"Authorization": f"Bearer {tok}"} if tok else {}

    async def aclose(self) -> None:
        if self._credential is not None:
            await self._credential.close()


class MonitorClient:
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.AsyncClient | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self.auth = MonitorAuth(settings)
        self._owned = client is None
        self.client = client or httpx.AsyncClient(base_url=settings.monitor_api_url.rstrip("/"), timeout=30, transport=transport)

    async def aclose(self) -> None:
        await self.auth.aclose()
        if self._owned:
            await self.client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers.update(await self.auth.headers())
        resp = await self.client.request(method, path, headers=headers, **kwargs)
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def list_decisions(self, **params: Any) -> dict[str, Any]:
        return await self._request("GET", "/api/gov/decisions", params={k: v for k, v in params.items() if v is not None})

    async def get_decision(self, decision_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/gov/decisions/{decision_id}")

    async def list_incidents(self, **params: Any) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/gov/incidents", params={k: v for k, v in params.items() if v is not None})

    async def get_incident(self, incident_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/api/gov/incidents/{incident_id}")

    async def create_incident(self, incident: dict[str, Any]) -> dict[str, Any]:
        return await self._request("POST", "/api/gov/incidents", json=incident)

    async def patch_incident(self, incident_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return await self._request("PATCH", f"/api/gov/incidents/{incident_id}", json=patch)

    async def list_agents(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/api/gov/agents")

    async def get_agent(self, agent_id: str) -> dict[str, Any] | None:
        for agent in await self.list_agents():
            if agent.get("id") == agent_id:
                return agent
        return None

    async def validate_lane(self, *, yaml_text: str | None = None, lane: dict[str, Any] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"yaml": yaml_text} if yaml_text is not None else {"lane": lane}
        return await self._request("POST", "/api/gov/lanes/validate", json=body)

    async def simulate_lane(self, *, yaml_text: str | None = None, lane: dict[str, Any] | None = None, **opts: Any) -> dict[str, Any]:
        body: dict[str, Any] = {"yaml": yaml_text} if yaml_text is not None else {"lane": lane}
        body.update({k: v for k, v in opts.items() if v is not None})
        return await self._request("POST", "/api/gov/lanes/simulate", json=body)

    async def create_lane(self, *, yaml_text: str | None = None, lane: dict[str, Any] | None = None, status: str = "proposed") -> dict[str, Any]:
        body: dict[str, Any] = {"yaml": yaml_text} if yaml_text is not None else {"lane": lane}
        body["status"] = status
        return await self._request("POST", "/api/gov/lanes", json=body)


@asynccontextmanager
async def monitor_client(settings: Settings, **kwargs: Any) -> AsyncIterator[MonitorClient]:
    client = MonitorClient(settings, **kwargs)
    try:
        yield client
    finally:
        await client.aclose()
