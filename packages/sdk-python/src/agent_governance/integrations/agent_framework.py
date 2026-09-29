from __future__ import annotations

from typing import Any, Callable

from agent_governance.client import AsyncGovernanceClient

def create_function_middleware(
    client: AsyncGovernanceClient,
    *,
    session_id: str | Callable[[Any], str],
    deny_result: Callable[[Any], Any] | None = None,
):
    try:
        from agent_framework import FunctionMiddleware  # type: ignore
    except ImportError as exc:
        raise ImportError('Install agent-governance[agent-framework] to use this integration') from exc

    class GovernanceFunctionMiddleware(FunctionMiddleware):  # type: ignore[misc,valid-type]
        async def process(self, context: Any, next: Callable[[Any], Any]):
            function = getattr(context, 'function', None)
            tool_name = getattr(function, 'name', None) or getattr(function, '__name__', None) or 'agent-framework-function'
            args = getattr(context, 'arguments', None)
            sid = session_id(context) if callable(session_id) else session_id
            decision = await client.check({'sessionId': sid, 'toolName': tool_name, 'checkpoint': 'pre_tool', 'args': args})
            if decision['verdict'] == 'deny':
                context.result = deny_result(decision) if deny_result else {'error': decision['reason'], 'governanceDecisionId': decision['id']}
                context.terminate = True
                return
            await next(context)
            result = getattr(context, 'result', None)
            if result is not None:
                await client.observe_result(request_id=decision['requestId'], session_id=sid, tool_name=tool_name, result=str(result))

    return GovernanceFunctionMiddleware()
