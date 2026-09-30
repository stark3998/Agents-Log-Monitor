from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from typesafe_sdk import Choice, Noul, Score, SystemOneResponse

from agentgov_intel.config import Settings
from agentgov_intel.guardian import (
    GuardianService,
    GuardianTrigger,
    build_guardian_shadow_record,
    guardian_baseline_severity,
)
from agentgov_intel.jev_triage import (
    INCIDENT_TYPES,
    MAX_STATE_DECISIONS,
    SEVERITY_LEVELS,
    TRIAGE_QUESTIONS,
    JevTriage,
    TriageResult,
    build_state,
    combine,
)
from agentgov_intel.monitor_client import MonitorClient

JEV_ENV = ("TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "JEV_MODEL", "JEV_TIMEOUT_MS", "JEV_SHADOW", "JEV_SHADOW_GUARDIAN")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.setenv("AGENT_MONITOR_ENV_FILE", "none")
    for name in JEV_ENV:
        monkeypatch.delenv(name, raising=False)


def jev_settings(**over) -> Settings:
    base = dict(typesafe_api_key="test-key", jev_model="jev-1.13.0", jev_timeout_ms=2000.0, jev_shadow=True, jev_shadow_guardian=True)
    base.update(over)
    return Settings(**base)


def decision(i: int, **extra):
    d = {
        "id": f"d{i}", "sessionId": "s1", "agentId": "a1", "laneId": "coding", "mode": "enforce",
        "toolName": "bash", "category": "SHELL", "verdict": "deny", "effectiveVerdict": "deny",
        "stage": "rules_deny", "reason": "Blocked command: cat ~/.ssh/id_rsa", "riskLevel": "high",
        "tainted": False, "wouldDeny": False, "createdAt": f"2026-09-30T12:{i % 60:02d}:00Z",
        "meta": {"args": {"secret": "RAW-PAYLOAD"}},
    }
    d.update(extra)
    return d


def trigger(**over) -> GuardianTrigger:
    base = dict(trigger="deny_burst", severity="high", confidence=0.85, title="Burst of denied actions for a1",
                agent_ids=["a1"], session_ids=["s1"], decision_ids=[f"d{i}" for i in range(5)], summary="5 denies in 10 minutes")
    base.update(over)
    return GuardianTrigger(**base)


def response(*, score=2.2, sev_conf=0.8, choice="credential_probing", choice_conf=0.9, inv=0.9, fp=0.05, usage=(321, 12)):
    return SystemOneResponse.model_validate({
        "model": "jev-1.13.0",
        "usage": {"input_tokens": usage[0], "output_tokens": usage[1]},
        "answers": {
            "severity": {"type": "score", "score": score, "confidence": sev_conf,
                         "legend": {i: s for i, s in enumerate(SEVERITY_LEVELS)}, "probabilities": {0: 0.1, 1: 0.2, 2: 0.5, 3: 0.2}},
            "incident_type": {"type": "choice", "choice": choice, "confidence": choice_conf,
                              "probabilities": {t: (choice_conf if t == choice else 0.0) for t in INCIDENT_TYPES}},
            "needs_investigation": {"type": "noul", "noul": inv},
            "likely_false_positive": {"type": "noul", "noul": fp},
        },
    })


class FakeTypeSafe:
    def __init__(self, result=None, exc: Exception | None = None, delay: float = 0.0):
        self.result, self.exc, self.delay, self.calls = result or response(), exc, delay, []

    async def system_one(self, state, questions, *, model=None, **_):
        self.calls.append({"state": state, "questions": questions, "model": model})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.exc:
            raise self.exc
        return self.result


# -- question set --------------------------------------------------------------------------
def test_question_set_shape():
    assert set(TRIAGE_QUESTIONS) == {"severity", "incident_type", "needs_investigation", "likely_false_positive"}
    sev = TRIAGE_QUESTIONS["severity"]
    assert isinstance(sev, Score) and len(sev.criteria) == 4
    for level, text in zip(SEVERITY_LEVELS, sev.criteria):
        assert text.startswith(level + ":")
    kind = TRIAGE_QUESTIONS["incident_type"]
    assert isinstance(kind, Choice) and tuple(kind.criteria) == INCIDENT_TYPES
    assert all(kind.criteria.values()), "every choice needs explicit criteria"
    for key in ("needs_investigation", "likely_false_positive"):
        q = TRIAGE_QUESTIONS[key]
        assert isinstance(q, Noul) and q.criteria and q.criteria["true"] and q.criteria["false"]
    # All questions serialise to the wire format the SDK sends.
    assert json.dumps({k: q.model_dump() for k, q in TRIAGE_QUESTIONS.items()})


def test_state_is_filtered_and_counts_in_code():
    window = [decision(i) for i in range(30)] + [decision(99, agentId="other", id="x99")]
    state = build_state(trigger(decision_ids=[f"d{i}" for i in range(30)]), window)
    assert len(state["decisions"]) == MAX_STATE_DECISIONS
    blob = json.dumps(state)
    assert "RAW-PAYLOAD" not in blob and "meta" not in blob
    assert "x99" not in blob and "other" not in blob
    # detector severity / confidence are not leaked to Jev
    assert "0.85" not in blob and '"severity"' not in blob
    facts = state["facts"]
    assert facts["denied"] == MAX_STATE_DECISIONS and facts["all_calls_blocked"] is True
    assert facts["same_tool_repeated_5_or_more_times"] is True
    assert state["lane_id"] == "coding" and state["trigger"]["kind"] == "deny_burst"


def test_state_truncates_reason():
    state = build_state(trigger(decision_ids=["d1"]), [decision(1, reason="x" * 5000)])
    assert len(state["decisions"][0]["reason"]) == 200


def test_state_reports_observe_mode_as_what_actually_ran():
    d = decision(1, mode="observe", verdict="allow", effectiveVerdict="deny", wouldDeny=True)
    state = build_state(trigger(trigger="lane_gap", decision_ids=["d1"]), [d])
    assert state["decisions"][0]["verdict"] == "allow" and state["decisions"][0]["would_deny"] is True
    assert state["facts"]["observe_mode_would_deny"] == 1 and state["facts"]["denied"] == 0


# -- combine -------------------------------------------------------------------------------
def test_combine_maps_score_and_flags():
    out = combine(response(score=2.2, inv=0.9, fp=0.05))
    assert out["severity"] == "high" and out["incident_type"] == "credential_probing"
    assert out["investigate"] is True and out["confidence"] == 0.8
    assert out["signals"]["needs_investigation"] == 0.9 and out["signals"]["incident_type"] == "credential_probing"


def test_combine_false_positive_downgrades_one_level_and_suppresses_investigation():
    out = combine(response(score=1.1, choice="policy_misconfiguration_false_positive", inv=0.6, fp=0.9))
    assert out["severity"] == "low"
    assert out["investigate"] is False
    assert "downgraded" in out["rationale"]


def test_combine_never_downgrades_critical_and_high_forces_investigate():
    assert combine(response(score=2.9, choice="benign_burst", fp=0.95))["severity"] == "critical"
    out = combine(response(score=2.0, choice="credential_probing", inv=0.1, fp=0.1))
    assert out["severity"] == "high" and out["investigate"] is True
    assert combine(response(score=0.2, choice="benign_burst", inv=0.2, fp=0.4))["investigate"] is False


# -- triage client -------------------------------------------------------------------------
async def test_triage_success_uses_pinned_model_and_reports_tokens():
    fake = FakeTypeSafe()
    result = await JevTriage(jev_settings(), client=fake).triage(trigger(), [decision(i) for i in range(5)])
    assert result.ok and result.severity == "high" and result.model == "jev-1.13.0"
    assert (result.input_tokens, result.output_tokens) == (321, 12)
    assert fake.calls[0]["model"] == "jev-1.13.0"
    assert fake.calls[0]["questions"] is TRIAGE_QUESTIONS


async def test_triage_swallows_errors_and_timeouts():
    err = await JevTriage(jev_settings(), client=FakeTypeSafe(exc=RuntimeError("boom"))).triage(trigger(), [])
    assert err.error and "boom" in err.error and err.severity is None
    slow = await JevTriage(jev_settings(jev_timeout_ms=20.0), client=FakeTypeSafe(delay=1.0)).triage(trigger(), [])
    assert slow.error and slow.error.startswith("timeout")


# -- config ---------------------------------------------------------------------------------
def test_jev_disabled_without_key_and_defaults(monkeypatch):
    s = Settings()
    assert s.jev_model == "jev-1.13.0" and s.jev_timeout_ms == 2000.0
    assert s.jev_enabled is False and s.jev_guardian_enabled is False
    monkeypatch.setenv("TYPESAFE_API_KEY", "k")
    assert Settings().jev_guardian_enabled is True
    monkeypatch.setenv("JEV_SHADOW_GUARDIAN", "off")
    assert Settings().jev_guardian_enabled is False
    monkeypatch.setenv("JEV_SHADOW_GUARDIAN", "on")
    monkeypatch.setenv("JEV_SHADOW", "off")
    assert Settings().jev_enabled is False


# -- guardian hook --------------------------------------------------------------------------
class FakeRunner:
    def __init__(self, report="## Timeline\n**Severity:** High\n..."):
        self.report = report

    async def run(self, prompt, *, model, instructions, tools=()):
        await asyncio.sleep(0)
        return self.report


class FailingRunner(FakeRunner):
    async def run(self, *a, **k):
        raise RuntimeError("llm down")


class FakeMonitor:
    def __init__(self, fail_post: bool = False):
        self.shadow: list[dict] = []
        self.fail_post = fail_post

    async def create_incident(self, body):
        return {"id": "inc1", **body}

    async def patch_incident(self, incident_id, patch):
        return {"id": incident_id, "severity": "high", **patch}

    async def get_decision(self, decision_id):
        return decision(int(decision_id[1:]))

    async def post_jev_shadow(self, record, timeout=5.0):
        if self.fail_post:
            raise httpx.ConnectError("monitor down")
        self.shadow.append(record)
        return record


class FakeTriager:
    def __init__(self, result: TriageResult | None = None, exc: Exception | None = None):
        self.result, self.exc, self.calls = result, exc, 0

    async def triage(self, trig, decisions):
        self.calls += 1
        if self.exc:
            raise self.exc
        return self.result

    async def aclose(self):
        pass


def ok_triage(severity="high") -> TriageResult:
    return TriageResult(model="jev-1.13.0", latency_ms=95.0, severity=severity, severity_score=2.1, incident_type="credential_probing",
                        investigate=True, confidence=0.8, signals={"severity": 2.1, "incident_type": "credential_probing"},
                        rationale="severity=high", input_tokens=300, output_tokens=10)


async def test_guardian_posts_shadow_record():
    monitor = FakeMonitor()
    triager = FakeTriager(ok_triage("high"))
    svc = GuardianService(jev_settings(guardian_deployment="gpt-5"), monitor, FakeRunner(), jev=triager)
    items = [decision(i) for i in range(5)]
    result = await svc.investigate_trigger(trigger(), decisions=items)
    await svc.drain_shadow(timeout=2)
    assert result["id"] == "inc1" and triager.calls == 1
    assert len(monitor.shadow) == 1
    rec = monitor.shadow[0]
    assert rec["kind"] == "guardian_triage" and rec["agentId"] == "a1" and rec["sessionId"] == "s1" and rec["laneId"] == "coding"
    assert rec["baseline"]["provider"] == "guardian" and rec["baseline"]["model"] == "gpt-5"
    assert rec["baseline"]["verdict"] == "high" and rec["baseline"]["latencyMs"] >= 0
    jev = rec["jev"]
    assert jev["model"] == "jev-1.13.0" and jev["verdict"] == "high" and jev["score"] == 2.1
    assert jev["inputTokens"] == 300 and jev["outputTokens"] == 10 and jev["signals"]["investigate"] == 1
    assert "error" not in jev and rec["agree"] is True
    json.dumps(rec)  # serialisable


async def test_guardian_swallows_jev_errors_and_still_records():
    monitor = FakeMonitor()
    svc = GuardianService(jev_settings(), monitor, FakeRunner(), jev=FakeTriager(exc=RuntimeError("jev exploded")))
    result = await svc.investigate_trigger(trigger(), decisions=[decision(1)])
    await svc.drain_shadow(timeout=2)
    assert result["report"].startswith("## Timeline")  # Guardian behaviour unchanged
    assert monitor.shadow == []  # triager crash -> nothing to compare, swallowed

    monitor2 = FakeMonitor()
    err = TriageResult(model="jev-1.13.0", latency_ms=2000.0, error="timeout after 2000ms")
    svc2 = GuardianService(jev_settings(), monitor2, FakeRunner(), jev=FakeTriager(err))
    await svc2.investigate_trigger(trigger(), decisions=[decision(1)])
    await svc2.drain_shadow(timeout=2)
    rec = monitor2.shadow[0]
    assert rec["jev"]["error"].startswith("timeout") and "verdict" not in rec["jev"] and "agree" not in rec


async def test_guardian_swallows_monitor_post_errors():
    svc = GuardianService(jev_settings(), FakeMonitor(fail_post=True), FakeRunner(), jev=FakeTriager(ok_triage()))
    result = await svc.investigate_trigger(trigger(), decisions=[decision(1)])
    await svc.drain_shadow(timeout=2)
    assert result["id"] == "inc1"


async def test_guardian_failure_records_skipped_baseline_and_reraises():
    monitor = FakeMonitor()
    svc = GuardianService(jev_settings(), monitor, FailingRunner(), jev=FakeTriager(ok_triage()))
    with pytest.raises(RuntimeError, match="llm down"):
        await svc.investigate_trigger(trigger(), decisions=[decision(1)])
    await svc.drain_shadow(timeout=2)
    assert monitor.shadow[0]["baseline"]["verdict"] == "skipped" and "agree" not in monitor.shadow[0]


async def test_guardian_shadow_does_not_delay_guardian():
    class SlowTriager(FakeTriager):
        async def triage(self, trig, decisions):
            await asyncio.sleep(0.5)
            return ok_triage()

    monitor = FakeMonitor()
    svc = GuardianService(jev_settings(), monitor, FakeRunner(), jev=SlowTriager())
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    await svc.investigate_trigger(trigger(), decisions=[decision(1)])
    assert loop.time() - t0 < 0.25
    await svc.drain_shadow(timeout=2)
    assert len(monitor.shadow) == 1


async def test_manual_investigation_fetches_referenced_decisions():
    monitor = FakeMonitor()
    seen = {}

    class Capture(FakeTriager):
        async def triage(self, trig, decisions):
            seen["n"] = len(decisions)
            return ok_triage()

    svc = GuardianService(jev_settings(), monitor, FakeRunner(), jev=Capture())
    await svc.investigate_request({"trigger": "manual", "decisionIds": ["d1", "d2"], "agentIds": ["a1"]})
    await svc.drain_shadow(timeout=2)
    assert seen["n"] == 2 and len(monitor.shadow) == 1


async def test_guardian_shadow_disabled_without_key():
    monitor = FakeMonitor()
    svc = GuardianService(Settings(), monitor, FakeRunner())
    await svc.investigate_trigger(trigger(), decisions=[decision(1)])
    await svc.drain_shadow(timeout=1)
    assert monitor.shadow == [] and svc._jev is None


def test_baseline_mapping():
    # Only the Guardian LLM's own `Severity:` line counts; the pre-filled incident severity is ignored.
    assert guardian_baseline_severity({"severity": "info"}) is None
    assert guardian_baseline_severity({"severity": "medium"}, "Severity: CRITICAL — escalate") == "critical"
    assert guardian_baseline_severity({"severity": "high"}, "no explicit level") is None
    assert guardian_baseline_severity({}, "## Summary\n**Severity:** info") == "low"
    assert guardian_baseline_severity({}, "- Severity: `medium`") == "medium"
    # A quoted incident dict must not be mistaken for the LLM's assessment.
    assert guardian_baseline_severity({}, "Incident: {'id': 'i', 'severity': 'high'}") is None
    # The last explicit line wins (the instructions ask for it at the end).
    assert guardian_baseline_severity({}, "Severity: low\n...\nSeverity: high") == "high"
    assert guardian_baseline_severity({}, None) is None
    rec = build_guardian_shadow_record(jev_settings(), trigger(), ok_triage("medium"), {"id": "i", "report": "x"}, 1.5)
    assert rec["baseline"]["verdict"] == "investigated" and "agree" not in rec
    rec = build_guardian_shadow_record(jev_settings(), trigger(), ok_triage("medium"), {"id": "i", "severity": "high"}, 1.5)
    assert rec["baseline"]["verdict"] == "investigated" and "agree" not in rec
    rec = build_guardian_shadow_record(
        jev_settings(), trigger(), ok_triage("medium"), {"id": "i", "severity": "medium", "report": "...\nSeverity: high"}, 1.5,
    )
    assert rec["agree"] is False and rec["baseline"]["verdict"] == "high" and rec["baseline"]["latencyMs"] == 1500.0


# -- monitor client ------------------------------------------------------------------------
async def test_monitor_client_post_jev_shadow_uses_auth():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(201, json={"id": "js1", **seen["body"]})

    settings = Settings(monitor_api_url="http://monitor.test", monitor_token="tok")
    client = MonitorClient(settings, transport=httpx.MockTransport(handler))
    try:
        out = await client.post_jev_shadow({"kind": "guardian_triage", "baseline": {"provider": "guardian"}, "jev": {"model": "m", "latencyMs": 1, "signals": {}}})
    finally:
        await client.aclose()
    assert seen["path"] == "/api/gov/jev/shadow" and seen["auth"] == "Bearer tok"
    assert out["id"] == "js1"


def test_eval_cases_file_is_well_formed():
    path = Path(__file__).resolve().parents[2] / "eval" / "triage-cases.jsonl"
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    assert len(cases) >= 35
    for c in cases:
        assert c["expected"]["severity"] in SEVERITY_LEVELS
        assert c["expected"]["incident_type"] in INCIDENT_TYPES
        assert isinstance(c["expected"]["investigate"], bool)
        assert c["trigger"]["kind"] and c["decisions"]
