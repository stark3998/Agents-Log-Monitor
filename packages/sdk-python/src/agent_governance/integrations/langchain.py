from __future__ import annotations

from typing import Any, Callable

from agent_governance.client import GovernanceClient, GovernanceDenied

class GovernanceCallbackHandler:
    def __init__(self, client: GovernanceClient, *, session_id: str | Callable[..., str]):
        self.client = client
        self.session_id = session_id
        self._pending: dict[str, tuple[str, str, str]] = {}

    def _session(self, *args: Any, **kwargs: Any) -> str:
        return self.session_id(*args, **kwargs) if callable(self.session_id) else self.session_id

    def on_tool_start(self, serialized: dict[str, Any], input_str: str, *, run_id: str | None = None, **kwargs: Any) -> None:
        tool_name = serialized.get('name') or serialized.get('id') or 'langchain-tool'
        sid = self._session(serialized, input_str, **kwargs)
        decision = self.client.check({'sessionId': sid, 'toolName': tool_name, 'checkpoint': 'pre_tool', 'args': input_str})
        if decision['verdict'] == 'deny':
            raise GovernanceDenied(decision)
        if run_id:
            self._pending[str(run_id)] = (decision['requestId'], sid, tool_name)

    def on_tool_end(self, output: Any, *, run_id: str | None = None, **kwargs: Any) -> None:
        if not run_id or str(run_id) not in self._pending:
            return
        request_id, sid, tool_name = self._pending.pop(str(run_id))
        self.client.observe_result(request_id=request_id, session_id=sid, tool_name=tool_name, result=str(output))

def wrap_tool(tool: Any, client: GovernanceClient, *, session_id: str | Callable[..., str], tool_name: str | None = None):
    name = tool_name or getattr(tool, 'name', None) or 'langchain-tool'
    original_invoke = getattr(tool, 'invoke')

    def invoke(input: Any, *args: Any, **kwargs: Any):
        sid = session_id(input, *args, **kwargs) if callable(session_id) else session_id
        decision = client.check({'sessionId': sid, 'toolName': name, 'checkpoint': 'pre_tool', 'args': input})
        if decision['verdict'] == 'deny':
            raise GovernanceDenied(decision)
        result = original_invoke(input, *args, **kwargs)
        client.observe_result(request_id=decision['requestId'], session_id=sid, tool_name=name, result=str(result))
        return result

    class Wrapped:
        def __getattr__(self, item: str):
            return getattr(tool, item)
        def invoke(self, input: Any, *args: Any, **kwargs: Any):
            return invoke(input, *args, **kwargs)
    return Wrapped()
