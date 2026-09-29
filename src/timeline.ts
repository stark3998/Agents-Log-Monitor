/** Converts stored event rows into compact timeline items for the conversation view. */

export interface EventRow {
  id: number;
  session_id: string;
  agent_id: string;
  parent_event_id: number | null;
  event_type: string;
  raw_event_name: string | null;
  tool_name: string | null;
  tool_use_id: string | null;
  status: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error_text: string | null;
  model: string | null;
  payload: string | null;
  created_at: string;
  capture_channel: string | null;
  category: string | null;
  mcp_server: string | null;
  risk_level: string | null;
  correlated_event_id: number | null;
}

export interface FindingLite {
  kind: string;
  key: string;
  label: string;
  severity: string | null;
  sample?: string | null;
}

export interface FindingRow extends FindingLite {
  event_id: number;
  masked_sample: string | null;
}

export type TimelineItem =
  | { kind: 'prompt' | 'assistant' | 'thinking'; id: number; t: string; agentId: string; text: string; truncated: boolean; channel: string; hook?: boolean; findings?: FindingLite[] }
  | { kind: 'tool'; id: number; resultId: number | null; t: string; agentId: string; name: string; mcpServer: string | null; category: string | null;
      status: string; durationMs: number | null; preview: string; risk: string | null; channel: string; hook: boolean; error: string | null; findings: FindingLite[];
      /** Source tool-call id; governance decisions carry it as `requestId`. */
      toolUseId: string | null }
  | { kind: 'subagent'; id: number; t: string; agentId: string; phase: 'start' | 'end'; name: string; agentType: string | null; status: string | null }
  | { kind: 'lifecycle'; id: number; t: string; agentId: string; label: string; detail: string | null; model: string | null; tokens: number | null }
  | { kind: 'notification'; id: number; t: string; agentId: string; text: string }
  | { kind: 'policy'; id: number; t: string; agentId: string; outcome: string; label: string };

export type LiveUpdate =
  | { op: 'append'; item: TimelineItem }
  | { op: 'tool_result'; callId: number; resultId: number; status: string; durationMs: number | null; error: string | null; findings: FindingLite[] };

const TEXT_LIMIT = 20_000;
const THINKING_LIMIT = 400;   // full reasoning is fetched lazily via /api/events/:id

