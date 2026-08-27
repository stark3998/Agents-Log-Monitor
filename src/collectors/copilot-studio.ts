import { DefaultAzureCredential } from '@azure/identity';
import { PollableCollector, NormalizedEvent } from './types';
import { config } from '../config';
import { getPollerState, setPollerState } from '../store';

// ── Wire types ──────────────────────────────────────────────────────────────

interface ConversationTranscript {
  conversationtranscriptid: string;
  name: string;
  createdon: string;
  conversationstarttime: string;
  content: string;
  metadata: string;
}

interface BotFrameworkActivity {
  ID: string;
  type: string;
  timestamp?: number;
  valueType?: string;
  from?: { id: string; role?: number };
  text?: string;
  value?: Record<string, unknown>;
}

interface TranscriptMeta {
  BatchId?: number;
  BotId?: string;
  BotName?: string;
}

// ── Collector ───────────────────────────────────────────────────────────────

class CopilotStudioCollector implements PollableCollector {
  readonly id = 'copilot-studio';
  readonly displayName = 'Copilot Studio';
  readonly pollIntervalMs = config.copilotStudio.pollIntervalMs;

  private readonly cred = new DefaultAzureCredential();

  normalize(_raw: unknown): NormalizedEvent[] {
    return [];
  }

  private async token(): Promise<string> {
    const orgUrl = config.copilotStudio.orgUrl.replace(/\/$/, '');
    const t = await this.cred.getToken(`${orgUrl}/.default`);
    return t.token;
  }

  async poll(): Promise<NormalizedEvent[]> {
    const tok    = await this.token();
    const orgUrl = config.copilotStudio.orgUrl.replace(/\/$/, '');

    // Default: look back 25 hours on first run to catch transcripts written after their 30-min delay
    const defaultStart = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const lastPolled   = getPollerState(this.id, 'last_polled_time', defaultStart);

    const filterParts = [`createdon gt ${lastPolled}`];
    if (config.copilotStudio.botId) {
      filterParts.push(`_bot_conversationtranscriptid_value eq ${config.copilotStudio.botId}`);
    }

    const baseParams = new URLSearchParams({
      '$filter': filterParts.join(' and '),
      '$orderby': 'createdon asc',
      '$select': 'conversationtranscriptid,name,createdon,conversationstarttime,content,metadata',
      '$top': '100',
    });

    let url: string | null = `${orgUrl}/api/data/v9.2/conversationtranscripts?${baseParams}`;
    const allRecords: ConversationTranscript[] = [];

    while (url) {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${tok}`,
          'OData-MaxVersion': '4.0',
          'OData-Version': '4.0',
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Dataverse ${res.status}: ${body}`);
      }
      const data = await res.json() as { value: ConversationTranscript[]; '@odata.nextLink'?: string };
      allRecords.push(...data.value);
      url = data['@odata.nextLink'] ?? null;
    }

    if (!allRecords.length) return [];

    // Advance cursor before processing so a partial failure doesn't replay everything
    setPollerState(this.id, 'last_polled_time', allRecords[allRecords.length - 1].createdon);

    // Group split transcripts: same name + conversationstarttime = same conversation
    const grouped = new Map<string, ConversationTranscript[]>();
    for (const r of allRecords) {
      const key = `${r.name}__${r.conversationstarttime}`;
      const arr = grouped.get(key) ?? [];
      arr.push(r);
      grouped.set(key, arr);
    }

    const events: NormalizedEvent[] = [];

    for (const records of grouped.values()) {
      // Sort by BatchId so merged content is in order
      records.sort((a, b) => {
        try {
          const ma = JSON.parse(a.metadata) as TranscriptMeta;
          const mb = JSON.parse(b.metadata) as TranscriptMeta;
          return (ma.BatchId ?? 0) - (mb.BatchId ?? 0);
        } catch { return 0; }
      });

      const primary   = records[0];
      const sessionId = primary.conversationtranscriptid;
      const startTime = safeIso(primary.conversationstarttime);

      // Merge content arrays from all batch records
      const activities: BotFrameworkActivity[] = [];
      for (const r of records) {
        try {
          const parsed = JSON.parse(r.content);
          if (Array.isArray(parsed)) activities.push(...parsed);
        } catch { /* skip malformed batch */ }
      }

      const convEvents: NormalizedEvent[] = [];

      for (const act of activities) {
        const time = act.timestamp ? new Date(act.timestamp * 1000).toISOString() : startTime;

        if (act.valueType === 'SessionInfo') {
          const endEpoch = (act.value as any)?.EndTime as number | undefined;
          if (endEpoch) {
            convEvents.push({
              sessionId,
              agentId: 'main',
              eventType: 'lifecycle',
              rawEventName: 'SessionEnd',
              externalId: `cs:${sessionId}:session_end`,
              status: String((act.value as any)?.Outcome) === 'Escalated' ? 'error' : 'success',
              payload: act,
              occurredAt: new Date(endEpoch * 1000).toISOString(),
            });
          }
          continue;
        }

        if (act.valueType === 'IntentRecognition') {
          convEvents.push({
            sessionId,
            agentId: 'main',
            eventType: 'lifecycle',
            rawEventName: 'TopicTriggered',
            externalId: `cs:${sessionId}:intent:${act.ID}`,
            payload: act,
            occurredAt: time,
          });
          continue;
        }

        if (act.type === 'message' && act.text) {
          const isUser = act.from?.role === 1;
          convEvents.push({
            sessionId,
            agentId: 'main',
            eventType: isUser ? 'prompt' : 'assistant_text',
            rawEventName: isUser ? 'UserMessage' : 'BotMessage',
            externalId: `cs:${sessionId}:msg:${act.ID}`,
            payload: act,
            occurredAt: time,
          });
        }
      }

      // Prepend a session start lifecycle event so the session row is created first
      convEvents.unshift({
        sessionId,
        agentId: 'main',
        eventType: 'lifecycle',
        rawEventName: 'SessionStart',
        externalId: `cs:${sessionId}:session_start`,
        payload: { name: primary.name, metadata: safeParse(primary.metadata) },
        occurredAt: startTime,
      });

      events.push(...convEvents);
    }

    return events;
  }
}

function safeIso(value: string): string {
  try { return new Date(value).toISOString(); } catch { return new Date().toISOString(); }
}

function safeParse(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}

export const copilotStudioCollector = new CopilotStudioCollector();
