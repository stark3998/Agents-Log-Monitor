import http from 'http';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import express from 'express';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { GatewayConfig } from './config';
import { gatewayPrincipalFromBearer } from './auth';
import { callerContextFromRequest, stdioCallerContext, type GatewayRequestAuth } from './identity';
import { GatewayProxy } from './proxy';

export async function runStdioGateway(proxy: GatewayProxy): Promise<void> {
  await proxy.connect();
  const server = proxy.createServer(() => stdioCallerContext());
  await server.connect(new StdioServerTransport());
}

function bearer(req: express.Request): string | undefined {
  const value = req.header('authorization') ?? '';
  return /^Bearer\s+(.+)$/i.exec(value)?.[1];
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1' || normalized === '[::1]';
}

function unauthorized(res: express.Response, message = 'unauthenticated'): void {
  res.setHeader('WWW-Authenticate', 'Bearer');
  res.status(401).json({ error: message });
}

async function authenticateGatewayRequest(req: express.Request, res: express.Response, config: GatewayConfig): Promise<GatewayRequestAuth | null> {
  const token = bearer(req);
  if (!token) {
    if (config.auth.allowAnonymous) return { anonymous: true };
    unauthorized(res);
    return null;
  }
  try {
    const principal = await gatewayPrincipalFromBearer(token, config);
    return { principal, authorization: req.header('authorization') };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid token';
    if (/requires role: Agent/i.test(message)) res.status(403).json({ error: message });
    else unauthorized(res, message);
    return null;
  }
}

export async function runHttpGateway(proxy: GatewayProxy, config: GatewayConfig): Promise<http.Server> {
  if (config.auth.allowAnonymous && !isLoopbackHost(config.host)) {
    throw new Error('AGENT_GATEWAY_ALLOW_ANONYMOUS is only allowed when the gateway binds to loopback');
  }
  await proxy.connect();
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  const transports = new Map<string, { transport: StreamableHTTPServerTransport; server: ReturnType<GatewayProxy['createServer']> }>();
  const authContext = new AsyncLocalStorage<GatewayRequestAuth>();

  app.all('/mcp', async (req, res) => {
    try {
      const auth = await authenticateGatewayRequest(req, res, config);
      if (!auth) return;
      const sessionId = Array.isArray(req.headers['mcp-session-id']) ? req.headers['mcp-session-id'][0] : req.headers['mcp-session-id'];
      let entry = sessionId ? transports.get(sessionId) : undefined;
      if (!entry) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing or invalid MCP session' }, id: null });
          return;
        }
        const server = proxy.createServer(extra => callerContextFromRequest(extra, config.identityHeaders, authContext.getStore()));
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: initializedSessionId => {
            transports.set(initializedSessionId, { transport, server });
          },
        });
        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (activeSessionId) transports.delete(activeSessionId);
          void server.close();
        };
        await server.connect(transport);
        entry = { transport, server };
      }
      if (req.method === 'DELETE') {
        transports.delete(entry.transport.sessionId ?? '');
        await entry.transport.close();
        res.status(200).json({ ok: true });
        return;
      }
      const { transport } = entry;
      await authContext.run(auth, async () => {
        await transport.handleRequest(req, res, req.body);
      });
    } catch (error) {
      console.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  return await new Promise((resolve, reject) => {
    const httpServer = app.listen(config.port, config.host, () => resolve(httpServer));
    httpServer.once('error', reject);
  });
}
