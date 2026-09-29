/**
 * Governance API client: wire types mirrored from src/governance/types.ts (keep in sync — see
 * docs/governance-api.md) plus TanStack Query hooks and mutations for /api/gov/*.
 */
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, apiSend, ApiError } from './client';
import { rangeBounds } from '../lib/range';

const rangeBoundsParams = (key: string): Record<string, string> => ({ ...rangeBounds(key) });

// ── Mirrored domain types ─────────────────────────────────────────────────

export type ToolCategory = 'READ' | 'WRITE' | 'EXEC' | 'NETWORK' | 'MCP' | 'AGENT' | 'OTHER';
export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export type Surface =
  | 'claude-code' | 'copilot-cli' | 'copilot-cloud-agent' | 'vscode' | 'mcp-gateway' | 'sdk'
  | 'foundry' | 'copilot-studio' | 'monitor' | 'unknown';

export type Checkpoint = 'goal' | 'pre_tool' | 'tool_result' | 'spawn' | 'response' | 'admin';
export type Verdict = 'allow' | 'deny' | 'ask' | 'escalate';
export type DecisionStage =
  | 'kill_switch' | 'limits' | 'rules_deny' | 'rules_allow' | 'default' | 'judge_fast' | 'judge_escalation'
  | 'human' | 'fail_mode' | 'cache' | 'not_governed';
export type LaneMode = 'observe' | 'enforce' | 'enforce+approval';

export interface JudgeVerdict {
  verdict: 'allow' | 'deny' | 'escalate';
  confidence: number;
  rationale: string;
  laneClause?: string;
  model: string;
  tier: 'fast' | 'escalation';
  latencyMs: number;
}

export interface Decision {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  laneId: string;
  laneVersion: number;
  mode: LaneMode;
  checkpoint: Checkpoint;
  toolName?: string;
  category?: ToolCategory;
  verdict: Verdict;
  effectiveVerdict: Verdict;
  wouldDeny: boolean;
  stage: DecisionStage;
  reason: string;
  ruleIds: string[];
  riskLevel?: RiskLevel | null;
  judge?: JudgeVerdict[];
  approvalId?: string;
  approver?: string;
  tainted: boolean;
  latencyMs: number;
  createdAt: string;
  seq?: number;
  prevHash?: string;
  hash?: string;
}

export interface LaneCondition {
  id?: string;
  category?: ToolCategory[];
  tool?: string[];
  mcpServer?: string[];
  risk?: string[];
  path?: string[];
  domain?: string[];
  command?: string[];
  detector?: string[];
  tainted?: boolean;
  description?: string;
}

export type FailMode = 'open' | 'closed';
export type DataPolicy = 'redacted' | 'full' | 'metadata-only';
export type ApprovalChannel = 'native' | 'dashboard' | 'teams';
export type AlertChannel = 'teams' | 'webhook' | 'email';
export type GovSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type GuardianAuthority = 'recommend' | 'contain' | 'autonomous';

export interface Lane {
  id: string;
  version: number;
  name?: string;
  appliesTo: { surfaces?: (Surface | '*')[]; agents?: string[]; repos?: string[]; users?: string[] };
  priority?: number;
  purpose: string;
  dos: string[];
  never: string[];
  rules: { deny?: LaneCondition[]; allow?: LaneCondition[]; judge?: LaneCondition[]; approve?: LaneCondition[] };
  defaultVerdict?: 'allow' | 'deny' | 'judge';
  mode: LaneMode;
  failMode: { default: FailMode } & Partial<Record<ToolCategory, FailMode>>;
  approval: { channels: ApprovalChannel[]; timeoutSec: number; approvers?: string[] };
  judge: { model?: string; escalateBelow: number; humanBelow?: number; dataPolicy: DataPolicy; timeoutMs?: number };
  limits?: {
    actionsPerMin?: number; maxSubagents?: number; maxDepth?: number; tokenBudget?: number; loopThreshold?: number; maxSessionMinutes?: number;
  };
  promptShields?: { enabled?: boolean; scan?: ToolCategory[]; taintTtlActions?: number };
  alerts?: Partial<Record<GovSeverity, AlertChannel[]>>;
  sync?: { dataPolicy: DataPolicy };
  guardian?: { authority: GuardianAuthority };
  meta?: { owner?: string; createdBy?: string; source?: 'file' | 'ui' | 'ai-draft'; notes?: string };
}

export type LaneStatus = 'active' | 'draft' | 'proposed' | 'archived';

export interface LaneRecord {
  lane: Lane;
  status: LaneStatus;
  updatedAt: string;
  updatedBy?: string;
  yaml?: string;
}

export type AgentStatus = 'active' | 'paused' | 'quarantined' | 'retired';

