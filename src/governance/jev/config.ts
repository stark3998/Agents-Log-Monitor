/**
 * TypeSafe Jev configuration (shadow mode). Jev is opt-in: nothing is sent to TypeSafe unless
 * `TYPESAFE_API_KEY` is set. Shadow runs never change a governance verdict.
 */
function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? n : d;
}
function bool(v: string | undefined, d: boolean): boolean {
  if (v == null || v === '') return d;
  return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

export type JevShadowScope = 'judge' | 'governed';
export type JevPolicyName = 'strict' | 'permissive';

/** Jev list price (USD per million input tokens; output tokens are free). */
export const JEV_PRICE_PER_MTOK_INPUT = 0.042;

export const jevConfig = {
  get apiKey(): string { return process.env.TYPESAFE_API_KEY ?? ''; },
  get baseUrl(): string { return process.env.TYPESAFE_BASE_URL ?? ''; },
  /** Pinned versioned model id: thresholds are tuned per version, aliases move. */
  get model(): string { return process.env.JEV_MODEL || 'jev-1.13.0'; },
  /** Per-attempt timeout for shadow/eval calls. */
  get timeoutMs(): number { return num(process.env.JEV_TIMEOUT_MS, 2000); },
  /** Threshold policy used to combine Jev answers into a verdict. */
  get policy(): JevPolicyName { return process.env.JEV_POLICY === 'permissive' ? 'permissive' : 'strict'; },
  /** True when an API key is configured (the client can be used, e.g. by the eval harness). */
  get available(): boolean { return !!this.apiKey; },

  shadow: {
    /** Shadow runs are on whenever a key is configured, unless JEV_SHADOW=off. */
    get enabled(): boolean { return jevConfig.available && bool(process.env.JEV_SHADOW, true); },
    /** `judge`: only actions that trigger the LLM judge; `governed`: every pre_tool/spawn decision. */
    get scope(): JevShadowScope { return process.env.JEV_SHADOW_SCOPE === 'governed' ? 'governed' : 'judge'; },
    /** 0..1 fraction of eligible events to shadow. */
    get sampleRate(): number { return Math.min(1, Math.max(0, num(process.env.JEV_SHADOW_SAMPLE_RATE, 1))); },
    get maxConcurrency(): number { return Math.max(1, num(process.env.JEV_MAX_CONCURRENCY, 8)); },
    get maxQueue(): number { return Math.max(0, num(process.env.JEV_MAX_QUEUE, 500)); },
    /** Shadow the tool_result prompt-injection check alongside Prompt Shields. */
    get injection(): boolean { return bool(process.env.JEV_SHADOW_INJECTION, true); },
    /** Background session semantic scoring. */
    get sessionScoring(): boolean { return bool(process.env.JEV_SHADOW_SESSIONS, true); },
    get sessionIntervalMs(): number { return Math.max(10_000, num(process.env.JEV_SHADOW_SESSION_INTERVAL_MS, 300_000)); },
    /** Days to keep shadow records. */
    get retentionDays(): number { return Math.max(1, num(process.env.JEV_SHADOW_RETENTION_DAYS, 30)); },
  },

  /** Optional baseline pricing (USD per million tokens) for cost comparison with the Foundry judge. */
  foundryPrice: {
    get inputPerMtok(): number | undefined { const v = process.env.FOUNDRY_PRICE_INPUT_PER_MTOK; return v ? num(v, 0) : undefined; },
    get outputPerMtok(): number | undefined { const v = process.env.FOUNDRY_PRICE_OUTPUT_PER_MTOK; return v ? num(v, 0) : undefined; },
  },
};
