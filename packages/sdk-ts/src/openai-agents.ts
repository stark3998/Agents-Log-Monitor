import { GovernanceClient, GovernanceDeniedError } from './client.js';
import type { CheckInput } from './client.js';
import type { Decision } from './types.js';

export interface OpenAIAgentsFunctionTool<TArgs = unknown, TResult = unknown> {
  name: string;
  description?: string;
  execute?: (args: TArgs, context?: unknown) => TResult | Promise<TResult>;
  inputGuardrail?: (input: unknown) => unknown | Promise<unknown>;
  [key: string]: unknown;
}

export interface OpenAIGovernanceOptions {
  sessionId: string | ((context: unknown, args: unknown) => string);
  requestId?: string | ((context: unknown, args: unknown) => string | undefined);
  category?: CheckInput['category'];
  mcpServer?: string;
  denyMessage?: (decision: Decision) => string;
}

function value<T>(v: T | ((context: unknown, args: unknown) => T), context: unknown, args: unknown): T {
  return typeof v === 'function' ? (v as (context: unknown, args: unknown) => T)(context, args) : v;
}

function denyText(decision: Decision): string {
  return `Governance denied tool call ${decision.toolName ?? ''}: ${decision.reason}`.trim();
}

export function governanceInputGuardrail(client: GovernanceClient, toolName: string, options: OpenAIGovernanceOptions) {
  return async (input: unknown) => {
    const context = (input as { context?: unknown })?.context ?? input;
    const args = (input as { input?: unknown; args?: unknown })?.input ?? (input as { args?: unknown })?.args ?? input;
    const decision = await client.check({
      sessionId: value(options.sessionId, context, args),
      requestId: options.requestId ? value(options.requestId, context, args) : undefined,
      checkpoint: 'pre_tool',
      toolName,
      category: options.category,
      mcpServer: options.mcpServer,
      args
    });
    if (decision.verdict === 'deny') throw new GovernanceDeniedError(decision);
  };
}

export function wrapOpenAITool<TArgs, TResult>(
  client: GovernanceClient,
  toolDef: OpenAIAgentsFunctionTool<TArgs, TResult>,
  options: OpenAIGovernanceOptions
): OpenAIAgentsFunctionTool<TArgs, TResult | string> {
  const execute = toolDef.execute;
  if (!execute) return { ...toolDef, inputGuardrail: governanceInputGuardrail(client, toolDef.name, options) };
  return {
    ...toolDef,
    inputGuardrail: governanceInputGuardrail(client, toolDef.name, options),
    async execute(args: TArgs, context?: unknown) {
      const decision = await client.check({
        sessionId: value(options.sessionId, context, args),
        requestId: options.requestId ? value(options.requestId, context, args) : undefined,
        checkpoint: 'pre_tool',
        toolName: toolDef.name,
        category: options.category,
        mcpServer: options.mcpServer,
        args
      });
      if (decision.verdict === 'deny') return options.denyMessage?.(decision) ?? denyText(decision);
      return await execute(args, context);
    }
  };
}
