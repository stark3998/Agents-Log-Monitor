"""Collector contract and helpers."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Protocol

from ..models import AgentProfile, CanonicalEvent
from ..state import State


@dataclass
class CollectResult:
    events: list[CanonicalEvent] = field(default_factory=list)
    profiles: list[AgentProfile] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


class Collector(Protocol):
    name: str

    def collect(self, state: State) -> CollectResult: ...


def stable_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()[:32]


def window(state: State, key: str, lookback_minutes: int, overlap_minutes: int) -> tuple[datetime, datetime]:
    """Returns (start, end). Start re-reads an overlap because many sources land late; dedup is by event id."""
    now = datetime.now(timezone.utc)
    cur = state.get_cursor(key)
    start = datetime.fromisoformat(cur) - timedelta(minutes=overlap_minutes) if cur else now - timedelta(minutes=lookback_minutes)
    return start, now


def parse_json(value: Any) -> Any:
    if isinstance(value, (dict, list)) or value is None:
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return value


def to_dt(value: Any) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    s = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return datetime.now(timezone.utc)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
