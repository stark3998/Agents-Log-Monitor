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
  /** Provider that produced the verdict (defaults to foundry when absent). */
  provider?: 'foundry' | 'jev';
  /** Token usage reported by the provider (used for cost comparison). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Raw structured signals (Jev question ids → probability / score / label). */
  signals?: Record<string, number | string>;
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
  /** Governance simulation mode was on: forced to observe (see wouldDeny / effectiveVerdict). */
  simulated?: boolean;
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
  filesystem?: string[]; network?: string[]; credential?: string[]; capability?: string[]; mcpCategory?: string[]; classifier?: string[]; operation?: ('read' | 'write' | 'delete' | 'execute')[];
  policyId?: string; policyVersion?: number; modeOverride?: 'observe' | 'enforce';
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
  policies?: string[];
  rules: { deny?: LaneCondition[]; allow?: LaneCondition[]; judge?: LaneCondition[]; approve?: LaneCondition[]; alert?: LaneCondition[] };
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
  meta?: { owner?: string; createdBy?: string; source?: 'file' | 'ui' | 'ai-draft'; notes?: string; appliedPolicies?: { id: string; version: number; global: boolean }[] };
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
  /** Extra context when the incident was raised by the monitoring fleet (alert ids, OWASP/ATLAS mapping…). */
  fleet?: Record<string, unknown>;
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
  wouldAlert?: number;
  ruleHits?: Record<string, number>;
  samples: SimulationSample[];
}

export interface LaneDraftResult { lane: LaneRecord; rationale?: string; simulation?: SimulationResult }

// ── TypeSafe Jev shadow mode (mirrored from src/governance/jev/types.ts) ──────

/** Kinds posted by the Python AgentMon Fleet (enterprise monitoring of Foundry / Copilot Studio agents). */
export type JevFleetShadowKind =
  | 'fleet_realtime' | 'fleet_intent' | 'fleet_alignment' | 'fleet_evasion' | 'fleet_injection' | 'fleet_code';

/** Which decision point a shadow record compares. */
export type JevShadowKind = 'judge' | 'injection' | 'guardian_triage' | 'session_score' | JevFleetShadowKind;

/** Raw Jev signals keyed by question id (Noul probability, Score expectation or Choice label). */
export type JevSignals = Record<string, number | string>;

/** The authoritative (non-Jev) outcome the shadow is compared against. */
export interface JevShadowBaseline {
  provider: 'foundry' | 'rules' | 'prompt-shields' | 'guardian' | 'heuristic' | 'none';
  model?: string;
  verdict?: string;
  score?: number;
  confidence?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  stage?: string;
}

/** Jev's shadow answer (never authoritative). */
export interface JevShadowOutcome {
  model: string;
  verdict?: string;
  score?: number;
  confidence?: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  policy?: string;
  rationale?: string;
  laneClause?: string;
  signals: JevSignals;
  /** Set when the Jev call failed; verdict/score are then undefined. */
  error?: string;
}

export interface JevShadowRecord {
  id: string;
  kind: JevShadowKind;
  decisionId?: string;
  requestId?: string;
  sessionId?: string;
  agentId?: string;
  laneId?: string;
  checkpoint?: string;
  toolName?: string;
  baseline: JevShadowBaseline;
  jev: JevShadowOutcome;
  /** Jev and baseline reached the same categorical outcome (undefined when not comparable). */
  agree?: boolean;
  createdAt: string;
}

export interface JevShadowPage { items: JevShadowRecord[]; cursor?: string | null }

export interface LatencyStats { count: number; p50: number; p95: number; p99: number; mean: number }

/** Per-kind comparison summary returned by `GET /api/gov/jev/summary`. */
export interface JevKindSummary {
  kind: JevShadowKind;
  total: number;
  compared: number;
  agreed: number;
  agreementRate: number;
  jevErrors: number;
  /** confusion[baselineVerdict][jevVerdict] = count. */
  confusion: Record<string, Record<string, number>>;
  jevStricter: number;
  jevLooser: number;
  latency: { jev: LatencyStats; baseline: LatencyStats };
  tokens: { jevInput: number; baselineInput: number; baselineOutput: number };
  estCostUsd: { jev: number; baseline?: number };
  baselineModels: string[];
  jevModels: string[];
}

export interface JevShadowSummary {
  enabled: boolean;
  model: string;
  since?: string;
  until?: string;
  kinds: JevKindSummary[];
  queue: { enqueued: number; completed: number; failed: number; dropped: number; inFlight: number; queued: number };
}

export interface JevShadowFilters {
  kind?: JevShadowKind;
  sessionId?: string;
  laneId?: string;
  agree?: boolean;
  since?: string;
  until?: string;
}

