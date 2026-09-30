import type {
  Approval, ApprovalState, Decision, FleetAlert, FleetAlertQuery, Incident, IncidentState, LaneRecord, LaneStatus,
  PolicyRecord, PostureEndpointRecord, PostureFindingRecord, PostureFindingState, RegisteredAgent, SessionIntent,
  Severity, Verdict,
} from '../types';
import type { JevShadowQuery, JevShadowRecord } from '../jev/types';

/**
 * Persistence contract for governance data. Two implementations:
 * - `SqliteGovernanceStore` (local enforcer, node:sqlite — src/governance/store/sqlite.ts)
 * - `CosmosGovernanceStore` (cloud control plane — src/governance/store/cosmos.ts)
 *
 * All methods are async so the cloud implementation can be a drop-in. Implementations must be
 * safe to call concurrently from request handlers.
 */
export interface DecisionQuery {
  sessionId?: string;
  agentId?: string;
  laneId?: string;
  verdict?: Verdict[];
  wouldDeny?: boolean;
  toolName?: string;
  since?: string;
  until?: string;
  /** Free text over reason / tool / rationale. */
  text?: string;
  limit?: number;
  /** Opaque cursor returned by the previous page (seq for SQLite, continuation token for Cosmos). */
  cursor?: string;
}

export interface Page<T> { items: T[]; cursor?: string }

export interface SettingDoc<T = unknown> { key: string; value: T; updatedAt: string; updatedBy?: string }

export interface PostureFindingQuery {
  state?: PostureFindingState[];
  endpointId?: string;
  checkId?: string;
  severity?: Severity[];
  level?: 'endpoint' | 'fleet';
  limit?: number;
}

export interface ApprovalQuery { state?: ApprovalState[]; sessionId?: string; agentId?: string; limit?: number }
export interface IncidentQuery { state?: IncidentState[]; agentId?: string; since?: string; limit?: number }

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  /** First broken sequence number, when !ok. */
  brokenAt?: number;
  headHash?: string;
}

export interface GovernanceStore {
  readonly kind: 'sqlite' | 'cosmos';
  init(): Promise<void>;

  // Lanes (versioned: every save appends a version row; `getLane` returns the latest active)
  listLanes(status?: LaneStatus[]): Promise<LaneRecord[]>;
  getLane(id: string, version?: number): Promise<LaneRecord | undefined>;
  listLaneVersions(id: string): Promise<LaneRecord[]>;
  saveLane(rec: LaneRecord): Promise<LaneRecord>;
  setLaneStatus(id: string, version: number, status: LaneStatus, by?: string): Promise<void>;

  // Policies (versioned exactly like lanes)
  listPolicies(status?: LaneStatus[]): Promise<PolicyRecord[]>;
  getPolicy(id: string, version?: number): Promise<PolicyRecord | undefined>;
  listPolicyVersions(id: string): Promise<PolicyRecord[]>;
  savePolicy(rec: PolicyRecord): Promise<PolicyRecord>;
  setPolicyStatus(id: string, version: number, status: LaneStatus, by?: string): Promise<void>;

  // Settings documents (classifier config, posture check config…). Last write wins.
  getSetting<T = unknown>(key: string): Promise<SettingDoc<T> | undefined>;
  putSetting<T = unknown>(key: string, value: T, by?: string): Promise<SettingDoc<T>>;

  // Endpoint posture
  upsertPostureEndpoint(e: PostureEndpointRecord): Promise<PostureEndpointRecord>;
  getPostureEndpoint(id: string): Promise<PostureEndpointRecord | undefined>;
  listPostureEndpoints(): Promise<PostureEndpointRecord[]>;
  upsertPostureFinding(f: PostureFindingRecord): Promise<PostureFindingRecord>;
  getPostureFinding(id: string): Promise<PostureFindingRecord | undefined>;
  listPostureFindings(q?: PostureFindingQuery): Promise<PostureFindingRecord[]>;

  // Agent registry
  listAgents(): Promise<RegisteredAgent[]>;
  getAgent(id: string): Promise<RegisteredAgent | undefined>;
  findAgentByExternalId(surface: string, externalId: string): Promise<RegisteredAgent | undefined>;
  upsertAgent(a: RegisteredAgent): Promise<RegisteredAgent>;

  // Session intent / runtime state
  getSessionIntent(sessionId: string): Promise<SessionIntent | undefined>;
  saveSessionIntent(s: SessionIntent): Promise<void>;

  // Decisions — append-only, hash-chained (the store assigns seq/prevHash/hash atomically)
  appendDecision(d: Decision): Promise<Decision>;
  getDecision(id: string): Promise<Decision | undefined>;
  queryDecisions(q: DecisionQuery): Promise<Page<Decision>>;
  verifyAuditChain(fromSeq?: number, limit?: number): Promise<AuditVerifyResult>;

  // Approvals
  createApproval(a: Approval): Promise<Approval>;
  getApproval(id: string): Promise<Approval | undefined>;
  updateApproval(id: string, patch: Partial<Approval>): Promise<Approval | undefined>;
  listApprovals(q?: ApprovalQuery): Promise<Approval[]>;

  // Incidents
  createIncident(i: Incident): Promise<Incident>;
  getIncident(id: string): Promise<Incident | undefined>;
  updateIncident(id: string, patch: Partial<Incident>): Promise<Incident | undefined>;
  listIncidents(q?: IncidentQuery): Promise<Incident[]>;

  // Monitoring-fleet alerts (idempotent on alert_id).
  upsertFleetAlerts(alerts: FleetAlert[]): Promise<number>;
  getFleetAlert(id: string): Promise<FleetAlert | undefined>;
  listFleetAlerts(q?: FleetAlertQuery): Promise<FleetAlert[]>;

  // Jev shadow comparisons — non-authoritative, NOT part of the hash-chained audit log.
  /** Insert-only: if a record with the same id already exists it is left untouched (no overwrite). */
  appendJevShadow(r: JevShadowRecord): Promise<JevShadowRecord>;
  queryJevShadow(q: JevShadowQuery): Promise<Page<JevShadowRecord>>;
  /** Delete shadow records older than `before` (ISO); returns the number removed. */
  pruneJevShadow(before: string): Promise<number>;

  // Outboxes (alerts, local→cloud sync). Items are opaque JSON.
  enqueue(box: 'alerts' | 'sync', item: unknown): Promise<void>;
  /** Claim up to `limit` items; returns ids to ack. */
  dequeue(box: 'alerts' | 'sync', limit: number): Promise<{ id: string; item: unknown; attempts: number }[]>;
  ack(box: 'alerts' | 'sync', ids: string[]): Promise<void>;
  nack(box: 'alerts' | 'sync', ids: string[]): Promise<void>;
}
