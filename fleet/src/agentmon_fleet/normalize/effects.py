"""Derive canonical Effects for an event (tool semantics + code analysis + argument inspection)."""
from __future__ import annotations

import json
import re
from typing import Any

from ..codeanalysis.analyze import analyze_snippet, canonical_host
from ..codeanalysis.extract import extract_code, extract_code_from_text
from ..models import CanonicalEvent, Capability, Effect, EventKind
from .capabilities import tool_capabilities

_URL = re.compile(r"(?i)\b(?:https?|wss?|ftp)://[^\s'\"<>)\]}]+")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_RESOURCE_KEYS = {"path", "file", "filename", "file_path", "table", "entity", "container", "blob", "database",
                  "mailbox", "secret_name", "vault", "resource", "resource_id", "record", "account"}
_RECIPIENT_KEYS = {"to", "recipient", "recipients", "cc", "bcc", "email", "address", "channel"}


def canonical_resource(value: str) -> str:
    v = value.strip().strip("'\"").replace("\\", "/")
    v = re.sub(r"(?i)^/proc/(self|\d+)/root", "", v)
    v = re.sub(r"(?i)^(\$env:userprofile|%userprofile%|\$home|~)", "~", v)
    v = re.sub(r"(?i)^[a-z]:/users/[^/]+", "~", v)
    v = re.sub(r"/+", "/", v)
    v = re.sub(r"/\./", "/", v)
    return v.lower().rstrip("/")


def _walk_strings(value: Any, key: str = "") -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    if isinstance(value, dict):
        for k, v in value.items():
            out.extend(_walk_strings(v, str(k).lower()))
    elif isinstance(value, list):
        for v in value:
            out.extend(_walk_strings(v, key))
    elif isinstance(value, str):
        s = value.strip()
        if s.startswith(("{", "[")):
            try:
                return _walk_strings(json.loads(s), key)
            except ValueError:
                pass
        out.append((key, value))
    elif value is not None:
        out.append((key, str(value)))
    return out


def argument_targets(arguments: Any) -> dict[str, list[str]]:
    """Resources, destinations and recipients referenced in tool arguments."""
    res: dict[str, list[str]] = {"resources": [], "destinations": [], "recipients": []}
    for key, s in _walk_strings(arguments):
        for u in _URL.findall(s):
            h = canonical_host(u)
            if h and h not in res["destinations"]:
                res["destinations"].append(h)
        if key in _RECIPIENT_KEYS:
            for e in _EMAIL.findall(s):
                if e.lower() not in res["recipients"]:
                    res["recipients"].append(e.lower())
        if key in _RESOURCE_KEYS and len(s) < 500:
            r = canonical_resource(s)
            if r and r not in res["resources"]:
                res["resources"].append(r)
    return res


def enrich(event: CanonicalEvent) -> CanonicalEvent:
    """Populate event.effects and attributes['code_analysis'] (idempotent)."""
    if event.effects or event.kind not in (EventKind.TOOL_CALL, EventKind.ASSISTANT_MESSAGE, EventKind.PLAN,
                                           EventKind.NETWORK_FLOW):
        return event
    effects: list[Effect] = []
    if event.kind == EventKind.NETWORK_FLOW:
        effects.append(Effect(capability=Capability.NET_EGRESS, destination=event.dest_host or event.dest_ip or "",
                              executor="network"))
        event.effects = effects
        return event

    executor = event.tool_name or event.tool_type or "assistant"
    analyses = []
    if event.kind == EventKind.TOOL_CALL:
        desc = str(event.attributes.get("tool_description") or "")
        caps = tool_capabilities(event.tool_name, event.tool_type, desc)
        targets = argument_targets(event.arguments)
        for c in caps:
            dests = targets["destinations"] if c in (Capability.NET_EGRESS, Capability.SEND_MESSAGE) else []
            reses = targets["resources"] if c not in (Capability.NET_EGRESS,) else []
            if not dests and not reses:
                effects.append(Effect(capability=c, executor=executor))
            for d in dests:
                effects.append(Effect(capability=c, destination=d, executor=executor))
            for r in reses[:5]:
                effects.append(Effect(capability=c, resource=r, executor=executor))
        for rcpt in targets["recipients"]:
            effects.append(Effect(capability=Capability.SEND_MESSAGE, destination=rcpt.split("@", 1)[1],
                                  resource=rcpt, executor=executor))
        snippets = extract_code(event.arguments, event.tool_name, event.tool_type)
    else:
        snippets = extract_code_from_text(event.text)

    for snip in snippets:
        a = analyze_snippet(snip)
        analyses.append(a.summary())
        effects.extend(a.effects(executor=f"{executor}:{snip.language}"))

    uniq: dict[str, Effect] = {}
    for e in effects:
        uniq.setdefault(e.key() + "|" + e.executor, e)
    event.effects = list(uniq.values())
    if analyses:
        event.attributes["code_analysis"] = analyses
    return event


def max_code_risk(event: CanonicalEvent) -> int:
    return max((a.get("risk", 0) for a in event.attributes.get("code_analysis", [])), default=0)