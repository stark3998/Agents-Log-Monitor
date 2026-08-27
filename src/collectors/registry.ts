import { Collector, isPollable } from './types';
import { claudeCodeCollector } from './claude-code';
import { processNormalizedEvent } from '../pipeline';

const collectors = new Map<string, Collector>();

export function register(c: Collector): void {
  collectors.set(c.id, c);
}

register(claudeCodeCollector);

export function getCollector(id: string): Collector | undefined {
  return collectors.get(id);
}

export function listCollectors(): Collector[] {
  return [...collectors.values()];
}

export function startPollers(): void {
  for (const collector of collectors.values()) {
    if (!isPollable(collector)) continue;
    const run = async () => {
      const events = await collector.poll().catch(err => {
        console.error(`[${collector.id}] poll error:`, err.message);
        return [];
      });
      for (const e of events) processNormalizedEvent(e, collector.id);
    };
    run();
    setInterval(run, collector.pollIntervalMs);
    console.log(`[poller] started ${collector.displayName} (interval: ${collector.pollIntervalMs}ms)`);
  }
}
