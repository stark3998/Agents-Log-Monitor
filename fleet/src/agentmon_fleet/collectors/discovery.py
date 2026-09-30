"""Subscription-wide discovery of Foundry / Azure OpenAI accounts and projects via ARM."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx

from ..auth import ARM_SCOPE, bearer
from ..config import Settings
from ..state import State

log = logging.getLogger(__name__)
ARM = "https://management.azure.com"
API = "2025-06-01"


@dataclass
class FoundryProject:
    account_id: str
    account_name: str
    name: str
    resource_id: str
    endpoint: str
    principal_id: str | None = None
    location: str = ""


@dataclass
class Inventory:
    accounts: list[dict] = field(default_factory=list)
    projects: list[FoundryProject] = field(default_factory=list)


def _get(url: str, token: str) -> dict:
    r = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def _list(url: str, token: str) -> list[dict]:
    items: list[dict] = []
    while url:
        body = _get(url, token)
        items.extend(body.get("value", []))
        url = body.get("nextLink") or ""
    return items


def discover(settings: Settings, state: State | None = None) -> Inventory:
    subs = settings.scope_subscriptions or ([settings.subscription_id] if settings.subscription_id else [])
    token = bearer(ARM_SCOPE)
    inv = Inventory()
    for sub in subs:
        try:
            accounts = _list(f"{ARM}/subscriptions/{sub}/providers/Microsoft.CognitiveServices/accounts?api-version={API}", token)
        except httpx.HTTPError as exc:
            log.warning("discovery failed for %s: %s", sub, exc)
            continue
        for a in accounts:
            inv.accounts.append({"id": a["id"], "name": a["name"], "kind": a.get("kind"), "location": a.get("location"),
                                 "principal_id": (a.get("identity") or {}).get("principalId")})
            pid = (a.get("identity") or {}).get("principalId")
            if state and pid:
                state.put_identity(pid, "foundry_account", a["name"])
            if a.get("kind") != "AIServices":
                continue
            try:
                projects = _list(f"{ARM}{a['id']}/projects?api-version={API}", token)
            except httpx.HTTPError:
                projects = []
            for p in projects:
                ep = ((p.get("properties") or {}).get("endpoints") or {}).get("AI Foundry API")
                if not ep:
                    continue
                ppid = (p.get("identity") or {}).get("principalId")
                proj = FoundryProject(account_id=a["id"], account_name=a["name"], name=p["name"].split("/")[-1],
                                      resource_id=p["id"], endpoint=ep.rstrip("/"), principal_id=ppid,
                                      location=a.get("location", ""))
                inv.projects.append(proj)
                if state and ppid:
                    state.put_identity(ppid, "foundry_project", f"{a['name']}/{proj.name}")
    extra = {e.rstrip("/") for e in settings.foundry_projects}
    if settings.foundry_project_endpoint:
        extra.add(settings.foundry_project_endpoint.rstrip("/"))
    known = {p.endpoint for p in inv.projects}
    for ep in extra - known:
        inv.projects.append(FoundryProject(account_id="", account_name=ep.split("//")[1].split(".")[0],
                                           name=ep.rsplit("/", 1)[-1], resource_id="", endpoint=ep))
    return inv
