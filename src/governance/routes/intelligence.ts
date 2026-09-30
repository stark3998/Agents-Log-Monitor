import { Router, type Request, type Response } from 'express';
import { Readable } from 'stream';
import { govConfig } from '../config';
import { requireRole } from '../auth';
import { askDeployment, docsAskAvailable, runDocsAsk, sanitizeMessages, type AskEvent } from '../../docs/ask-agent';

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
  if (!url) {
    if (docsAskAvailable()) await builtInChat(req, res);
    else unavailable(res);
    return;
  }
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
  // no-transform keeps the compression middleware from buffering the event stream.
  res.setHeader('cache-control', noTransform(upstream.headers.get('cache-control') ?? 'no-cache'));
  const accel = upstream.headers.get('x-accel-buffering');
  if (accel) res.setHeader('x-accel-buffering', accel);
  if (!upstream.body) { res.end(); return; }
  Readable.fromWeb(upstream.body as never).pipe(res);
}

function noTransform(cacheControl: string): string {
  return /no-transform/i.test(cacheControl) ? cacheControl : `${cacheControl}, no-transform`;
}

/** Docs-grounded Ask agent on Foundry, served in-process when no intelligence service is configured. */
async function builtInChat(req: Request, res: Response): Promise<void> {
  const messages = sanitizeMessages((req.body as { messages?: unknown } | undefined)?.messages);
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    res.status(400).json({ error: 'messages must end with a user message' });
    return;
  }
  res.status(200);
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctrl.abort(); });
  const send = (ev: AskEvent) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  try {
    for await (const ev of runDocsAsk(messages, { signal: ctrl.signal })) send(ev);
  } catch (err) {
    if (!ctrl.signal.aborted) {
      const message = err instanceof Error && err.name === 'TimeoutError' ? 'The model took too long to answer.' : (err as Error).message || 'Ask failed';
      console.error('[ask] built-in docs agent failed:', message);
      send({ type: 'error', message });
      send({ type: 'done' });
    }
  } finally {
    res.end();
  }
}

/** Which engine answers Ask (for the UI caption). */
router.get('/status', requireRole('Viewer'), (_req, res) => {
  if (targetUrl('chat')) res.json({ available: true, engine: 'intelligence', grounding: 'docs' });
  else if (docsAskAvailable()) res.json({ available: true, engine: 'foundry', model: askDeployment(), grounding: 'docs' });
  else res.json({ available: false });
});

router.post('/chat', requireRole('Viewer'), (req, res, next) => { void proxySse(req, res).catch(next); });
router.post('/lanes/draft', requireRole('PolicyAdmin'), (req, res, next) => { void proxyJson(req, res, 'lanes/draft').catch(next); });
router.post('/investigate', requireRole('PolicyAdmin'), (req, res, next) => { void proxyJson(req, res, 'investigate').catch(next); });

export default router;
