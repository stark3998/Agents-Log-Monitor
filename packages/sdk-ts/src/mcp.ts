import { GovernanceClient, GovernanceDeniedError } from './client.js';
import type { CheckInput } from './client.js';

export interface McpClientLike<TResult = unknown> {
  callTool(name: string, args?: unknown, options?: unknown): TResult | Promise<TResult>;
  [key: string]: unknown;
}

export interface McpGovernanceOptions {
  sessionId: string | ((name: string, args?: unknown, options?: unknown) => string);
  mcpServer?: string;
  category?: CheckInput['category'];
}

function sessionIdOf(option: McpGovernanceOptions['sessionId'], name: string, args?: unknown, callOptions?: unknown): string {
  return typeof option === 'function' ? option(name, args, callOptions) : option;
}

export function wrapMcpClient<T extends McpClientLike>(client: GovernanceClient, mcpClient: T, options: McpGovernanceOptions): T {
  const original = mcpClient.callTool.bind(mcpClient);
  return new Proxy(mcpClient, {
    get(target, prop, receiver) {
      if (prop !== 'callTool') return Reflect.get(target, prop, receiver);
      return async (name: string, args?: unknown, callOptions?: unknown) => {
        const decision = await client.check({ sessionId: sessionIdOf(options.sessionId, name, args, callOptions), checkpoint: 'pre_tool', toolName: name, category: options.category ?? 'MCP', mcpServer: options.mcpServer, args });
        if (decision.verdict === 'deny') throw new GovernanceDeniedError(decision);
        const result = await original(name, args, callOptions);
        await client.observeResult({ requestId: decision.requestId, sessionId: decision.sessionId, toolName: name, result: typeof result === 'string' ? result : JSON.stringify(result) });
        return result;
      };
    }
  }) as T;
}
