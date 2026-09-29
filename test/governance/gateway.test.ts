import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Server as HttpServer } from 'http';
import type { GatewayConfig } from '../../src/gateway/config';
import { PdpClient } from '../../src/gateway/pdp-client';
import { GatewayProxy } from '../../src/gateway/proxy';
import { callerContextFromRequest } from '../../src/gateway/identity';
import { runHttpGateway } from '../../src/gateway/server';
import { __setGatewayJwksForTests } from '../../src/gateway/auth';
import type { AgentIdentity, Decision, Lane } from '../../src/governance/types';

interface FakeTool {
  name: string;
  text: string;
}

const servers: HttpServer[] = [];
const mcpServers: Server[] = [];
const clients: Client[] = [];

afterEach(async () => {
  __setGatewayJwksForTests(null);
  await Promise.allSettled(clients.splice(0).map(client => client.close()));
  await Promise.allSettled(mcpServers.splice(0).map(server => server.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('governance MCP gateway', () => {
  it('aggregates namespaced tools, denies governed calls, forwards allowed calls, and scans results', async () => {
    const pdp = await startFakePdp();
    const upstreamClients = new Map<string, Client>();
    upstreamClients.set('fs', await createFakeUpstream('fs', [
      { name: 'read_file', text: 'hello from fs' },
      { name: 'delete_repo', text: 'deleted' },
    ]));
    upstreamClients.set('git', await createFakeUpstream('git', [
      { name: 'read_file', text: 'hello from git with tainted payload' },
    ]));
    const proxy = new GatewayProxy(testConfig(pdp.url, 'closed'), new PdpClient(testConfig(pdp.url, 'closed')), upstreamClients);
    const context = caller('Bearer caller-token');

    const listed = await proxy.listTools(context);
    expect(listed.map(tool => tool.publicName).sort()).toEqual(['delete_repo', 'fs__read_file', 'git__read_file']);

    const denied = await proxy.callTool('delete_repo', { repo: 'prod' }, context);
    expect(denied.isError).toBe(true);
    expect(denied.content[0]).toMatchObject({ type: 'text' });
    expect((denied.content[0] as { text: string }).text).toContain('Blocked by agent governance policy: no deletes');

    const allowed = await proxy.callTool('fs__read_file', { path: 'README.md' }, context);
    expect(allowed.isError).toBeFalsy();
    expect((allowed.content[0] as { text: string }).text).toBe('hello from fs');

    const tainted = await proxy.callTool('git__read_file', { path: 'PROMPT.md' }, context);
    expect((tainted.content[0] as { text: string }).text).toContain('tainted payload');
    await waitFor(() => pdp.results.some(item => item.body.result.includes('tainted payload')));

    expect(pdp.decisions.map(item => item.body.toolName)).toEqual(['delete_repo', 'read_file', 'read_file']);
    expect(pdp.decisions[0].authorization).toBe('Bearer caller-token');
    expect(pdp.results.some(item => item.body.result.includes('tainted payload'))).toBe(true);
  });

  it('applies fail-closed and fail-open behavior when the PDP is unreachable', async () => {
    const upstreamClients = new Map<string, Client>();
    upstreamClients.set('fs', await createFakeUpstream('fs', [{ name: 'read_file', text: 'ok' }]));
    const closedConfig = testConfig('http://127.0.0.1:9', 'closed', ['fs']);
    const closedProxy = new GatewayProxy(closedConfig, new PdpClient(closedConfig), upstreamClients);
    const closed = await closedProxy.callTool('read_file', {}, caller());
    expect(closed.isError).toBe(true);
    expect((closed.content[0] as { text: string }).text).toContain('fail-closed');

    const openConfig = testConfig('http://127.0.0.1:9', 'open', ['fs']);
    const openProxy = new GatewayProxy(openConfig, new PdpClient(openConfig), upstreamClients);
    const open = await openProxy.callTool('read_file', {}, caller());
    expect(open.isError).toBeFalsy();
    expect((open.content[0] as { text: string }).text).toBe('ok');
  });

  it('derives HTTP caller identity headers and forwards them to the PDP', async () => {
    const pdp = await startFakePdp();
    const upstreamClients = new Map<string, Client>();
    upstreamClients.set('fs', await createFakeUpstream('fs', [{ name: 'read_file', text: 'ok' }]));
    const config = testConfig(pdp.url, 'closed', ['fs']);
    const proxy = new GatewayProxy(config, new PdpClient(config), upstreamClients);
    const context = callerContextFromRequest({
      sessionId: 'transport-session',
      requestInfo: {
        headers: {
          'x-agent-id': 'foundry-agent-1',
          'x-agent-name': 'Foundry Agent',
          'x-agent-surface': 'foundry',
          'x-session-id': 'thread-123',
          'x-user': 'user@contoso.com',
        },
      },
    } as any, config.identityHeaders, {
      authorization: 'Bearer caller-token',
      principal: {
        id: 'oid-1',
        externalId: 'app-1',
        subject: 'sub-1',
        name: 'Token App',
        roles: ['Agent'],
        tenantId: 'tenant-1',
      },
    });

    const result = await proxy.callTool('read_file', {}, context);
    expect((result.content[0] as { text: string }).text).toBe('ok');
    expect(pdp.decisions[0].authorization).toBe('Bearer caller-token');
    expect(pdp.decisions[0].body.sessionId).toBe('sub-1:thread-123');
    expect(pdp.decisions[0].body.agent).toMatchObject({
      surface: 'foundry',
      externalId: 'app-1/foundry-agent-1',
      name: 'Token App',
    });
  });

  it('rejects missing and invalid HTTP gateway tokens', async () => {
    const { server, url } = await startGatewayForAuthTests();
    servers.push(server);

    const missing = await fetch(`${url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(missing.status).toBe(401);

    const invalid = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-jwt' },
      body: '{}',
    });
    expect(invalid.status).toBe(401);
  });

  it('accepts a valid gateway token and derives identity from token claims plus header suffixes', async () => {
    const { server, url, pdp } = await startGatewayForAuthTests();
    servers.push(server);
    const token = await mintGatewayToken();
    const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${token}`,
          'x-agent-id': 'foundry-agent-1',
          'x-agent-name': 'Caller Controlled Name',
          'x-agent-surface': 'foundry',
          'x-session-id': 'thread-123',
          'x-user': 'spoofed@contoso.com',
        },
      },
    });
    const client = new Client({ name: 'gateway-auth-test', version: '0.1.0' }, { capabilities: {} });
    clients.push(client);
    await client.connect(transport);
    await client.callTool({ name: 'read_file', arguments: {} });

    expect(pdp.decisions[0].body.sessionId).toBe('subject-1:thread-123');
    expect(pdp.decisions[0].body.agent).toMatchObject({
      surface: 'foundry',
      externalId: 'gateway-app/foundry-agent-1',
      agentId: 'gateway-app/foundry-agent-1',
      name: 'Gateway Test App',
    });
    expect(pdp.decisions[0].body.agent.user).toBeUndefined();
  });

  it('refuses anonymous HTTP gateway mode on non-loopback binds', async () => {
    const pdp = await startFakePdp();
    const config = testConfig(pdp.url, 'closed', ['fs']);
    config.host = '0.0.0.0';
    config.auth.allowAnonymous = true;
    const proxy = new GatewayProxy(config, new PdpClient(config), new Map());
    await expect(runHttpGateway(proxy, config)).rejects.toThrow(/ALLOW_ANONYMOUS/i);
  });

  it('bounds and expires the PDP lane cache', async () => {
    const pdp = await startFakePdp();
    const config = testConfig(pdp.url, 'closed');
    const client = new PdpClient(config);
    const agent = caller().agent;

    expect(await client.getEffectiveLane(agent)).toMatchObject({ id: 'lane' });
    expect(await client.getEffectiveLane(agent)).toMatchObject({ id: 'lane' });
    expect(pdp.laneRequests.length).toBe(1);

    const key = (client as any).laneCacheKey(agent);
    (client as any).laneCache.get(key).expires = Date.now() - 1;
    expect(await client.getEffectiveLane(agent)).toMatchObject({ id: 'lane' });
    expect(pdp.laneRequests.length).toBe(2);

    for (let i = 0; i < 1005; i++) (client as any).setCachedLane(`caller-controlled-${i}`, fakeLane());
    expect((client as any).laneCache.size).toBeLessThanOrEqual(1000);
  });
});

async function createFakeUpstream(name: string, tools: FakeTool[]): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: `${name}-server`, version: '1.0.0' }, { capabilities: { tools: {} } });
  mcpServers.push(server);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: `${tool.name} test tool`,
      inputSchema: { type: 'object', properties: {} },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = tools.find(item => item.name === request.params.name);
    if (!tool) throw new Error(`unknown test tool ${request.params.name}`);
    return { content: [{ type: 'text', text: tool.text }] };
  });
  await server.connect(serverTransport);
  const client = new Client({ name: `${name}-client`, version: '1.0.0' }, { capabilities: {} });
  clients.push(client);
  await client.connect(clientTransport);
  return client;
}

