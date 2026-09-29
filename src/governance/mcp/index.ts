import express, { type Express, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LOCAL_PRINCIPAL, principalFromBearer } from '../auth';
import { govConfig } from '../config';
import { telemetry } from '../telemetry';
import { initSqliteTelemetry } from '../telemetry-sqlite';
import type { Principal } from '../types';
import { createMcpServer } from './server';

function ensureTelemetry(): void {
  try { telemetry(); } catch { initSqliteTelemetry(); }
}

function baseUrl(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `127.0.0.1:${req.socket.localPort ?? ''}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

function metadataUrl(req: Request): string {
  return `${baseUrl(req)}/.well-known/oauth-protected-resource`;
}

function bearer(req: Request): string | undefined {
  const auth = req.header('authorization');
  const m = auth?.match(/^Bearer\s+(.+)$/i);
  return m?.[1];
}

function isLoopback(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
}

function localhostOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

function unauthorized(req: Request, res: Response): void {
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl(req)}"`);
  res.status(401).json({ error: 'unauthenticated' });
}

async function authenticateMcp(req: Request, res: Response): Promise<Principal | null> {
  if (govConfig.mode === 'local') {
    if (!localhostOrigin(req.header('origin'))) {
      res.status(403).json({ error: 'origin not allowed' });
      return null;
    }
    const token = bearer(req);
    if (token) {
      const p = await principalFromBearer(token);
      if (p) return p;
      unauthorized(req, res);
      return null;
    }
    if (govConfig.auth.trustLoopback && isLoopback(req)) return LOCAL_PRINCIPAL;
    unauthorized(req, res);
    return null;
  }

  const token = bearer(req);
  if (!token) {
    unauthorized(req, res);
    return null;
  }
  const p = await principalFromBearer(token);
  if (!p) {
    unauthorized(req, res);
    return null;
  }
  return p;
}

function oauthMetadata(req: Request) {
  const audience = govConfig.auth.audience;
  if (!audience) return null;
  const tenant = govConfig.auth.tenantId || 'organizations';
  const scope = audience.startsWith('api://') ? `${audience}/.default` : `api://${audience}/.default`;
  return {
    resource: `${baseUrl(req)}/mcp`,
    authorization_servers: [`https://login.microsoftonline.com/${tenant}/v2.0`],
    scopes_supported: [scope],
    bearer_methods_supported: ['header'],
  };
}

export function mountMcp(app: Express): void {
  ensureTelemetry();

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    const meta = oauthMetadata(req);
    if (!meta) { res.status(404).json({ error: 'oauth metadata not configured' }); return; }
    res.json(meta);
  });

  app.use('/mcp', express.json({ limit: '4mb' }));

  const handler = async (req: Request, res: Response) => {
    const principal = await authenticateMcp(req, res);
    if (!principal) return;
    const mcp = createMcpServer(principal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await mcp.connect(transport);
      res.on('close', () => {
        void transport.close().catch(() => undefined);
        void mcp.close().catch(() => undefined);
      });
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
      await transport.close().catch(() => undefined);
      await mcp.close().catch(() => undefined);
    }
  };

  app.post('/mcp', handler);
  app.get('/mcp', handler);
  app.delete('/mcp', handler);
}
