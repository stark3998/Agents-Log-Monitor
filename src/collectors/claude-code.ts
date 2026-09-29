import { Collector, NormalizedEvent } from './types';

// Raw shape Claude Code hooks POST to /ingest/claude-code
interface ClaudeCodePayload {
  hook_event_name?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  parent_agent_id?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  tool_result?: unknown;
  error?: string;
  cwd?: string;
  model?: string;
  transcript_path?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
  [key: string]: unknown;
}

function eventType(name: string): NormalizedEvent['eventType'] {
  const n = name.toLowerCase();
  if (n === 'pretooluse') return 'tool_call';
  if (n === 'posttooluse') return 'tool_result';
  if (n === 'userpromptsubmit') return 'prompt';
  if (n === 'notification') return 'notification';
  if (n === 'subagentstart' || n === 'subagentstoр') return 'lifecycle';
  return 'lifecycle';
}

function toolStatus(p: ClaudeCodePayload, name: string): NormalizedEvent['status'] | undefined {
  const n = name.toLowerCase();
  if (n === 'pretooluse') return 'pending';
  if (n === 'posttooluse') return p.error ? 'error' : 'success';
  return undefined;
}

export const claudeCodeCollector: Collector = {
  id: 'claude-code',
  displayName: 'Claude Code',

  normalize(raw: unknown): NormalizedEvent[] {
    const p = raw as ClaudeCodePayload;
    const rawEventName = p.hook_event_name ?? 'unknown';
    const sessionId = p.session_id ?? 'unknown-session';
    const agentId = p.agent_id ?? 'main';
    const now = new Date().toISOString();

    return [
      {
        sessionId,
        agentId,
        parentAgentId:        p.parent_agent_id,
        agentType:            p.agent_type,
        eventType:            eventType(rawEventName),
        rawEventName,
        toolName:             p.tool_name,
        toolUseId:            p.tool_use_id,
        transcriptPath:       p.transcript_path,
        status:               toolStatus(p, rawEventName),
        inputTokens:          p.usage?.input_tokens,
        outputTokens:         p.usage?.output_tokens,
        cacheReadInputTokens: p.usage?.cache_read_input_tokens,
        errorText:            p.error,
        model:                p.model,
        payload:              raw,
        occurredAt:           now,
        captureChannel:       'hook',
      },
    ];
  },
};