export interface RegisteredAgent {
  id: string;
  name: string;
  surface: Surface;
  externalId?: string;
  entraAgentId?: string;
  owner?: string;
  purpose?: string;
  laneId?: string;
  allowedTools?: string[];
  status: AgentStatus;
  statusReason?: string;
  discovered: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export type GovAgentRow = RegisteredAgent & { laneId: string; stats: { decisions: number; denies: number; lastSeenAt: string } };

export interface SessionIntent {
  sessionId: string;
  agentId: string;
  goal?: string;
  goalSource?: 'llm' | 'heuristic' | 'sdk';
  trajectory: string[];
  taint?: { reason: string; source: string; remainingActions: number; at: string } | null;
  status: 'active' | 'paused' | 'quarantined';
  counters: { actions: number; subagents: number; tokens: number };
  startedAt: string;
  updatedAt: string;
}

export type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface Approval {
  id: string;
  requestId: string;
  sessionId: string;
  agentId: string;
  laneId: string;
  toolName?: string;
  summary: string;
  reason: string;
  channels: ApprovalChannel[];
  state: ApprovalState;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolutionNote?: string;
}

export type IncidentState = 'open' | 'investigating' | 'contained' | 'resolved' | 'dismissed';

export interface IncidentRecommendation {
  action: string;
  target: string;
  rationale: string;
  status: 'proposed' | 'applied' | 'rejected';
}

export interface Incident {
  id: string;
  title: string;
  severity: GovSeverity;
  state: IncidentState;
  trigger: string;
  agentIds: string[];
  sessionIds: string[];
  decisionIds: string[];
  summary?: string;
  report?: string;
  recommendations?: IncidentRecommendation[];
  containment?: { action: string; target: string; at: string; by: string }[];
  createdAt: string;
  updatedAt: string;
}

export type Role = 'Viewer' | 'Approver' | 'PolicyAdmin' | 'Agent';

export interface Principal {
  id: string;
  name?: string;
  roles: Role[];
  kind: 'user' | 'agent' | 'device' | 'local';
  tenantId?: string;
}

// ── Endpoint payloads ─────────────────────────────────────────────────────

export interface GovOverview {
  decisions: { allow: number; deny: number; ask: number; escalate: number; wouldDeny: number };
  pendingApprovals: number;
  openIncidents: number;
  agents: { active: number; paused: number; quarantined: number };
  judge: { calls: number; p95Ms: number };
  trend: { t: string; allow: number; deny: number; wouldDeny: number }[];
}

export interface DecisionPage { items: Decision[]; cursor?: string | null }

export interface DecisionFilters {
  sessionId?: string;
  agentId?: string;
  laneId?: string;
  verdict?: Verdict | '';
  wouldDeny?: boolean;
  text?: string;
  since?: string;
  until?: string;
}

export interface GovConfig {
  mode: 'local' | 'cloud';
  judge?: { enabled: boolean; fast?: string; escalation?: string };
  shields?: { enabled: boolean };
  intelligence?: { enabled: boolean };
  auth: { mode: 'local' | 'cloud' | 'entra' | string; clientId?: string; tenantId?: string; audience?: string };
}

export interface LaneValidation { ok: boolean; errors: string[]; lane?: Lane }

export interface SimulationSample { eventId: string | number; sessionId: string; tool: string; summary: string; verdict: string; ruleIds: string[] }

export interface SimulationResult {
  evaluated: number;
  wouldAllow: number;
  wouldDeny: number;
  wouldJudge: number;
  wouldApprove: number;
  samples: SimulationSample[];
}

export interface LaneDraftResult { lane: LaneRecord; rationale?: string; simulation?: SimulationResult }

// ── Role helpers (mirror of src/governance/auth.ts roleClaims) ────────────

export function expandRoles(roles: readonly Role[] | undefined): Set<Role> {
  const out = new Set<Role>(roles ?? []);
  if (out.has('PolicyAdmin')) { out.add('Approver'); out.add('Viewer'); }
  if (out.has('Approver')) out.add('Viewer');
  return out;
}

export function principalHasRole(p: Principal | null | undefined, ...roles: Role[]): boolean {
  if (!p) return false;
  const set = expandRoles(p.roles);
  return roles.some(r => set.has(r));
}

// ── Query keys ────────────────────────────────────────────────────────────

export const govKeys = {
  all: ['gov'] as const,
  config: ['gov', 'config'] as const,
  me: ['gov', 'me'] as const,
  overview: (rangeKey: string) => ['gov', 'overview', rangeKey] as const,
  decisions: (f: DecisionFilters) => ['gov', 'decisions', f] as const,
  sessionDecisions: (sessionId: string) => ['gov', 'session-decisions', sessionId] as const,
  decision: (id: string) => ['gov', 'decision', id] as const,
  approvals: (state: string) => ['gov', 'approvals', state] as const,
  agents: ['gov', 'agents'] as const,
  lanes: (status?: string) => ['gov', 'lanes', status ?? 'all'] as const,
  lane: (id: string, version?: number) => ['gov', 'lane', id, version ?? 'current'] as const,
  laneVersions: (id: string) => ['gov', 'lane-versions', id] as const,
  incidents: (state?: string) => ['gov', 'incidents', state ?? 'all'] as const,
  incident: (id: string) => ['gov', 'incident', id] as const,
  intent: (sessionId: string) => ['gov', 'intent', sessionId] as const,
};

const enc = encodeURIComponent;
/** 404 on the governance API means "not governed / governance disabled" — don't retry. */
const noRetryOn4xx = (count: number, err: unknown) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1;

// ── Queries ───────────────────────────────────────────────────────────────

export const fetchGovConfig = () => api<GovConfig>('gov/config');
export const fetchMe = () => api<Principal>('gov/me');

export const useGovOverview = (rangeKey: string) =>
  useQuery({ queryKey: govKeys.overview(rangeKey), queryFn: () => api<GovOverview>('gov/overview', rangeBoundsParams(rangeKey)), placeholderData: keepPreviousData, retry: noRetryOn4xx });

function decisionParams(f: DecisionFilters, extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    sessionId: f.sessionId, agentId: f.agentId, laneId: f.laneId, verdict: f.verdict || undefined,
    wouldDeny: f.wouldDeny == null ? undefined : String(f.wouldDeny), text: f.text, since: f.since, until: f.until, ...extra,
  };
}

