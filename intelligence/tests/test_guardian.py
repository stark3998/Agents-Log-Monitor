from __future__ import annotations

from datetime import datetime, timezone

from agentgov_intel.guardian import detect_guardian_triggers
from agentgov_intel.tools import chat_allowed_tools, guardian_allowed_tools


def decision(i: int, *, agent: str = "a1", verdict: str = "deny", **extra):
    return {
        "id": f"d{i}",
        "requestId": f"r{i}",
        "sessionId": f"s{i % 2}",
        "agentId": agent,
        "laneId": "default",
        "laneVersion": 1,
        "mode": extra.pop("mode", "enforce"),
        "checkpoint": "pre_tool",
        "toolName": "bash",
        "verdict": verdict,
        "effectiveVerdict": extra.pop("effectiveVerdict", verdict),
        "wouldDeny": extra.pop("wouldDeny", False),
        "stage": extra.pop("stage", "rules_deny"),
        "reason": extra.pop("reason", "blocked"),
        "tainted": extra.pop("tainted", False),
        "createdAt": extra.pop("createdAt", "2026-09-29T17:00:00Z"),
        **extra,
    }


def test_detects_denial_burst_and_lane_gap():
    items = [decision(i) for i in range(5)]
    items += [decision(10 + i, verdict="allow", effectiveVerdict="deny", mode="observe", wouldDeny=True) for i in range(5)]
    triggers = detect_guardian_triggers(items, now=datetime(2026, 9, 29, 17, 0, tzinfo=timezone.utc))
    names = {t.trigger for t in triggers}
    assert "deny_burst" in names
    assert "lane_gap" in names


def test_detects_taint_limits_and_coordination_host():
    items = [
        decision(1, tainted=True, reason="tainted deny"),
        decision(2, stage="limits", reason="rate limit"),
        decision(3, agent="a1", reason="curl https://new.example.com/x"),
        decision(4, agent="a2", reason="curl https://new.example.com/x"),
        decision(5, agent="a3", reason="curl https://new.example.com/x"),
    ]
    triggers = detect_guardian_triggers(items)
    names = {t.trigger for t in triggers}
    assert {"taint_risky", "limits", "coordination_host"} <= names


def test_authority_allow_lists_are_code_enforced():
    assert "pause_agent" not in guardian_allowed_tools("recommend")
    assert "pause_agent" in guardian_allowed_tools("contain")
    assert "propose_lane_change" in guardian_allowed_tools("autonomous")
    assert "pause_agent" not in chat_allowed_tools()
