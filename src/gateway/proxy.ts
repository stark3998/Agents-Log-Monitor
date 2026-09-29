import crypto from 'crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ToolCategory } from '../analytics/classify';
import type { ActionRequest, AgentIdentity, Lane, LaneCondition } from '../governance/types';
import type { CallerContext } from './identity';
import type { GatewayConfig, UpstreamConfig } from './config';
import { PdpClient } from './pdp-client';

type RequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ContextResolver = (extra: RequestExtra) => CallerContext;

interface UpstreamRuntime {
  config: UpstreamConfig;
  client: Client;
  tools?: ToolEntry[];
  resources?: ResourceEntry[];
  prompts?: PromptEntry[];
}

interface ToolEntry {
  upstream: UpstreamRuntime;
  rawName: string;
  publicName: string;
  tool: Record<string, unknown>;
}

interface ResourceEntry {
  upstream: UpstreamRuntime;
  rawUri: string;
  publicUri: string;
  resource: Record<string, unknown>;
}

interface PromptEntry {
  upstream: UpstreamRuntime;
  rawName: string;
  publicName: string;
  prompt: Record<string, unknown>;
}

export class GatewayProxy {
  private readonly upstreams = new Map<string, UpstreamRuntime>();

  constructor(
    private readonly config: GatewayConfig,
    private readonly pdp: PdpClient,
    upstreamClients?: Map<string, Client>,
  ) {
    for (const upstream of config.upstreams) {
      const client = upstreamClients?.get(upstream.name) ?? new Client(
        { name: `governance-gateway-${upstream.name}`, version: '0.1.0' },
        { capabilities: {} },
      );
      this.upstreams.set(upstream.name, { config: upstream, client });
    }
  }

  async connect(): Promise<void> {
    for (const upstream of this.upstreams.values()) {
      if (upstream.client.getServerCapabilities()) continue;
      const transport = this.createTransport(upstream.config);
      await upstream.client.connect(transport);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.upstreams.values()].map(upstream => upstream.client.close()));
  }

  createServer(resolveContext: ContextResolver): Server {
    const server = new Server(
      { name: 'agent-governance-mcp-gateway', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const context = resolveContext(extra);
      const tools = await this.listTools(context);
      return { tools: tools.map(entry => ({ ...entry.tool, name: entry.publicName })) } as any;
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const context = resolveContext(extra);
      return await this.callTool(request.params.name, request.params.arguments, context);
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await this.listResources();
      return { resources: resources.map(entry => ({ ...entry.resource, uri: entry.publicUri })) } as any;
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      const context = resolveContext(extra);
      return await this.readResource(request.params.uri, context) as any;
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      const prompts = await this.listPrompts();
      return { prompts: prompts.map(entry => ({ ...entry.prompt, name: entry.publicName })) } as any;
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      const prompts = await this.listPrompts();
      const entry = prompts.find(item => item.publicName === request.params.name);
      if (!entry) throw new Error(`Unknown prompt ${request.params.name}`);
      return await entry.upstream.client.getPrompt({ ...request.params, name: entry.rawName } as any);
    });

    return server;
  }

  async listTools(context?: CallerContext): Promise<ToolEntry[]> {
    const entries = await this.refreshTools();
    if (!this.config.hideDeniedTools || !context) return entries;
    const lane = await this.pdp.getEffectiveLane(context.agent, context.authorization);
    if (!lane) return entries;
    return entries.filter(entry => !isOutrightDenied(lane, entry.rawName, entry.upstream.config.name));
  }

  async callTool(publicName: string, args: unknown, context: CallerContext): Promise<CallToolResult> {
    const entry = (await this.refreshTools()).find(item => item.publicName === publicName);
    if (!entry) throw new Error(`Unknown tool ${publicName}`);

    const category = this.categoryFor(entry.rawName, entry.upstream.config.name);
    const requestId = crypto.randomUUID();
    const action: ActionRequest = {
      requestId,
      sessionId: context.sessionId,
      checkpoint: 'pre_tool',
      agent: context.agent,
      toolName: entry.rawName,
      mcpServer: entry.upstream.config.name,
      category,
      args,
    };
    const decision = await this.pdp.decide(action, context.authorization);
    if (decision.verdict !== 'allow') {
      return blockedResult(`Blocked by agent governance policy: ${decision.reason} (decision ${decision.id})`);
    }

    const result = await entry.upstream.client.callTool({ name: entry.rawName, arguments: args as any }) as CallToolResult;
    void this.pdp.observeResult({
      requestId,
      sessionId: context.sessionId,
      agent: context.agent,
      toolName: entry.rawName,
      result: resultToText(result),
      authorization: context.authorization,
    }).then(scan => {
      if (scan?.tainted) console.warn(`PDP marked MCP result tainted for ${entry.upstream.config.name}/${entry.rawName}: ${scan.reason ?? 'tainted'}`);
    });
    return result;
  }

  private async readResource(publicUri: string, context: CallerContext): Promise<Record<string, unknown>> {
    const entry = (await this.listResources()).find(item => item.publicUri === publicUri);
    if (!entry) throw new Error(`Unknown resource ${publicUri}`);
    const requestId = crypto.randomUUID();
    const action: ActionRequest = {
      requestId,
      sessionId: context.sessionId,
      checkpoint: 'pre_tool',
      agent: context.agent,
      toolName: 'resources/read',
      mcpServer: entry.upstream.config.name,
      category: 'READ',
      args: { uri: entry.rawUri },
    };
    const decision = await this.pdp.decide(action, context.authorization);
    if (decision.verdict !== 'allow') {
      return { contents: [{ uri: publicUri, mimeType: 'text/plain', text: `Blocked by agent governance policy: ${decision.reason} (decision ${decision.id})` }] };
    }
    return await entry.upstream.client.readResource({ uri: entry.rawUri }) as Record<string, unknown>;
  }

  private async refreshTools(): Promise<ToolEntry[]> {
    const listed = await Promise.all([...this.upstreams.values()].map(async upstream => {
      if (!upstream.tools) {
        const result = await upstream.client.listTools();
        upstream.tools = result.tools.map(tool => ({
          upstream,
          rawName: tool.name,
          publicName: tool.name,
          tool: tool as unknown as Record<string, unknown>,
        }));
      }
      return upstream.tools;
    }));
    const entries = listed.flat();
    const counts = countBy(entries.map(entry => entry.rawName));
    for (const entry of entries) {
      entry.publicName = publicName(entry.upstream.config, entry.rawName, counts.get(entry.rawName)! > 1);
    }
    return entries;
  }

  private async listResources(): Promise<ResourceEntry[]> {
    const listed = await Promise.all([...this.upstreams.values()].map(async upstream => {
      if (!upstream.resources) {
        try {
          const result = await upstream.client.listResources();
          upstream.resources = result.resources.map(resource => ({
            upstream,
            rawUri: resource.uri,
            publicUri: resource.uri,
            resource: resource as unknown as Record<string, unknown>,
          }));
        } catch {
          upstream.resources = [];
        }
      }
      return upstream.resources;
    }));
    const entries = listed.flat();
    const counts = countBy(entries.map(entry => entry.rawUri));
    for (const entry of entries) {
      entry.publicUri = counts.get(entry.rawUri)! > 1
        ? encodeGatewayUri(entry.upstream.config.name, entry.rawUri)
        : entry.rawUri;
    }
    return entries;
  }

  private async listPrompts(): Promise<PromptEntry[]> {
    const listed = await Promise.all([...this.upstreams.values()].map(async upstream => {
      if (!upstream.prompts) {
        try {
          const result = await upstream.client.listPrompts();
          upstream.prompts = result.prompts.map(prompt => ({
            upstream,
            rawName: prompt.name,
            publicName: prompt.name,
            prompt: prompt as unknown as Record<string, unknown>,
          }));
        } catch {
          upstream.prompts = [];
        }
      }
      return upstream.prompts;
    }));
    const entries = listed.flat();
    const counts = countBy(entries.map(entry => entry.rawName));
    for (const entry of entries) {
      entry.publicName = publicName(entry.upstream.config, entry.rawName, counts.get(entry.rawName)! > 1);
    }
    return entries;
  }

  private createTransport(upstream: UpstreamConfig) {
    if (upstream.transport === 'stdio') {
      return new StdioClientTransport({
        command: upstream.command!,
        args: upstream.args,
        env: upstream.env ? { ...process.env, ...upstream.env } as Record<string, string> : undefined,
      });
    }
    if (upstream.transport === 'sse') {
      return new SSEClientTransport(new URL(upstream.url!), {
        requestInit: { headers: upstream.headers },
        eventSourceInit: upstream.headers ? { fetch: (url: string | URL, init?: RequestInit) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...upstream.headers } }) } as any : undefined,
      });
    }
    return new StreamableHTTPClientTransport(new URL(upstream.url!), {
      requestInit: { headers: upstream.headers },
    });
  }

  private categoryFor(toolName: string, upstreamName: string): ToolCategory {
    return this.pdp.deriveCategory(toolName, upstreamName);
  }
}

