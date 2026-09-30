/**
 * Module contracts composed by the PDP (src/governance/pdp.ts). Each module lives in its own
 * folder and exports a default implementation matching these signatures, so modules can be built,
 * tested and swapped independently (e.g. in-memory vs Redis limits, mock vs Foundry judge).
 */
import type { ActionFeatures } from './features';
import type {
  ActionRequest, AgentIdentity, Approval, ApprovalChannel, JudgeVerdict, Lane, LaneCondition,
  RegisteredAgent, SessionIntent,
} from './types';

// ── registry/ ─────────────────────────────────────────────────────────────
export interface Registry {
  /** Resolve (or auto-register as discovered) the agent behind a request. Must be fast (cached). */
  identify(agent: AgentIdentity): Promise<RegisteredAgent>;
  setStatus(agentId: string, status: RegisteredAgent['status'], reason: string, by: string): Promise<RegisteredAgent | undefined>;
}

// ── lanes/ ────────────────────────────────────────────────────────────────
export interface RuleMatch {
  bucket: 'deny' | 'allow' | 'judge' | 'approve' | 'alert';
  ruleId: string;
  description: string;
  condition: LaneCondition;
}

export interface RuleEvaluation {
  /** Winning deny rule (deny always wins; enforcing rules outrank observe-only policy rules). */
  deny?: RuleMatch;
  /** Approve (human) rules that matched. */
  approve: RuleMatch[];
  /** Judge rules that matched. */
  judge: RuleMatch[];
  /** Allow rules that matched. */
  allow: RuleMatch[];
  /** Non-blocking alert rules that matched. */
  alert: RuleMatch[];
}

export interface LaneEngine {
  /**
   * Pick the lane for an agent + request (explicit assignment, then appliesTo match, then default
   * lane) and merge in applicable policies (global in scope + attached).
   */
  resolve(agent: RegisteredAgent, req: ActionRequest): Promise<Lane>;
  /** Evaluate deterministic rules. Pure and synchronous; target < 1 ms. */
  evaluate(lane: Lane, req: ActionRequest, f: ActionFeatures, ctx: { tainted: boolean; workspace?: string }): RuleEvaluation;
}

// ── limits/ ───────────────────────────────────────────────────────────────
export interface LimitHit { limitId: string; reason: string }

export interface Limits {
  /** Record the action and return the first limit exceeded (if any). */
  check(lane: Lane, intent: SessionIntent, req: ActionRequest, f: ActionFeatures): Promise<LimitHit | null>;
}

// ── intent/ ───────────────────────────────────────────────────────────────
export interface IntentTracker {
  /** Load or create the session's intent state. */
  get(sessionId: string, agentId: string): Promise<SessionIntent>;
  /** Record a user prompt / goal. May update the goal asynchronously via the LLM. */
  recordGoal(intent: SessionIntent, text: string, source: SessionIntent['goalSource']): Promise<SessionIntent>;
  /** Append an action to the trajectory and decrement taint TTL. */
  recordAction(intent: SessionIntent, f: ActionFeatures, verdict: string): Promise<SessionIntent>;
  /** Mark the session tainted by untrusted content. */
  taint(intent: SessionIntent, reason: string, source: string, ttlActions: number): Promise<SessionIntent>;
  /** Compact digest (last N actions) for the judge prompt. */
  digest(intent: SessionIntent, maxLines?: number): string;
}

// ── judge/ ────────────────────────────────────────────────────────────────
export interface JudgeInput {
  lane: Lane;
  /** Session goal (may be undefined when unknown). */
  goal?: string;
  trajectory: string;
  /** Action description, already shaped per the lane's data policy (redacted/full/metadata-only). */
  action: { tool: string; category: string; mcpServer?: string | null; summary: string; args?: string; risk: string[]; hosts: string[]; paths: string[] };
  tainted: boolean;
  taintReason?: string;
  /** Why the judge was invoked (matching rule ids). */
  triggers: string[];
}

export interface Judge {
  readonly available: boolean;
  evaluate(input: JudgeInput, tier: 'fast' | 'escalation', timeoutMs: number): Promise<JudgeVerdict>;
}

// ── shields/ ──────────────────────────────────────────────────────────────
export interface ShieldResult {
  attackDetected: boolean;
  /** 'document' (indirect injection in tool result) | 'prompt' (direct jailbreak in user prompt). */
  kind?: 'document' | 'prompt';
  detail?: string;
  latencyMs: number;
  /** false when the service wasn't configured or failed. */
  scanned: boolean;
}

export interface Shields {
  readonly available: boolean;
  scanDocuments(docs: string[], userPrompt?: string): Promise<ShieldResult>;
}

// ── approvals/ ────────────────────────────────────────────────────────────
export interface ApprovalRequest {
  req: ActionRequest;
  agent: RegisteredAgent;
  lane: Lane;
  summary: string;
  reason: string;
  channels: ApprovalChannel[];
  timeoutSec: number;
}

export interface Approvals {
  /** Create a pending approval and notify channels (dashboard WS, Teams). */
  request(r: ApprovalRequest): Promise<Approval>;
  /** Resolve when a human decides or the timeout elapses (state 'expired'). */
  wait(id: string, timeoutMs: number): Promise<Approval>;
  resolve(id: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined>;
}
