import { EventEmitter } from 'events';
import type { Approval, Decision, Incident, LaneRecord, RegisteredAgent, SessionIntent } from './types';

/**
 * In-process governance event bus. Producers (PDP, approvals, registry, lanes) emit; consumers
 * (WebSocket broadcast, alerts, Guardian triggers, sync outbox) subscribe. Keeps modules decoupled.
 */
export interface GovEvents {
  'decision': (d: Decision) => void;
  'approval.requested': (a: Approval) => void;
  'approval.resolved': (a: Approval) => void;
  'agent.updated': (a: RegisteredAgent) => void;
  'lane.updated': (l: LaneRecord) => void;
  'session.updated': (s: SessionIntent) => void;
  'incident.created': (i: Incident) => void;
  'incident.updated': (i: Incident) => void;
}

class TypedBus extends EventEmitter {
  override emit<K extends keyof GovEvents>(event: K, ...args: Parameters<GovEvents[K]>): boolean {
    return super.emit(event, ...args);
  }
  override on<K extends keyof GovEvents>(event: K, listener: GovEvents[K]): this {
    return super.on(event, listener as (...a: unknown[]) => void);
  }
  override off<K extends keyof GovEvents>(event: K, listener: GovEvents[K]): this {
    return super.off(event, listener as (...a: unknown[]) => void);
  }
}

export const govBus = new TypedBus();
govBus.setMaxListeners(50);
