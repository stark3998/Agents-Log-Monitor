import { DefaultAzureCredential } from '@azure/identity';
import { PollableCollector, NormalizedEvent } from './types';
import { config } from '../config';
import { getPollerState, setPollerState } from '../store';

// Foundry project endpoints (https://<account>.services.ai.azure.com/api/projects/<project>) accept tokens for the
// ai.azure.com audience and serve the Agent Service (classic threads/runs/steps) at the project root with api-version=v1.
// The older cognitiveservices audience and /agents/v1 prefix are rejected (401/400) by current project endpoints.
const ENTRA_SCOPE = 'https://ai.azure.com/.default';
const API_VERSION = 'v1';

// ── Wire types ──────────────────────────────────────────────────────────────

interface FoundryThread {
  id: string;
  created_at: number;
  object: string;
}

interface FoundryRun {
  id: string;
  thread_id: string;
  status: string;       // queued | in_progress | completed | failed | cancelled | expired
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  failed_at: number | null;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  last_error?: { code: string; message: string };
}

interface FoundryRunStep {
  id: string;
  run_id: string;
  thread_id: string;
  type: 'message_creation' | 'tool_calls';
  status: string;
  created_at: number;
  completed_at: number | null;
  failed_at: number | null;
  last_error?: { code: string; message: string };
  step_details: {
    type: 'message_creation' | 'tool_calls';
    message_creation?: { message_id: string };
    tool_calls?: Array<{
      id: string;
      type: string;
      function?: { name: string; arguments: string; output: string | null };
    }>;
  };
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface ListResponse<T> {
  data: T[];
  has_more: boolean;
  last_id: string | null;
  first_id: string | null;
}

// ── Collector ───────────────────────────────────────────────────────────────

class FoundryCollector implements PollableCollector {
  readonly id = 'foundry';
  readonly displayName = 'Azure AI Foundry';
  readonly pollIntervalMs = config.foundry.pollIntervalMs;

  private readonly cred = new DefaultAzureCredential();
  // Tracks run IDs already processed this process lifetime (memory cache on top of DB dedup)
  private readonly processedRuns = new Set<string>();

  normalize(_raw: unknown): NormalizedEvent[] {
    return [];
  }

  private async token(): Promise<string> {
    const t = await this.cred.getToken(ENTRA_SCOPE);
    return t.token;
  }

  private async fetchJson<T>(url: string, tok: string): Promise<T> {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}api-version=${API_VERSION}`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Foundry ${res.status} ${url}: ${body}`);
    }
    return res.json() as Promise<T>;
  }

  async poll(): Promise<NormalizedEvent[]> {
    const tok  = await this.token();
    const base = config.foundry.endpoint.replace(/\/$/, '');
    const events: NormalizedEvent[] = [];

    // Load last-seen thread cursor from DB to handle restarts
    const lastCursor = getPollerState(this.id, 'thread_cursor', '');

    let threadsUrl: string | null = `${base}/threads?limit=100&order=desc`;
    const newThreadIds: string[] = [];

    // Paginate threads; stop when we hit the last-seen cursor
    outerThreads: while (threadsUrl) {
      const resp: ListResponse<FoundryThread> = await this.fetchJson<ListResponse<FoundryThread>>(threadsUrl, tok);
      for (const thread of resp.data) {
        if (lastCursor && thread.id === lastCursor) break outerThreads;
        newThreadIds.push(thread.id);
      }
      threadsUrl = resp.has_more && resp.last_id
        ? `${base}/threads?limit=100&order=desc&after=${resp.last_id}`
        : null;
    }

    if (newThreadIds.length && newThreadIds[0]) {
      setPollerState(this.id, 'thread_cursor', newThreadIds[0]);
    }

    for (const threadId of newThreadIds) {
      const runsResp = await this.fetchJson<ListResponse<FoundryRun>>(
        `${base}/threads/${threadId}/runs?limit=100&order=desc`, tok,
      );

      for (const run of runsResp.data) {
        if (this.processedRuns.has(run.id)) continue;
        // Only process terminal runs (steps are only fully available once done)
        if (run.status !== 'completed' && run.status !== 'failed') continue;

        const runEvents = await this.eventsForRun(base, tok, run);
        events.push(...runEvents);
        this.processedRuns.add(run.id);
      }
    }

    return events;
  }

  private async eventsForRun(base: string, tok: string, run: FoundryRun): Promise<NormalizedEvent[]> {
    const events: NormalizedEvent[] = [];
    const sessionId  = run.thread_id;
    const occurredAt = new Date(run.created_at * 1000).toISOString();

    // Run lifecycle event
    events.push({
      sessionId,
      agentId: 'main',
      eventType: 'lifecycle',
      rawEventName: run.status === 'completed' ? 'RunCompleted' : 'RunFailed',
      externalId: `foundry:run:${run.id}`,
      status: run.status === 'completed' ? 'success' : 'error',
      errorText: run.last_error?.message,
      model: run.model,
      inputTokens: run.usage?.prompt_tokens,
      outputTokens: run.usage?.completion_tokens,
      payload: run,
      occurredAt,
    });

    // Run steps
    const stepsResp = await this.fetchJson<ListResponse<FoundryRunStep>>(
      `${base}/threads/${run.thread_id}/runs/${run.id}/steps?limit=100&order=asc`, tok,
    );

    for (const step of stepsResp.data) {
      const stepTime = new Date(step.created_at * 1000).toISOString();
      const doneAt   = step.completed_at ?? step.failed_at;
      const durationMs = doneAt ? Math.round((doneAt - step.created_at) * 1000) : undefined;
      const stepStatus = step.status === 'completed' ? 'success' : 'error' as const;

      if (step.type === 'tool_calls' && step.step_details.tool_calls) {
        for (const tc of step.step_details.tool_calls) {
          const toolName = tc.function?.name ?? tc.type;
          events.push({
            sessionId,
            agentId: 'main',
            eventType: 'tool_call',
            rawEventName: 'RunStepToolCall',
            toolName,
            toolUseId: `${step.id}:${tc.id}`,
            externalId: `foundry:step:${step.id}:${tc.id}`,
            status: stepStatus,
            durationMs,
            errorText: step.last_error?.message,
            inputTokens: step.usage?.prompt_tokens,
            outputTokens: step.usage?.completion_tokens,
            payload: tc,
            occurredAt: stepTime,
          });
        }
      } else if (step.type === 'message_creation') {
        events.push({
          sessionId,
          agentId: 'main',
          eventType: 'assistant_text',
          rawEventName: 'RunStepMessage',
          externalId: `foundry:step:${step.id}`,
          status: stepStatus,
          durationMs,
          payload: step.step_details,
          occurredAt: stepTime,
        });
      }
    }

    return events;
  }
}

export const foundryCollector = new FoundryCollector();
