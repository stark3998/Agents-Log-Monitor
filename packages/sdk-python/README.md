# agent-governance

Python SDK for custom agents that must ask the Agent Governance PDP before using tools. It mirrors the TypeScript SDK and the `src/governance/types.ts` wire names.

## Install

```bash
pip install agent-governance
```

Runtime dependency: `httpx` only.

## Sync client

```python
from agent_governance import GovernanceClient, GovernanceDenied

client = GovernanceClient(
    base_url="https://governance.example.com",
    token="...",
    agent={"surface": "sdk", "externalId": "refund-agent", "name": "Refund agent"},
    fail_mode={"default": "closed", "READ": "open"},
)

client.goal("session-1", "Help the user inspect an order")
decision = client.check({"sessionId": "session-1", "toolName": "issue_refund", "category": "WRITE", "args": {"orderId": "42"}})
if decision["verdict"] == "deny":
    raise GovernanceDenied(decision)
```

`guard()` is both a decorator and a context manager:

```python
@client.guard("issue_refund", session_id="session-1")
def issue_refund(order_id: str): ...

with client.guard("send_email", session_id="session-1", args={"to": "a@contoso.com"}):
    send_email()
```

## Async client

```python
from agent_governance import AsyncGovernanceClient

async with AsyncGovernanceClient(base_url=url, agent={"surface": "sdk"}) as client:
    decision = await client.check({"sessionId": "s1", "toolName": "search", "category": "READ"})
```

## Entra tokens

Install the optional Azure extra and pass a callback:

```python
from azure.identity import DefaultAzureCredential
credential = DefaultAzureCredential()
client = GovernanceClient(
    base_url=url,
    agent={"surface": "sdk", "externalId": "agent-1"},
    get_token=lambda: credential.get_token("api://<audience>/.default").token,
)
```

## Integrations

### Microsoft Agent Framework Python

Assumption: function middleware subclasses `FunctionMiddleware` and implements `process(context: FunctionInvocationContext, next)`, where the context exposes `function`, `arguments`, `result`, and `terminate`. See <https://learn.microsoft.com/en-us/agent-framework/concepts/agents/middleware/defining-middleware> and <https://learn.microsoft.com/en-us/python/api/agent-framework-core/agent_framework.functioninvocationcontext>.

```python
from agent_governance.integrations.agent_framework import create_function_middleware
middleware = create_function_middleware(async_client, session_id="session-1")
```

### Semantic Kernel Python

Assumption: filters are registered with `kernel.add_filter(FilterTypes.AUTO_FUNCTION_INVOCATION, filter)`, and auto function filters receive `(context, next)` with function metadata and result. See <https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters>.

```python
from agent_governance.integrations.semantic_kernel import add_governance_filter
add_governance_filter(kernel, async_client, session_id="session-1")
```

### LangChain

```python
from agent_governance.integrations.langchain import GovernanceCallbackHandler, wrap_tool
callbacks = [GovernanceCallbackHandler(client, session_id="session-1")]
guarded_tool = wrap_tool(tool, client, session_id="session-1")
```

### OpenAI Agents SDK Python

Assumption: `agents.function_tool` creates function tools and `agents.tool_input_guardrail` can return `ToolGuardrailFunctionOutput.allow()` or `.reject_content(reason=...)`. See <https://github.com/openai/openai-agents-python/blob/main/docs/tools.md> and <https://github.com/openai/openai-agents-python/blob/main/docs/guardrails.md>.

```python
from agent_governance.integrations.openai_agents import governance_tool_input_guardrail, wrap_function_tool
guardrail = governance_tool_input_guardrail(async_client, session_id="session-1")
tool = wrap_function_tool(my_function, async_client, session_id="session-1")
```