export const fetchDecisions = (f: DecisionFilters, limit = 100, cursor?: string) =>
  api<DecisionPage>('gov/decisions', decisionParams(f, { limit: String(limit), cursor }));

/** Cursor-paged decisions list (`{ items, cursor? }`). */
export const useDecisionsInfinite = (f: DecisionFilters, pageSize = 100) =>
  useInfiniteQuery({
    queryKey: govKeys.decisions(f),
    queryFn: ({ pageParam }) => fetchDecisions(f, pageSize, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.cursor ?? undefined,
    retry: noRetryOn4xx,
  });

export const useRecentDecisions = (f: DecisionFilters, limit = 10) =>
  useQuery({ queryKey: [...govKeys.decisions(f), 'recent', limit], queryFn: () => fetchDecisions(f, limit), retry: noRetryOn4xx });

export const useDecision = (id: string | null) =>
  useQuery({ queryKey: govKeys.decision(id ?? ''), queryFn: () => api<Decision>(`gov/decisions/${enc(id!)}`), enabled: !!id, staleTime: Infinity, retry: noRetryOn4xx });

/** All decisions for one session (drives timeline badges). Returns [] when governance is unavailable. */
export const useSessionDecisions = (sessionId: string | null) =>
  useQuery({
    queryKey: govKeys.sessionDecisions(sessionId ?? ''),
    queryFn: async () => {
      try {
        return (await fetchDecisions({ sessionId: sessionId! }, 1000)).items;
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) return [];
        throw e;
      }
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    retry: false,
  });

export const usePendingApprovals = (pollMs: number | false = 15_000) =>
  useQuery({ queryKey: govKeys.approvals('pending'), queryFn: () => api<Approval[]>('gov/approvals', { state: 'pending' }), refetchInterval: pollMs, retry: noRetryOn4xx });

export const useAllApprovals = (enabled: boolean) =>
  useQuery({ queryKey: govKeys.approvals('all'), queryFn: () => api<Approval[]>('gov/approvals'), enabled, retry: noRetryOn4xx });

export const useGovAgents = () =>
  useQuery({ queryKey: govKeys.agents, queryFn: () => api<GovAgentRow[]>('gov/agents'), retry: noRetryOn4xx });

export const useLanes = (status?: string) =>
  useQuery({ queryKey: govKeys.lanes(status), queryFn: () => api<LaneRecord[]>('gov/lanes', { status }), retry: noRetryOn4xx });

export const useLane = (id: string | null, version?: number) =>
  useQuery({
    queryKey: govKeys.lane(id ?? '', version),
    queryFn: () => api<LaneRecord>(`gov/lanes/${enc(id!)}`, { version: version != null ? String(version) : undefined }),
    enabled: !!id, retry: noRetryOn4xx,
  });

export const useLaneVersions = (id: string | null) =>
  useQuery({ queryKey: govKeys.laneVersions(id ?? ''), queryFn: () => api<LaneRecord[]>(`gov/lanes/${enc(id!)}/versions`), enabled: !!id, retry: noRetryOn4xx });

export const useIncidents = (state?: string) =>
  useQuery({ queryKey: govKeys.incidents(state), queryFn: () => api<Incident[]>('gov/incidents', { state }), retry: noRetryOn4xx });

export const useIncident = (id: string | null) =>
  useQuery({ queryKey: govKeys.incident(id ?? ''), queryFn: () => api<Incident>(`gov/incidents/${enc(id!)}`), enabled: !!id, retry: noRetryOn4xx });

export const useSessionIntent = (sessionId: string | null) =>
  useQuery({ queryKey: govKeys.intent(sessionId ?? ''), queryFn: () => api<SessionIntent>(`gov/sessions/${enc(sessionId!)}/intent`), enabled: !!sessionId, retry: false });

// ── Mutations ─────────────────────────────────────────────────────────────

const invalidate = (qc: QueryClient, ...keys: (readonly unknown[])[]) => Promise.all(keys.map(k => qc.invalidateQueries({ queryKey: k })));

/** Upsert an approval into cached lists (used by mutations and gov.approval WS messages). */
export function applyApprovalUpdate(qc: QueryClient, a: Approval): void {
  qc.setQueryData<Approval[]>(govKeys.approvals('pending'), list => {
    if (!list) return list;
    const rest = list.filter(x => x.id !== a.id);
    return a.state === 'pending' ? [...rest, a] : rest;
  });
  qc.setQueryData<Approval[]>(govKeys.approvals('all'), list => (list ? [...list.filter(x => x.id !== a.id), a] : list));
}

export function useResolveApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: 'approve' | 'deny'; note?: string }) =>
      apiSend<Approval>('POST', `gov/approvals/${enc(id)}/${action}`, note ? { note } : {}),
    onSuccess: a => { if (a?.id) applyApprovalUpdate(qc, a); void invalidate(qc, ['gov', 'overview']); },
  });
}

