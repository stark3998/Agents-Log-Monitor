import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import { govConfig } from './config';
import { hasValidLocalAdminSession, isLocalAdminBearer, LOCAL_ADMIN_PRINCIPAL } from './local-admin';
import type { Principal, Role } from './types';

declare module 'express-serve-static-core' {
  interface Request { principal?: Principal }
}

export const LOCAL_PRINCIPAL: Principal = {
  id: 'local-agent',
  name: 'Local agent',
  roles: ['Agent', 'Viewer'],
  kind: 'local',
};

export const LOCAL_AGENT_PRINCIPAL = LOCAL_PRINCIPAL;

export const LOCAL_USER_PRINCIPAL: Principal = {
  id: 'local',
  name: 'Local user',
  roles: ['Viewer', 'Approver', 'PolicyAdmin', 'Agent'],
  kind: 'local',
};

const VALID_ROLES = new Set<Role>(['Viewer', 'Approver', 'PolicyAdmin', 'Agent']);
const remoteJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
let testJwks: Parameters<typeof jwtVerify>[1] | null = null;

export function __setJwksForTests(jwks: Parameters<typeof jwtVerify>[1] | null): void {
  testJwks = jwks;
}

function bearer(req: Request): string | undefined {
  const h = req.header('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m?.[1];
}

function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hostParts(hostHeader: string | undefined): { hostname: string; port: number | null } | null {
  const raw = (hostHeader ?? '').trim();
  if (!raw) return null;
  try {
    const u = new URL(`http://${raw}`);
    return { hostname: u.hostname.toLowerCase(), port: u.port ? Number(u.port) : null };
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

export function isAllowedLoopbackOrigin(origin: string | undefined, expectedPort: number): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return false;
    if (!isLoopbackHostname(u.hostname)) return false;
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80);
    if (port === expectedPort) return true;
    return process.env.NODE_ENV !== 'production' && (port === 5173);
  } catch {
    return false;
  }
}

function actualPort(req: Request, configuredPort: number): number {
  return Number(req.socket.localPort) || configuredPort;
}

function isMutation(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

export function localRequestGuard(configuredPort: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (govConfig.mode !== 'local') { next(); return; }
    const port = actualPort(req, configuredPort);
    const host = hostParts(req.header('host'));
    if (!host || host.port !== port || !isLoopbackHostname(host.hostname)) {
      res.status(421).json({ error: 'host not allowed' });
      return;
    }
    if (isMutation(req.method) && !isAllowedLoopbackOrigin(req.header('origin'), port)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }
    next();
  };
}

export function requireJsonForGovMutations(req: Request, res: Response, next: NextFunction): void {
  if (!isMutation(req.method)) { next(); return; }
  if (req.is('application/json')) { next(); return; }
  res.status(415).json({ error: 'content-type must be application/json' });
}

function roleClaims(v: unknown): Role[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const direct = raw.filter((r): r is Role => VALID_ROLES.has(r as Role));
  const out = new Set<Role>(direct);
  if (out.has('PolicyAdmin')) { out.add('Approver'); out.add('Viewer'); }
  if (out.has('Approver')) out.add('Viewer');
  return [...out];
}

export function hasRole(p: Principal | undefined, ...roles: Role[]): boolean {
  if (!p) return false;
  const expanded = roleClaims(p.roles);
  return roles.some(r => expanded.includes(r));
}

function audiences(): string[] {
  const aud = govConfig.auth.audience.trim();
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

function textKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

async function principalFromDeviceToken(token: string): Promise<Principal | null> {
  const secret = process.env.GOVERNANCE_DEVICE_SIGNING_KEY;
  if (!secret) return null;
  try {
    const { payload } = await jwtVerify(token, textKey(secret), { algorithms: ['HS256'] });
    if (payload.kind !== 'device') return null;
    const id = String(payload.sub ?? '');
    if (!id) return null;
    return { id, name: id, kind: 'device', roles: roleClaims(payload.roles), tenantId: govConfig.tenantId };
  } catch {
    return null;
  }
}

function principalFromEntraPayload(payload: JWTPayload): Principal {
  const p = payload as JWTPayload & Record<string, unknown>;
  const roles = roleClaims(p.roles);
  const scopes = typeof p.scp === 'string' ? p.scp.trim() : '';
  const kind: Principal['kind'] = p.idtyp === 'app' || !scopes ? 'agent' : 'user';
  const appId = typeof p.appid === 'string' ? p.appid : typeof p.azp === 'string' ? p.azp : undefined;
  const id = String(p.oid ?? p.sub ?? appId ?? 'unknown');
  const name = String(p.preferred_username ?? p.name ?? appId ?? id);
  return {
    id,
    name,
    roles,
    kind,
    tenantId: typeof p.tid === 'string' ? p.tid : govConfig.auth.tenantId || undefined,
  };
}

async function principalFromEntraToken(token: string): Promise<Principal> {
  const tenant = govConfig.auth.tenantId;
  const audience = audiences();
  if (!tenant || !audience.length) throw new Error('Entra authentication is not configured');
  const { payload } = await jwtVerify(token, testJwks ?? jwksForTenant(tenant), {
    issuer: issuers(tenant),
    audience,
  });
  return principalFromEntraPayload(payload);
}

export async function principalFromBearer(token: string | undefined): Promise<Principal | null> {
  if (!token) return null;
  if (govConfig.mode === 'local' && isLocalAdminBearer(token)) return LOCAL_ADMIN_PRINCIPAL;
  const device = await principalFromDeviceToken(token);
  if (device) return device;
  return principalFromEntraToken(token);
}

export async function issueDeviceToken(deviceId: string, roles: Role[] = ['Agent'], ttlDays = 30): Promise<{ token: string; deviceId: string; expiresAt: string }> {
  const secret = process.env.GOVERNANCE_DEVICE_SIGNING_KEY;
  if (!secret) throw new Error('GOVERNANCE_DEVICE_SIGNING_KEY is required to issue device tokens');
  const safeRoles = roleClaims(['Agent', ...roles.filter(r => r === 'Viewer' || r === 'Agent')]);
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
  const token = await new SignJWT({ kind: 'device', roles: safeRoles })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(deviceId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(textKey(secret));
  return { token, deviceId, expiresAt: expiresAt.toISOString() };
}

function authHeader(req: Request): string {
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol ?? 'http').split(',')[0].trim();
  const host = req.get('host') ?? 'localhost';
  const parts = ['Bearer'];
  if (govConfig.auth.audience) parts.push(`resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
  return parts.join(' ');
}

function unauthorized(req: Request, res: Response, message = 'unauthenticated'): void {
  res.setHeader('WWW-Authenticate', authHeader(req));
  res.status(401).json({ error: message });
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  if (token) {
    try {
      const principal = await principalFromBearer(token);
      if (principal) { req.principal = principal; next(); return; }
    } catch (err) {
      unauthorized(req, res, (err as Error).message || 'invalid token');
      return;
    }
  }

  if (govConfig.mode === 'local' && govConfig.auth.trustLoopback && isLoopback(req.socket.remoteAddress)) {
    req.principal = hasValidLocalAdminSession(req) ? LOCAL_ADMIN_PRINCIPAL : LOCAL_AGENT_PRINCIPAL;
    next();
    return;
  }

  unauthorized(req, res);
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) { res.status(401).json({ error: 'unauthenticated' }); return; }
    if (!hasRole(p, ...roles)) { res.status(403).json({ error: `requires role: ${roles.join(' | ')}` }); return; }
    next();
  };
}
