import { Collector, isPollable } from './types';
import { claudeCodeCollector } from './claude-code';
import { copilotCliHooksCollector } from './copilot-cli-hooks';
import { processNormalizedEvent } from '../pipeline';
import { maybeTruncateWal, optimizeDb, transaction } from '../db';

export interface CollectorStatus {
  id: string;
  displayName: string;
  kind: 'push' | 'poll';
  lastPollAt: string | null;
  lastError: string | null;
  backlog: boolean;
}

const collectors = new Map<string, Collector>();
const status = new Map<string, { lastPollAt: string | null; lastError: string | null; backlog: boolean }>();

export function register(c: Collector): void {
  collectors.set(c.id, c);
}

register(claudeCodeCollector);
register(copilotCliHooksCollector);

export function getCollector(id: string): Collector | undefined {
  return collectors.get(id);
}

export function listCollectors(): Collector[] {
  return [...collectors.values()];
}

export function collectorStatuses(): CollectorStatus[] {
  return listCollectors().map(c => ({
    id: c.id,
    displayName: c.displayName,
    kind: isPollable(c) ? 'poll' : 'push',
    lastPollAt: status.get(c.id)?.lastPollAt ?? null,
    lastError: status.get(c.id)?.lastError ?? null,
    backlog: status.get(c.id)?.backlog ?? false,
  }));
}

export function startPollers(): void {
  for (const collector of collectors.values()) {
    if (!isPollable(collector)) continue;
    let running = false;
    const run = async () => {
      if (running) return;
      running = true;
      const st = { lastPollAt: new Date().toISOString(), lastError: null as string | null, backlog: false };
      try {
        const events = await collector.poll().catch(err => {
          st.lastError = String(err?.message ?? err);
          console.error(`[${collector.id}] poll error:`, st.lastError);
          return [];
        });
        // Process in slices so a large backfill doesn't starve HTTP/WebSocket traffic.
        for (let i = 0; i < events.length; i += 400) {
          const slice = events.slice(i, i + 400);
          transaction(() => { for (const e of slice) processNormalizedEvent(e, collector.id); });
          maybeTruncateWal();
          if (i + 400 < events.length) await new Promise(r => setImmediate(r));
        }
        st.backlog = collector.hasBacklog?.() ?? false;
        if (events.length >= 1000 || (events.length && !st.backlog)) optimizeDb();
      } finally {
        status.set(collector.id, st);
        running = false;
      }
      // Drain chunked backfills quickly while still yielding to HTTP/WebSocket traffic.
      if (st.backlog) setTimeout(run, 50);
    };
    run();
    setInterval(run, collector.pollIntervalMs);
    console.log(`[poller] started ${collector.displayName} (interval: ${collector.pollIntervalMs}ms)`);
  }
}
