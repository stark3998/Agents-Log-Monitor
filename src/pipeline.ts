import { NormalizedEvent } from './collectors/types';
import { upsertSession, upsertAgent, insertEvent } from './store';
import { broadcast } from './broadcast';

export function processNormalizedEvent(e: NormalizedEvent, collectorId: string): void {
  try {
    upsertSession(e, collectorId);
    upsertAgent(e);
    const id = insertEvent(e);
    if (id) broadcast({ ...e, id });
  } catch (err) {
    console.error(`[pipeline] store error for ${collectorId}:`, err);
  }
}
