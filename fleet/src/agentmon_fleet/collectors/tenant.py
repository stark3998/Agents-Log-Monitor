"""Optional tenant-level collectors, each behind a feature flag (all off by default).

  purview   FLEET_TENANT_PURVIEW=true   O365 Management Activity API, Audit.General: CopilotInteraction (RecordType 261)
                                        and Copilot Studio Bot* operations.
            App permission: Office 365 Management APIs / ActivityFeed.Read (admin consent). The Audit.General
            subscription must be started once (FLEET_PURVIEW_START_SUBSCRIPTION=true lets the fleet start it).
  entra     FLEET_TENANT_ENTRA=true     Microsoft Graph: Entra Agent ID inventory (servicePrincipals/agentIdentity)
                                        registered as known callers and mapped to agent keys, plus agent sign-ins.
            App permissions: Application.Read.All (or AgentIdentity.Read.All), AuditLog.Read.All.
  defender  FLEET_TENANT_DEFENDER=true  Defender XDR advanced hunting through Graph runHuntingQuery: AI/agent alerts
                                        (AlertInfo + AlertEvidence), BehaviorInfo, Copilot Studio CloudAppEvents and
                                        the AgentsInfo inventory (Agent 365 licensing).
            App permission: ThreatHunting.Read.All.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import httpx

from ..auth import bearer
from ..config import Settings
from ..models import CanonicalEvent, Capability, Decision, Effect, EventKind, Platform
from ..state import State
from .base import CollectResult, parse_json, stable_id, to_dt, window

log = logging.getLogger(__name__)
GRAPH = "https://graph.microsoft.com"
GRAPH_SCOPE = "https://graph.microsoft.com/.default"
O365_SCOPE = "https://manage.office.com/.default"
TokenFn = Callable[[str], str]

COPILOT_INTERACTION = 261
BOT_OP_RX = re.compile(r"(?i)^bot|copilotstudio|^agent(create|update|delete|publish)")
BOT_CHANGE_RX = re.compile(r"(?i)(create|update|publish|delete|remove|share|import|enable|disable)")


def _get(d: dict[str, Any], *keys: str) -> Any:
    for k in keys:
        if d.get(k) not in (None, "", []):
            return d[k]
    return None


# ── Purview (O365 Management Activity API) ───────────────────────────────────
class PurviewCollector:
    name = "purview"
    MAX_BLOBS = 400

    def __init__(self, settings: Settings, http: httpx.Client | None = None, token: TokenFn = bearer) -> None:
        self.settings = settings
        tenant = settings.azure_tenant_id
        if not tenant:
            raise ValueError("FLEET_AZURE_TENANT_ID is required for the Purview collector")
        self.base = f"https://manage.office.com/api/v1.0/{tenant}/activity/feed"
        self.http = http or httpx.Client(timeout=60)
        self.token = token
        self._subscribed = False

    def _headers(self) -> dict[str, str]:
        return {"Authorization": "Bearer " + self.token(O365_SCOPE)}

    def _params(self, **kw: str) -> dict[str, str]:
        return {"PublisherIdentifier": self.settings.azure_tenant_id or "", **kw}

    def _ensure_subscription(self) -> None:
        if self._subscribed or not self.settings.purview_start_subscription:
            return
        r = self.http.post(f"{self.base}/subscriptions/start", headers=self._headers(),
                           params=self._params(contentType="Audit.General"))
        if r.status_code >= 400 and "already enabled" not in r.text.lower():
            r.raise_for_status()
        self._subscribed = True

    def _content_uris(self, start: datetime, end: datetime) -> list[str]:
        uris: list[str] = []
        s = max(start, end - timedelta(days=7) + timedelta(minutes=5))  # API only serves the last 7 days
        while s < end and len(uris) < self.MAX_BLOBS:
            e = min(end, s + timedelta(hours=24))  # max 24 h per listing
            url: str | None = f"{self.base}/subscriptions/content"
            params: dict[str, str] | None = self._params(contentType="Audit.General",
                                                         startTime=s.strftime("%Y-%m-%dT%H:%M:%S"),
                                                         endTime=e.strftime("%Y-%m-%dT%H:%M:%S"))
            while url and len(uris) < self.MAX_BLOBS:
                r = self.http.get(url, headers=self._headers(), params=params)
                r.raise_for_status()
                uris.extend(b["contentUri"] for b in r.json() or [] if b.get("contentUri"))
                url, params = r.headers.get("NextPageUri"), None
            s = e
        return uris

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        start, end = window(state, "tenant.purview", self.settings.lookback_minutes, max(self.settings.overlap_minutes, 60))
        try:
            self._ensure_subscription()
            for uri in self._content_uris(start, end):
                r = self.http.get(uri, headers=self._headers())
                r.raise_for_status()
                for rec in r.json() or []:
                    out.events.extend(purview_events(rec))
        except httpx.HTTPStatusError as exc:
            out.errors.append(f"purview: HTTP {exc.response.status_code} {exc.response.text[:200]}")
            return out
        except httpx.HTTPError as exc:
            out.errors.append(f"purview: {exc}")
            return out
        state.set_cursor("tenant.purview", end.isoformat())
        return out


def purview_events(rec: dict[str, Any]) -> list[CanonicalEvent]:
    """Map one unified-audit record to canonical events (empty for records the fleet does not use)."""
    op = str(rec.get("Operation") or "")
    when = to_dt(rec.get("CreationTime"))
    user = rec.get("UserId")
    rid = str(rec.get("Id") or stable_id(op, user, rec.get("CreationTime")))
    if rec.get("RecordType") == COPILOT_INTERACTION or op == "CopilotInteraction":
        return _copilot_interaction(rec, rid, when, user)
    if BOT_OP_RX.search(op) or "copilot studio" in str(rec.get("Workload", "")).lower():
        agent_id = _get(rec, "BotId", "AgentId", "ObjectId")
        verb = "DELETE" if re.search(r"(?i)delete|remove", op) else "WRITE" if BOT_CHANGE_RX.search(op) else "READ"
        return [CanonicalEvent(
            id=stable_id("purview", rid), platform=Platform.COPILOT_STUDIO, source="tenant.purview",
            kind=EventKind.CONTROL_PLANE, occurred_at=when, user_id=user, caller_ip=rec.get("ClientIP"),
            agent_id=agent_id, agent_name=_get(rec, "BotName", "AgentName"),
            resource_id=_get(rec, "EnvironmentId", "EnvironmentName"),
            tool_name=f"POWERPLATFORM/COPILOTSTUDIO/{op}/{verb}", status=str(rec.get("ResultStatus") or ""),
            attributes={"operation": op, "workload": rec.get("Workload"), "record_type": rec.get("RecordType")})]
    return []


def _copilot_interaction(rec: dict[str, Any], rid: str, when: datetime, user: str | None) -> list[CanonicalEvent]:
    data = rec.get("CopilotEventData") or {}
    agent_id = _get(data, "AgentId") or _get(rec, "AgentId")
    agent_name = _get(data, "AgentName") or _get(rec, "AgentName")
    app_host = _get(data, "AppHost") or "copilot"
    platform = Platform.COPILOT_STUDIO if agent_id or "studio" in str(app_host).lower() else Platform.CUSTOM
    session = _get(data, "ThreadId") or rid
    base = dict(platform=platform, source="tenant.purview", occurred_at=when, user_id=user, caller_ip=rec.get("ClientIP"),
                agent_id=agent_id or f"m365:{app_host}", agent_name=agent_name or f"Microsoft 365 Copilot ({app_host})",
                session_id=session)
    effects = []
    for res in data.get("AccessedResources") or []:
        label = _get(res, "SensitivityLabelId", "SensitivityLabel") or ""
        effects.append(Effect(capability=Capability.READ_DATA, resource=str(_get(res, "SiteUrl", "Name", "Id") or ""),
                              data_class=f"label:{label}" if label else "", executor=str(res.get("Type") or "copilot"),
                              evidence=str(res.get("Action") or "")[:200]))
    plugins = [p.get("Name") or p.get("Id") for p in data.get("AISystemPlugin") or [] if isinstance(p, dict)]
    events = [CanonicalEvent(
        id=stable_id("purview", rid), kind=EventKind.INFERENCE, effects=effects[:50], **base,
        attributes={"operation": "CopilotInteraction", "app_host": app_host, "plugins": plugins,
                    "messages": len(data.get("Messages") or []), "contexts": data.get("Contexts")})]
    for i, m in enumerate(data.get("Messages") or []):
        if isinstance(m, dict) and m.get("JailbreakDetected"):
            events.append(CanonicalEvent(
                id=stable_id("purview-jb", rid, m.get("Id") or i), kind=EventKind.POLICY_DECISION,
                decision=Decision.BLOCKED, decision_reason="jailbreak detected (Purview CopilotInteraction)",
                attributes={"message_id": m.get("Id"), "is_prompt": m.get("isPrompt")}, **base))
    return events


# ── Entra Agent ID (Microsoft Graph) ─────────────────────────────────────────
class EntraAgentIdCollector:
    name = "entra"
    INVENTORY_EVERY_S = 3600

    def __init__(self, settings: Settings, http: httpx.Client | None = None, token: TokenFn = bearer) -> None:
        self.settings = settings
        self.http = http or httpx.Client(timeout=60)
        self.token = token
        self._inventory_at = 0.0

    def _paged(self, url: str, params: dict[str, str] | None = None, limit: int = 5000) -> list[dict]:
        out: list[dict] = []
        headers = {"Authorization": "Bearer " + self.token(GRAPH_SCOPE), "ConsistencyLevel": "eventual"}
        next_url: str | None = url
        while next_url and len(out) < limit:
            r = self.http.get(next_url, headers=headers, params=params)
            r.raise_for_status()
            body = r.json()
            out.extend(body.get("value", []))
            next_url, params = body.get("@odata.nextLink"), None
        return out[:limit]

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        now = datetime.now(timezone.utc).timestamp()
        if now - self._inventory_at >= self.INVENTORY_EVERY_S:
            try:
                n = self._inventory(state)
                self._inventory_at = now
                log.info("entra: %d agent identities registered", n)
            except httpx.HTTPError as exc:
                out.errors.append(f"entra.inventory: {_http_err(exc)}")
        start, end = window(state, "tenant.entra.signins", self.settings.lookback_minutes, self.settings.overlap_minutes)
        try:
            rows = self._paged(f"{GRAPH}/beta/auditLogs/signIns", {
                "$filter": "signInEventTypes/any(t: t eq 'servicePrincipal') and agent/agentType eq 'AgentIdentity' "
                           f"and createdDateTime ge {start.strftime('%Y-%m-%dT%H:%M:%SZ')}",
                "$top": "500"}, limit=5000)
        except httpx.HTTPError as exc:
            out.errors.append(f"entra.signins: {_http_err(exc)}")
            return out
        out.events.extend(e for r in rows if (e := signin_event(r, state)) is not None)
        state.set_cursor("tenant.entra.signins", end.isoformat())
        return out

    def _inventory(self, state: State) -> int:
        idents = self._paged(f"{GRAPH}/v1.0/servicePrincipals/microsoft.graph.agentIdentity",
                             {"$select": "id,appId,displayName,agentIdentityBlueprintId,createdDateTime,tags"})
        profiles = {p.name.lower(): p.agent_key for p in state.list_profiles()}
        for a in idents:
            name = a.get("displayName") or a.get("appId") or a["id"]
            state.put_identity(a["id"].lower(), "agent_identity", name, match_agent_key(name, profiles))
        return len(idents)


def match_agent_key(identity_name: str, profiles: dict[str, str]) -> str | None:
    """Agent identities are usually named after the agent (optionally with a project/platform prefix or suffix)."""
    n = identity_name.lower()
    if n in profiles:
        return profiles[n]
    hits = [k for name, k in profiles.items() if len(name) >= 4 and (name in n or n in name)]
    return hits[0] if len(hits) == 1 else None


def signin_event(r: dict[str, Any], state: State) -> CanonicalEvent | None:
    sp = (r.get("servicePrincipalId") or "").lower()
    if not sp:
        return None
    ident = state.get_identity(sp) or {}
    agent_key = ident.get("agent_key") or ""
    platform_s, _, agent_id = agent_key.partition(":")
    try:
        platform = Platform(platform_s)
    except ValueError:
        platform = Platform.CUSTOM
    status = r.get("status") or {}
    code = status.get("errorCode") or 0
    failed = code not in (0, "0")
    agent = r.get("agent") or {}
    return CanonicalEvent(
        id=stable_id("entra-signin", r.get("id")), source="tenant.entra", platform=platform,
        kind=EventKind.POLICY_DECISION if failed else EventKind.CONTROL_PLANE, occurred_at=to_dt(r.get("createdDateTime")),
        agent_id=agent_id or sp, agent_name=ident.get("name") or r.get("servicePrincipalName"), caller_object_id=sp,
        caller_ip=r.get("ipAddress"), tool_name=None if failed else "ENTRA/AGENTSIGNIN/READ",
        dest_host=r.get("resourceDisplayName"), status=str(code),
        decision=Decision.BLOCKED if failed else Decision.ALLOWED,
        decision_reason=f"access denied: {status.get('failureReason') or code}" if failed else None,
        attributes={"resource": r.get("resourceDisplayName"), "resource_id": r.get("resourceId"),
                    "app_id": r.get("appId"), "agent_type": agent.get("agentType"),
                    "risk": r.get("riskLevelDuringSignIn"), "conditional_access": r.get("conditionalAccessStatus"),
                    "location": (r.get("location") or {}).get("countryOrRegion")})


# ── Defender XDR advanced hunting ────────────────────────────────────────────
HUNT_ALERTS = """AlertInfo
| where Timestamp between (datetime({start}) .. datetime({end}))
| where Title has_any ("AI", "agent", "Copilot", "prompt", "jailbreak", "LLM", "model")
    or Category has_any ("AI", "Agent") or DetectionSource has_any ("AI", "Agent")
