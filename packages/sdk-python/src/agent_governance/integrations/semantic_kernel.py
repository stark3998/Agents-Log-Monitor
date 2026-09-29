from __future__ import annotations

from typing import Any, Callable

from agent_governance.client import AsyncGovernanceClient

def add_governance_filter(
    kernel: Any,
    client: AsyncGovernanceClient,
    *,
    session_id: str | Callable[[Any], str],
    deny_result: Callable[[Any], Any] | None = None,
):
    try:
        from semantic_kernel.filters.filter_types import FilterTypes  # type: ignore
    except ImportError as exc:
        raise ImportError('Install agent-governance[semantic-kernel] to use this integration') from exc

    async def governance_filter(context: Any, next_filter: Callable[[Any], Any]):
        function = getattr(context, 'function', None) or getattr(context, 'function_metadata', None)
        tool_name = getattr(function, 'name', None) or getattr(function, 'plugin_name', None) or 'semantic-kernel-function'
        args = getattr(context, 'arguments', None)
        sid = session_id(context) if callable(session_id) else session_id
        decision = await client.check({'sessionId': sid, 'toolName': tool_name, 'checkpoint': 'pre_tool', 'args': args})
        if decision['verdict'] == 'deny':
            context.result = deny_result(decision) if deny_result else {'error': decision['reason'], 'governanceDecisionId': decision['id']}
            return
        await next_filter(context)
        if getattr(context, 'result', None) is not None:
            await client.observe_result(request_id=decision['requestId'], session_id=sid, tool_name=tool_name, result=str(context.result))

    kernel.add_filter(FilterTypes.AUTO_FUNCTION_INVOCATION, governance_filter)
    return governance_filter