function caller(authorization?: string) {
  const agent: AgentIdentity = {
    surface: 'mcp-gateway',
    externalId: 'agent-1',
    agentId: 'agent-1',
    name: 'Test Agent',
    user: 'user@contoso.com',
  };
  return { sessionId: 'session-1', authorization, agent };
}

function testConfig(pdpUrl: string, failModeDefault: 'open' | 'closed', upstreamNames = ['fs', 'git']): GatewayConfig {
  return {
    upstreams: upstreamNames.map(name => ({ name, transport: 'stdio', command: 'node' })),
    pdpUrl,
    pdpTokenEnv: 'AGENT_GATEWAY_PDP_TOKEN',
    auth: {
      audience: 'api://gateway-test',
      tenantId: 'tenant-1',
      allowAnonymous: false,
    },
    port: 0,
    host: '127.0.0.1',
    failModeDefault,
    identityHeaders: {
      agentId: 'x-agent-id',
      agentName: 'x-agent-name',
      surface: 'x-agent-surface',
      sessionId: 'x-session-id',
      user: 'x-user',
    },
    decideTimeoutMs: 2_000,
    resultTimeoutMs: 2_000,
    hideDeniedTools: false,
  };
}

async function startGatewayForAuthTests(): Promise<{ server: HttpServer; url: string; pdp: Awaited<ReturnType<typeof startFakePdp>> }> {
  const pdp = await startFakePdp();
  const upstreamClients = new Map<string, Client>();
  upstreamClients.set('fs', await createFakeUpstream('fs', [{ name: 'read_file', text: 'ok' }]));
  const config = testConfig(pdp.url, 'closed', ['fs']);
  const proxy = new GatewayProxy(config, new PdpClient(config), upstreamClients);
  const server = await runHttpGateway(proxy, config);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { server, url: `http://127.0.0.1:${address.port}`, pdp };
}