// ── Jev offline benchmarks (mirrored from src/governance/jev/benchmarks.ts) ──

export type BenchmarkDataset = 'judge' | 'injection' | 'triage';

export interface BenchmarkVariant {
  variant: string;
  provider: string;
  models: string[];
  total: number;
  n: number;
  errors: number;
  accuracy: number;
  macroF1: number;
  positiveRecall: number;
  positivePrecision: number;
  falseAllowRate: number;
  escalationRate: number;
  perClass: Record<string, { precision: number; recall: number; f1: number; support: number; predicted: number }>;
  confusion: Record<string, Record<string, number>>;
  calibration?: { brier: number; ece: number; n: number } | null;
  latency: LatencyStats;
  tokens: { input: number; output: number };
  costUsd?: number | null;
  costPer1kUsd?: number | null;
  selfConsistency?: number | null;
  perTag: Record<string, { n: number; correct: number; accuracy: number }>;
}

export interface BenchmarkPrediction { verdict?: string; confidence?: number; error?: string }

export interface BenchmarkCaseRow {
  id: string;
  expected: string;
  tags: string[];
  jev?: BenchmarkPrediction;
  baseline?: BenchmarkPrediction;
  jevCorrect: boolean;
  baselineCorrect: boolean;
}

export interface CompareBenchmarkRun {
  id: string;
  dataset: 'judge' | 'injection';
  generatedAt: string;
  cases: number;
  repeat: number;
  positiveLabel: string;
  providers: { id: string; variants: string[] }[];
  skipped: { id: string; reason: string }[];
  variants: BenchmarkVariant[];
  agreement: Record<string, Record<string, { agree: number; compared: number; rate: number }>>;
  headline?: {
    jev: string; baseline: string; accuracyDelta?: number; positiveRecallDelta?: number;
    falseAllowDelta?: number; p95Speedup?: number; costRatio?: number;
  } | null;
  sweep?: {
    base: string; constraintMet: boolean; minPositiveRecall?: number; minPositiveRecallSource?: string;
    best?: { params: Record<string, number>; accuracy: number; macroF1: number; positiveRecall: number; falseAllowRate: number; escalationRate: number } | null;
    points: number;
  } | null;
  misses: BenchmarkCaseRow[];
}

export interface TriageBenchmarkRun {
  id: string;
  dataset: 'triage';
  generatedAt: string;
  model: string;
  questionsVersion?: string;
  metrics: Record<string, number>;
  misses: { id: string; expected: Record<string, unknown>; got: Record<string, unknown> }[];
}

export interface JevBenchmarks {
  available: boolean;
  runs: { id: string; dataset: BenchmarkDataset; generatedAt: string }[];
  judge?: CompareBenchmarkRun;
  injection?: CompareBenchmarkRun;
  triage?: TriageBenchmarkRun;
}

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
  jevSummary: (rangeKey: string) => ['gov', 'jev', 'summary', rangeKey] as const,
  jevShadow: (f: JevShadowFilters & { range?: string }) => ['gov', 'jev', 'shadow', f] as const,
  jevBenchmarks: (sel: Partial<Record<BenchmarkDataset, string>>) => ['gov', 'jev', 'benchmarks', sel] as const,
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

/** Jev-vs-baseline shadow summary for a time range (`GET /api/gov/jev/summary`). */
export const useJevSummary = (rangeKey: string) =>
  useQuery({
    queryKey: govKeys.jevSummary(rangeKey),
    queryFn: () => { const b = rangeBounds(rangeKey); return api<JevShadowSummary>('gov/jev/summary', { since: b.from, until: b.to }); },
    placeholderData: keepPreviousData,
    retry: noRetryOn4xx,
  });

