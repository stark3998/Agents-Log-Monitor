import fs from 'fs';
import { broadcast } from './broadcast';
import { get, insert } from './db';

interface WatchEntry {
  sessionId: string;
  path: string;
  offset: number;
  timer: ReturnType<typeof setInterval>;
}

const watches = new Map<string, WatchEntry>();

export function watchTranscript(sessionId: string, transcriptPath: string): void {
  if (watches.has(sessionId)) return;
  if (!transcriptPath) return;
  try {
    if (!fs.existsSync(transcriptPath)) return;
    const entry: WatchEntry = {
      sessionId,
      path: transcriptPath,
      offset: fs.statSync(transcriptPath).size, // start at current end — don't replay here
      timer: setInterval(() => pollTranscript(sessionId), 800),
    };
    watches.set(sessionId, entry);
    console.log(`[transcript] watching ${transcriptPath} for session ${sessionId.slice(0,8)}`);
  } catch (err) {
    console.warn('[transcript] watchTranscript error:', err);
  }
}

export function stopWatch(sessionId: string): void {
  const entry = watches.get(sessionId);
  if (entry) {
    clearInterval(entry.timer);
    watches.delete(sessionId);
  }
}

function pollTranscript(sessionId: string): void {
  const entry = watches.get(sessionId);
  if (!entry) return;

  let stat: fs.Stats;
  try { stat = fs.statSync(entry.path); } catch { return; }
  if (stat.size <= entry.offset) return;

  let buf: Buffer;
  try {
    const fd = fs.openSync(entry.path, 'r');
    buf = Buffer.alloc(stat.size - entry.offset);
    fs.readSync(fd, buf, 0, buf.length, entry.offset);
    fs.closeSync(fd);
  } catch { return; }

  entry.offset = stat.size;

  const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
  for (const line of lines) {
    try { processLine(sessionId, line); } catch { /* skip malformed lines */ }
  }
}

// replayTranscript reads the entire transcript and imports thinking/assistant_text events.
// Idempotent: skips sessions that already have thinking events stored.
export function replayTranscript(sessionId: string, transcriptPath: string): void {
  if (!transcriptPath) return;
  try {
    if (!fs.existsSync(transcriptPath)) return;

    const existing = get<{ c: number }>(
      `SELECT COUNT(*) as c FROM events WHERE session_id = ? AND event_type IN ('thinking','assistant_text') LIMIT 1`,
      [sessionId],
    );
    if (existing && existing.c > 0) return;

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try { processLine(sessionId, line); } catch { /* skip malformed */ }
    }
  } catch (err) {
    console.warn('[transcript] replayTranscript error:', err);
  }
}

interface TranscriptLine {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: ContentItem[];
  };
}

interface ContentItem {
  type: string;
  thinking?: string;
  signature?: string;
  text?: string;
  id?: string;
  name?: string;
}

function processLine(sessionId: string, line: string): void {
  const msg = JSON.parse(line) as TranscriptLine;
  if (msg.type !== 'assistant') return;

  const ts = msg.timestamp ?? new Date().toISOString();
  const content = msg.message?.content ?? [];

  for (const item of content) {
    if (item.type === 'thinking' && item.thinking) {
      emitEvent(sessionId, 'main', 'thinking', 'Thinking', ts, {
        thinking: item.thinking,
        signature: item.signature ?? null,
      });
    } else if (item.type === 'text' && item.text?.trim()) {
      emitEvent(sessionId, 'main', 'assistant_text', 'AssistantText', ts, {
        text: item.text,
      });
    }
    // type === 'tool_use': skip — captured by PreToolUse hook
  }
}

function emitEvent(
  sessionId: string,
  agentId: string,
  eventType: string,
  rawEventName: string,
  occurredAt: string,
  payloadObj: Record<string, unknown>,
): void {
  const id = insert(
    `INSERT INTO events (session_id, agent_id, event_type, raw_event_name, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [sessionId, agentId, eventType, rawEventName, JSON.stringify(payloadObj), occurredAt],
  );
  broadcast({
    id,
    sessionId,
    agentId,
    eventType,
    rawEventName,
    toolName: null,
    status: null,
    durationMs: null,
    payload: payloadObj,
    occurredAt,
  });
}
