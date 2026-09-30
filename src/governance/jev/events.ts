import { govBus } from '../events';
import type { JevShadowRecord } from './types';

/** Notifies live dashboards that a shadow record was stored. Never throws. */
export function emitShadow(r: JevShadowRecord): void {
  try {
    govBus.emit('jev.shadow', { id: r.id, kind: r.kind, sessionId: r.sessionId, decisionId: r.decisionId, agree: r.agree });
  } catch { /* listeners must not affect shadow persistence */ }
}
