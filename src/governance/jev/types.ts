/**
 * Shared types for TypeSafe Jev shadow mode. Jev runs next to the authoritative decision makers
 * (Foundry LLM judge, Prompt Shields, Guardian, heuristic session severity) and never changes a
 * verdict; every run is persisted as a non-authoritative `JevShadowRecord` for benchmarking.
 */

/** Kinds posted by the Python AgentMon Fleet (enterprise monitoring of Foundry / Copilot Studio agents). */
export type JevFleetShadowKind =
  | 'fleet_realtime'   // real-time tool-call gate: allow|block (score = risk 0..100)
  | 'fleet_intent'     // session intent scope: in_scope|out_of_scope|ambiguous
  | 'fleet_alignment'  // action vs goal: aligned|misaligned
  | 'fleet_evasion'    // same-effect adjudication after a block: same|different
  | 'fleet_injection'  // tool output / user prompt injection or jailbreak: attack|review|clean
  | 'fleet_code';      // script necessity / risk: necessary|unnecessary (score = risk 0..100)

/** Which decision point a shadow record compares. */
export type JevShadowKind = 'judge' | 'injection' | 'guardian_triage' | 'session_score' | JevFleetShadowKind;

/** Raw Jev signals keyed by question id (Noul probability, Score expectation or Choice label). */
export type JevSignals = Record<string, number | string>;

/** The authoritative (non-Jev) outcome the shadow is compared against. */
export interface JevShadowBaseline {
  /**
   * `foundry` (LLM judge), `rules` (deterministic lane rules / fail mode / cache / default),
   * `prompt-shields`, `guardian`, `heuristic` (session severity), or `none` when nothing ran.
   */
  provider: 'foundry' | 'rules' | 'prompt-shields' | 'guardian' | 'heuristic' | 'none';
  /** Deployment / model name when an AI provider produced the baseline. */
  model?: string;
  /** Categorical outcome: allow|deny|escalate, attack|clean, severity label, etc. */
  verdict?: string;
  /** Numeric outcome when the baseline is a score. */
  score?: number;
  confidence?: number;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** PDP stage for judge baselines (rules_deny, judge_fast, cache, …). */
  stage?: string;
}

/** Jev's shadow answer. */
export interface JevShadowOutcome {
  /** Versioned model id reported by the API (e.g. jev-1.13.0). */
  model: string;
  verdict?: string;
  score?: number;
  confidence?: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Named threshold policy used to combine answers (strict | permissive). */
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

export interface JevShadowQuery {
  kind?: JevShadowKind[];
  sessionId?: string;
  laneId?: string;
  agree?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  /** Opaque cursor from the previous page. */
  cursor?: string;
}

/** Body accepted by `POST /api/gov/jev/shadow` (the server assigns id / createdAt when absent). */
export type JevShadowInput = Omit<JevShadowRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: string };

export interface LatencyStats { count: number; p50: number; p95: number; p99: number; mean: number }

/** Per-kind comparison summary returned by `GET /api/gov/jev/summary`. */
export interface JevKindSummary {
  kind: JevShadowKind;
  total: number;
  /** Records where agreement could be computed. */
  compared: number;
  agreed: number;
  /** agreed / compared (0 when compared = 0). */
  agreementRate: number;
  jevErrors: number;
  /** confusion[baselineVerdict][jevVerdict] = count. */
  confusion: Record<string, Record<string, number>>;
  /** Disagreements where Jev was stricter (would deny/flag) vs looser (would allow/clean) than baseline. */
  jevStricter: number;
  jevLooser: number;
  latency: { jev: LatencyStats; baseline: LatencyStats };
  tokens: { jevInput: number; baselineInput: number; baselineOutput: number };
  /** Estimated USD cost for the window (Jev list price; baseline via FOUNDRY_PRICE_* env when set). */
  estCostUsd: { jev: number; baseline?: number };
  /** Distinct baseline providers/models seen. */
  baselineModels: string[];
  jevModels: string[];
}

export interface JevShadowSummary {
  enabled: boolean;
  model: string;
  since?: string;
  until?: string;
  kinds: JevKindSummary[];
  /** Runtime counters from the shadow queue (since process start). */
  queue: { enqueued: number; completed: number; failed: number; dropped: number; inFlight: number; queued: number };
}
