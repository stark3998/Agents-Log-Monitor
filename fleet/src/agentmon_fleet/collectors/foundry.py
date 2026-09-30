"""Foundry data-plane collector: agent definitions (v2 + classic), Responses API traffic, classic threads/runs/steps."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from ..auth import AI_SCOPE, bearer
from ..config import Settings
from ..models import AgentProfile, CanonicalEvent, Decision, EventKind, Platform
from ..state import State
from .base import CollectResult, to_dt
from .discovery import FoundryProject, discover
from .foundry_items import items_to_events
from .foundry_classic import run_steps_to_events

log = logging.getLogger(__name__)
MAX_RESPONSES = 200
MAX_THREADS = 60


class FoundryCollector:
    name = "foundry"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._http = httpx.Client(timeout=60)
        self._denied: set[str] = set()

    def _get(self, url: str, params: dict[str, Any] | None = None) -> dict:
        tok = bearer(AI_SCOPE)
        r = self._http.get(url, params=params, headers={"Authorization": "Bearer " + tok})
        r.raise_for_status()
        return r.json()

    def _paged(self, url: str, params: dict[str, Any], limit: int) -> list[dict]:
        out: list[dict] = []
        p = dict(params)
        while len(out) < limit:
            body = self._get(url, p)
            data = body.get("data", [])
            out.extend(data)
            if not body.get("has_more") or not data:
                break
            p["after"] = body.get("last_id") or data[-1].get("id")
        return out[:limit]

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        try:
            projects = discover(self.settings, state).projects
        except Exception as exc:
            out.errors.append(f"foundry.discovery: {exc}")
            projects = []
        for proj in projects:
            if proj.endpoint in self._denied:
                continue
            if self.settings.content_projects and not any(
                    s.lower() in proj.endpoint.lower() for s in self.settings.content_projects):
                continue  # metadata for these comes from diagnostics; deep content only for allow-listed projects
            try:
                out.profiles.extend(self._profiles(proj))
                resp_events = self._responses(proj, state)
                out.events.extend(resp_events)
                out.profiles.extend(self.inline_profiles(resp_events))
                out.events.extend(self._classic_threads(proj, state))
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code in (401, 403):
                    self._denied.add(proj.endpoint)
                    log.info("no data-plane access to %s (grant Foundry User to the fleet identity)", proj.endpoint)
                else:
                    out.errors.append(f"foundry {proj.name}: {exc.response.status_code} {exc.request.url.path}")
            except httpx.HTTPError as exc:
                out.errors.append(f"foundry {proj.name}: {exc}")
        return out

    # ── agent definitions → profiles ────────────────────────────────────────
    def _profiles(self, proj: FoundryProject) -> list[AgentProfile]:
        profiles: list[AgentProfile] = []
        for a in self._paged(f"{proj.endpoint}/agents", {"api-version": "v1", "limit": 100}, 500):
            latest = ((a.get("versions") or {}).get("latest") or {})
            d = latest.get("definition") or {}
            profiles.append(self._profile(proj, a.get("id") or a.get("name"), a.get("name"), d.get("instructions") or "",
                                          d.get("tools") or [], latest.get("description") or "", d.get("kind", "prompt"),
                                          d.get("model"), latest.get("version")))
        for a in self._paged(f"{proj.endpoint}/assistants", {"api-version": "v1", "limit": 100}, 500):
            profiles.append(self._profile(proj, a["id"], a.get("name") or a["id"], a.get("instructions") or "",
                                          a.get("tools") or [], a.get("description") or "", "classic", a.get("model"), None))
        return profiles

    @staticmethod
    def _profile(proj: FoundryProject, agent_id: str, name: str, instructions: str, tools: list[dict], description: str,
                 kind: str, model: str | None, version: str | None) -> AgentProfile:
        norm_tools = []
        for t in tools:
            fn = t.get("function") or {}
            norm_tools.append({"type": t.get("type"), "name": fn.get("name") or t.get("name") or t.get("server_label")
                               or t.get("type"), "description": (fn.get("description") or t.get("description") or
                                                                 t.get("server_url") or "")[:500],
                               "require_approval": t.get("require_approval"), "allowed_tools": t.get("allowed_tools")})
        return AgentProfile(
            agent_key=f"{Platform.FOUNDRY}:{agent_id}", platform=Platform.FOUNDRY, agent_id=agent_id, name=name or agent_id,
            resource_id=proj.resource_id or proj.endpoint, description=description, instructions=instructions,
            tools=norm_tools, definition_hash=AgentProfile.hash_definition(instructions, norm_tools, model),
            knowledge=[f"kind={kind}", f"model={model}", f"version={version}", f"project={proj.endpoint}"])

    # ── Responses API (v2 agents + direct "agent inference" apps) ───────────
    def _responses(self, proj: FoundryProject, state: State) -> list[CanonicalEvent]:
        key = f"foundry.responses:{proj.endpoint}"
        default_since = (datetime.now(timezone.utc) - timedelta(minutes=self.settings.lookback_minutes)).timestamp()
        since = float(state.get_cursor(key) or default_since)
        url = f"{proj.endpoint}/openai/v1/responses"
        fresh: list[dict] = []
        params: dict[str, Any] = {"limit": 100, "order": "desc"}
        while len(fresh) < MAX_RESPONSES:
            body = self._get(url, params)
            data = body.get("data", [])
            stop = False
            for r in data:
                if r.get("created_at", 0) <= since:
                    stop = True
                    break
                if r.get("status") in ("completed", "failed", "incomplete", "cancelled"):
                    fresh.append(r)
            if stop or not body.get("has_more") or not data:
                break
            params["after"] = data[-1]["id"]
        events: list[CanonicalEvent] = []
        for r in sorted(fresh, key=lambda x: x.get("created_at", 0)):
            events.extend(self._response_events(proj, r, state))
        if fresh:
            state.set_cursor(key, str(max(r["created_at"] for r in fresh)))
        return events

    def _response_events(self, proj: FoundryProject, r: dict, state: State) -> list[CanonicalEvent]:
        agent = r.get("agent") or r.get("agent_reference") or {}
        meta = r.get("metadata") or {}
        if agent.get("name"):
            agent_id, agent_name, platform = agent.get("name"), agent.get("name"), Platform.FOUNDRY
        else:
            # Direct Responses API use ("agent inference"): group by declared app name, else by tool set.
            tools = sorted(t.get("name") or t.get("type", "") for t in r.get("tools") or [])
            label = meta.get("agent_name") or meta.get("app") or (("app:" + "+".join(tools)[:60]) if tools else "app:chat")
            agent_id, agent_name, platform = f"{proj.name}/{label}", label, Platform.AZURE_OPENAI
        conv = r.get("conversation")
        conv_id = conv.get("id") if isinstance(conv, dict) else conv
        prev = r.get("previous_response_id")
        root = conv_id or (state.get_cursor(f"resproot:{prev}") if prev else None) or prev or r["id"]
        state.set_cursor(f"resproot:{r['id']}", root)
        try:
            inputs = self._paged(f"{proj.endpoint}/openai/v1/responses/{r['id']}/input_items",
                                 {"order": "asc", "limit": 100}, 300)
        except httpx.HTTPError:
            inputs = []
        base = dict(platform=platform, source="foundry.responses", resource_id=proj.resource_id or proj.endpoint,
                    agent_id=agent_id, agent_name=agent_name, agent_version=agent.get("version"), session_id=root,
                    turn_id=r["id"], model=r.get("model"), user_id=r.get("user") or meta.get("user_id"))
        when = to_dt(r.get("created_at"))
        # Only new input for this turn: drop items already seen in earlier turns of the chain.
        events = items_to_events(inputs + (r.get("output") or []), base=base, occurred_at=when, id_prefix=r["id"])
        if not agent.get("name") and (r.get("instructions") or r.get("tools")):
            for e in events:
                e.attributes.setdefault("inline_definition", {"instructions": (r.get("instructions") or "")[:4000],
                                                              "tools": [t.get("name") or t.get("type")
                                                                        for t in r.get("tools") or []]})
        usage = r.get("usage") or {}
        if events:
            events[-1].tokens_in = usage.get("input_tokens")
            events[-1].tokens_out = usage.get("output_tokens")
        err = r.get("error") or {}
        incomplete = r.get("incomplete_details") or {}
        reason = err.get("code") or incomplete.get("reason")
        if reason and any(k in str(reason).lower() for k in ("content_filter", "jailbreak", "responsible_ai", "policy")):
            last_user = next((e.text for e in reversed(events) if e.kind == EventKind.USER_MESSAGE), None)
            events.append(CanonicalEvent(
                id=f"{r['id']}:block", kind=EventKind.POLICY_DECISION, occurred_at=when, decision=Decision.BLOCKED,
                decision_reason=f"content_filter: {err.get('message') or reason}"[:500], text=last_user,
                attributes={"content_filters": r.get("content_filters")}, **base))
        return events

    def inline_profiles(self, events: list[CanonicalEvent]) -> list[AgentProfile]:
        """Synthesize profiles for direct Responses API apps from the instructions/tools they send."""
        seen: dict[str, AgentProfile] = {}
        for e in events:
            d = e.attributes.get("inline_definition")
            if not d or e.agent_key in seen:
                continue
            seen[e.agent_key] = AgentProfile(
                agent_key=e.agent_key, platform=e.platform, agent_id=e.agent_id, name=e.agent_name or "app",
                resource_id=e.resource_id, instructions=d.get("instructions", ""),
                tools=[{"name": t} for t in d.get("tools", [])],
                definition_hash=AgentProfile.hash_definition(d), derived_by="inline")
        return list(seen.values())

    # ── classic Agent Service (threads / runs / steps) ──────────────────────
    def _classic_threads(self, proj: FoundryProject, state: State) -> list[CanonicalEvent]:
        key = f"foundry.threads:{proj.endpoint}"
        default_since = (datetime.now(timezone.utc) - timedelta(minutes=self.settings.lookback_minutes)).timestamp()
        since = float(state.get_cursor(key) or default_since)
        base_q = {"api-version": "v1"}
        threads = [t for t in self._paged(f"{proj.endpoint}/threads", {**base_q, "limit": 100, "order": "desc"}, MAX_THREADS)
                   if t.get("created_at", 0) > since - 3600]
        events: list[CanonicalEvent] = []
        newest = since
        for t in threads:
            runs = self._paged(f"{proj.endpoint}/threads/{t['id']}/runs", {**base_q, "limit": 50, "order": "asc"}, 100)
            done = [ru for ru in runs if ru.get("status") in ("completed", "failed", "cancelled", "expired", "incomplete")
                    and (ru.get("completed_at") or ru.get("failed_at") or ru.get("cancelled_at") or 0) > since]
            if not done:
                continue
            msgs = self._paged(f"{proj.endpoint}/threads/{t['id']}/messages", {**base_q, "limit": 100, "order": "asc"}, 300)
            for ru in done:
                steps = self._paged(f"{proj.endpoint}/threads/{t['id']}/runs/{ru['id']}/steps",
                                    {**base_q, "limit": 100, "order": "asc"}, 300)
                events.extend(run_steps_to_events(proj, t["id"], ru, steps, msgs))
                newest = max(newest, float(ru.get("completed_at") or ru.get("failed_at") or ru.get("created_at") or 0))
        if newest > since:
            state.set_cursor(key, str(newest))
        return events