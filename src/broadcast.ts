import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';
import { govConfig } from './governance/config';
import { hasRole, isAllowedLoopbackOrigin, principalFromBearer } from './governance/auth';

let wss: WebSocketServer | null = null;

function isLoopback(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * Local mode: loopback clients are trusted (as before). Otherwise — and always in cloud mode — the
 * client must present a bearer token as `?token=` (browsers cannot set WebSocket headers) that
 * carries the Viewer role.
 */
async function authorize(req: IncomingMessage): Promise<boolean> {
  const addr = req.socket.remoteAddress ?? '';
  const localPort = Number(req.socket.localPort) || Number(process.env.PORT ?? 4317);
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (govConfig.mode === 'local' && !isAllowedLoopbackOrigin(origin, localPort)) return false;
  if (govConfig.mode === 'local' && govConfig.auth.trustLoopback && isLoopback(addr)) return true;
  const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
  const principal = await principalFromBearer(token).catch(() => null);
  return hasRole(principal ?? undefined, 'Viewer');
}

export function attachWebSocket(server: Server) {
  wss = new WebSocketServer({
    server,
    path: '/live',
    verifyClient: (info, done) => {
      authorize(info.req).then(ok => done(ok, ok ? undefined : 401), () => done(false, 401));
    },
  });
  wss.on('connection', (ws: WebSocket) => {
    ws.on('error', () => { /* ignore */ });
  });
  console.log('WebSocket server attached at /live');
}

export function broadcast(event: unknown) {
  if (!wss) return;
  const msg = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}
