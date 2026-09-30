"""Control-plane Auditor: sensitive ARM/data-plane operations on AI resources and agent definition drift."""
from __future__ import annotations

import re
from datetime import timedelta

from ..models import AgentProfile, Alert, CanonicalEvent, EventKind, Platform
from .base import Context, make_alert

KEY_ENUM_THRESHOLD = 4


def _normalize_op(op: str) -> str:
    """ARM 'MICROSOFT.COGNITIVESERVICES/ACCOUNTS/LISTKEYS/ACTION' and data-plane audit 'ListKey' are the same act."""
    o = op.lower()
    if "listkey" in o:
        return "listkeys"
    if "regeneratekey" in o:
        return "regeneratekey"
    return o

# (operation regex, alert type, base score, description)
RULES: list[tuple[re.Pattern[str], str, float, str]] = [
    (re.compile(r"(?i)DIAGNOSTICSETTINGS/DELETE"), "TELEMETRY_TAMPERING", 75, "diagnostic settings deleted"),
    (re.compile(r"(?i)OPERATIONALINSIGHTS/WORKSPACES/(DELETE|TABLES/DELETE|DATAEXPORTS/DELETE)"), "TELEMETRY_TAMPERING",
     70, "Log Analytics data deleted"),
    (re.compile(r"(?i)INSIGHTS/COMPONENTS/DELETE"), "TELEMETRY_TAMPERING", 65, "Application Insights deleted"),
    (re.compile(r"(?i)RAIPOLICIES/(WRITE|DELETE)|RAIBLOCKLISTS/(WRITE|DELETE)"), "SENSITIVE_CONTROL_PLANE_OP", 60,
     "content filter / guardrail policy changed"),
    (re.compile(r"(?i)COGNITIVESERVICES/ACCOUNTS/(LISTKEYS|REGENERATEKEY)/ACTION|^ListKey$|^RegenerateKey"),
     "SENSITIVE_CONTROL_PLANE_OP", 45, "account keys listed or regenerated"),
    (re.compile(r"(?i)AUTHORIZATION/ROLEASSIGNMENTS/(WRITE|DELETE)"), "SENSITIVE_CONTROL_PLANE_OP", 50,
     "role assignment changed"),
    (re.compile(r"(?i)KEYVAULT/VAULTS/(WRITE|DELETE|ACCESSPOLICIES/WRITE)"), "SENSITIVE_CONTROL_PLANE_OP", 45,
     "Key Vault configuration changed"),
    (re.compile(r"(?i)ACCOUNTS/PROJECTS/CONNECTIONS/(WRITE|DELETE)|ACCOUNTS/CONNECTIONS/(WRITE|DELETE)"),
     "AGENT_CONFIG_CHANGE", 40, "Foundry tool/data connection changed"),
    (re.compile(r"(?i)ACCOUNTS/DEPLOYMENTS/(WRITE|DELETE)"), "AGENT_CONFIG_CHANGE", 25, "model deployment changed"),
    (re.compile(r"(?i)ACCOUNTS/PROJECTS/(WRITE|DELETE)$"), "AGENT_CONFIG_CHANGE", 25, "Foundry project changed"),
    (re.compile(r"(?i)COGNITIVESERVICES/ACCOUNTS/(WRITE|DELETE)$"), "AGENT_CONFIG_CHANGE", 30,
     "Foundry account (network/identity/auth) changed"),
    (re.compile(r"(?i)BOTSERVICE/.*/(WRITE|DELETE)|POWERPLATFORM/.*/(WRITE|DELETE)"), "AGENT_CONFIG_CHANGE", 30,
     "bot / Power Platform resource changed"),
]


