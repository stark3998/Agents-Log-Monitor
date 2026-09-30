"""Shared detector context and alert construction."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Protocol

from ..config import Settings
from ..llm import LLM
from ..models import AgentProfile, Alert, CanonicalEvent, Platform, Severity
from ..state import State
from ..taxonomy import info


@dataclass
class Context:
    settings: Settings
    state: State
    llm: LLM | None
    profiles: dict[str, AgentProfile] = field(default_factory=dict)
    llm_budget: int = 60  # max LLM calls per cycle (cost control)
    realtime: bool = False
    jev: Any = None  # FleetJev (shadow mode only; see agentmon_fleet.jev)
    jev_budget: int = 2000  # max Jev calls per cycle (separate from llm_budget)

    def profile_for(self, event: CanonicalEvent) -> AgentProfile | None:
        return self.profiles.get(event.agent_key) or self.state.get_profile(event.agent_key)

    def take_llm(self) -> LLM | None:
        if self.llm is None or self.llm_budget <= 0:
            return None
        self.llm_budget -= 1
        return self.llm

    def take_jev(self) -> Any:
        """The FleetJev client, consuming one unit of the per-cycle Jev budget; None when disabled or exhausted."""
        if self.jev is None or self.jev_budget <= 0:
            return None
        self.jev_budget -= 1
        return self.jev


class Detector(Protocol):
    name: str

    def process(self, event: CanonicalEvent, ctx: Context) -> list[Alert]: ...


def make_alert(alert_type: str, detector: str, event: CanonicalEvent | None, score: float, summary: str,
               evidence: dict[str, Any] | None = None, *, title: str | None = None, platform: Platform | None = None,
               source_ids: list[str] | None = None, action: str = "alert") -> Alert:
    t = info(alert_type)
    sev = Severity.from_score(score)
    if sev.rank < t.default_severity.rank and score >= 50:
        sev = t.default_severity
    ev = dict(evidence or {})
    if event is not None:
        ev.setdefault("event", {"kind": event.kind.value, "tool": event.tool_name, "source": event.source,
                                "at": event.occurred_at.isoformat(), "action": event.action_text(600)})
    return Alert(
        alert_id=str(uuid.uuid4()), alert_type=alert_type, severity=sev, score=round(min(100.0, score), 1),
        title=title or t.title, summary=summary[:2000], detector=detector,
        platform=platform or (event.platform if event else Platform.CUSTOM),
        agent_id=event.agent_id if event else None, agent_name=event.agent_name if event else None,
        session_id=event.session_id if event else None, user_id=event.user_id if event else None,
        action=action, owasp_llm=t.owasp_llm, owasp_agentic=t.owasp_agentic, mitre_atlas=t.mitre_atlas,
        evidence=ev, source_event_ids=source_ids or ([event.id] if event else []))