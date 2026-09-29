import { GovernanceClient, GovernanceDeniedError } from './client.js';
import type { CheckInput } from './client.js';

export interface RunnableTool<TInput = unknown, TResult = unknown> {
  name?: string;
  invoke(input: TInput, config?: unknown): TResult | Promise<TResult>;
  [key: string]: unknown;
}

export interface LangChainGovernanceOptions {
  sessionId: string | ((input: unknown, config?: unknown) => string);
  toolName?: string;
  category?: CheckInput['category'];
}

function readSessionId(option: LangChainGovernanceOptions['sessionId'], input: unknown, config?: unknown): string {
  return typeof option === 'function' ? option(input, config) : option;
}

export function wrapStructuredTool<TInput, TResult>(
  client: GovernanceClient,
  tool: RunnableTool<TInput, TResult>,
  options: LangChainGovernanceOptions
): RunnableTool<TInput, TResult> {
  const originalInvoke = tool.invoke.bind(tool);
  const name = options.toolName ?? tool.name ?? 'langchain-tool';
  return {
    ...tool,
    async invoke(input: TInput, config?: unknown) {
      const decision = await client.check({ sessionId: readSessionId(options.sessionId, input, config), checkpoint: 'pre_tool', toolName: name, category: options.category, args: input });
      if (decision.verdict === 'deny') throw new GovernanceDeniedError(decision);
      const result = await originalInvoke(input, config);
      await client.observeResult({ requestId: decision.requestId, sessionId: decision.sessionId, toolName: name, result: typeof result === 'string' ? result : JSON.stringify(result) });
      return result;
    }
  };
}

export function createGovernanceCallbackHandler(client: GovernanceClient, options: LangChainGovernanceOptions) {
  const pending = new Map<string, { requestId: string; sessionId: string; toolName: string }>();
  return {
    name: 'agent-governance-callback-handler',
    async handleToolStart(tool: { name?: string }, input: unknown, runId?: string, _parentRunId?: string, _tags?: string[], metadata?: Record<string, unknown>) {
      const toolName = options.toolName ?? tool.name ?? 'langchain-tool';
      const sessionId = typeof options.sessionId === 'function' ? options.sessionId(input, { metadata }) : options.sessionId;
      const decision = await client.check({ sessionId, checkpoint: 'pre_tool', toolName, category: options.category, args: input });
      if (decision.verdict === 'deny') throw new GovernanceDeniedError(decision);
      if (runId) pending.set(runId, { requestId: decision.requestId, sessionId, toolName });
    },
    async handleToolEnd(output: unknown, runId?: string) {
      const item = runId ? pending.get(runId) : undefined;
      if (!item) return;
      pending.delete(runId!);
      await client.observeResult({ ...item, result: typeof output === 'string' ? output : JSON.stringify(output) });
    }
  };
}
