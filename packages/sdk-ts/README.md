# @agent-governance/sdk

Thin TypeScript client for the Agent Governance PDP. It calls `POST /v1/decide` before tool execution, polls `/v1/approvals/:id` for `escalate`, reports goals/results, and can fail open or closed locally when the PDP is unreachable.

## Install

```bash
npm install @agent-governance/sdk
```

No runtime dependencies are required beyond Node/browser `fetch`.

## Core client

```ts
import { GovernanceClient } from '@agent-governance/sdk';

const governance = new GovernanceClient({
  baseUrl: 'https://governance.example.com',
  token: process.env.GOVERNANCE_TOKEN,
  agent: { surface: 'sdk', externalId: 'refund-agent', name: 'Refund agent' },
  failMode: { default: 'closed', READ: 'open' },
  timeoutMs: 30_000,
});

await governance.goal('session-1', 'Help the user inspect an order.');
const decision = await governance.check({
  sessionId: 'session-1',
  toolName: 'issue_refund',
  category: 'WRITE',
  args: { orderId: '42' },
});
if (decision.verdict === 'deny') throw new Error(decision.reason);
```

`guard(toolName, fn)` wraps an existing function and throws `GovernanceDeniedError` on deny:

```ts
const guardedRefund = governance.guard('issue_refund', issueRefund);
await guardedRefund({ orderId: '42' }, { sessionId: 'session-1' });
```

## Entra tokens

Pass `getToken` to integrate with `@azure/identity` without making it a dependency:

```ts
import { DefaultAzureCredential } from '@azure/identity';
const credential = new DefaultAzureCredential();
const governance = new GovernanceClient({
  baseUrl: process.env.GOVERNANCE_URL!,
  agent: { surface: 'sdk', externalId: 'agent-1' },
  getToken: async () => (await credential.getToken('api://<audience>/.default'))!.token,
});
```

## Adapters

### OpenAI Agents SDK JS

Assumption: `@openai/agents` function tools are created with `tool({ name, parameters, execute })`, and tool guardrails can be attached as an `inputGuardrail` on the tool definition. See <https://openai.github.io/openai-agents-js/guides/tools/> and <https://openai.github.io/openai-agents-js/guides/guardrails/>.

```ts
import { wrapOpenAITool } from '@agent-governance/sdk/openai-agents';
const toolDef = wrapOpenAITool(governance, rawToolDef, { sessionId: 'session-1' });
```

On deny the wrapped `execute` returns an error string to the model.

### LangChain.js / LangGraph.js

```ts
import { wrapStructuredTool, createGovernanceCallbackHandler } from '@agent-governance/sdk/langchain';
const guardedTool = wrapStructuredTool(governance, tool, { sessionId: 'session-1' });
const callbacks = [createGovernanceCallbackHandler(governance, { sessionId: 'session-1' })];
```

The wrapper intercepts `invoke`; the callback reports tool start/end.

### MCP clients

```ts
import { wrapMcpClient } from '@agent-governance/sdk/mcp';
const guardedMcp = wrapMcpClient(governance, mcpClient, { sessionId: 'session-1', mcpServer: 'github' });
await guardedMcp.callTool('create_issue', { title: '...' });
```
