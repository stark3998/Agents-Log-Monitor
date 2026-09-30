// src/governance/jev/summary.ts
/**
 * Builds the `JevShadowSummary` served by `GET /api/gov/jev/summary` and the `jev_shadow_summary`
 * MCP tool: pages shadow records for the window out of the store (bounded) and aggregates them.
 */
import type { GovernanceStore } from '../store/repository';
import { jevConfig } from './config';
import { shadowQueueStats } from './runtime';
import { summarizeShadow } from './stats';
import type { JevShadowKind, JevShadowRecord, JevShadowSummary } from './types';

/** Hard cap on records aggregated per summary request (bounded memory / RU). */
export const JEV_SUMMARY_MAX_RECORDS = 20_000;
const PAGE_SIZE = 1000;

export interface JevSummaryOptions {
  since?: string;
  until?: string;
  kind?: JevShadowKind[];
  /** Override the record cap (tests); clamped to JEV_SUMMARY_MAX_RECORDS. */
  maxRecords?: number;
}

/** Load up to `maxRecords` newest shadow records in the window. `truncated` is true when more exist. */
export async function loadShadowRecords(store: GovernanceStore, opts: JevSummaryOptions): Promise<{ records: JevShadowRecord[]; truncated: boolean }> {
  const max = Math.min(Math.max(opts.maxRecords ?? JEV_SUMMARY_MAX_RECORDS, 1), JEV_SUMMARY_MAX_RECORDS);
  const records: JevShadowRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.queryJevShadow({
      kind: opts.kind, since: opts.since, until: opts.until, limit: Math.min(PAGE_SIZE, max - records.length), cursor,
    });
    records.push(...page.items);
    cursor = page.cursor;
  } while (cursor && records.length < max);
  return { records, truncated: !!cursor };
}

/** Aggregate the shadow window into a `JevShadowSummary` (plus a `truncated` hint when capped). */
export async function buildShadowSummary(store: GovernanceStore, opts: JevSummaryOptions = {}): Promise<JevShadowSummary & { truncated: boolean }> {
  const { records, truncated } = await loadShadowRecords(store, opts);
  const q = shadowQueueStats();
  return {
    enabled: jevConfig.shadow.enabled,
    model: jevConfig.model,
    since: opts.since,
    until: opts.until,
    kinds: summarizeShadow(records, { since: opts.since, until: opts.until }),
    queue: { enqueued: q.enqueued, completed: q.completed, failed: q.failed, dropped: q.dropped, inFlight: q.inFlight, queued: q.queued },
    truncated,
  };
}
