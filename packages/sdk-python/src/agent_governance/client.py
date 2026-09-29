from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any, ParamSpec, TypeVar, cast

import httpx

from .types import ActionRequest, AgentIdentity, Approval, Checkpoint, Decision, FailMode, GoalResponse, ResultResponse, ToolCategory

P = ParamSpec('P')
R = TypeVar('R')
FailModeConfig = FailMode | dict[str, FailMode]

class GovernanceDenied(Exception):
    def __init__(self, decision: Decision):
        super().__init__(decision.get('reason') or 'Governance denied the action')
        self.decision = decision

def _id(prefix: str) -> str:
    return f'{prefix}_{uuid.uuid4()}'

def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')

def _merge_agent(base: AgentIdentity, override: AgentIdentity | None) -> AgentIdentity:
    merged: AgentIdentity = dict(base)
    if override:
        merged.update(override)
    return merged

class _BaseGovernanceClient:
    def __init__(
        self,
        *,
        base_url: str,
        agent: AgentIdentity,
        token: str | None = None,
        get_token: Callable[[], str] | Callable[[], Awaitable[str]] | None = None,
        fail_mode: FailModeConfig | None = None,
        timeout_ms: int = 30_000,
        approval_poll_interval_ms: int = 1_000,
    ):
        self.base_url = base_url.rstrip('/')
        self.agent = agent
        self.token = token
        self.get_token = get_token
        self.fail_mode = fail_mode or {'default': 'closed', 'READ': 'open'}
        self.timeout_ms = timeout_ms
        self.approval_poll_interval_ms = approval_poll_interval_ms

    def _fail_mode_for(self, category: ToolCategory | None) -> FailMode:
        if isinstance(self.fail_mode, str):
            return self.fail_mode
        if category and category in self.fail_mode:
            return self.fail_mode[category]
        return self.fail_mode.get('default', 'closed')

    def _fail_mode_decision(self, request: ActionRequest, error: Exception) -> Decision:
        mode = self._fail_mode_for(cast(ToolCategory | None, request.get('category')))
        verdict = 'allow' if mode == 'open' else 'deny'
        agent = cast(AgentIdentity, request['agent'])
        decision: Decision = {
            'id': _id('local_decision'),
            'requestId': cast(str, request['requestId']),
            'sessionId': cast(str, request['sessionId']),
            'agentId': agent.get('agentId') or agent.get('externalId') or agent.get('name') or 'unknown',
            'laneId': 'local-fail-mode',
            'laneVersion': 0,
            'mode': 'enforce',
            'checkpoint': cast(Checkpoint, request['checkpoint']),
            'verdict': verdict,
            'effectiveVerdict': verdict,
            'wouldDeny': verdict == 'deny',
            'stage': 'fail_mode',
            'reason': f'PDP unavailable; fail-{mode}: {error}',
            'ruleIds': ['local-fail-mode'],
            'riskLevel': None,
            'tainted': False,
            'latencyMs': 0,
            'createdAt': _now(),
        }
        if 'toolName' in request:
            decision['toolName'] = cast(str, request['toolName'])
        if 'category' in request:
            decision['category'] = cast(ToolCategory, request['category'])
        return decision

    def _normalize(self, action: ActionRequest) -> ActionRequest:
        if 'sessionId' not in action:
            raise ValueError('sessionId is required')
        req: ActionRequest = dict(action)
        req.setdefault('requestId', _id('gov_req'))
        req.setdefault('checkpoint', 'pre_tool')
        req['agent'] = _merge_agent(self.agent, cast(AgentIdentity | None, action.get('agent')))
        return req

    @staticmethod
    def _decision_from_approval(decision: Decision, approval: Approval) -> Decision:
        allowed = approval.get('state') == 'approved'
        updated: Decision = dict(decision)
        updated['verdict'] = 'allow' if allowed else 'deny'
        updated['effectiveVerdict'] = updated['verdict']
        updated['wouldDeny'] = not allowed
        updated['stage'] = 'human'
        updated['reason'] = approval.get('resolutionNote') or ('Human approval granted' if allowed else f"Human approval {approval.get('state')}")
        if approval.get('resolvedBy'):
            updated['approver'] = approval['resolvedBy']
        return updated