| join kind=leftouter (AlertEvidence | where Timestamp between (datetime({start}) .. datetime({end}))
    | summarize Entities = make_set(pack("type", EntityType, "role", EvidenceRole, "account", AccountObjectId,
        "app", Application, "ip", RemoteIP, "url", RemoteUrl, "resource", CloudResource), 20) by AlertId) on AlertId
| project Timestamp, AlertId, Title, Category, Severity, ServiceSource, DetectionSource, AttackTechniques, Entities
| take 500"""
HUNT_BEHAVIORS = """BehaviorInfo
| where Timestamp between (datetime({start}) .. datetime({end}))
| where ServiceSource has_any ("AI", "Agent") or Description has_any ("agent", "Copilot", "AI ")
| project Timestamp, BehaviorId, ActionType, Description, Categories, AttackTechniques, ServiceSource,
    AccountObjectId, AccountUpn
| take 500"""
HUNT_CLOUDAPP = """CloudAppEvents
| where Timestamp between (datetime({start}) .. datetime({end}))
| where Application has_any ("Copilot Studio", "Power Virtual Agents", "Microsoft Power Platform")
| project Timestamp, ReportId, ActionType, Application, AccountObjectId, AccountDisplayName, IPAddress, ObjectId,
    ObjectName, RawEventData
