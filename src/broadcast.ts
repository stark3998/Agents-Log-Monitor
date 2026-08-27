import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server } from 'http';

let wss: WebSocketServer | null = null;

export function attachWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: '/live' });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Reject non-localhost connections
    const addr = req.socket.remoteAddress ?? '';
    if (!addr.includes('127.0.0.1') && !addr.includes('::1')) {
      ws.close();
      return;
    }
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
