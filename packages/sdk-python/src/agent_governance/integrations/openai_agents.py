from __future__ import annotations

from typing import Any, Callable

from agent_governance.client import AsyncGovernanceClient

def governance_tool_input_guardrail(
    client: AsyncGovernanceClient,
    *,
    session_id: str | Callable[[Any], str],
    tool_name: str | None = None,
):
    try:
        from agents import ToolGuardrailFunctionOutput, tool_input_guardrail  # type: ignore
    except ImportError as exc:
        raise ImportError('Install agent-governance[openai-agents] to use this integration') from exc

    @tool_input_guardrail
    async def guardrail(data: Any):
        context = getattr(data, 'context', data)
        args = getattr(context, 'tool_arguments', None) or getattr(data, 'tool_arguments', None) or data
        name = tool_name or getattr(context, 'tool_name', None) or 'openai-agents-tool'
        sid = session_id(data) if callable(session_id) else session_id
        decision = await client.check({'sessionId': sid, 'toolName': name, 'checkpoint': 'pre_tool', 'args': args})
        if decision['verdict'] == 'deny':
            return ToolGuardrailFunctionOutput.reject_content(reason=decision['reason'])
        return ToolGuardrailFunctionOutput.allow()
    return guardrail

def wrap_function_tool(
    fn: Callable[..., Any],
    client: AsyncGovernanceClient,
    *,
    session_id: str | Callable[..., str],
    name: str | None = None,
    **function_tool_kwargs: Any,
):
    try:
        from agents import function_tool  # type: ignore
    except ImportError as exc:
        raise ImportError('Install agent-governance[openai-agents] to use this integration') from exc

    tool_name = name or getattr(fn, '__name__', 'openai-agents-tool')

    async def wrapped(*args: Any, **kwargs: Any):
        sid = session_id(*args, **kwargs) if callable(session_id) else session_id
        decision = await client.check({'sessionId': sid, 'toolName': tool_name, 'checkpoint': 'pre_tool', 'args': {'args': args, 'kwargs': kwargs}})
        if decision['verdict'] == 'deny':
            return {'error': decision['reason'], 'governanceDecisionId': decision['id']}
        result = fn(*args, **kwargs)
        if hasattr(result, '__await__'):
            result = await result
        await client.observe_result(request_id=decision['requestId'], session_id=sid, tool_name=tool_name, result=str(result))
        return result

    return function_tool(wrapped, name_override=tool_name, **function_tool_kwargs)
