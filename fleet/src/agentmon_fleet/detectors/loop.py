"""Runaway-loop detection: an agent repeating the same action, or burning through tool calls, within one session."""
from __future__ import annotations

import hashlib
import json

from ..models import Alert, CanonicalEvent, EventKind
from .base import Context, make_alert

REPEAT_THRESHOLD = 5      # identical tool + arguments
SESSION_CALL_THRESHOLD = 40


def _signature(e: CanonicalEvent) -> str:
    try:
        args = json.dumps(e.arguments, sort_keys=True, default=str)[:2000]
    except Exception:
        args = str(e.arguments)[:2000]
    return hashlib.sha256(f"{e.tool_name}|{args}".encode()).hexdigest()[:16]


class RunawayLoopDetector:
    name = "runaway_loop"

    def process(self, event: CanonicalEvent, ctx: Context) -> list[Alert]:
        if event.kind != EventKind.TOOL_CALL or not event.session_id:
            return []
        key = f"loop:{event.session_id}"
        b = ctx.state.get_baseline(key)
        seen = b.setdefault("seen", [])
        if event.id in seen:  # the same event re-processed (real-time + offline) is not a repeat
            return []
        seen.append(event.id)
        del seen[:-200]
        sig = _signature(event)
        counts = b.setdefault("counts", {})
        counts[sig] = counts.get(sig, 0) + 1
        b["total"] = b.get("total", 0) + 1
        alerts: list[Alert] = []
        n = counts[sig]
        if n >= REPEAT_THRESHOLD and n in (REPEAT_THRESHOLD, 2 * REPEAT_THRESHOLD, 4 * REPEAT_THRESHOLD):
            alerts.append(make_alert(
                "RUNAWAY_LOOP", self.name, event, min(85, 50 + 3 * n),
                f"{event.agent_name or event.agent_id} called {event.tool_name} with identical arguments {n} times "
                "in one session.",
                {"tool": event.tool_name, "repeats": n, "fingerprint_basis": f"loop|{sig}|{n}"}))
        total = b["total"]
        if total in (SESSION_CALL_THRESHOLD, 2 * SESSION_CALL_THRESHOLD):
            alerts.append(make_alert(
                "RUNAWAY_LOOP", self.name, event, 50 if total == SESSION_CALL_THRESHOLD else 65,
                f"{total} tool calls in one session by {event.agent_name or event.agent_id}.",
                {"total_tool_calls": total, "fingerprint_basis": f"loop-total|{total}"}))
        ctx.state.put_baseline(key, b)
        return alerts
