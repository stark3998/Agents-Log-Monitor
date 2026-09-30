"""Inference & Network Sentinel: who calls models directly, how much, denied bursts, content-filter hits,
suspicious flows, and Defender for AI alerts mapped onto the fleet taxonomy."""
from __future__ import annotations

import math
import re
from datetime import datetime, timedelta

from ..models import Alert, CanonicalEvent, Decision, EventKind, Platform
from .base import Context, make_alert

MODEL_OP_RX = re.compile(r"(?i)(chat|completion|response|embedding|image|audio|speech|generate|root_wildcard_post|"
                         r"^post$|responses|embeddings)")
AGENT_MGMT_RX = re.compile(r"(?i)(assistant|thread|run|vector|agent|project|connection|file|blocklist)")

DEFENDER_MAP: list[tuple[str, str]] = [
    ("Jailbreak", "JAILBREAK_ATTEMPT"),
    ("CredentialTheft", "CREDENTIAL_ACCESS"),
    ("MaliciousUrl", "UNAPPROVED_DESTINATION"),
    ("ASCIISmuggling", "PROMPT_INJECTION_SUSPECTED"),
    ("AnomalousToolInvocation", "OUT_OF_CHARTER_ACTION"),
    ("LLMReconnaissance", "INTENT_OUT_OF_SCOPE"),
    ("DOWVolumeAnomaly", "INFERENCE_ANOMALY"),
    ("AccessFromAnonymizedIP", "UNREGISTERED_INFERENCE_CALLER"),
    ("AccessFromSuspiciousIP", "UNREGISTERED_INFERENCE_CALLER"),
    ("AccessAnomaly", "UNREGISTERED_INFERENCE_CALLER"),
    ("DataExfiltration", "DATA_EXFILTRATION"),
    ("SensitiveData", "DATA_EXFILTRATION"),
]
DEFENDER_SEVERITY = {"high": 80, "medium": 60, "low": 40, "informational": 20}
COMMON_PORTS = {53, 80, 123, 443, 8443}


