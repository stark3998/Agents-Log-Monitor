export interface NormalizedEvent {
  sessionId: string;
  agentId: string;           // 'main' when there's no subagent involved
  parentAgentId?: string;
  agentType?: string;
  eventType: 'tool_call' | 'tool_result' | 'prompt' | 'lifecycle' | 'notification' | 'terminal_chunk' | 'thinking' | 'assistant_text';
  rawEventName: string;      // e.g. 'PreToolUse', 'preToolUse'
  toolName?: string;
  toolUseId?: string;        // Anthropic API correlation ID linking PreToolUse ↔ PostToolUse
  externalId?: string;       // Platform-native event ID used for cross-restart deduplication
  transcriptPath?: string;   // path to the JSONL transcript file for this session
  status?: 'pending' | 'success' | 'error' | 'blocked';
  durationMs?: number;
  parentEventId?: number;    // links a terminal_chunk back to its tool_call
  inputTokens?: number;      // usage.input_tokens (Stop / UserPromptSubmit)
  outputTokens?: number;     // usage.output_tokens
  cacheReadInputTokens?: number;  // usage.cache_read_input_tokens
  errorText?: string;        // PostToolUse payload.error message text
  model?: string;            // e.g. "claude-sonnet-4-6"
  payload: unknown;          // original payload, kept for the detail drawer
  occurredAt: string;        // ISO timestamp
  /** How the event was captured: push hook, tailed local log, or remote poll. */
  captureChannel?: 'hook' | 'log' | 'poll';
  /** Full text used for sensitive-data detection when `payload` is a trimmed copy. Never stored. */
  scanText?: string;
  /** Autonomy level observed at this event (1 supervised · 2 assisted · 3 autonomous). */
  autonomyLevel?: number;
  /** Explicit policy outcome carried by the source (e.g. a permission denial). */
  policy?: { outcome: 'blocked' | 'denied' | 'warned' | 'prompted' | 'approved'; label: string };
  /** Session working directory, when the source reports it outside `payload.cwd`. */
  cwd?: string;
}

export interface Collector {
  id: string;
  displayName: string;
  /** One raw payload can fan out to several normalized events. */
  normalize(raw: unknown): NormalizedEvent[];
}

export interface PollableCollector extends Collector {
  /** How often to call poll() in milliseconds. */
  pollIntervalMs: number;
  /** Fetch new events since the last poll. Must be idempotent — events with externalId are deduped by the DB. */
  poll(): Promise<NormalizedEvent[]>;
  /** When true after a poll, the registry polls again immediately (used for chunked backfills). */
  hasBacklog?(): boolean;
}

export function isPollable(c: Collector): c is PollableCollector {
  return 'poll' in c && typeof (c as unknown as PollableCollector).poll === 'function';
}
