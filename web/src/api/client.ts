import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rangeBounds } from '../lib/range';
import { authFetch } from '../auth/token';
import type { AgentRow, Connections, Conversation, ConversationDetail, EnforcementRow, EventDetail, Overview, Settings, Source } from './types';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function queryString(params?: Record<string, string | undefined>): string {
  if (!params) return '';
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as [string, string][]).toString();
  return qs ? `?${qs}` : '';
}

/** Build an ApiError from a failed response, preferring the server's `{ error }` message. */
export async function errorFrom(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const body = await res.json() as { error?: unknown; message?: unknown };
    const m = typeof body?.error === 'string' ? body.error : typeof body?.message === 'string' ? body.message : null;
    if (m) message = m;
  } catch { /* non-JSON body */ }
  return new ApiError(res.status, message);
}

export async function api<T>(path: string, params?: Record<string, string | undefined>): Promise<T> {
  const res = await authFetch(`/api/${path}${queryString(params)}`);
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

/** JSON request with a body (POST/PATCH). Attaches the bearer token in cloud mode. */
export async function apiSend<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await authFetch(`/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function exportUrl(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '') as [string, string][]).toString();
  return `/api/${path}${qs ? `?${qs}` : ''}`;
}

const ranged = <T,>(path: string, rangeKey: string, extra?: Record<string, string | undefined>) =>
  () => api<T>(path, { ...rangeBounds(rangeKey), ...extra });

export const useOverview = (range: string) =>
  useQuery({ queryKey: ['overview', range], queryFn: ranged<Overview>('overview', range), placeholderData: keepPreviousData });

export const useAgents = (range: string) =>
  useQuery({ queryKey: ['agents', range], queryFn: ranged<AgentRow[]>('agents', range), placeholderData: keepPreviousData });

export const useConnections = (range: string) =>
  useQuery({ queryKey: ['connections', range], queryFn: ranged<Connections>('connections', range, { top: '30' }), placeholderData: keepPreviousData });

export const useConversations = (range: string) =>
  useQuery({ queryKey: ['conversations', range], queryFn: ranged<Conversation[]>('conversations', range), placeholderData: keepPreviousData });

export const useEnforcements = (range: string) =>
  useQuery({ queryKey: ['enforcements', range], queryFn: ranged<EnforcementRow[]>('enforcements', range), placeholderData: keepPreviousData });

export const useSources = (enabled = true) =>
  useQuery({ queryKey: ['sources'], queryFn: () => api<Source[]>('sources'), enabled, refetchInterval: enabled ? 5000 : false });

export const useConversation = (id: string | null) =>
  useQuery({ queryKey: ['conversation', id], queryFn: () => api<ConversationDetail>(`conversations/${encodeURIComponent(id!)}`), enabled: !!id, staleTime: 60_000 });

export const useEventDetail = (id: number | null, resultId?: number | null) =>
  useQuery({
    queryKey: ['event', id, resultId ?? null],
    queryFn: () => api<EventDetail>(`events/${id}`, { result: resultId ? String(resultId) : undefined }),
    enabled: id != null,
    staleTime: Infinity,
  });

export const useSettings = (enabled = true) =>
  useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('settings'), enabled, refetchInterval: enabled ? 5000 : false });
