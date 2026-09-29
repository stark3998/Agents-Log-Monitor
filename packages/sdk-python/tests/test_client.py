import pytest
import httpx
import sys
import types

from agent_governance import AsyncGovernanceClient, GovernanceClient, GovernanceDenied
from agent_governance.integrations.langchain import GovernanceCallbackHandler, wrap_tool

def decision(verdict='allow', **extra):
    data = {
        'id': 'd1',
        'requestId': 'r1',
        'sessionId': 's1',
        'agentId': 'a1',
        'laneId': 'l1',
        'laneVersion': 1,
        'mode': 'enforce',
        'checkpoint': 'pre_tool',
        'toolName': 'tool',
        'verdict': verdict,
        'effectiveVerdict': verdict,
        'wouldDeny': verdict == 'deny',
        'stage': 'rules_allow',
        'reason': verdict,
        'ruleIds': [],
        'riskLevel': None,
        'tainted': False,
        'latencyMs': 1,
        'createdAt': '2026-01-01T00:00:00Z',
    }
    data.update(extra)
    return data

def response(data, status=200):
    return httpx.Response(status, json=data)

def test_allow_and_auth_header():
    def handler(request):
        assert request.url.path == '/v1/decide'
        assert request.headers['authorization'] == 'Bearer t'
        return response(decision('allow'))
    client = GovernanceClient(base_url='https://pdp', token='t', agent={'surface': 'sdk'}, transport=httpx.MockTransport(handler))
    assert client.check({'sessionId': 's1', 'toolName': 'tool'})['verdict'] == 'allow'

def test_deny_decision():
    client = GovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    assert client.check({'sessionId': 's1', 'toolName': 'tool'})['verdict'] == 'deny'

def test_escalate_polling():
    def handler(request):
        if request.url.path == '/v1/decide':
            return response(decision('escalate', approvalId='ap1', stage='judge_escalation'))
        return response({'id': 'ap1', 'state': 'approved', 'requestId': 'r1', 'sessionId': 's1', 'agentId': 'a1', 'laneId': 'l1', 'summary': '', 'reason': '', 'channels': [], 'requestedAt': '', 'expiresAt': '', 'resolvedBy': 'human'})
    client = GovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, approval_poll_interval_ms=1, transport=httpx.MockTransport(handler))
    result = client.check({'sessionId': 's1', 'toolName': 'tool'})
    assert result['verdict'] == 'allow'
    assert result['stage'] == 'human'

def test_fail_modes():
    def handler(request):
        raise httpx.ConnectError('offline', request=request)
    client = GovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, fail_mode={'default': 'closed', 'READ': 'open'}, transport=httpx.MockTransport(handler))
    assert client.check({'sessionId': 's1', 'toolName': 'read', 'category': 'READ'})['verdict'] == 'allow'
    assert client.check({'sessionId': 's1', 'toolName': 'write', 'category': 'WRITE'})['verdict'] == 'deny'

def test_guard_decorator_throws():
    client = GovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    @client.guard('danger', session_id='s1')
    def danger():
        return 'executed'
    with pytest.raises(GovernanceDenied):
        danger()

@pytest.mark.asyncio
async def test_async_client():
    client = AsyncGovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('allow'))))
    assert (await client.check({'sessionId': 's1', 'toolName': 'tool'}))['verdict'] == 'allow'
    await client.aclose()

def test_langchain_adapter_deny_path():
    client = GovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    handler = GovernanceCallbackHandler(client, session_id='s1')
    with pytest.raises(GovernanceDenied):
        handler.on_tool_start({'name': 'refund'}, '{}', run_id='r')

    class Tool:
        name = 'refund'
        def invoke(self, input):
            return 'executed'
    wrapped = wrap_tool(Tool(), client, session_id='s1')
    with pytest.raises(GovernanceDenied):
        wrapped.invoke({})

@pytest.mark.asyncio
async def test_agent_framework_fake_middleware_deny(monkeypatch):
    module = types.ModuleType('agent_framework')
    class FunctionMiddleware:
        pass
    module.FunctionMiddleware = FunctionMiddleware
    monkeypatch.setitem(sys.modules, 'agent_framework', module)

    from agent_governance.integrations.agent_framework import create_function_middleware
    client = AsyncGovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    middleware = create_function_middleware(client, session_id='s1')
    context = types.SimpleNamespace(function=types.SimpleNamespace(name='refund'), arguments={'x': 1}, result=None, terminate=False)
    called = False
    async def next_call(_context):
        nonlocal called
        called = True
    await middleware.process(context, next_call)
    assert context.terminate is True
    assert context.result['error'] == 'deny'
    assert called is False
    await client.aclose()

@pytest.mark.asyncio
async def test_semantic_kernel_fake_filter_deny(monkeypatch):
    filter_types = types.ModuleType('semantic_kernel.filters.filter_types')
    filter_types.FilterTypes = types.SimpleNamespace(AUTO_FUNCTION_INVOCATION='auto')
    monkeypatch.setitem(sys.modules, 'semantic_kernel', types.ModuleType('semantic_kernel'))
    monkeypatch.setitem(sys.modules, 'semantic_kernel.filters', types.ModuleType('semantic_kernel.filters'))
    monkeypatch.setitem(sys.modules, 'semantic_kernel.filters.filter_types', filter_types)

    from agent_governance.integrations.semantic_kernel import add_governance_filter
    client = AsyncGovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    captured = {}
    class Kernel:
        def add_filter(self, filter_type, filter_func):
            captured['type'] = filter_type
            captured['filter'] = filter_func
    add_governance_filter(Kernel(), client, session_id='s1')
    context = types.SimpleNamespace(function=types.SimpleNamespace(name='refund'), arguments={}, result=None)
    called = False
    async def next_filter(_context):
        nonlocal called
        called = True
    await captured['filter'](context, next_filter)
    assert captured['type'] == 'auto'
    assert context.result['error'] == 'deny'
    assert called is False
    await client.aclose()

@pytest.mark.asyncio
async def test_openai_agents_fake_guardrail_deny(monkeypatch):
    module = types.ModuleType('agents')
    class ToolGuardrailFunctionOutput:
        @staticmethod
        def reject_content(reason):
            return {'allowed': False, 'reason': reason}
        @staticmethod
        def allow():
            return {'allowed': True}
    def tool_input_guardrail(fn):
        return fn
    module.ToolGuardrailFunctionOutput = ToolGuardrailFunctionOutput
    module.tool_input_guardrail = tool_input_guardrail
    monkeypatch.setitem(sys.modules, 'agents', module)

    from agent_governance.integrations.openai_agents import governance_tool_input_guardrail
    client = AsyncGovernanceClient(base_url='https://pdp', agent={'surface': 'sdk'}, transport=httpx.MockTransport(lambda request: response(decision('deny'))))
    guardrail = governance_tool_input_guardrail(client, session_id='s1', tool_name='refund')
    result = await guardrail(types.SimpleNamespace(context=types.SimpleNamespace(tool_arguments={'x': 1}, tool_name='refund')))
    assert result == {'allowed': False, 'reason': 'deny'}
    await client.aclose()
