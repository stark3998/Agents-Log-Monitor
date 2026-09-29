import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { govConfig } from '../config';
import { requireRole } from '../auth';

const router = Router();

function targetUrl(path: string): string | null {
  const base = govConfig.intelligence.url.trim();
  if (!base) return null;
  return new URL(path, base.endsWith('/') ? base : `${base}/`).toString();
}

function authorization(req: Request): string | undefined {
  return req.header('authorization') ?? undefined;
}

function unavailable(res: Response): void {
  res.status(503).json({ error: 'intelligence service not configured' });
}

async function proxyJson(req: Request, res: Response, path: string): Promise<void> {
  const url = targetUrl(path);
  if (!url) { unavailable(res); return; }
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization(req) ? { authorization: authorization(req)! } : {}),
    },
    body: JSON.stringify(req.body ?? {}),
  });
  const text = await upstream.text();
  res.status(upstream.status);
  const contentType = upstream.headers.get('content-type');
  if (contentType) res.setHeader('content-type', contentType);
  res.send(text);
}

async function proxySse(req: Request, res: Response): Promise<void> {
  const url = targetUrl('chat');
  if (!url) { unavailable(res); return; }
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(authorization(req) ? { authorization: authorization(req)! } : {}),
    },
    body: JSON.stringify(req.body ?? {}),
  });
  res.status(upstream.status);
  res.setHeader('content-type', upstream.headers.get('content-type') ?? 'text/event-stream');
  res.setHeader('cache-control', upstream.headers.get('cache-control') ?? 'no-cache');
  const accel = upstream.headers.get('x-accel-buffering');
  if (accel) res.setHeader('x-accel-buffering', accel);
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body as never).pipe(res);
}

router.post('/chat', requireRole('Viewer'), (req, res, next) => { void proxySse(req, res).catch(next); });
router.post('/lanes/draft', requireRole('PolicyAdmin'), (req, res, next) => { void proxyJson(req, res, 'lanes/draft').catch(next); });
router.post('/investigate', requireRole('PolicyAdmin'), (req, res, next) => { void proxyJson(req, res, 'investigate').catch(next); });

export default router;
