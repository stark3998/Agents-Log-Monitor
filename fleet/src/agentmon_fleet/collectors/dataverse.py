"""Copilot Studio via Dataverse: agent definitions (bot/botcomponent) and conversation transcripts (incl. generative plans)."""
from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..auth import bearer
from ..config import Settings
from ..models import AgentProfile, Platform
from ..state import State
from .base import CollectResult, window
from .dataverse_transcripts import transcript_events

log = logging.getLogger(__name__)
COMPONENT_TYPES = {0: "topic", 1: "skill", 9: "topic_v2", 13: "skill_v2", 15: "custom_gpt", 16: "knowledge_source",
                   17: "external_trigger", 18: "copilot_settings"}


class DataverseCollector:
    name = "dataverse"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.org = (settings.dataverse_org_url or "").rstrip("/")
        self._http = httpx.Client(timeout=90)

    def _get_all(self, path: str, params: dict[str, str], limit: int = 2000) -> list[dict]:
        tok = bearer(f"{self.org}/.default")
        headers = {"Authorization": "Bearer " + tok, "Accept": "application/json", "OData-Version": "4.0",
                   "OData-MaxVersion": "4.0", "Prefer": "odata.maxpagesize=100"}
        url: str | None = f"{self.org}/api/data/v9.2/{path}"
        out: list[dict] = []
        first = True
        while url and len(out) < limit:
            r = self._http.get(url, params=params if first else None, headers=headers)
            r.raise_for_status()
            body = r.json()
            out.extend(body.get("value", []))
            url = body.get("@odata.nextLink")
            first = False
        return out

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        if not self.org:
            return out
        try:
            out.profiles.extend(self._profiles())
        except httpx.HTTPError as exc:
            out.errors.append(f"dataverse.bots: {exc}")
        names = {p.agent_id: p.name for p in out.profiles}
        start, end = window(state, "dataverse.transcripts", self.settings.lookback_minutes,
                            max(self.settings.overlap_minutes, 90))
        try:
            rows = self._get_all("conversationtranscripts", {
                "$select": "conversationtranscriptid,name,conversationstarttime,metadata,content,_bot_conversationtranscriptid_value,createdon",
                "$filter": f"createdon gt {start.strftime('%Y-%m-%dT%H:%M:%SZ')}",
                "$orderby": "createdon asc"})
        except httpx.HTTPError as exc:
            out.errors.append(f"dataverse.transcripts: {exc}")
            return out
        out.events.extend(transcript_events(rows, names, self.settings.pp_environment_id))
        state.set_cursor("dataverse.transcripts", end.isoformat())
        return out

    def _profiles(self) -> list[AgentProfile]:
        bots = self._get_all("bots", {"$select": "botid,name,schemaname,configuration,publishedon,statecode,authenticationmode"})
        comps = self._get_all("botcomponents", {
            "$select": "botcomponentid,name,schemaname,componenttype,description,data,_parentbotid_value,statecode",
            "$filter": "statecode eq 0"}, limit=5000)
        profiles = []
        for b in bots:
            mine = [c for c in comps if c.get("_parentbotid_value") == b["botid"]]
            instructions = ""
            tools: list[dict[str, Any]] = []
            knowledge: list[str] = []
            for c in mine:
                ctype = COMPONENT_TYPES.get(c.get("componenttype"), str(c.get("componenttype")))
                data = c.get("data") or ""
                if ctype == "custom_gpt":
                    m = re.search(r"(?ms)^instructions:\s*[|>]?-?\s*\n?(.*?)(?=^\w[\w ]*:|\Z)", data)
                    instructions = (m.group(1) if m else data).strip()[:8000]
                elif ctype == "knowledge_source":
                    knowledge.append(c.get("name") or c.get("schemaname"))
                elif "TaskDialog" in data or ".action." in (c.get("schemaname") or "") or "InvokeConnectorTaskAction" in data \
                        or "InvokeFlowTaskAction" in data or "MCP" in data[:400]:
                    kind = re.search(r"(?m)^\s*kind:\s*(\w+)", data.split("action:", 1)[-1])
                    tools.append({"name": c.get("schemaname"), "display": c.get("name"),
                                  "type": kind.group(1) if kind else "action",
                                  "description": (c.get("description") or "")[:500]})
                elif ctype in ("topic", "topic_v2"):
                    tools.append({"name": c.get("schemaname"), "display": c.get("name"), "type": "topic",
                                  "description": (c.get("description") or "")[:300]})
            profiles.append(AgentProfile(
                agent_key=f"{Platform.COPILOT_STUDIO}:{b['botid']}", platform=Platform.COPILOT_STUDIO, agent_id=b["botid"],
                name=b.get("name") or b.get("schemaname"), resource_id=f"{self.org}|{self.settings.pp_environment_id}",
                description=f"schema={b.get('schemaname')} auth={b.get('authenticationmode')}",
                instructions=instructions, tools=tools, knowledge=knowledge,
                definition_hash=AgentProfile.hash_definition(instructions, tools, knowledge)))
        return profiles