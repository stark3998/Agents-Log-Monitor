import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, apiSend } from './client';

export type PostureSeverity = 'low' | 'medium' | 'high' | 'critical';
export type PostureLevel = 'endpoint' | 'fleet';
export type FindingState = 'open' | 'resolved' | 'suppressed';
export interface PostureCheck { id: string; title: string; description: string; severity: PostureSeverity; category: string; level: PostureLevel; platforms: string[]; confidence: 'confirmed' | 'heuristic'; note?: string; remediation: { summary: string; snippet?: string; snippetLang?: string; autoFix?: boolean; docsUrl?: string }; enabled: boolean; effectiveSeverity: PostureSeverity; scope?: { endpoints?: string[]; users?: string[] } }
export interface PostureConfig { checks: Record<string, { enabled?: boolean; severity?: string; scope?: { endpoints?: string[]; users?: string[] } }>; orgDomains: string[]; corporateSaasDomains?: string[]; alertMinSeverity: string; incidentOnCritical: boolean }
export interface PostureFinding { id: string; endpointId: string; hostname: string; checkId: string; level: PostureLevel; title: string; severity: PostureSeverity; category: string; subject: string; summary: string; evidence: Record<string, unknown>; fixable: boolean; state: FindingState; firstSeenAt: string; lastSeenAt: string; resolvedAt?: string; suppression?: { reason: string; by: string; at: string; until?: string }; incidentId?: string }
export interface PostureEndpointSummary { id: string; hostname: string; user: string; os: string; osRelease?: string; lastScanAt: string; scannerVersion?: string; source: 'local' | 'cli' | 'device'; findingCounts: Partial<Record<PostureSeverity, number>>; isLocal: boolean; agents: { id: string; name: string; version?: string }[]; mcpServerCount: number; extensionCount: number; errors?: string[] }
export interface PostureEndpoint extends PostureEndpointSummary { inventory: { agents: { id: string; name: string; kind: string; version?: string; installPath?: string; configPaths: string[]; accounts?: string[]; running?: boolean; elevated?: boolean }[]; mcpServers: { name: string; client: string; configPath: string; transport: string; command?: string; package?: string; url?: string; identities: string[]; categories: string[] }[]; extensions: { id: string; name?: string; version?: string; host: string; permissions?: string[]; publisher?: string }[]; scheduledTasks: { source: string; name: string; command: string; agentId?: string }[]; accounts: { agentId: string; account: string }[]; errors: string[] } }
export interface PostureChecksResponse { items: PostureCheck[]; config: PostureConfig }
export interface PostureSummary { open: number; endpoints: number; lastScanAt?: string; bySeverity: Partial<Record<PostureSeverity, number>>; byCategory: Record<string, number>; byCheck: Record<string, number> }
export type PostureFindingDetail = PostureFinding & { check?: PostureCheck };
export interface PostureScanResult { endpointId: string; open: number; new: number; reopened: number; resolved: number }
export interface PostureFixResult { ok: boolean; changedFiles: string[]; backups: string[]; message: string; finding: PostureFinding; scan: PostureScanResult }
export interface FindingFilters { state?: string; severity?: string; endpointId?: string; checkId?: string; level?: string }

export const postureKeys = {
  all: ['gov', 'posture'] as const,
  checks: ['gov', 'posture', 'checks'] as const,
  summary: ['gov', 'posture', 'summary'] as const,
  findings: (f?: FindingFilters) => ['gov', 'posture', 'findings', f ?? {}] as const,
  finding: (id: string) => ['gov', 'posture', 'finding', id] as const,
  endpoints: ['gov', 'posture', 'endpoints'] as const,
  endpoint: (id: string) => ['gov', 'posture', 'endpoint', id] as const,
};
const enc = encodeURIComponent;
const invalidate = (qc: QueryClient) => Promise.all([qc.invalidateQueries({ queryKey: postureKeys.summary }), qc.invalidateQueries({ queryKey: ['gov', 'posture', 'findings'] }), qc.invalidateQueries({ queryKey: postureKeys.endpoints }), qc.invalidateQueries({ queryKey: postureKeys.checks })]);

export const usePostureChecks = () => useQuery({ queryKey: postureKeys.checks, queryFn: () => api<PostureChecksResponse>('gov/posture/checks') });
export const usePostureSummary = () => useQuery({ queryKey: postureKeys.summary, queryFn: () => api<PostureSummary>('gov/posture/summary') });
export const usePostureFindings = (filters: FindingFilters) => useQuery({ queryKey: postureKeys.findings(filters), queryFn: () => api<PostureFinding[]>('gov/posture/findings', filters as Record<string, string | undefined>) });
export const usePostureFinding = (id: string | null) => useQuery({ queryKey: postureKeys.finding(id ?? ''), queryFn: () => api<PostureFindingDetail>(`gov/posture/findings/${enc(id!)}`), enabled: !!id });
export const usePostureEndpoints = () => useQuery({ queryKey: postureKeys.endpoints, queryFn: () => api<PostureEndpointSummary[]>('gov/posture/endpoints') });
export const usePostureEndpoint = (id: string | null) => useQuery({ queryKey: postureKeys.endpoint(id ?? ''), queryFn: () => api<PostureEndpoint>(`gov/posture/endpoints/${enc(id!)}`), enabled: !!id });

export function useSavePostureConfig() { const qc = useQueryClient(); return useMutation({ mutationFn: (config: PostureConfig) => apiSend<PostureConfig>('PUT', 'gov/posture/config', config), onSuccess: () => invalidate(qc) }); }
export function useScanPosture() { const qc = useQueryClient(); return useMutation({ mutationFn: () => apiSend<PostureScanResult>('POST', 'gov/posture/scan'), onSuccess: () => invalidate(qc) }); }
export function useSuppressFinding() { const qc = useQueryClient(); return useMutation({ mutationFn: ({ id, reason, until }: { id: string; reason: string; until?: string }) => apiSend<PostureFinding>(`POST`, `gov/posture/findings/${enc(id)}/suppress`, { reason, until }), onSuccess: f => { qc.setQueryData(postureKeys.finding(f.id), f); void invalidate(qc); } }); }
export function useUnsuppressFinding() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => apiSend<PostureFinding>('POST', `gov/posture/findings/${enc(id)}/unsuppress`), onSuccess: f => { qc.setQueryData(postureKeys.finding(f.id), f); void invalidate(qc); } }); }
export function useFixFinding() { const qc = useQueryClient(); return useMutation({ mutationFn: (id: string) => apiSend<PostureFixResult>('POST', `gov/posture/findings/${enc(id)}/fix`), onSuccess: r => { if (r.finding?.id) qc.setQueryData(postureKeys.finding(r.finding.id), r.finding); void invalidate(qc); } }); }
