"""Secret and PII redaction applied to captured agent content before storage, LLM analysis or export.

Placeholders are typed (``[REDACTED:aws_access_key]``) so detectors still know *what kind* of data was present, and
e-mail domains are kept because destination analysis (exfiltration to an external domain) depends on them.
"""
from __future__ import annotations

import re
from typing import Any

from .models import CanonicalEvent

_SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private_key", re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]{20,}?-----END (?:[A-Z ]+ )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")),
    ("aws_access_key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b")),
    ("slack_token", re.compile(r"\bxox[abposr]-[A-Za-z0-9-]{10,}\b")),
    ("openai_key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
    ("azure_storage_key", re.compile(r"(?i)\bAccountKey=[A-Za-z0-9+/=]{40,}")),
    ("azure_sas", re.compile(r"(?i)\bsig=[A-Za-z0-9%+/=]{20,}")),
    ("connection_string_password", re.compile(r"(?i)\b(?:password|pwd)\s*=\s*[^;'\"\s]{4,}")),
    ("bearer_token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*")),
    ("azure_client_secret", re.compile(r"\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}\b")),
    ("generic_secret_assignment", re.compile(
        r"(?i)\b(?:api[_-]?key|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\b"
        r"(\s*[:=]\s*['\"]?)([^'\"\s,;}{]{8,})")),
]

_PII_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("us_ssn", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")),
    ("phone", re.compile(r"(?<![\w.])\+?1?[\s.-]?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b")),
]
_CARD = re.compile(r"\b(?:\d[ -]?){13,19}\b")
_EMAIL = re.compile(r"\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_SENSITIVE_KEY = re.compile(
    r"(?i)^(?:.*_)?(secret|token|password|passwd|pwd|api_?key|access_?key|private_?key|client_?secret|"
    r"conn(?:ection)?_?string|sas)$")


def _luhn(digits: str) -> bool:
    total, alt = 0, False
    for ch in reversed(digits):
        d = ord(ch) - 48
        if alt:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        alt = not alt
    return total % 10 == 0


def _card(m: re.Match[str]) -> str:
    digits = re.sub(r"\D", "", m.group(0))
    return "[REDACTED:card]" if 13 <= len(digits) <= 19 and _luhn(digits) else m.group(0)


def redact_text(s: str, pii: bool = True) -> str:
    if not s:
        return s
    for name, rx in _SECRET_PATTERNS:
        if name == "generic_secret_assignment":
            s = rx.sub(lambda m: m.group(0)[: m.start(2) - m.start(0)] + "[REDACTED:secret]", s)
        else:
            s = rx.sub(f"[REDACTED:{name}]", s)
    if pii:
        for name, rx in _PII_PATTERNS:
            s = rx.sub(f"[REDACTED:{name}]", s)
        s = _CARD.sub(_card, s)
        s = _EMAIL.sub(lambda m: f"{m.group(1)[:1]}***@{m.group(2)}", s)
    return s


def redact_value(v: Any, pii: bool = True, depth: int = 0) -> Any:
    if depth > 12:
        return v
    if isinstance(v, str):
        return redact_text(v, pii)
    if isinstance(v, list):
        return [redact_value(x, pii, depth + 1) for x in v]
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if isinstance(x, str) and x and _SENSITIVE_KEY.match(str(k)):
                out[k] = "[REDACTED:field]"
            else:
                out[k] = redact_value(x, pii, depth + 1)
        return out
    return v


_CONTENT_ATTRS = ("system_instructions", "inline_definition", "tool_description", "refusal_or_block", "plan")


def redact_event(e: CanonicalEvent, pii: bool = True) -> CanonicalEvent:
    """In-place redaction of every content-bearing field. Returns the same event."""
    if e.text:
        e.text = redact_text(e.text, pii)
    if e.thought:
        e.thought = redact_text(e.thought, pii)
    if e.arguments is not None:
        e.arguments = redact_value(e.arguments, pii)
    if e.result is not None:
        e.result = redact_value(e.result, pii)
    if e.error:
        e.error = redact_text(e.error, pii)
    if e.decision_reason:
        e.decision_reason = redact_text(e.decision_reason, pii)
    for k in _CONTENT_ATTRS:
        if k in e.attributes:
            e.attributes[k] = redact_value(e.attributes[k], pii)
    for eff in e.effects:
        eff.evidence = redact_text(eff.evidence, pii)
    return e
