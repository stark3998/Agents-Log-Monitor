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
}

export function isPollable(c: Collector): c is PollableCollector {
  return 'poll' in c && typeof (c as unknown as PollableCollector).poll === 'function';
}
