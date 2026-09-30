"""Helpers for OTel GenAI / OpenAI message formats and policy-block detection."""
from __future__ import annotations

import re
from typing import Any

from .base import parse_json

_BLOCK_RX = re.compile(
    r"(?i)(blocked by (policy|guardrail|content filter|administrator|dlp|security)|content_filter|policy violation|"
    r"not (allowed|permitted|authorized)|permission denied|access (is )?denied|forbidden|\b403\b|approval (was )?(denied|rejected)|"
    r"user (denied|rejected)|request was denied|jailbreak|blocked action|action was blocked|blockAction|"
    r"prohibited|disallowed|rejected by (the )?(user|approver|reviewer))")


def detect_block(*texts: Any) -> str | None:
    for t in texts:
        if t is None:
            continue
        s = t if isinstance(t, str) else str(t)
        m = _BLOCK_RX.search(s[:4000])
        if m:
            return s[max(0, m.start() - 80): m.end() + 120].strip()
    return None


_REFUSAL_RX = re.compile(
    r"(?i)^.{0,200}?\b(i\s*(?:can(?:no|'|’)?t|cannot|am (?:not able|unable)|'m (?:not able|unable)|won(?:'|’)t|"
    r"must decline|am not (?:allowed|permitted))\s+(?:help|assist|do|provide|comply|share|create|write|run|execute|"
    r"perform|generate|support|fulfil|fulfill)|(?:that|this) (?:request )?(?:is|goes) (?:outside|beyond) (?:my|the) "
    r"(?:scope|capabilities|purpose)|against (?:my|our|the) (?:policy|policies|guidelines|usage policies)|"
    r"not something i can (?:help|assist) with)")


def detect_refusal(text: Any) -> str | None:
    """The model declining a request (a soft block). Only the opening of a reply is checked."""
    if not isinstance(text, str) or not text:
        return None
    m = _REFUSAL_RX.search(text[:600])
    return text[: min(len(text), m.end() + 120)].strip() if m else None


def message_text(msg: Any) -> str:
    """Text from an OTel GenAI message ({role, parts:[{type,content}]}) or OpenAI item/message."""
    if isinstance(msg, str):
        return msg
    if not isinstance(msg, dict):
        return ""
    parts = msg.get("parts")
    if isinstance(parts, list):
        return "\n".join(str(p.get("content") or p.get("text") or "") for p in parts
                         if isinstance(p, dict) and p.get("type") in (None, "text", "input_text", "output_text"))
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for c in content:
            if isinstance(c, dict):
                t = c.get("text")
                if isinstance(t, dict):
                    t = t.get("value")
                if t:
                    out.append(str(t))
            elif isinstance(c, str):
                out.append(c)
        return "\n".join(out)
    return str(msg.get("text") or "")


def messages(value: Any) -> list[dict[str, Any]]:
    v = parse_json(value)
    if isinstance(v, dict):
        v = v.get("messages") or [v]
    return [m for m in v if isinstance(m, dict)] if isinstance(v, list) else []


def last_user_text(value: Any) -> str | None:
    for m in reversed(messages(value)):
        if m.get("role") == "user":
            t = message_text(m).strip()
            if t:
                return t
    return None


def assistant_text(value: Any) -> str | None:
    texts = [message_text(m) for m in messages(value) if m.get("role") in (None, "assistant")]
    t = "\n".join(x for x in texts if x).strip()
    return t or None


def tool_calls_in(value: Any) -> list[dict[str, Any]]:
    """Tool-call parts inside OTel output messages: {type:'tool_call', id, name, arguments}."""
    calls = []
    for m in messages(value):
        for p in m.get("parts") or []:
            if isinstance(p, dict) and p.get("type") == "tool_call":
                calls.append({"id": p.get("id"), "name": p.get("name"), "arguments": parse_json(p.get("arguments"))})
    return calls
