from __future__ import annotations

import json

import httpx

from agentmon_fleet.collectors import tenant
from agentmon_fleet.collectors.tenant import (
    DefenderXdrCollector, EntraAgentIdCollector, PurviewCollector, match_agent_key, purview_events, tenant_collectors)
from agentmon_fleet.detectors.controlplane import ControlPlaneAuditor
from agentmon_fleet.detectors.inference import InferenceNetworkSentinel
from agentmon_fleet.models import Decision, EventKind, Platform

from .conftest import profile


def _tok(_scope: str) -> str:
    return "t"


def test_flags_default_off(settings):
    assert tenant_collectors(settings) == []
    s = settings.model_copy(update={"tenant_entra": True, "tenant_defender": True, "tenant_purview": True,
                                    "azure_tenant_id": "tid"})
    assert [c.name for c in tenant_collectors(s)] == ["purview", "entra", "defender"]
    s2 = settings.model_copy(update={"tenant_purview": True, "azure_tenant_id": None})
    assert tenant_collectors(s2) == []  # purview needs the tenant id


COPILOT_REC = {
    "Id": "rec-1", "RecordType": 261, "Operation": "CopilotInteraction", "CreationTime": "2026-09-30T12:00:00",
    "UserId": "sam@agentmon.lab", "ClientIP": "198.51.100.7",
    "CopilotEventData": {"AppHost": "Copilot Studio", "AgentId": "bot-1", "AgentName": "AgentMon HR Policy",
                         "ThreadId": "thread-9",
                         "Messages": [{"Id": "m1", "isPrompt": True, "JailbreakDetected": True}, {"Id": "m2"}],
                         "AccessedResources": [{"Type": "File", "SiteUrl": "https://contoso.sharepoint.com/hr/pay.xlsx",
                                                "SensitivityLabelId": "confidential", "Action": "Read"}]}}


def test_purview_copilot_interaction_and_jailbreak():
    evs = purview_events(COPILOT_REC)
    inf, jb = evs
    assert inf.kind == EventKind.INFERENCE and inf.platform == Platform.COPILOT_STUDIO
    assert inf.session_id == "thread-9" and inf.agent_id == "bot-1" and inf.user_id == "sam@agentmon.lab"
    assert inf.effects[0].data_class == "label:confidential"
    assert jb.kind == EventKind.POLICY_DECISION and jb.decision == Decision.BLOCKED
    assert "jailbreak" in jb.decision_reason and jb.tool_name is None


def test_purview_bot_operation_feeds_control_plane_auditor(ctx):
    rec = {"Id": "r2", "RecordType": 204, "Operation": "BotUpdateOperation-BotPublish", "Workload": "PowerPlatform",
           "CreationTime": "2026-09-30T12:00:00", "UserId": "maker@agentmon.lab", "BotId": "bot-1"}
    (e,) = purview_events(rec)
    assert e.kind == EventKind.CONTROL_PLANE and e.tool_name.endswith("/WRITE")
    alerts = ControlPlaneAuditor().process(e, ctx)
    assert [a.alert_type for a in alerts] == ["AGENT_CONFIG_CHANGE"]
    assert purview_events({"Id": "x", "RecordType": 1, "Operation": "FileAccessed"}) == []


def test_purview_collector_lists_content_and_advances_cursor(settings, state):
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path.endswith("/subscriptions/content"):
            return httpx.Response(200, json=[{"contentUri": "https://manage.office.com/blob/1"}])
        if req.url.path.endswith("/blob/1"):
            return httpx.Response(200, json=[COPILOT_REC])
        return httpx.Response(404)

    s = settings.model_copy(update={"azure_tenant_id": "tid", "lookback_minutes": 60})
    col = PurviewCollector(s, http=httpx.Client(transport=httpx.MockTransport(handler)), token=_tok)
    res = col.collect(state)
    assert not res.errors and len(res.events) == 2
    assert state.get_cursor("tenant.purview")
    assert "/subscriptions/start" not in " ".join(calls)  # never started unless explicitly allowed


