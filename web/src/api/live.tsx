import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationDetail, LiveUpdate, TimelineItem } from './types';
import { applyApprovalUpdate, govKeys, type Approval, type Decision, type Incident, type RegisteredAgent } from './governance';
import { getAccessToken } from '../auth/token';

type Status = 'connecting' | 'live' | 'offline';

// Tiny external store of recently-updated conversation ids (drives row flash animations).
const flashListeners = new Set<() => void>();
let flashIds: ReadonlySet<string> = new Set();
function setFlash(next: ReadonlySet<string>) { flashIds = next; flashListeners.forEach(l => l()); }
export function useFlashIds(): ReadonlySet<string> {
  return useSyncExternalStore(cb => { flashListeners.add(cb); return () => flashListeners.delete(cb); }, () => flashIds, () => flashIds);
}

const StatusCtx = createContext<Status>('connecting');
export const useLiveStatus = () => useContext(StatusCtx);

export function applyLiveUpdate(detail: ConversationDetail, u: LiveUpdate): ConversationDetail {
  if (u.op === 'append') {
    if (detail.timeline.some(i => i.id === u.item.id && i.kind === u.item.kind)) return detail;
    return { ...detail, timeline: [...detail.timeline, u.item] };
  }
  let changed = false;
  const timeline = detail.timeline.map((i): TimelineItem => {
    if (i.kind !== 'tool' || i.id !== u.callId) return i;
    changed = true;
    return { ...i, resultId: u.resultId, status: u.status, durationMs: u.durationMs, error: u.error, findings: [...i.findings, ...u.findings] };
  });
  return changed ? { ...detail, timeline } : detail;
}

const LIST_KEYS = ['overview', 'agents', 'connections', 'conversations', 'enforcements'];

type GovMessage =
  | { type: 'gov.decision'; decision: Decision }
  | { type: 'gov.approval'; approval: Approval }
  | { type: 'gov.agent'; agent: RegisteredAgent }
  | { type: 'gov.lane'; lane: { id: string; version: number; status: string } }
  | { type: 'gov.incident'; incident: Incident };

/** Append a live decision to the per-session cache that drives conversation timeline badges. */
export function applyGovDecision(qc: QueryClient, d: Decision): void {
  qc.setQueryData<Decision[]>(govKeys.sessionDecisions(d.sessionId), list => (list && !list.some(x => x.id === d.id) ? [...list, d] : list));
}

/** Apply a gov.* WebSocket message to the query cache. Returns the gov query prefixes to refresh. */
export function handleGovMessage(qc: QueryClient, msg: GovMessage): string[] {
  switch (msg.type) {
    case 'gov.decision':
      if (msg.decision) applyGovDecision(qc, msg.decision);
      return ['overview', 'decisions'];
    case 'gov.approval':
      if (msg.approval) applyApprovalUpdate(qc, msg.approval);
      return ['overview'];
    case 'gov.agent':
      return ['agents', 'overview'];
    case 'gov.lane':
      if (msg.lane?.id) void qc.invalidateQueries({ queryKey: ['gov', 'lane', msg.lane.id] });
      return ['lanes', 'lane-versions'];
    case 'gov.incident':
      if (msg.incident?.id) qc.setQueryData(govKeys.incident(msg.incident.id), msg.incident);
      return ['incidents', 'overview'];
  }
  return [];
}

function handleMessage(qc: QueryClient, msg: { type?: string; sessionId?: string; sessionIds?: string[]; update?: LiveUpdate }, pending: Set<string>, schedule: () => void, govPending: Set<string>) {
  if (msg.type?.startsWith('gov.')) {
    for (const k of handleGovMessage(qc, msg as GovMessage)) govPending.add(k);
    schedule();
    return;
  }
  if (msg.type === 'timeline' && msg.sessionId && msg.update) {
    qc.setQueryData<ConversationDetail>(['conversation', msg.sessionId], d => (d ? applyLiveUpdate(d, msg.update!) : d));
    pending.add(msg.sessionId);
    schedule();
  } else if (msg.type === 'sessions.updated') {
    for (const id of msg.sessionIds ?? []) pending.add(id);
    schedule();
  }
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<Status>('connecting');
  const pending = useRef(new Set<string>());
  const govPending = useRef(new Set<string>());
  const listDirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    // Aggregate bursts of updates: refetch list queries at most every 2.5s.
    const schedule = () => {
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        const ids = new Set(pending.current);
        pending.current.clear();
        const gov = new Set(govPending.current);
        govPending.current.clear();
        if (listDirty.current) {
          listDirty.current = false;
          for (const k of LIST_KEYS) qc.invalidateQueries({ queryKey: [k] });
        }
        for (const k of gov) qc.invalidateQueries({ queryKey: ['gov', k] });
        if (ids.size) {
          setFlash(new Set([...flashIds, ...ids]));
          setTimeout(() => setFlash(new Set([...flashIds].filter(x => !ids.has(x)))), 1600);
        }
      }, 2500);
    };

    const connect = async () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      // Cloud mode: browsers can't set headers on WebSocket upgrades, so the bearer token travels as
      // the `token` query parameter (wss only in production). Local mode: no token.
      const token = await getAccessToken();
      if (closed) return;
      ws = new WebSocket(`${proto}://${location.host}/live${token ? `?token=${encodeURIComponent(token)}` : ''}`);
      ws.onopen = () => setStatus('live');
      ws.onmessage = ev => {
        try {
          const msg = JSON.parse(ev.data);
          if (!String(msg?.type ?? '').startsWith('gov.')) listDirty.current = true;
          handleMessage(qc, msg, pending.current, schedule, govPending.current);
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        setStatus('offline');
        if (!closed) retry = setTimeout(() => void connect(), 3000);
      };
      ws.onerror = () => ws?.close();
    };
    void connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (timer.current) clearTimeout(timer.current);
      ws?.close();
    };
  }, [qc]);

  return <StatusCtx.Provider value={status}>{children}</StatusCtx.Provider>;
}
