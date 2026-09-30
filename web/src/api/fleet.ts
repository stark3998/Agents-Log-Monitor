/**
 * Monitoring-fleet API client (`/api/gov/fleet/*`): wire types mirrored from src/governance/types.ts
 * (FleetAlert) plus TanStack Query hooks. Alerts are raised by the Python fleet (fleet/) about Foundry /
 * Copilot Studio agents and model callers; the server broadcasts `gov.fleet.alerts` over the live socket.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, ApiError } from './client';
import { rangeBounds } from '../lib/range';

// ── Mirrored domain types ─────────────────────────────────────────────────

export type FleetSeverity = 'informational' | 'low' | 'medium' | 'high' | 'critical';

export const FLEET_SEVERITIES: FleetSeverity[] = ['critical', 'high', 'medium', 'low', 'informational'];

export interface FleetAlert {
  alert_id: string;
  alert_type: string;
  severity: FleetSeverity;
  score: number;
  title: string;
  summary: string;
  detector: string;
  platform: string;
  agent_id?: string | null;
  agent_name?: string | null;
  session_id?: string | null;
  user_id?: string | null;
  lane_id?: string | null;
  action?: string;
  owasp_llm?: string[];
  owasp_agentic?: string[];
  mitre_atlas?: string[];
  evidence?: Record<string, unknown>;
  source_event_ids?: string[];
  incident_id?: string | null;
  created_at: string;
  /** Set by the server on ingestion. */
  received_at?: string;
}

/** `GET /api/gov/fleet/summary` — counts over the window starting at `since`. */
export interface FleetSummary {
  since: string;
  total: number;
  bySeverity: Record<string, number>;
  byType: Record<string, number>;
  byPlatform: Record<string, number>;
  byAgent: Record<string, number>;
  byOwaspAgentic: Record<string, number>;
}

/** Query filters for `GET /api/gov/fleet/alerts` (list values are sent comma-separated). */
export interface FleetAlertFilters {
  severity?: FleetSeverity[];
  type?: string[];
  platform?: string[];
  /** Matches agent_name or agent_id. */
  agent?: string;
  session?: string;
  incident?: string;
  since?: string;
  limit?: number;
}

// ── Keys & fetchers ───────────────────────────────────────────────────────

export const fleetKeys = {
  all: ['gov', 'fleet'] as const,
  summary: (rangeKey: string) => ['gov', 'fleet', 'summary', rangeKey] as const,
  alerts: (f: FleetAlertFilters & { range?: string }) => ['gov', 'fleet', 'alerts', f] as const,
  alert: (id: string) => ['gov', 'fleet', 'alert', id] as const,
  session: (sessionId: string) => ['gov', 'fleet', 'session', sessionId] as const,
};

const enc = encodeURIComponent;
const list = (v?: string[]) => (v?.length ? v.join(',') : undefined);
/** 4xx (e.g. governance disabled, missing role) is final — don't retry. */
const noRetryOn4xx = (count: number, err: unknown) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1;

export function fleetAlertParams(f: FleetAlertFilters): Record<string, string | undefined> {
  return {
    severity: list(f.severity), type: list(f.type), platform: list(f.platform), agent: f.agent || undefined,
    session: f.session || undefined, incident: f.incident || undefined, since: f.since,
    limit: f.limit != null ? String(f.limit) : undefined,
  };
}

export const fetchFleetAlerts = (f: FleetAlertFilters) => api<FleetAlert[]>('gov/fleet/alerts', fleetAlertParams(f));
export const fetchFleetAlert = (id: string) => api<FleetAlert>(`gov/fleet/alerts/${enc(id)}`);
export const fetchFleetSummary = (since?: string) => api<FleetSummary>('gov/fleet/summary', { since });

// ── Queries ───────────────────────────────────────────────────────────────

/** Fleet alert counts for a time-range key (24h / 7d / 30d); `since` is resolved at fetch time. */
export const useFleetSummary = (rangeKey: string) =>
  useQuery({
    queryKey: fleetKeys.summary(rangeKey),
    queryFn: () => fetchFleetSummary(rangeBounds(rangeKey).from),
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

/**
 * Newest-first fleet alerts matching `f`. When `rangeKey` is given and `f.since` is not, the window
 * start is resolved at fetch time so live refetches use a fresh "now".
 */
export const useFleetAlerts = (f: FleetAlertFilters, rangeKey?: string, enabled = true) =>
  useQuery({
    queryKey: fleetKeys.alerts({ ...f, range: rangeKey }),
    queryFn: () => fetchFleetAlerts({ ...f, since: f.since ?? (rangeKey ? rangeBounds(rangeKey).from : undefined) }),
    placeholderData: keepPreviousData,
    enabled,
    retry: noRetryOn4xx,
  });

/** One alert by id. Pass `initial` (from a list) to render instantly without a request. */
export const useFleetAlert = (id: string | null, initial?: FleetAlert) =>
  useQuery({
    queryKey: fleetKeys.alert(id ?? ''),
    queryFn: () => fetchFleetAlert(id!),
    enabled: !!id && !initial,
    initialData: initial,
    retry: noRetryOn4xx,
  });

/** Every alert of one session, oldest first (session timeline). */
export const useSessionFleetAlerts = (sessionId: string | null) =>
  useQuery({
    queryKey: fleetKeys.session(sessionId ?? ''),
    queryFn: async () => {
      const rows = await fetchFleetAlerts({ session: sessionId!, limit: 2000 });
      return [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.alert_id.localeCompare(b.alert_id));
    },
    enabled: !!sessionId,
    retry: noRetryOn4xx,
  });