def test_entra_registers_agent_identities_and_maps_signins(settings, state):
    state.put_profile(profile("agentmon-it-helpdesk"))

    def handler(req: httpx.Request) -> httpx.Response:
        if "agentIdentity" in req.url.path:
            return httpx.Response(200, json={"value": [{"id": "SP-1", "displayName": "agentmon-it-helpdesk"},
                                                       {"id": "SP-2", "displayName": "orphan-agent"}]})
        if req.url.path.endswith("/auditLogs/signIns"):
            assert "AgentIdentity" in req.url.params["$filter"]
            return httpx.Response(200, json={"value": [
                {"id": "si-1", "servicePrincipalId": "SP-1", "createdDateTime": "2026-09-30T12:00:00Z",
                 "status": {"errorCode": 0}, "resourceDisplayName": "Azure AI Services", "ipAddress": "10.0.0.4"},
                {"id": "si-2", "servicePrincipalId": "SP-2", "createdDateTime": "2026-09-30T12:01:00Z",
                 "status": {"errorCode": 7000218, "failureReason": "invalid client"}}]})
        return httpx.Response(404)

    col = EntraAgentIdCollector(settings, http=httpx.Client(transport=httpx.MockTransport(handler)), token=_tok)
    res = col.collect(state)
    assert not res.errors
    ident = state.get_identity("sp-1")
    assert ident["kind"] == "agent_identity" and ident["agent_key"] == "foundry:agentmon-it-helpdesk"
    ok, failed = sorted(res.events, key=lambda e: e.occurred_at)
    assert ok.platform == Platform.FOUNDRY and ok.agent_id == "agentmon-it-helpdesk" and ok.decision == Decision.ALLOWED
    assert failed.kind == EventKind.POLICY_DECISION and failed.decision == Decision.BLOCKED
    assert failed.decision_reason.startswith("access denied")


def test_match_agent_key():
    profiles = {"agentmon-it-helpdesk": "foundry:a", "agentmon-data-analyst": "foundry:b"}
    assert match_agent_key("AgentMon-IT-Helpdesk", profiles) == "foundry:a"
    assert match_agent_key("codex-jay/agentmon-data-analyst", profiles) == "foundry:b"
    assert match_agent_key("agentmon", profiles) is None  # ambiguous


def test_defender_alerts_pass_through_and_missing_tables_are_skipped(settings, state, ctx):
    queries: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        q = json.loads(req.content)["Query"]
        queries.append(q.split()[0])
        if q.startswith("AlertInfo"):
            return httpx.Response(200, json={"results": [
                {"Timestamp": "2026-09-30T12:00:00Z", "AlertId": "da1", "Title": "Jailbreak attempt on an AI agent",
                 "Severity": "High", "Category": "AI", "Entities": [{"account": "oid-7"}]}]})
        if q.startswith("CloudAppEvents"):
            return httpx.Response(200, json={"results": [
                {"Timestamp": "2026-09-30T12:00:00Z", "ReportId": "r1", "ActionType": "BotDeleted",
                 "Application": "Microsoft Copilot Studio", "ObjectId": "bot-1"},
                {"Timestamp": "2026-09-30T12:00:00Z", "ReportId": "r2", "ActionType": "BotChatMessage"}]})
        return httpx.Response(400, text="Semantic error: Failed to resolve table 'X'")

    col = DefenderXdrCollector(settings, http=httpx.Client(transport=httpx.MockTransport(handler)), token=_tok)
    res = col.collect(state)
    assert not res.errors
    alert_ev = next(e for e in res.events if e.source == "tenant.defender")
    (a,) = InferenceNetworkSentinel().process(alert_ev, ctx)
    assert a.alert_type == "JAILBREAK_ATTEMPT" and a.score == 80
    cp = [e for e in res.events if e.kind == EventKind.CONTROL_PLANE]
    assert len(cp) == 1 and cp[0].tool_name.endswith("/DELETE")
    assert col._missing == {"behaviors", "agents"}
    col.collect(state)
    assert queries.count("BehaviorInfo") == 1  # not retried once known missing


def test_tenant_module_is_imported_by_pipeline():
    from agentmon_fleet.pipeline import build_collectors
    assert tenant.tenant_collectors and build_collectors