function publicName(upstream: UpstreamConfig, rawName: string, collision: boolean): string {
  if (collision || upstream.toolPrefix) return `${upstream.toolPrefix ?? upstream.name}__${rawName}`;
  return rawName;
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function encodeGatewayUri(upstream: string, uri: string): string {
  return `mcp-gateway://${encodeURIComponent(upstream)}/${Buffer.from(uri, 'utf8').toString('base64url')}`;
}

function blockedResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

function resultToText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const maybeContent = (result as { content?: unknown }).content;
  if (!Array.isArray(maybeContent)) return JSON.stringify(result);
  return maybeContent.map(item => {
    if (!item || typeof item !== 'object') return String(item);
    const typed = item as Record<string, unknown>;
    if (typed.type === 'text') return String(typed.text ?? '');
    if (typed.type === 'resource' && typed.resource && typeof typed.resource === 'object') {
      return String((typed.resource as Record<string, unknown>).text ?? '');
    }
    return JSON.stringify(typed);
  }).join('\n');
}

function isOutrightDenied(lane: Lane, tool: string, mcpServer: string): boolean {
  return (lane.rules?.deny ?? []).some(condition => onlyToolServerCondition(condition) && conditionMatches(condition, tool, mcpServer));
}

function onlyToolServerCondition(condition: LaneCondition): boolean {
  const allowed = new Set(['id', 'description', 'tool', 'mcpServer']);
  return Object.keys(condition).every(key => allowed.has(key)) && (!!condition.tool || !!condition.mcpServer);
}

function conditionMatches(condition: LaneCondition, tool: string, mcpServer: string): boolean {
  const toolMatches = !condition.tool || condition.tool.some(pattern => globMatch(pattern, tool));
  const serverMatches = !condition.mcpServer || condition.mcpServer.some(pattern => globMatch(pattern, mcpServer));
  return toolMatches && serverMatches;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}
