// src/governance/jev/runtime.ts
/**
 * Process-wide Jev shadow runtime singletons. The shadow runner (jev/shadow.ts) enqueues work on
 * `shadowQueue`; the admin API / MCP read its counters via `shadowQueueStats()` without importing
 * the runner (keeps read paths free of the Jev client dependency).
 */
import { jevConfig } from './config';
import { ShadowQueue, type ShadowQueueStats } from './queue';

export const shadowQueue = new ShadowQueue({
  maxConcurrency: jevConfig.shadow.maxConcurrency,
  maxQueue: jevConfig.shadow.maxQueue,
  onError: err => console.warn('[jev] shadow task failed:', err instanceof Error ? err.message : String(err)),
});

/** Runtime counters of the shadow queue since process start. */
export function shadowQueueStats(): ShadowQueueStats {
  return shadowQueue.stats();
}
