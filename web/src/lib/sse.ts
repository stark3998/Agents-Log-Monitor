import { authFetch } from '../auth/token';
import { docRoute } from './docs';

export type CitationKind = 'session' | 'decision' | 'incident' | 'doc';

export type ChatEvent =
  | { type: 'meta'; engine?: string; model?: string; grounding?: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; args?: unknown }
  | { type: 'citation'; kind: CitationKind; id: string; title?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/**
 * Incremental Server-Sent Events parser. Feed decoded text chunks (which may split lines or events
 * anywhere); it calls `onData` with each complete event's `data:` payload (multi-line data joined by \n).
 */
export function createSseParser(onData: (data: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buf = '';
  let data: string[] = [];
  const dispatch = () => {
    if (data.length) onData(data.join('\n'));
    data = [];
  };
  const line = (l: string) => {
    if (l === '') { dispatch(); return; }
    if (l.startsWith(':')) return; // comment / keep-alive
    const i = l.indexOf(':');
    const field = i === -1 ? l : l.slice(0, i);
    let value = i === -1 ? '' : l.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  };
  return {
    push(chunk: string) {
      buf += chunk;
      let nl: number;
      while ((nl = buf.search(/\r\n|\r|\n/)) !== -1) {
        if (buf[nl] === '\r' && nl === buf.length - 1) break; // wait: may be the first half of \r\n
        const sep = buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1;
        line(buf.slice(0, nl));
        buf = buf.slice(nl + sep);
      }
    },
    flush() {
      if (buf) { line(buf.replace(/\r$/, '')); buf = ''; }
      dispatch();
    },
  };
}

/** Parse one SSE `data:` payload into a ChatEvent (ignores `[DONE]` sentinels and malformed JSON). */
export function parseChatEvent(data: string): ChatEvent | null {
  const d = data.trim();
  if (!d) return null;
  if (d === '[DONE]') return { type: 'done' };
  try {
    const ev = JSON.parse(d) as ChatEvent;
    return ev && typeof ev === 'object' && 'type' in ev ? ev : null;
  } catch {
    return null;
  }
}

export class ChatUnavailableError extends Error {
  constructor(message = 'Ask the monitor is not configured on this server.') { super(message); }
}

/** In-app route for a chat citation (doc ids may carry a `#heading` anchor). */
export function citationHref(c: { kind: CitationKind; id: string }): string {
  if (c.kind === 'doc') {
    const [docId, anchor] = c.id.split('#', 2);
    return docRoute(docId, anchor);
  }
  const id = encodeURIComponent(c.id);
  return c.kind === 'session' ? `/conversations?c=${id}` : c.kind === 'decision' ? `/enforcements?d=${id}` : `/incidents/${id}`;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

/**
 * POST /api/gov/intelligence/chat and stream SSE events. Resolves when the stream ends.
 * Throws ChatUnavailableError on 503 (intelligence service not configured).
 */
export async function streamChat(opts: {
  messages: ChatMessage[]; conversationId?: string; signal?: AbortSignal; onEvent: (e: ChatEvent) => void;
}): Promise<void> {
  const res = await authFetch('/api/gov/intelligence/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: opts.messages, conversationId: opts.conversationId }),
    signal: opts.signal,
  });
  if (res.status === 503 || res.status === 404 || res.status === 501) throw new ChatUnavailableError();
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`.trim();
    try { const b = await res.json() as { error?: string }; if (b?.error) msg = b.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('Streaming is not supported by this browser.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(d => { const ev = parseChatEvent(d); if (ev) opts.onEvent(ev); });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push(decoder.decode());
  parser.flush();
}