class GovernanceClient(_BaseGovernanceClient):
    def __init__(
        self,
        *,
        base_url: str,
        agent: AgentIdentity,
        token: str | None = None,
        get_token: Callable[[], str] | None = None,
        fail_mode: FailModeConfig | None = None,
        timeout_ms: int = 30_000,
        approval_poll_interval_ms: int = 1_000,
        transport: httpx.BaseTransport | None = None,
    ):
        super().__init__(base_url=base_url, agent=agent, token=token, get_token=get_token, fail_mode=fail_mode, timeout_ms=timeout_ms, approval_poll_interval_ms=approval_poll_interval_ms)
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout_ms / 1000, transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> GovernanceClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def goal(self, session_id: str, text: str, source: str | None = None) -> GoalResponse:
        body: dict[str, Any] = {'sessionId': session_id, 'agent': self.agent, 'text': text}
        if source:
            body['source'] = source
        return cast(GoalResponse, self._request('POST', '/v1/goal', json=body).json())

    def check(self, action: ActionRequest, *, blocking: bool = True, supports_ask: bool = False, deadline_ms: int | None = None) -> Decision:
        request = self._normalize(action)
        deadline = deadline_ms or self.timeout_ms
        started = time.monotonic()
        try:
            decision = cast(Decision, self._request('POST', '/v1/decide', json={**request, 'options': {'blocking': blocking, 'supportsAsk': supports_ask, 'deadlineMs': deadline}}, timeout=deadline / 1000).json())
            if decision.get('verdict') == 'escalate' and decision.get('approvalId'):
                remaining = max(0.0, deadline / 1000 - (time.monotonic() - started))
                decision = self._resolve_escalation(decision, remaining)
            return decision
        except Exception as exc:
            return self._fail_mode_decision(request, exc if isinstance(exc, Exception) else Exception(str(exc)))

    def observe_result(self, *, request_id: str, session_id: str, tool_name: str | None = None, result: str, agent: AgentIdentity | None = None) -> ResultResponse:
        try:
            body = {'requestId': request_id, 'sessionId': session_id, 'agent': _merge_agent(self.agent, agent), 'toolName': tool_name, 'result': result}
            return cast(ResultResponse, self._request('POST', '/v1/result', json=body).json())
        except Exception as exc:
            return {'tainted': False, 'reason': str(exc)}

    def check_response(self, *, session_id: str, text: str, request_id: str | None = None, tokens: dict[str, int] | None = None, meta: dict[str, Any] | None = None) -> Decision:
        action: ActionRequest = {'sessionId': session_id, 'checkpoint': 'response', 'text': text}
        if request_id:
            action['requestId'] = request_id
        if tokens:
            action['tokens'] = tokens
        if meta:
            action['meta'] = meta
        return self.check(action)

    def guard(self, tool_name: str, *, session_id: str | None = None, category: ToolCategory | None = None, args: Any = None):
        client = self
        class Guard:
            def __enter__(self_nonlocal):
                decision = client.check({'sessionId': session_id or _session_from_args(args), 'toolName': tool_name, 'category': category, 'args': args})
                if decision['verdict'] == 'deny':
                    raise GovernanceDenied(decision)
                self_nonlocal.decision = decision
                return decision
            def __exit__(self_nonlocal, *exc: object) -> None:
                return None
            def __call__(self_nonlocal, fn: Callable[P, R]) -> Callable[P, R]:
                @wraps(fn)
                def wrapper(*fn_args: P.args, **fn_kwargs: P.kwargs) -> R:
                    payload = args if args is not None else {'args': fn_args, 'kwargs': fn_kwargs}
                    sid = session_id or _session_from_args(fn_kwargs) or _session_from_args(fn_args[-1] if fn_args else None)
                    decision = client.check({'sessionId': sid, 'toolName': tool_name, 'category': category, 'args': payload})
                    if decision['verdict'] == 'deny':
                        raise GovernanceDenied(decision)
                    return fn(*fn_args, **fn_kwargs)
                return wrapper
        return Guard()

    def _resolve_escalation(self, decision: Decision, timeout_s: float) -> Decision:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            approval = cast(Approval, self._request('GET', f"/v1/approvals/{decision['approvalId']}").json())
            if approval.get('state') != 'pending':
                return self._decision_from_approval(decision, approval)
            time.sleep(self.approval_poll_interval_ms / 1000)
        raise TimeoutError('approval polling timed out')

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = kwargs.pop('headers', {}) or {}
        token = self.token or (self.get_token() if self.get_token else None)
        if token:
            headers['Authorization'] = f'Bearer {token}'
        response = self._client.request(method, path, headers=headers, **kwargs)
        response.raise_for_status()
        return response

