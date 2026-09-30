// src/governance/jev/retention.ts
/**
 * Periodic retention sweep for Jev shadow records (`JEV_SHADOW_RETENTION_DAYS`, default 30).
 * Runs once shortly after start and then every ~24h on an unref'd timer so it never keeps the
 * process alive. Only started when shadow mode is enabled.
 */
import { govStore } from '../store';
import { jevConfig } from './config';

const DAY_MS = 24 * 3600_000;
let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;

/** Delete shadow records older than the retention window; returns the number removed (0 on error). */
export async function pruneJevShadowOnce(now = Date.now()): Promise<number> {
  const before = new Date(now - jevConfig.shadow.retentionDays * DAY_MS).toISOString();
  try {
    const n = await govStore().pruneJevShadow(before);
    if (n) console.log(`[jev] pruned ${n} shadow record(s) older than ${before}`);
    return n;
  } catch (err) {
    console.warn('[jev] shadow retention sweep failed:', err instanceof Error ? err.message : String(err));
    return 0;
  }
}

/** Start the daily retention sweep (no-op when shadow mode is disabled or already started). */
export function startJevShadowRetention(intervalMs = DAY_MS): void {
  if (!jevConfig.shadow.enabled || timer) return;
  firstTimer = setTimeout(() => { void pruneJevShadowOnce(); }, 60_000);
  firstTimer.unref?.();
  timer = setInterval(() => { void pruneJevShadowOnce(); }, intervalMs);
  timer.unref?.();
}

/** Stop the sweep (tests / graceful shutdown). */
export function stopJevShadowRetention(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}
