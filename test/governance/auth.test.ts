import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import { govConfig } from '../../src/governance/config';
import {
  __setJwksForTests, authenticate, hasRole, issueDeviceToken, LOCAL_AGENT_PRINCIPAL, principalFromBearer, requireRole,
} from '../../src/governance/auth';

const tenant = '11111111-1111-1111-1111-111111111111';
const audience = 'api://22222222-2222-2222-2222-222222222222';

function mockReq(remoteAddress = '10.0.0.8', token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    headers,
    protocol: 'https',
    socket: { remoteAddress },
    header: (n: string) => headers[n.toLowerCase()],
    get: (n: string) => (n.toLowerCase() === 'host' ? 'gov.contoso.com' : undefined),
  } as unknown as Request;
}

function mockRes(): Response & { code?: number; body?: unknown; sentHeaders: Record<string, string> } {
  const res = {
    sentHeaders: {} as Record<string, string>,
    setHeader(n: string, v: string) { this.sentHeaders[n] = v; return this; },
    status(c: number) { this.code = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  return res as unknown as Response & { code?: number; body?: unknown; sentHeaders: Record<string, string> };
}

async function makeToken(claims: Record<string, unknown>, expires = '1h', aud = audience, iss = `https://login.microsoftonline.com/${tenant}/v2.0`) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key';
  __setJwksForTests(createLocalJWKSet({ keys: [jwk] }));
  return new SignJWT({ tid: tenant, oid: 'user-1', preferred_username: 'a@contoso.com', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setSubject('sub-1')
    .setIssuedAt()
    .setExpirationTime(expires)
    .sign(privateKey);
}

beforeEach(() => {
  vi.restoreAllMocks();
  __setJwksForTests(null);
  govConfig.mode = 'cloud';
  govConfig.auth.tenantId = tenant;
  govConfig.auth.audience = audience;
  govConfig.auth.trustLoopback = true;
  process.env.GOVERNANCE_DEVICE_SIGNING_KEY = 'test-device-signing-key-32-bytes';
  delete process.env.GOVERNANCE_LOCAL_ADMIN_TOKEN;
});

describe('governance auth', () => {
  it('validates Entra issuer, audience and role hierarchy', async () => {
    const token = await makeToken({ roles: ['PolicyAdmin', 'Bogus'], scp: 'user_impersonation' });
    const p = await principalFromBearer(token);
    expect(p).toMatchObject({ id: 'user-1', name: 'a@contoso.com', kind: 'user', tenantId: tenant });
    expect(p?.roles.sort()).toEqual(['Approver', 'PolicyAdmin', 'Viewer'].sort());
    expect(hasRole(p ?? undefined, 'Viewer', 'Approver')).toBe(true);
  });

  it('accepts v1 issuer and bare client-id audience', async () => {
    const token = await makeToken({ roles: ['Agent'], idtyp: 'app', appid: 'app-1' }, '1h', audience.slice('api://'.length), `https://sts.windows.net/${tenant}/`);
    const p = await principalFromBearer(token);
    expect(p).toMatchObject({ id: 'user-1', kind: 'agent' });
    expect(p?.roles).toEqual(['Agent']);
  });

  it('rejects expired tokens', async () => {
    const token = await makeToken({ roles: ['Viewer'] }, '-1s');
    await expect(principalFromBearer(token)).rejects.toThrow();
  });

  it('gives unauthenticated loopback local-agent least-privilege roles', async () => {
    govConfig.mode = 'local';
    const req = mockReq('127.0.0.1');
    const res = mockRes();
    const next = vi.fn<NextFunction>();
    await authenticate(req, res, next);
    expect(req.principal).toEqual(LOCAL_AGENT_PRINCIPAL);
    expect(hasRole(req.principal, 'Agent', 'Viewer')).toBe(true);
    expect(hasRole(req.principal, 'Approver', 'PolicyAdmin')).toBe(false);
    expect(next).toHaveBeenCalled();

    const badReq = mockReq('127.0.0.1', 'not-a-jwt');
    const badRes = mockRes();
    await authenticate(badReq, badRes, vi.fn());
    expect(badRes.code).toBe(401);
  });

  it('accepts the opt-in local admin bearer automation token', async () => {
    govConfig.mode = 'local';
    process.env.GOVERNANCE_LOCAL_ADMIN_TOKEN = 'admin-secret';
    await expect(principalFromBearer('admin-secret')).resolves.toMatchObject({ id: 'local-admin', roles: ['Viewer', 'Approver', 'PolicyAdmin', 'Agent'] });
    delete process.env.GOVERNANCE_LOCAL_ADMIN_TOKEN;
    await expect(principalFromBearer('admin-secret')).rejects.toThrow();
  });

  it('returns cloud 401 with protected-resource metadata', async () => {
    govConfig.mode = 'cloud';
    const res = mockRes();
    await authenticate(mockReq('10.0.0.8'), res, vi.fn());
    expect(res.code).toBe(401);
    expect(res.sentHeaders['WWW-Authenticate']).toContain('Bearer');
    expect(res.sentHeaders['WWW-Authenticate']).toContain('https://gov.contoso.com/.well-known/oauth-protected-resource');
  });

  it('issues and verifies device tokens', async () => {
    const issued = await issueDeviceToken('dev-1', ['Agent', 'Viewer'], 1);
    const p = await principalFromBearer(issued.token);
    expect(issued.expiresAt).toBeTruthy();
    expect(p).toMatchObject({ id: 'dev-1', kind: 'device', roles: ['Agent', 'Viewer'] });
  });

  it('enforces requireRole with implied roles', () => {
    const req = { principal: { id: 'u', kind: 'user', roles: ['Approver'] } } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();
    requireRole('Viewer')(req, res, next);
    expect(next).toHaveBeenCalled();

    requireRole('PolicyAdmin')(req, res, vi.fn());
    expect(res.code).toBe(403);
  });
});
