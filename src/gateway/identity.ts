import crypto from 'crypto';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AgentIdentity, Surface } from '../governance/types';
import type { IdentityHeaderNames } from './config';
import type { GatewayPrincipal } from './auth';

export interface CallerContext {
  agent: AgentIdentity;
  sessionId: string;
  authorization?: string;
}

export interface GatewayRequestAuth {
  principal?: GatewayPrincipal;
  authorization?: string;
  anonymous?: boolean;
}

const stdioSessionId = crypto.randomUUID();

function firstHeader(headers: Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const item = Array.isArray(value) ? value[0] : value;
    return item && item.length > 0 ? item : undefined;
  }
  return undefined;
}

function asSurface(value: string | undefined): Surface {
  const allowed: Surface[] = [
    'claude-code',
    'copilot-cli',
    'copilot-cloud-agent',
    'vscode',
    'mcp-gateway',
    'sdk',
    'foundry',
    'copilot-studio',
    'monitor',
    'unknown',
  ];
  return value && (allowed as string[]).includes(value) ? value as Surface : 'mcp-gateway';
}

function safeSuffix(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 200);
}

function contextFromAuthenticatedRequest(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  names: IdentityHeaderNames,
  auth: GatewayRequestAuth,
): CallerContext {
  const headers = extra.requestInfo?.headers;
  const principal = auth.principal!;
  const suffix = safeSuffix(firstHeader(headers, names.agentId));
  const externalId = suffix ? `${principal.externalId}/${suffix}` : principal.externalId;
  const rawSessionId = firstHeader(headers, names.sessionId) ?? extra.sessionId ?? crypto.randomUUID();
  return {
    sessionId: `${principal.subject}:${rawSessionId}`,
    authorization: auth.authorization,
    agent: {
      surface: asSurface(firstHeader(headers, names.surface)),
      externalId,
      agentId: externalId,
      name: principal.name ?? externalId,
      user: principal.user,
    },
  };
}

export function stdioCallerContext(): CallerContext {
  const sessionId = process.env.X_SESSION_ID ?? process.env.AGENT_SESSION_ID ?? stdioSessionId;
  return {
    sessionId,
    authorization: process.env.AGENT_GATEWAY_AUTHORIZATION,
    agent: {
      surface: asSurface(process.env.AGENT_SURFACE),
      externalId: process.env.AGENT_ID,
      agentId: process.env.AGENT_ID,
      name: process.env.AGENT_NAME,
      user: process.env.AGENT_USER ?? process.env.USERNAME ?? process.env.USER,
    },
  };
}

export function callerContextFromRequest(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  names: IdentityHeaderNames,
  auth?: GatewayRequestAuth,
): CallerContext {
  if (auth?.principal) return contextFromAuthenticatedRequest(extra, names, auth);
  const headers = extra.requestInfo?.headers;
  const sessionId = firstHeader(headers, names.sessionId) ?? extra.sessionId ?? crypto.randomUUID();
  const agentId = firstHeader(headers, names.agentId);
  const agentName = firstHeader(headers, names.agentName);
  const surface = asSurface(firstHeader(headers, names.surface));
  const user = firstHeader(headers, names.user);
  return {
    sessionId,
    authorization: firstHeader(headers, 'authorization'),
    agent: {
      surface,
      externalId: agentId,
      agentId,
      name: agentName,
      user,
    },
  };
}