export type AgentAction = 'pause' | 'resume' | 'quarantine';

export function useAgentStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: AgentAction; reason: string }) =>
      apiSend<RegisteredAgent>('POST', `gov/agents/${enc(id)}/${action}`, { reason }),
    onSuccess: () => invalidate(qc, govKeys.agents, ['gov', 'overview']),
  });
}

export function usePatchAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Pick<RegisteredAgent, 'name' | 'owner' | 'purpose' | 'laneId'>> }) =>
      apiSend<RegisteredAgent>('PATCH', `gov/agents/${enc(id)}`, patch),
    onSuccess: () => invalidate(qc, govKeys.agents),
  });
}

export function useSessionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, action, reason }: { sessionId: string; action: AgentAction; reason?: string }) =>
      apiSend<SessionIntent>('POST', `gov/sessions/${enc(sessionId)}/${action}`, reason ? { reason } : {}),
    onSuccess: (intent, v) => { qc.setQueryData(govKeys.intent(v.sessionId), intent); },
  });
}

export const validateLaneYaml = (yaml: string) => apiSend<LaneValidation>('POST', 'gov/lanes/validate', { yaml });

export const simulateLane = (body: { yaml: string; from?: string; to?: string; agentId?: string; limit?: number }) =>
  apiSend<SimulationResult>('POST', 'gov/lanes/simulate', body);

export function useSaveLane() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { yaml: string; status: 'draft' | 'proposed' | 'active' }) => apiSend<LaneRecord>('POST', 'gov/lanes', body),
    onSuccess: rec => invalidate(qc, ['gov', 'lanes'], govKeys.laneVersions(rec.lane.id), ['gov', 'lane', rec.lane.id]),
  });
}

export function useLaneVersionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version, action }: { id: string; version: number; action: 'activate' | 'archive' }) =>
      apiSend<LaneRecord>('POST', `gov/lanes/${enc(id)}/versions/${version}/${action}`),
    onSuccess: (_r, v) => invalidate(qc, ['gov', 'lanes'], govKeys.laneVersions(v.id), ['gov', 'lane', v.id]),
  });
}

export const draftLane = (body: { agentId: string; description?: string; systemPrompt?: string }) =>
  apiSend<LaneDraftResult>('POST', 'gov/intelligence/lanes/draft', body);

export function usePatchIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Incident> }) => apiSend<Incident>('PATCH', `gov/incidents/${enc(id)}`, patch),
    onSuccess: inc => { qc.setQueryData(govKeys.incident(inc.id), inc); void invalidate(qc, ['gov', 'incidents']); },
  });
}

export function useInvestigate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { incidentId: string } | { trigger: string; agentIds?: string[]; sessionIds?: string[]; decisionIds?: string[] }) =>
      apiSend<Incident>('POST', 'gov/intelligence/investigate', body),
    onSuccess: inc => { if (inc?.id) qc.setQueryData(govKeys.incident(inc.id), inc); void invalidate(qc, ['gov', 'incidents']); },
  });
}

/** Human-friendly message for mutation errors (403 → role hint, 503 → service not configured). */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return `You don't have permission for this action (${e.message}).`;
    if (e.status === 503) return 'The intelligence service is not configured on this server.';
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