/** Latest offline benchmark results per dataset (`GET /api/gov/jev/benchmarks`); pass run ids to pick older runs. */
export const useJevBenchmarks = (sel: Partial<Record<BenchmarkDataset, string>> = {}) =>
  useQuery({
    queryKey: govKeys.jevBenchmarks(sel),
    queryFn: () => api<JevBenchmarks>('gov/jev/benchmarks', { judge: sel.judge, injection: sel.injection, triage: sel.triage }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: noRetryOn4xx,
  });

const jevShadowParams = (f: JevShadowFilters, limit: number, cursor?: string): Record<string, string | undefined> => ({
  kind: f.kind, sessionId: f.sessionId, laneId: f.laneId, agree: f.agree == null ? undefined : String(f.agree),
  since: f.since, until: f.until, limit: String(limit), cursor,
});

export const fetchJevShadow = (f: JevShadowFilters, limit = 50, cursor?: string) =>
  api<JevShadowPage>('gov/jev/shadow', jevShadowParams(f, limit, cursor));

/**
 * Cursor-paged shadow records (`GET /api/gov/jev/shadow`). When `rangeKey` is given, `since`/`until`
 * are resolved at fetch time so refetches use a fresh "now".
 */
export const useJevShadowInfinite = (f: JevShadowFilters, rangeKey?: string, pageSize = 50, enabled = true) =>
  useInfiniteQuery({
    queryKey: govKeys.jevShadow({ ...f, range: rangeKey }),
    queryFn: ({ pageParam }) => {
      const b = rangeKey ? rangeBounds(rangeKey) : null;
      return fetchJevShadow({ ...f, since: f.since ?? b?.from, until: f.until ?? b?.to }, pageSize, pageParam);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.cursor ?? undefined,
    enabled,
    retry: noRetryOn4xx,
  });

/** Judge shadow records for one session (conversation drawer). Returns [] when Jev/governance is unavailable. */
export const useSessionJevShadow = (sessionId: string | null, kind: JevShadowKind = 'judge') =>
  useQuery({
    queryKey: ['gov', 'jev', 'session', sessionId ?? '', kind] as const,
    queryFn: async () => {
      try {
        return (await fetchJevShadow({ sessionId: sessionId!, kind }, 500)).items;
      } catch (e) {
        if (e instanceof ApiError && e.status >= 400 && e.status < 500) return [];
        throw e;
      }
    },
    enabled: !!sessionId,
    staleTime: 30_000,
    retry: false,
  });

export const useSessionIntent = (sessionId: string | null) =>
  useQuery({ queryKey: govKeys.intent(sessionId ?? ''), queryFn: () => api<SessionIntent | null>(`gov/sessions/${enc(sessionId!)}/intent`), enabled: !!sessionId, retry: false });

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

// ── Test harness: simulation mode + Copilot hook install (src/governance/routes/harness.ts) ──

export interface GovSimulationState {
  enabled: boolean;
  source: 'env' | 'setting';
  updatedAt?: string;
  updatedBy?: string;
  enforcementEnabled?: boolean;
}

export type HookTarget = 'copilot-cli' | 'vscode';
export type HookFailMode = 'auto' | 'open' | 'closed';

export interface HookTargetStatus {
  target: HookTarget;
  path: string;
  installed: boolean;
  managed: boolean;
  failMode?: string;
  port?: number;
  modifiedAt?: string;
}

export interface CopilotHooksStatus {
  mode: 'local' | 'cloud';
  /** False in cloud mode: hooks are installed per endpoint, not by the control plane. */
  available: boolean;
  simulation: GovSimulationState;
  copilotHome: string;
  forwarder: { powershell: string; bash: string; present: boolean };
  targets: HookTargetStatus[];
}

export const harnessKeys = {
  simulation: ['gov', 'harness', 'simulation'] as const,
  hooks: ['gov', 'harness', 'hooks'] as const,
};

export const useGovSimulation = (enabled = true) =>
  useQuery({ queryKey: harnessKeys.simulation, queryFn: () => api<GovSimulationState>('gov/simulation'), enabled, staleTime: 30_000, retry: noRetryOn4xx });

export const useCopilotHooks = () =>
  useQuery({ queryKey: harnessKeys.hooks, queryFn: () => api<CopilotHooksStatus>('gov/hooks/copilot'), retry: noRetryOn4xx });

function applyHarness(qc: QueryClient, s: CopilotHooksStatus | GovSimulationState): void {
  if ('targets' in s) {
    qc.setQueryData(harnessKeys.hooks, s);
    qc.setQueryData(harnessKeys.simulation, s.simulation);
  } else {
    qc.setQueryData(harnessKeys.simulation, s);
    qc.setQueryData<CopilotHooksStatus>(harnessKeys.hooks, h => (h ? { ...h, simulation: s } : h));
  }
}

export function useSetGovSimulation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => apiSend<GovSimulationState>('PUT', 'gov/simulation', { enabled }),
    onSuccess: s => applyHarness(qc, s),
  });
}

export function useInstallCopilotHooks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { targets: HookTarget[]; failMode: HookFailMode; simulate?: boolean }) =>
      apiSend<CopilotHooksStatus>('POST', 'gov/hooks/copilot/install', body),
    onSuccess: s => applyHarness(qc, s),
  });
}

export function useUninstallCopilotHooks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targets?: HookTarget[]) => apiSend<CopilotHooksStatus>('POST', 'gov/hooks/copilot/uninstall', targets ? { targets } : {}),
    onSuccess: s => applyHarness(qc, s),
  });
}

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