| take 2000"""
HUNT_AGENTS = "AgentsInfo | take 1000"


class DefenderXdrCollector:
    name = "defender"

    def __init__(self, settings: Settings, http: httpx.Client | None = None, token: TokenFn = bearer) -> None:
        self.settings = settings
        self.http = http or httpx.Client(timeout=120)
        self.token = token
        self._missing: set[str] = set()

    def hunt(self, query: str) -> list[dict]:
        r = self.http.post(f"{GRAPH}/v1.0/security/runHuntingQuery", json={"Query": query},
                           headers={"Authorization": "Bearer " + self.token(GRAPH_SCOPE)})
        r.raise_for_status()
        return r.json().get("results", [])

    def collect(self, state: State) -> CollectResult:
        out = CollectResult()
        start, end = window(state, "tenant.defender", self.settings.lookback_minutes, self.settings.overlap_minutes)
        span = dict(start=start.strftime("%Y-%m-%dT%H:%M:%SZ"), end=end.strftime("%Y-%m-%dT%H:%M:%SZ"))
        ok = True
        for label, query, mapper in (("alerts", HUNT_ALERTS, defender_alert_event),
                                     ("behaviors", HUNT_BEHAVIORS, defender_behavior_event),
                                     ("cloudapp", HUNT_CLOUDAPP, cloudapp_event)):
            if label in self._missing:
                continue
            try:
                out.events.extend(e for row in self.hunt(query.format(**span)) if (e := mapper(row)) is not None)
            except httpx.HTTPStatusError as exc:
                if _table_missing(exc):
                    self._missing.add(label)  # not licensed / not onboarded: stop asking
                    log.info("defender: %s table unavailable; skipping", label)
                    continue
                ok = False
                out.errors.append(f"defender.{label}: {_http_err(exc)}")
            except httpx.HTTPError as exc:
                ok = False
                out.errors.append(f"defender.{label}: {exc}")
        if "agents" not in self._missing:
            try:
                register_agents_info(self.hunt(HUNT_AGENTS), state)
            except httpx.HTTPStatusError as exc:
                if _table_missing(exc):
                    self._missing.add("agents")
                else:
                    out.errors.append(f"defender.agents: {_http_err(exc)}")
            except httpx.HTTPError as exc:
                out.errors.append(f"defender.agents: {exc}")
        if ok:
            state.set_cursor("tenant.defender", end.isoformat())
        return out


def defender_alert_event(r: dict[str, Any]) -> CanonicalEvent:
    entities = parse_json(r.get("Entities")) or []
    account = next((e.get("account") for e in entities if isinstance(e, dict) and e.get("account")), None)
    return CanonicalEvent(
        id=stable_id("xdr-alert", r.get("AlertId")), platform=Platform.FOUNDRY, source="tenant.defender",
        kind=EventKind.POLICY_DECISION, occurred_at=to_dt(r.get("Timestamp")), caller_object_id=account,
        text=r.get("Title"), tool_name=r.get("Title") or r.get("Category"),
        attributes={"defender_alert": r.get("Title"), "severity": r.get("Severity"), "entity": entities[:20],
                    "extended": {"category": r.get("Category"), "service": r.get("ServiceSource"),
                                 "detection": r.get("DetectionSource"),
                                 "techniques": parse_json(r.get("AttackTechniques"))}})


def defender_behavior_event(r: dict[str, Any]) -> CanonicalEvent:
    return CanonicalEvent(
        id=stable_id("xdr-behavior", r.get("BehaviorId")), platform=Platform.FOUNDRY, source="tenant.defender",
        kind=EventKind.POLICY_DECISION, occurred_at=to_dt(r.get("Timestamp")),
        caller_object_id=r.get("AccountObjectId"), user_id=r.get("AccountUpn"), text=r.get("Description"),
        tool_name=r.get("ActionType"),
        attributes={"defender_alert": r.get("ActionType"), "severity": "medium", "entity": r.get("AccountUpn"),
                    "extended": {"categories": parse_json(r.get("Categories")), "service": r.get("ServiceSource"),
                                 "techniques": parse_json(r.get("AttackTechniques"))}})


def cloudapp_event(r: dict[str, Any]) -> CanonicalEvent | None:
    action = str(r.get("ActionType") or "")
    if not BOT_CHANGE_RX.search(action):
        return None  # reads/chats are covered by transcripts and Purview; keep configuration changes only
    raw = parse_json(r.get("RawEventData")) or {}
    verb = "DELETE" if re.search(r"(?i)delete|remove", action) else "WRITE"
    return CanonicalEvent(
        id=stable_id("xdr-cloudapp", r.get("ReportId"), action), platform=Platform.COPILOT_STUDIO,
        source="tenant.defender.cloudapp", kind=EventKind.CONTROL_PLANE, occurred_at=to_dt(r.get("Timestamp")),
        user_id=r.get("AccountDisplayName"), caller_object_id=r.get("AccountObjectId"), caller_ip=r.get("IPAddress"),
        agent_id=_get(raw, "BotId", "AgentId") or r.get("ObjectId"), agent_name=r.get("ObjectName"),
        tool_name=f"POWERPLATFORM/COPILOTSTUDIO/{action}/{verb}",
        attributes={"operation": action, "application": r.get("Application")})


def register_agents_info(rows: list[dict[str, Any]], state: State) -> int:
    """AgentsInfo (Agent 365) schema is still evolving: take whatever identity columns are present."""
    n = 0
    for r in rows:
        oid = _get(r, "AgentObjectId", "ObjectId", "EntraObjectId", "AgentIdentityId")
        if not oid:
            continue
        state.put_identity(str(oid).lower(), "agent_identity",
                           str(_get(r, "AgentName", "DisplayName", "Name") or oid))
        n += 1
    return n


def _table_missing(exc: httpx.HTTPStatusError) -> bool:
    t = exc.response.text.lower()
    return exc.response.status_code in (400, 404) and ("failed to resolve table" in t or "semantic error" in t
                                                        or "could not be found" in t)


def _http_err(exc: httpx.HTTPError) -> str:
    if isinstance(exc, httpx.HTTPStatusError):
        return f"HTTP {exc.response.status_code} {exc.response.text[:200]}"
    return str(exc)


def tenant_collectors(settings: Settings) -> list[Any]:
    cols: list[Any] = []
    for flag, cls in ((settings.tenant_purview, PurviewCollector), (settings.tenant_entra, EntraAgentIdCollector),
                      (settings.tenant_defender, DefenderXdrCollector)):
        if not flag:
            continue
        try:
            cols.append(cls(settings))
        except ValueError as exc:
            log.warning("%s disabled: %s", cls.__name__, exc)
    return cols