class AsyncGovernanceClient(_BaseGovernanceClient):
    def __init__(
        self,
        *,
        base_url: str,
        agent: AgentIdentity,
        token: str | None = None,
        get_token: Callable[[], str | Awaitable[str]] | None = None,
        fail_mode: FailModeConfig | None = None,
        timeout_ms: int = 30_000,
        approval_poll_interval_ms: int = 1_000,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        super().__init__(base_url=base_url, agent=agent, token=token, get_token=get_token, fail_mode=fail_mode, timeout_ms=timeout_ms, approval_poll_interval_ms=approval_poll_interval_ms)
        self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout_ms / 1000, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> AsyncGovernanceClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def goal(self, session_id: str, text: str, source: str | None = None) -> GoalResponse:
        body: dict[str, Any] = {'sessionId': session_id, 'agent': self.agent, 'text': text}
        if source:
            body['source'] = source
        return cast(GoalResponse, (await self._request('POST', '/v1/goal', json=body)).json())

    async def check(self, action: ActionRequest, *, blocking: bool = True, supports_ask: bool = False, deadline_ms: int | None = None) -> Decision:
        request = self._normalize(action)
        deadline = deadline_ms or self.timeout_ms
        started = time.monotonic()
        try:
            decision = cast(Decision, (await self._request('POST', '/v1/decide', json={**request, 'options': {'blocking': blocking, 'supportsAsk': supports_ask, 'deadlineMs': deadline}}, timeout=deadline / 1000)).json())
            if decision.get('verdict') == 'escalate' and decision.get('approvalId'):
                remaining = max(0.0, deadline / 1000 - (time.monotonic() - started))
                decision = await self._resolve_escalation(decision, remaining)
            return decision
        except Exception as exc:
            return self._fail_mode_decision(request, exc if isinstance(exc, Exception) else Exception(str(exc)))

    async def observe_result(self, *, request_id: str, session_id: str, tool_name: str | None = None, result: str, agent: AgentIdentity | None = None) -> ResultResponse:
        try:
            body = {'requestId': request_id, 'sessionId': session_id, 'agent': _merge_agent(self.agent, agent), 'toolName': tool_name, 'result': result}
            return cast(ResultResponse, (await self._request('POST', '/v1/result', json=body)).json())
        except Exception as exc:
            return {'tainted': False, 'reason': str(exc)}

    async def check_response(self, *, session_id: str, text: str, request_id: str | None = None, tokens: dict[str, int] | None = None, meta: dict[str, Any] | None = None) -> Decision:
        action: ActionRequest = {'sessionId': session_id, 'checkpoint': 'response', 'text': text}
        if request_id:
            action['requestId'] = request_id
        if tokens:
            action['tokens'] = tokens
        if meta:
            action['meta'] = meta
        return await self.check(action)

    def guard(self, tool_name: str, *, session_id: str | None = None, category: ToolCategory | None = None, args: Any = None):
        client = self
        class AsyncGuard:
            async def __aenter__(self_nonlocal):
                decision = await client.check({'sessionId': session_id or _session_from_args(args), 'toolName': tool_name, 'category': category, 'args': args})
                if decision['verdict'] == 'deny':
                    raise GovernanceDenied(decision)
                self_nonlocal.decision = decision
                return decision
            async def __aexit__(self_nonlocal, *exc: object) -> None:
                return None
            def __call__(self_nonlocal, fn: Callable[P, Awaitable[R]]) -> Callable[P, Awaitable[R]]:
                @wraps(fn)
                async def wrapper(*fn_args: P.args, **fn_kwargs: P.kwargs) -> R:
                    payload = args if args is not None else {'args': fn_args, 'kwargs': fn_kwargs}
                    sid = session_id or _session_from_args(fn_kwargs) or _session_from_args(fn_args[-1] if fn_args else None)
                    decision = await client.check({'sessionId': sid, 'toolName': tool_name, 'category': category, 'args': payload})
                    if decision['verdict'] == 'deny':
                        raise GovernanceDenied(decision)
                    return await fn(*fn_args, **fn_kwargs)
                return wrapper
        return AsyncGuard()

    async def _resolve_escalation(self, decision: Decision, timeout_s: float) -> Decision:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            approval = cast(Approval, (await self._request('GET', f"/v1/approvals/{decision['approvalId']}")).json())
            if approval.get('state') != 'pending':
                return self._decision_from_approval(decision, approval)
            await asyncio.sleep(self.approval_poll_interval_ms / 1000)
        raise TimeoutError('approval polling timed out')

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = kwargs.pop('headers', {}) or {}
        token = self.token
        if not token and self.get_token:
            maybe = self.get_token()
            token = await maybe if hasattr(maybe, '__await__') else cast(str, maybe)
        if token:
            headers['Authorization'] = f'Bearer {token}'
        response = await self._client.request(method, path, headers=headers, **kwargs)
        response.raise_for_status()
        return response

def _session_from_args(obj: Any) -> str:
    if isinstance(obj, dict):
        value = obj.get('session_id') or obj.get('sessionId')
        if value:
            return str(value)
    raise ValueError('guarded tool calls require session_id/sessionId or an explicit session_id')
