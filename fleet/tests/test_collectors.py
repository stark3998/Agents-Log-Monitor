from agentmon_fleet.collectors.dataverse_transcripts import parse_activities
from agentmon_fleet.collectors.foundry_items import items_to_events
from agentmon_fleet.collectors.genai import detect_refusal
from agentmon_fleet.collectors.law import LogAnalyticsCollector
from agentmon_fleet.models import Decision, EventKind, Platform

from .conftest import T0


class _NoClient:
    pass


def _law(settings):
    return LogAnalyticsCollector(settings, client=_NoClient())


def test_inference_usage_row_with_array_tokens(settings):
    rows = _law(settings)._inference({"TimeGenerated": T0.isoformat(), "Category": "AzureOpenAIRequestUsage",
                                      "OperationName": "responses", "ResultSignature": "", "CorrelationId": "c1",
                                      "objectId": "OID", "deployment": "gpt-5.5", "promptTokens": 10,
                                      "completionTokens": 5, "ResourceId": "/x/accounts/acct"})
    e = rows[0]
    assert e.kind == EventKind.INFERENCE and e.caller_object_id == "OID" and e.tokens_in == 10 and e.model == "gpt-5.5"


def test_403_is_access_denied_and_audit_is_control_plane(settings):
    law = _law(settings)
    d = law._inference({"TimeGenerated": T0.isoformat(), "Category": "RequestResponse", "OperationName": "Projects_Get",
                        "ResultSignature": "403", "CorrelationId": "c2"})[0]
    assert d.decision == Decision.BLOCKED and "access denied" in d.decision_reason
    a = law._inference({"TimeGenerated": T0.isoformat(), "Category": "Audit", "OperationName": "ListKey",
                        "CorrelationId": "c3", "objectId": "X"})[0]
    assert a.kind == EventKind.CONTROL_PLANE and a.tool_name == "ListKey"


def test_network_flow_status_words(settings):
    law = _law(settings)
    denied = law._network({"TimeGenerated": T0.isoformat(), "SrcIp": "198.51.100.1", "DestIp": "10.42.1.4",
                           "DestPort": 23, "FlowType": "ExternalPublic", "FlowDirection": "Inbound",
                           "Statuses": '["Denied"]'})[0]
    assert denied.decision == Decision.BLOCKED and denied.attributes["direction"] == "inbound"
    mixed = law._network({"TimeGenerated": T0.isoformat(), "SrcIp": "10.42.1.4", "DestIp": "198.51.100.1",
                          "DestPort": 443, "FlowType": "ExternalPublic", "FlowDirection": "Outbound",
                          "Statuses": ["Allowed", "Denied"]})[0]
    assert mixed.decision == Decision.ALLOWED


def test_otel_execute_tool_span(settings):
    e = _law(settings)._span({"TimeGenerated": T0.isoformat(), "SpanId": "s1", "TraceId": "t1", "Success": False,
                              "Properties": {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "send_email",
                                             "gen_ai.agent.name": "helpdesk", "gen_ai.conversation.id": "conv1",
                                             "gen_ai.tool.call.arguments": '{"to": "x@evil.com"}',
                                             "gen_ai.tool.call.result": "Blocked by policy: external recipients"}})
    assert len(e) == 1 and e[0].decision == Decision.BLOCKED and e[0].session_id == "conv1"
    assert e[0].arguments == {"to": "x@evil.com"}


def test_responses_items_mcp_approval_denied_and_code():
    items = [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "reset bob's password"}]},
        {"type": "mcp_approval_request", "id": "apr1", "server_label": "it", "name": "reset_password",
         "arguments": '{"user": "bob"}'},
        {"type": "mcp_approval_response", "approval_request_id": "apr1", "approve": False},
        {"type": "code_interpreter_call", "id": "ci1", "code": "import os\nprint(os.environ)", "outputs": []},
    ]
    evs = items_to_events(items, base={"platform": Platform.FOUNDRY, "source": "t", "session_id": "c"},
                          occurred_at=T0, id_prefix="r1")
    kinds = [(e.kind, e.tool_name, e.decision) for e in evs]
    assert (EventKind.USER_MESSAGE, None, None) in kinds
    assert (EventKind.TOOL_CALL, "it.reset_password", Decision.BLOCKED) in kinds
    assert (EventKind.TOOL_CALL, "code_interpreter", Decision.ALLOWED) in kinds


def test_tool_output_arriving_in_a_later_response_is_not_lost():
    base = {"platform": Platform.FOUNDRY, "source": "t", "session_id": "c"}
    call = {"type": "function_call", "id": "fc_1", "call_id": "call_1", "name": "fetch_vendor_page", "arguments": "{}"}
    turn1 = items_to_events([call], base=base, occurred_at=T0, id_prefix="r1")
    out = {"type": "function_call_output", "id": "fco_1", "call_id": "call_1",
           "output": "Blocked by policy: external host"}
    turn2 = items_to_events([call, out], base=base, occurred_at=T0, id_prefix="r2")
    assert turn1[0].id == turn2[0].id  # same call item -> deduplicated on insert
    res = [e for e in turn2 if e.kind == EventKind.TOOL_RESULT]
    assert res and res[0].decision == Decision.BLOCKED and res[0].tool_name == "fetch_vendor_page"


def test_copilot_studio_plan_steps():
    acts = [
        {"type": "message", "id": "1", "timestamp": 1790000000, "from": {"role": 1, "aadObjectId": "u9"}, "text": "status of vpn"},
        {"type": "event", "id": "2", "timestamp": 1790000001, "valueType": "DynamicPlanStepTriggered",
         "value": {"planIdentifier": "p1", "taskDialogId": "cr_itops.action.HttpStatus", "thought": "check vpn"}},
        {"type": "event", "id": "3", "timestamp": 1790000002, "valueType": "DynamicPlanStepBindUpdate",
         "value": {"planIdentifier": "p1", "taskDialogId": "cr_itops.action.HttpStatus", "arguments": {"url": "https://status.agentmon.lab/vpn"}}},
        {"type": "event", "id": "4", "timestamp": 1790000003, "valueType": "DynamicPlanStepFinished",
         "value": {"planIdentifier": "p1", "taskDialogId": "cr_itops.action.HttpStatus", "state": "completed",
                   "observation": {"status": "up"}}},
    ]
    evs = parse_activities(acts, "conv", "bot1", "AgentMon IT Ops", "env", "tenant")
    tool = [e for e in evs if e.kind == EventKind.TOOL_CALL][0]
    assert tool.tool_type == "action" and tool.arguments["url"].startswith("https://status") and tool.thought == "check vpn"
    assert evs[0].user_id == "u9"


def test_refusal_detection():
    assert detect_refusal("I'm sorry, but I can't help with creating malware.")
    assert detect_refusal("That request is outside my scope as an HR assistant.")
    assert not detect_refusal("Here is the summary you asked for. I can't wait to help more!")