function parse(p: string | null): Record<string, unknown> {
  if (!p) return {};
  try { const o = JSON.parse(p); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

function str(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function toolPreview(input: unknown): string {
  if (input == null) return '';
  if (typeof input !== 'object') return clip(str(input).replace(/\s+/g, ' '), 200);
  const o = input as Record<string, unknown>;
  for (const k of ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'content']) {
    if (o[k] != null && o[k] !== '') return clip(str(o[k]).replace(/\s+/g, ' '), 200);
  }
  const first = Object.keys(o)[0];
  return first ? clip(`${first}: ${str(o[first]).replace(/\s+/g, ' ')}`, 200) : '';
}

function lite(f: FindingRow): FindingLite {
  return { kind: f.kind, key: f.key, label: f.label, severity: f.severity, sample: f.masked_sample };
}

function textItem(kind: 'prompt' | 'assistant' | 'thinking', e: EventRow, text: string, findings: FindingLite[]): TimelineItem {
  const limit = kind === 'thinking' ? THINKING_LIMIT : TEXT_LIMIT;
  return {
    kind, id: e.id, t: e.created_at, agentId: e.agent_id,
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated: text.length > limit,
    channel: e.capture_channel ?? 'hook',
    findings: findings.length ? findings : undefined,
  };
}

function toolItem(call: EventRow, result: EventRow | null, findings: FindingLite[], hook: boolean): TimelineItem {
  const p = parse(call.payload);
  const status = result ? (result.status ?? 'success') : (call.status && call.status !== 'pending' ? call.status : 'pending');
  let dur = result?.duration_ms ?? null;
  if (dur == null && result && result.id !== call.id) {
    dur = Math.max(0, new Date(result.created_at).getTime() - new Date(call.created_at).getTime());
  }
  return {
    kind: 'tool', id: call.id, resultId: result && result.id !== call.id ? result.id : null,
    t: call.created_at, agentId: call.agent_id,
    name: call.tool_name ?? '(unknown)', mcpServer: call.mcp_server, category: call.category,
    status: status ?? 'pending', durationMs: dur, preview: toolPreview(p.tool_input),
    risk: call.risk_level, channel: call.capture_channel ?? 'hook', hook,
    error: result?.error_text ?? call.error_text ?? null, findings,
    toolUseId: call.tool_use_id ?? null,
  };
}

function nonToolItem(e: EventRow, findings: FindingLite[]): TimelineItem | null {
  const p = parse(e.payload);
  const policy = findings.find(f => f.kind === 'policy');
  switch (e.event_type) {
    case 'prompt':
      return textItem('prompt', e, str(p.prompt ?? p.message ?? p.user_message), findings);
    case 'assistant_text':
      return textItem('assistant', e, str(p.text), []);
    case 'thinking':
      return textItem('thinking', e, str(p.thinking), []);
    case 'notification':
      if (policy) return { kind: 'policy', id: e.id, t: e.created_at, agentId: e.agent_id, outcome: policy.key, label: policy.label };
      return { kind: 'notification', id: e.id, t: e.created_at, agentId: e.agent_id, text: clip(str(p.message ?? p.text), 2000) };
    case 'terminal_chunk':
      return null;
  }
  if (e.raw_event_name === 'SubagentStart' || e.raw_event_name === 'SubagentStop') {
    return {
      kind: 'subagent', id: e.id, t: e.created_at, agentId: e.agent_id,
      phase: e.raw_event_name === 'SubagentStart' ? 'start' : 'end',
      name: str(p.agentDisplayName ?? p.agent_display_name ?? p.agentName ?? p.agent_type ?? p.agentType) || e.agent_id.slice(0, 8),
      agentType: str(p.agentType ?? p.agent_type ?? p.agentName) || null,
      status: e.status,
    };
  }
  if (policy) return { kind: 'policy', id: e.id, t: e.created_at, agentId: e.agent_id, outcome: policy.key, label: policy.label };
  const detail = str(p.detail ?? p.reason ?? p.newMode ?? p.stop_reason ?? '') || null;
  const tokens = (e.input_tokens ?? 0) + (e.output_tokens ?? 0);
  return {
    kind: 'lifecycle', id: e.id, t: e.created_at, agentId: e.agent_id,
    label: e.raw_event_name || e.event_type, detail: detail ? clip(detail, 300) : null,
    model: e.model, tokens: tokens || null,
  };
}

/** Build the whole timeline for a session. `events` must be sorted by created_at, id. */
export function buildTimeline(events: EventRow[], findings: FindingRow[]): TimelineItem[] {
  const byEvent = new Map<number, FindingLite[]>();
  for (const f of findings) {
    const arr = byEvent.get(f.event_id) ?? [];
    arr.push(lite(f));
    byEvent.set(f.event_id, arr);
  }

  // Hook rows that duplicate a log row are hidden; the log row gets a "hook" marker.
  const hookConfirmed = new Set<number>();
  for (const e of events) {
    if (e.capture_channel === 'hook' && e.correlated_event_id != null) hookConfirmed.add(e.correlated_event_id);
  }

  const resultsByCall = new Map<number, EventRow>();
  const unpairedCalls = new Map<string, EventRow[]>();   // FIFO pairing for sources without tool_use_id
  const pairedResults = new Set<number>();
  const pairKey = (e: EventRow) => `${e.agent_id}|${e.capture_channel}|${e.tool_name}`;
  for (const e of events) {
    if (e.event_type === 'tool_call' && !e.tool_use_id) {
      const k = pairKey(e);
      const q = unpairedCalls.get(k) ?? [];
      q.push(e);
      unpairedCalls.set(k, q);
    } else if (e.event_type === 'tool_result') {
      if (e.parent_event_id != null) {
        resultsByCall.set(e.parent_event_id, e);
        pairedResults.add(e.id);
      } else if (!e.tool_use_id) {
        const call = unpairedCalls.get(pairKey(e))?.shift();
        if (call) { resultsByCall.set(call.id, e); pairedResults.add(e.id); }
      }
    }
  }

  const items: TimelineItem[] = [];
  for (const e of events) {
    if (e.capture_channel === 'hook' && e.correlated_event_id != null) continue;
    const f = byEvent.get(e.id) ?? [];
    if (e.event_type === 'tool_call') {
      const result = resultsByCall.get(e.id) ?? null;
      const all = result ? f.concat(byEvent.get(result.id) ?? []) : f;
      items.push(toolItem(e, result, all, hookConfirmed.has(e.id)));
    } else if (e.event_type === 'tool_result') {
      if (pairedResults.has(e.id)) continue;
      items.push(toolItem(e, e, f, hookConfirmed.has(e.id)));
    } else {
      const it = nonToolItem(e, f);
      if (it) {
        if ((it.kind === 'prompt') && hookConfirmed.has(e.id)) it.hook = true;
        items.push(it);
      }
    }
  }
  return items;
}

/** Build the live update for one freshly inserted event (null when nothing to show). */
export function buildLiveUpdate(e: EventRow, findings: FindingRow[]): LiveUpdate | null {
  if (e.capture_channel === 'hook' && e.correlated_event_id != null) return null;
  const f = findings.map(lite);
  if (e.event_type === 'tool_result' && e.parent_event_id != null) {
    return { op: 'tool_result', callId: e.parent_event_id, resultId: e.id, status: e.status ?? 'success', durationMs: e.duration_ms, error: e.error_text, findings: f };
  }
  if (e.event_type === 'tool_call' || e.event_type === 'tool_result') {
    return { op: 'append', item: toolItem(e, e.event_type === 'tool_result' ? e : null, f, false) };
  }
  const it = nonToolItem(e, f);
  return it ? { op: 'append', item: it } : null;
}
