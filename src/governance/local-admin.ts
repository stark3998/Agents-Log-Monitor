import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import type { Principal } from './types';

const COOKIE_NAME = 'agentgov_admin';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const startupSecret = crypto.randomBytes(32);
const oneTimeTokens = new Map<string, number>();
const sessions = new Map<string, number>();

export const LOCAL_ADMIN_PRINCIPAL: Principal = {
  id: 'local-admin',
  name: 'Local admin',
  roles: ['Viewer', 'Approver', 'PolicyAdmin', 'Agent'],
  kind: 'local',
};

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function cleanup(now = Date.now()): void {
  for (const [token, expires] of oneTimeTokens) if (expires <= now) oneTimeTokens.delete(token);
  for (const [sid, expires] of sessions) if (expires <= now) sessions.delete(sid);
}

export function adminLoginUrl(port: number): string {
  cleanup();
  const token = randomToken();
  oneTimeTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return `http://127.0.0.1:${port}/api/gov/local-login?token=${encodeURIComponent(token)}`;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function hasValidLocalAdminSession(req: Request): boolean {
  cleanup();
  const sid = parseCookies(req.header('cookie'))[COOKIE_NAME];
  if (!sid) return false;
  const expires = sessions.get(sid);
  if (!expires || expires <= Date.now()) {
    sessions.delete(sid);
    return false;
  }
  sessions.set(sid, Date.now() + SESSION_TTL_MS);
  return true;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function isLocalAdminBearer(token: string | undefined): boolean {
  const configured = process.env.GOVERNANCE_LOCAL_ADMIN_TOKEN;
  if (!configured || !token) return false;
  return safeEqual(token, configured);
}

export function localAdminRouter(): Router {
  const router = Router();
  router.get('/local-login', (req: Request, res: Response) => {
    cleanup();
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const expires = oneTimeTokens.get(token);
    oneTimeTokens.delete(token);
    if (!expires || expires <= Date.now()) {
      res.status(401).type('text/plain').send('Local admin login token is invalid or expired.');
      return;
    }
    const sid = randomToken();
    sessions.set(sid, Date.now() + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
    res.redirect(302, '/governance');
  });
  return router;
}

export function __resetLocalAdminForTests(): void {
  oneTimeTokens.clear();
  sessions.clear();
  startupSecret.fill(0);
  crypto.randomFillSync(startupSecret);
}
