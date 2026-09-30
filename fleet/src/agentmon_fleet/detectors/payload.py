"""User-supplied obfuscated payloads: a user hands the agent encoded/obfuscated code, and the agent (often decoding it
first) executes it. The executed code then looks clean, so the obfuscation is only visible in the user turn."""
from __future__ import annotations

import re

from ..codeanalysis.analyze import analyze_code
from ..codeanalysis.deobfuscate import deobfuscate
from ..models import Alert, CanonicalEvent, EventKind
from .base import Context, make_alert

_WS = re.compile(r"\s+")
MIN_FRAGMENT = 12


def _norm(s: str) -> str:
    return _WS.sub("", s).lower()


class UserPayloadDetector:
    name = "user_payload"

    def process(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        if not event.session_id:
            return []
        if event.kind == EventKind.USER_MESSAGE and event.text:
            return self._on_user(event, ctx)
        if event.kind == EventKind.TOOL_CALL:
            return self._on_exec(event, ctx)
        return []

    def _on_user(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        r = deobfuscate(event.text or "")
        if not r.obfuscated:
            return []
        decoded = [layer for layer in r.layers if len(layer.strip()) >= MIN_FRAGMENT]
        risk = max((analyze_code(layer, "text", "user").summary().get("risk", 0) for layer in decoded), default=0)
        key = f"payload:{event.session_id}"
        b = ctx.state.get_baseline(key)
        b.setdefault("fragments", [])
        b["fragments"] = (b["fragments"] + [_norm(x)[:400] for x in decoded])[-20:]
        b["techniques"] = sorted(set(b.get("techniques", [])) | set(r.techniques))
        ctx.state.put_baseline(key, b)
        return [make_alert(
            "OBFUSCATED_CODE", self.name, event, 45 + min(25, risk // 3) + (10 if r.dynamic_exec else 0),
            f"User supplied obfuscated code ({', '.join(r.techniques)}) to the agent"
            f"{' with dynamic execution' if r.dynamic_exec else ''}; decoded: '{(decoded[0] if decoded else '')[:160]}'.",
            {"techniques": r.techniques, "decoded": [x[:500] for x in decoded[:3]], "decoded_risk": risk,
             "source": "user", "fingerprint_basis": f"userpayload|{','.join(r.techniques)}|{_norm(r.original)[:80]}"})]

    def _on_exec(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        b = ctx.state.get_baseline(f"payload:{event.session_id}")
        frags = b.get("fragments") or []
        if not frags or event.arguments is None:
            return []
        executed = _norm(event.arguments if isinstance(event.arguments, str) else str(event.arguments))
        hit = next((f for f in frags if f[:200] and f[:200] in executed), None)
        if not hit:
            return []
        return [make_alert(
            "OBFUSCATED_CODE", self.name, event, 72,
            f"{event.agent_name or event.agent_id} executed a user-supplied obfuscated payload via {event.tool_name} "
            f"({', '.join(b.get('techniques', []))}); the agent decoded it before running it.",
            {"techniques": b.get("techniques"), "executed_fragment": hit[:300], "source": "agent_executed_user_payload",
             "fingerprint_basis": f"payloadexec|{hit[:80]}"})]
