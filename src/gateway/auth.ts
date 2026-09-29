import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Role } from '../governance/types';
import type { GatewayConfig } from './config';

export interface GatewayPrincipal {
  id: string;
  externalId: string;
  subject: string;
  name?: string;
  user?: string;
  roles: Role[];
  tenantId?: string;
}

const VALID_ROLES = new Set<Role>(['Viewer', 'Approver', 'PolicyAdmin', 'Agent']);
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
let testJwks: Parameters<typeof jwtVerify>[1] | null = null;

export function __setGatewayJwksForTests(jwks: Parameters<typeof jwtVerify>[1] | null): void {
  testJwks = jwks;
}

function roleClaims(v: unknown): Role[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  return raw.filter((r): r is Role => VALID_ROLES.has(r as Role));
}

function audiences(audience: string): string[] {
  const aud = audience.trim();
  if (!aud) return [];
  const out = new Set<string>([aud]);
  if (aud.startsWith('api://')) out.add(aud.slice('api://'.length));
  else out.add(`api://${aud}`);
  return [...out];
}

function issuers(tenant: string): string[] {
  return [`https://login.microsoftonline.com/${tenant}/v2.0`, `https://sts.windows.net/${tenant}/`];
}

function jwksForTenant(tenant: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = remoteJwks.get(tenant);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`));
  remoteJwks.set(tenant, jwks);
  return jwks;
}

function stringClaim(payload: JWTPayload & Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = payload[name];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function principalFromPayload(payload: JWTPayload): GatewayPrincipal {
  const p = payload as JWTPayload & Record<string, unknown>;
  const roles = roleClaims(p.roles);
  if (!roles.includes('Agent')) throw new Error('requires role: Agent');
  const appId = stringClaim(p, 'appid', 'azp');
  const oid = stringClaim(p, 'oid');
  const externalId = oid ?? appId ?? String(p.sub ?? 'unknown');
  const subject = String(p.sub ?? externalId);
  return {
    id: externalId,
    externalId: appId ?? externalId,
    subject,
    name: stringClaim(p, 'app_displayname', 'appDisplayName', 'name', 'preferred_username') ?? appId ?? externalId,
    user: stringClaim(p, 'preferred_username', 'upn'),
    roles,
    tenantId: stringClaim(p, 'tid'),
  };
}

export async function gatewayPrincipalFromBearer(token: string, config: Pick<GatewayConfig, 'auth'>): Promise<GatewayPrincipal> {
  const tenant = config.auth.tenantId;
  const audience = audiences(config.auth.audience);
  if (!tenant || !audience.length) throw new Error('gateway Entra authentication is not configured');
  const { payload } = await jwtVerify(token, testJwks ?? jwksForTenant(tenant), {
    issuer: issuers(tenant),
    audience,
  });
  return principalFromPayload(payload);
}
