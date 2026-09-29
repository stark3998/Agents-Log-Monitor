import { afterEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Principal } from '../../src/governance/types';

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
}

async function appWith(url: string, principal: Principal): Promise<{ appUrl: string; close: () => Promise<void> }> {
  vi.resetModules();
  process.env.INTELLIGENCE_URL = url;
  const router = (await import('../../src/governance/routes/intelligence')).default;
  const app: Express = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.principal = principal; next(); });
  app.use('/api/gov/intelligence', router);
  const server = http.createServer(app);
  return { appUrl: await listen(server), close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

const viewer: Principal = { id: 'viewer', roles: ['Viewer'], kind: 'user' };
const admin: Principal = { id: 'admin', roles: ['PolicyAdmin'], kind: 'user' };

afterEach(() => {
  delete process.env.INTELLIGENCE_URL;
  vi.resetModules();
});

describe('intelligence proxy', () => {
  it('returns 503 when service is not configured', async () => {
    const { appUrl, close } = await appWith('', viewer);
    try {
      const res = await fetch(`${appUrl}/api/gov/intelligence/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'intelligence service not configured' });
    } finally {
      await close();
    }
  });

  it('streams chat SSE through and forwards authorization', async () => {
    let auth = '';
    const upstream = http.createServer((req, res) => {
      auth = req.headers.authorization ?? '';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: {"type":"delta","text":"hello"}\n\n');
      res.end('data: {"type":"done"}\n\n');
    });
    const upstreamUrl = await listen(upstream);
    const { appUrl, close } = await appWith(upstreamUrl, viewer);
    try {
      const res = await fetch(`${appUrl}/api/gov/intelligence/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer caller-token' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(await res.text()).toBe('data: {"type":"delta","text":"hello"}\n\ndata: {"type":"done"}\n\n');
      expect(auth).toBe('Bearer caller-token');
    } finally {
      await close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it('requires PolicyAdmin for draft and proxies JSON', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lane: { status: 'proposed' } }));
    });
    const upstreamUrl = await listen(upstream);
    const denied = await appWith(upstreamUrl, viewer);
    try {
      const res = await fetch(`${denied.appUrl}/api/gov/intelligence/lanes/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(403);
    } finally {
      await denied.close();
    }
    const allowed = await appWith(upstreamUrl, admin);
    try {
      const res = await fetch(`${allowed.appUrl}/api/gov/intelligence/lanes/draft`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"agentId":"a"}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ lane: { status: 'proposed' } });
    } finally {
      await allowed.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
