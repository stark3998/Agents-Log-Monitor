import fs from 'fs';
import path from 'path';
import type { FailMode } from '../governance/types';

export type UpstreamTransport = 'stdio' | 'http' | 'sse';

export interface UpstreamConfig {
  name: string;
  transport: UpstreamTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolPrefix?: string;
}

export interface IdentityHeaderNames {
  agentId: string;
  agentName: string;
  surface: string;
  sessionId: string;
  user: string;
}

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
  pdpUrl: string;
  pdpTokenEnv: string;
  auth: {
    audience: string;
    tenantId: string;
    allowAnonymous: boolean;
  };
  port: number;
  host: string;
  failModeDefault: FailMode;
  identityHeaders: IdentityHeaderNames;
  decideTimeoutMs: number;
  resultTimeoutMs: number;
  hideDeniedTools: boolean;
}

const DEFAULT_IDENTITY_HEADERS: IdentityHeaderNames = {
  agentId: 'x-agent-id',
  agentName: 'x-agent-name',
  surface: 'x-agent-surface',
  sessionId: 'x-session-id',
  user: 'x-user',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(1|true|yes)$/i.test(value)) return true;
    if (/^(0|false|no)$/i.test(value)) return false;
  }
  return fallback;
}

function asFailMode(value: unknown, fallback: FailMode): FailMode {
  return value === 'open' || value === 'closed' ? value : fallback;
}

function normaliseUpstream(raw: unknown): UpstreamConfig {
  const value = asRecord(raw);
  const name = asString(value.name, '');
  if (!name) throw new Error('Each gateway upstream must have a non-empty name');
  const transport = value.transport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw new Error(`Upstream ${name} has unsupported transport ${String(transport)}`);
  }
  const upstream: UpstreamConfig = {
    name,
    transport,
    command: typeof value.command === 'string' ? value.command : undefined,
    args: Array.isArray(value.args) ? value.args.map(String) : undefined,
    env: asStringRecord(value.env),
    url: typeof value.url === 'string' ? value.url : undefined,
    headers: asStringRecord(value.headers),
    toolPrefix: typeof value.toolPrefix === 'string' && value.toolPrefix ? value.toolPrefix : undefined,
  };
  if (transport === 'stdio' && !upstream.command) throw new Error(`Stdio upstream ${name} requires command`);
  if ((transport === 'http' || transport === 'sse') && !upstream.url) {
    throw new Error(`${transport} upstream ${name} requires url`);
  }
  return upstream;
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw !== undefined && raw !== null) out[key] = String(raw);
  }
  return Object.keys(out).length ? out : undefined;
}

export function loadGatewayConfig(configPath = process.env.AGENT_GATEWAY_CONFIG ?? '.\\agent-gateway.json'): GatewayConfig {
  const resolved = path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
  const fromFile = fs.existsSync(resolved) ? JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown : {};
  const raw = asRecord(fromFile);
  const headers = { ...DEFAULT_IDENTITY_HEADERS, ...asStringRecord(raw.identityHeaders) };
  const upstreamsRaw = Array.isArray(raw.upstreams) ? raw.upstreams : [];

  const failMode = asRecord(raw.failMode);
  const auth = asRecord(raw.auth);
  return {
    upstreams: upstreamsRaw.map(normaliseUpstream),
    pdpUrl: (process.env.AGENT_GATEWAY_PDP_URL ?? asString(raw.pdpUrl, 'http://127.0.0.1:4317')).replace(/\/+$/, ''),
    pdpTokenEnv: asString(raw.pdpTokenEnv, 'AGENT_GATEWAY_PDP_TOKEN'),
    auth: {
      audience: asString(process.env.AGENT_GATEWAY_AUDIENCE ?? auth.audience, ''),
      tenantId: asString(process.env.ENTRA_TENANT_ID ?? process.env.AZURE_TENANT_ID ?? auth.tenantId, ''),
      allowAnonymous: asBool(process.env.AGENT_GATEWAY_ALLOW_ANONYMOUS ?? auth.allowAnonymous, false),
    },
    port: asNumber(process.env.AGENT_GATEWAY_PORT ?? raw.port, 4127),
    host: asString(process.env.GATEWAY_HOST ?? raw.host, '127.0.0.1'),
    failModeDefault: asFailMode(raw.failModeDefault ?? failMode.default, 'closed'),
    identityHeaders: headers,
    decideTimeoutMs: asNumber(raw.decideTimeoutMs, 30_000),
    resultTimeoutMs: asNumber(raw.resultTimeoutMs, 1_500),
    hideDeniedTools: raw.hideDeniedTools !== false,
  };
}

export function getConfiguredPdpToken(config: Pick<GatewayConfig, 'pdpTokenEnv'>): string | undefined {
  const token = process.env[config.pdpTokenEnv];
  return token && token.length > 0 ? token : undefined;
}