def _hour(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H")


def _short_resource(rid: str | None) -> str:
    return (rid or "").rstrip("/").rsplit("/", 1)[-1].lower()


class InferenceNetworkSentinel:
    name = "inference_network_sentinel"

    def process(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        if event.kind == EventKind.INFERENCE and event.source.startswith(("law.inference", "storage")):
            return self._inference(event, ctx)
        if event.kind == EventKind.NETWORK_FLOW:
            return self._flow(event, ctx)
        if event.kind == EventKind.POLICY_DECISION and event.source in ("law.defender", "tenant.defender"):
            return self._defender(event)
        return []

    # ── direct inference / data-plane access ────────────────────────────────
    def _known(self, oid: str | None, ctx: Context) -> bool:
        if not oid:
            return True  # key-based calls carry no identity; handled via ListKey audit instead
        o = oid.lower()
        if o in {k.lower() for k in ctx.settings.known_callers}:
            return True
        ident = ctx.state.get_identity(o)
        return bool(ident and ident.get("kind") in ("foundry_account", "foundry_project", "agent", "agent_identity",
                                                    "fleet", "allowed"))

    def _inference(self, e: CanonicalEvent, ctx: Context) -> list[Alert]:
        alerts: list[Alert] = []
        op = str(e.attributes.get("operation") or "")
        caller = (e.caller_object_id or "").lower()
        res = _short_resource(e.resource_id) or str(e.attributes.get("resource") or "").lower()
        is_model_call = e.attributes.get("category") == "AzureOpenAIRequestUsage" or (
            MODEL_OP_RX.search(op) and not AGENT_MGMT_RX.search(op))

        if e.decision == Decision.BLOCKED and "access denied" in (e.decision_reason or ""):
            alerts += self._denied_burst(e, ctx, caller, res, op)
        if e.decision == Decision.BLOCKED and (e.decision_reason or "").startswith("content_filter"):
            alerts += self._filter_hits(e, ctx, caller, res)
        if not is_model_call or e.decision == Decision.BLOCKED:
            return alerts

        tokens = (e.tokens_in or 0) + (e.tokens_out or 0)
        key = f"inf:{caller or 'key'}:{res}"
        b = ctx.state.get_baseline(key)
        hour = _hour(e.occurred_at)
        if b.get("hour") != hour:
            if b.get("hour"):
                prev = float(b.get("tokens", 0))
                mean, var, n = float(b.get("mean", prev)), float(b.get("var", 0.0)), int(b.get("n", 0))
                alpha = 0.2
                diff = prev - mean
                mean += alpha * diff
                var = (1 - alpha) * (var + alpha * diff * diff)
                b.update(mean=mean, var=var, n=n + 1)
            b.update(hour=hour, tokens=0, requests=0, alerted=False)
        b["tokens"] = int(b.get("tokens", 0)) + tokens
        b["requests"] = int(b.get("requests", 0)) + 1
        b.setdefault("first_seen", e.occurred_at.isoformat())
        b["last_seen"] = e.occurred_at.isoformat()
        deployments = set(b.get("deployments", []))
        if e.model:
            deployments.add(e.model)
        b["deployments"] = sorted(deployments)[:20]
        mean, std = float(b.get("mean", 0.0)), math.sqrt(float(b.get("var", 0.0)))
        threshold = max(ctx.settings.inference_hourly_token_alert, mean + 4 * std) if b.get("n", 0) >= 6 else \
            ctx.settings.inference_hourly_token_alert
        if not b.get("alerted") and b["tokens"] > threshold:
            b["alerted"] = True
            alerts.append(make_alert(
                "INFERENCE_ANOMALY", self.name, e, 55 if b["tokens"] < 2 * threshold else 70,
                f"{b['tokens']:,} tokens in hour {hour} from caller {caller or 'API key'} on {res} "
                f"(baseline {mean:,.0f}±{std:,.0f}).",
                {"caller": caller, "resource": res, "hour": hour, "tokens": b["tokens"], "requests": b["requests"],
                 "baseline_mean": round(mean), "baseline_std": round(std), "deployments": b["deployments"],
                 "fingerprint_basis": f"anom|{caller}|{res}|{hour}"}, platform=Platform.AZURE_OPENAI))
        if caller and not self._known(caller, ctx) and not b.get("unregistered_alerted"):
            b["unregistered_alerted"] = True
            alerts.append(make_alert(
                "UNREGISTERED_INFERENCE_CALLER", self.name, e, 30,
                f"Identity {caller} calls models on {res} directly ({e.model or op}) and is not a registered agent "
                "or allow-listed application.",
                {"caller": caller, "caller_ip": e.caller_ip, "resource": res, "operation": op, "model": e.model,
                 "fingerprint_basis": f"unreg|{caller}|{res}"}, platform=Platform.AZURE_OPENAI))
        ctx.state.put_baseline(key, b)
        inventory = ctx.state.get_baseline("inference_inventory")
        entry = inventory.setdefault(f"{caller or 'key'}|{res}", {"first_seen": e.occurred_at.isoformat(), "tokens": 0,
                                                                  "requests": 0, "deployments": []})
        entry["last_seen"] = e.occurred_at.isoformat()
        entry["tokens"] += tokens
        entry["requests"] += 1
        if e.model and e.model not in entry["deployments"]:
            entry["deployments"].append(e.model)
        entry["registered"] = self._known(caller, ctx)
        ctx.state.put_baseline("inference_inventory", inventory)
        return alerts

    def _window_count(self, ctx: Context, key: str, at: datetime, minutes: int) -> tuple[int, dict]:
        b = ctx.state.get_baseline(key)
        stamps = [s for s in b.get("stamps", []) if s >= (at - timedelta(minutes=minutes)).isoformat()]
        stamps.append(at.isoformat())
        b["stamps"] = stamps[-500:]
        ctx.state.put_baseline(key, b)
        return len(stamps), b

    def _denied_burst(self, e: CanonicalEvent, ctx: Context, caller: str, res: str, op: str) -> list[Alert]:
        n, b = self._window_count(ctx, f"deny:{caller}:{res}", e.occurred_at, 10)
        if n < ctx.settings.denied_burst_threshold or b.get("alerted_until", "") > e.occurred_at.isoformat():
            return []
        b["alerted_until"] = (e.occurred_at + timedelta(hours=1)).isoformat()
        ctx.state.put_baseline(f"deny:{caller}:{res}", b)
        return [make_alert(
            "ACCESS_DENIED_BURST", self.name, e, 50 if self._known(caller, ctx) else 62,
            f"{n} denied requests in 10 minutes from {caller or 'unknown caller'} ({e.caller_ip}) against {res} "
            f"(e.g. {op}). Possible enumeration or a misconfigured agent identity.",
            {"caller": caller, "caller_ip": e.caller_ip, "resource": res, "count_10m": n, "operation": op,
             "fingerprint_basis": f"deny|{caller}|{res}|{_hour(e.occurred_at)}"}, platform=Platform.AZURE_OPENAI)]

    def _filter_hits(self, e: CanonicalEvent, ctx: Context, caller: str, res: str) -> list[Alert]:
        n, _ = self._window_count(ctx, f"filter:{caller}:{res}", e.occurred_at, 60)
        score = 35 if n < 3 else min(80, 45 + 5 * n)
        return [make_alert(
            "CONTENT_FILTER_TRIGGERED", self.name, e, score,
            f"Content filter blocked a request from {caller or 'API key'} on {res} ({n} in the last hour).",
            {"caller": caller, "resource": res, "count_1h": n,
             "fingerprint_basis": f"filter|{caller}|{res}|{n >= 3}"}, platform=Platform.AZURE_OPENAI)]

    # ── network flows ───────────────────────────────────────────────────────
    def _flow(self, e: CanonicalEvent, ctx: Context) -> list[Alert]:
        ftype = str(e.attributes.get("flow_type") or "")
        direction = str(e.attributes.get("direction") or "outbound")
        dest = e.dest_host or e.dest_ip or ""
        allowed = {d.lower() for d in ctx.settings.network_allowed_destinations}
        if dest.lower() in allowed:
            return []
        ev = {"src": e.src_ip, "dest": dest, "port": e.dest_port, "flow_type": ftype, "bytes": e.bytes_out,
              "direction": direction, "country": e.attributes.get("country"), "subnet": e.attributes.get("subnet"),
              "fingerprint_basis": f"flow|{e.src_ip}|{dest}|{e.dest_port}"}
        if direction == "inbound":
            # Internet background noise against exposed agent infrastructure. Denied probes are the NSG working;
            # allowed traffic from known-malicious sources is an exposure finding, aggregated per host per day.
            if e.decision == Decision.BLOCKED or ftype != "MaliciousFlow":
                return []
            day = e.occurred_at.strftime("%Y-%m-%d")
            key = f"exposure:{dest}:{day}"
            b = ctx.state.get_baseline(key)
            srcs = set(b.get("sources", [])) | {e.src_ip or "?"}
            b["sources"] = sorted(srcs)[:200]
            ctx.state.put_baseline(key, b)
            if b.get("alerted"):
                return []
            b["alerted"] = True
            ctx.state.put_baseline(key, b)
            return [make_alert("SUSPICIOUS_NETWORK_FLOW", self.name, e, 35,
                               f"Agent infrastructure {dest} accepted inbound traffic on port {e.dest_port} from "
                               f"known-malicious source {e.src_ip} (exposure; further sources today are aggregated).",
                               {**ev, "fingerprint_basis": f"exposure|{dest}|{day}"})]
        if e.decision == Decision.BLOCKED:
            return []
        if ftype == "MaliciousFlow":
            return [make_alert("SUSPICIOUS_NETWORK_FLOW", self.name, e, 78,
                               f"Agent network {e.src_ip} connected out to known-malicious {dest}:{e.dest_port}.", ev)]
        if ftype == "ExternalPublic" and (e.bytes_out or 0) > 50_000_000:
            return [make_alert("DATA_EXFILTRATION", self.name, e, 60,
                               f"{(e.bytes_out or 0) / 1e6:.0f} MB sent from {e.src_ip} to external {dest}.", ev)]
        if ftype == "ExternalPublic" and e.dest_port and e.dest_port not in COMMON_PORTS:
            return [make_alert("SUSPICIOUS_NETWORK_FLOW", self.name, e, 42,
                               f"Outbound flow from agent network {e.src_ip} to {dest} on uncommon port {e.dest_port}.",
                               ev)]
        return []

    # ── Defender for AI passthrough ─────────────────────────────────────────
    def _defender(self, e: CanonicalEvent) -> list[Alert]:
        at = str(e.tool_name or "")
        alert_type = next((t for k, t in DEFENDER_MAP if k.lower() in at.lower()), "SESSION_RISK_ESCALATION")
        score = DEFENDER_SEVERITY.get(str(e.attributes.get("severity") or "").lower(), 55)
        return [make_alert(alert_type, "defender_for_ai", e, score,
                           f"Microsoft Defender for AI: {e.attributes.get('defender_alert') or at}. {(e.text or '')[:400]}",
                           {"defender_alert_type": at, "entity": e.attributes.get("entity"),
                            "extended": e.attributes.get("extended"), "fingerprint_basis": f"mdc|{e.id}"},
                           title=f"Defender: {e.attributes.get('defender_alert') or at}")]