class ControlPlaneAuditor:
    name = "control_plane_auditor"
    AI_SCOPE_RX = re.compile(r"(?i)/providers/(microsoft\.cognitiveservices|microsoft\.machinelearningservices|"
                             r"microsoft\.botservice|microsoft\.operationalinsights|microsoft\.insights/components|"
                             r"microsoft\.apimanagement)/")
    NEEDS_AI_SCOPE = re.compile(r"(?i)AUTHORIZATION/|KEYVAULT/|DIAGNOSTICSETTINGS/")

    def process(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        if event.kind != EventKind.CONTROL_PLANE:
            return []
        op = str(event.tool_name or "")
        if self.NEEDS_AI_SCOPE.search(op) and not self.AI_SCOPE_RX.search(event.resource_id or ""):
            return []
        for rx, alert_type, score, what in RULES:
            if not rx.search(op):
                continue
            failed = "fail" in str(event.status or "").lower()
            if failed:
                score += 10  # denied sensitive operations are a probing signal
            who = event.user_id or event.caller_object_id or "unknown"
            norm_op = _normalize_op(op)
            resource = (event.resource_id or "").lower()
            alerts = [make_alert(
                alert_type, self.name, event, score,
                f"{what.capitalize()} by {who} on {resource.rsplit('/', 1)[-1] or 'resource'}"
                f"{' (FAILED)' if failed else ''}: {op}.",
                {"operation": op, "caller": who, "caller_ip": event.caller_ip, "resource_id": event.resource_id,
                 "status": event.status, "fingerprint_basis": f"cp|{norm_op}|{resource}|{who.lower()}"},
                platform=Platform.AZURE_CONTROL_PLANE)]
            if norm_op in ("listkeys", "regeneratekey"):
                alerts += self._key_enumeration(event, ctx, who, resource)
            return alerts
        return []

    def _key_enumeration(self, event: CanonicalEvent, ctx: Context, who: str, resource: str) -> list[Alert]:
        """One identity pulling keys from many AI accounts in a short window looks like credential harvesting."""
        key = f"keyenum:{who.lower()}"
        b = ctx.state.get_baseline(key)
        cutoff = (event.occurred_at - timedelta(hours=1)).isoformat()
        seen = {r: t for r, t in b.get("accounts", {}).items() if t >= cutoff}
        seen[resource] = event.occurred_at.isoformat()
        b["accounts"] = seen
        out: list[Alert] = []
        n = len(seen)
        if n >= KEY_ENUM_THRESHOLD and b.get("alerted_n", 0) < n and b.get("alerted_until", "") < event.occurred_at.isoformat():
            b["alerted_n"] = n
            b["alerted_until"] = (event.occurred_at + timedelta(hours=6)).isoformat()
            out.append(make_alert(
                "CREDENTIAL_ACCESS", self.name, event, min(90, 60 + 2 * n),
                f"{who} listed keys on {n} AI accounts within an hour — possible credential harvesting of model "
                "endpoints (key-based access bypasses per-identity attribution).",
                {"caller": who, "accounts": sorted(r.rsplit('/', 1)[-1] for r in seen), "count": n,
                 "fingerprint_basis": f"keyenum|{who.lower()}|{event.occurred_at:%Y-%m-%d}"},
                title="Key enumeration across AI accounts", platform=Platform.AZURE_CONTROL_PLANE))
        ctx.state.put_baseline(key, b)
        return out

    def definition_changes(self, changed: list[AgentProfile], previous: dict[str, AgentProfile | None]) -> list[Alert]:
        """Alerts for agents whose definition (instructions/tools/model) changed since the last cycle."""
        alerts = []
        for p in changed:
            prev = previous.get(p.agent_key)
            added = sorted({t.get("name") for t in p.tools} - {t.get("name") for t in (prev.tools if prev else [])})
            removed = sorted({t.get("name") for t in (prev.tools if prev else [])} - {t.get("name") for t in p.tools})
            new_caps = sorted({c.value for c in p.allowed_capabilities} -
                              {c.value for c in (prev.allowed_capabilities if prev else [])})
            instr_changed = bool(prev and prev.instructions != p.instructions)
            score = 30 + (15 if new_caps else 0) + (10 if added else 0)
            e = CanonicalEvent(id=f"defchange:{p.agent_key}:{p.definition_hash}", platform=p.platform,
                               source="profiler", kind=EventKind.CONTROL_PLANE, occurred_at=p.updated_at,
                               agent_id=p.agent_id, agent_name=p.name, resource_id=p.resource_id)
            alerts.append(make_alert(
                "AGENT_CONFIG_CHANGE", self.name, e, score,
                f"Definition of {p.name} changed: tools added {added or '-'}, removed {removed or '-'}, "
                f"new capabilities {new_caps or '-'}, instructions {'changed' if instr_changed else 'unchanged'}.",
                {"tools_added": added, "tools_removed": removed, "new_capabilities": new_caps,
                 "instructions_changed": instr_changed, "definition_hash": p.definition_hash,
                 "previous_hash": prev.definition_hash if prev else None,
                 "fingerprint_basis": f"def|{p.agent_key}|{p.definition_hash}"}))
        return alerts