async function mintGatewayToken(overrides: Record<string, unknown> = {}): Promise<string> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'gateway-test-key';
  jwk.alg = 'RS256';
  __setGatewayJwksForTests(createLocalJWKSet({ keys: [jwk] }));
  return await new SignJWT({
    roles: ['Agent'],
    appid: 'gateway-app',
    oid: 'oid-1',
    app_displayname: 'Gateway Test App',
    tid: 'tenant-1',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'gateway-test-key' })
    .setIssuer('https://login.microsoftonline.com/tenant-1/v2.0')
    .setAudience('api://gateway-test')
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

async function startFakePdp(): Promise<{
  url: string;
  decisions: Array<{ body: any; authorization?: string }>;
  results: Array<{ body: any; authorization?: string }>;
  laneRequests: string[];
}> {
  const app = express();
  app.use(express.json());
  const decisions: Array<{ body: any; authorization?: string }> = [];
  const results: Array<{ body: any; authorization?: string }> = [];
  const laneRequests: string[] = [];
  const lane = fakeLane();
  app.get('/v1/lanes/effective', (req, res) => { laneRequests.push(req.url); res.json(lane); });
  app.post('/v1/decide', (req, res) => {
    decisions.push({ body: req.body, authorization: req.header('authorization') });
    const verdict = req.body.toolName === 'delete_repo' ? 'deny' : 'allow';
    res.json(fakeDecision(req.body, verdict, verdict === 'deny' ? 'no deletes' : 'allowed'));
  });
  app.post('/v1/result', (req, res) => {
    results.push({ body: req.body, authorization: req.header('authorization') });
    res.json({ tainted: String(req.body.result).includes('tainted'), reason: 'prompt injection' });
  });
  const server = await new Promise<HttpServer>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  return { url: `http://127.0.0.1:${address.port}`, decisions, results, laneRequests };
}

function fakeDecision(body: any, verdict: 'allow' | 'deny', reason: string): Decision {
  return {
    id: `dec-${body.requestId}`,
    requestId: body.requestId,
    sessionId: body.sessionId,
    agentId: body.agent?.agentId ?? 'agent',
    laneId: 'lane',
    laneVersion: 1,
    mode: 'enforce',
    checkpoint: body.checkpoint,
    toolName: body.toolName,
    category: body.category,
    verdict,
    effectiveVerdict: verdict,
    wouldDeny: verdict === 'deny',
    stage: verdict === 'deny' ? 'rules_deny' : 'rules_allow',
    reason,
    ruleIds: [],
    tainted: false,
    latencyMs: 1,
    createdAt: new Date().toISOString(),
  };
}

function fakeLane(): Lane {
  return {
    id: 'lane',
    version: 1,
    appliesTo: { surfaces: ['*'] },
    purpose: 'tests',
    dos: [],
    never: [],
    rules: { deny: [{ tool: ['delete_repo'] }] },
    mode: 'enforce',
    failMode: { default: 'closed', READ: 'open' },
    approval: { channels: ['dashboard'], timeoutSec: 30 },
    judge: { escalateBelow: 0.5, dataPolicy: 'metadata-only' },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}
