/**
 * Builds the structured `state` sent to Jev. Only relevant context goes in (jev-1.13 degrades with
 * large irrelevant state), untrusted content is labeled `untrusted_*`, secrets are masked, and every
 * string is truncated so the serialized state stays far below the 32k-token state budget.
 */
import type { JsonValue } from '@typesafe-ai/sdk';
import { REDACTION_MODE, redactString } from '../../analytics/redact';
import type { JudgeInput } from '../contracts';
import { neverRules } from './questions';

export type JevState = { [key: string]: JsonValue };

/** Hard cap on the serialized state (~15k tokens at ~4 chars/token; budget is 32k tokens). */
export const MAX_STATE_CHARS = 60_000;
const MAX_ARGS_CHARS = 24_000;
const MAX_TOOL_OUTPUT_CHARS = 40_000;
const MAX_FIELD_CHARS = 2_000;
const MAX_LIST_ITEM_CHARS = 500;
const MAX_LIST_ITEMS = 50;
const MAX_RECENT_ACTIONS = 20;
const MAX_SESSION_ACTIONS = 80;
const MAX_ACTION_LINE_CHARS = 300;

/** Truncate with an explicit marker so the model knows content was cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(0, max - 40);
  return `${s.slice(0, keep)}…[truncated ${s.length - keep} chars]`;
}

/**
 * Anything sent to TypeSafe always has secrets masked, even when local storage redaction is off
 * (`REDACT_PAYLOADS=off`); `all` additionally masks email addresses.
 */
export const EGRESS_REDACTION = REDACTION_MODE === 'all' ? 'all' : 'secrets';

function clean(s: string | null | undefined, max: number): string {
  return truncate(redactString(String(s ?? ''), EGRESS_REDACTION), max);
}

function list(items: readonly string[] | undefined, maxItems = MAX_LIST_ITEMS, maxChars = MAX_LIST_ITEM_CHARS): string[] {
  return (items ?? []).filter(x => x != null && String(x).trim() !== '').slice(0, maxItems).map(x => clean(String(x), maxChars));
}

function lines(text: string | undefined, maxLines: number): string[] {
  const all = String(text ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return all.slice(-maxLines).map(l => clean(l, MAX_ACTION_LINE_CHARS));
}

/** Shrink `untrusted_*` payloads until the serialized state fits `MAX_STATE_CHARS`. */
function fit(state: JevState, get: () => string, set: (v: string) => void): JevState {
  let size = JSON.stringify(state).length;
  let guard = 0;
  while (size > MAX_STATE_CHARS && guard++ < 8) {
    const cur = get();
    const next = Math.max(0, cur.length - (size - MAX_STATE_CHARS) - 200);
    set(truncate(cur, next));
    size = JSON.stringify(state).length;
    if (next === 0) break;
  }
  return state;
}

/**
 * State for the judge battery. Uses only what `JudgeInput` already contains (it is shaped by the
 * lane's `judge.dataPolicy`); args are additionally secret-masked before leaving the process.
 */
export function judgeState(input: JudgeInput): JevState {
  const a = input.action;
  const action: { [key: string]: JsonValue } = {
    tool: clean(a.tool, 200),
    category: clean(a.category, 50),
    mcp_server: a.mcpServer ? clean(a.mcpServer, 200) : null,
    summary: clean(a.summary, MAX_FIELD_CHARS),
    untrusted_args: a.args != null && a.args !== '' ? clean(a.args, MAX_ARGS_CHARS) : null,
    hosts: list(a.hosts),
    paths: list(a.paths),
    risk_flags: list(a.risk, MAX_LIST_ITEMS, 100),
  };
  const state: JevState = {
    lane: {
      purpose: clean(input.lane.purpose, MAX_FIELD_CHARS),
      dos: list(input.lane.dos),
      never: neverRules(input.lane).map(r => clean(r, MAX_LIST_ITEM_CHARS)),
    },
    session: {
      goal: input.goal ? clean(input.goal, MAX_FIELD_CHARS) : null,
      recent_actions: lines(input.trajectory, MAX_RECENT_ACTIONS),
      tainted: !!input.tainted,
      taint_reason: input.taintReason ? clean(input.taintReason, 500) : null,
    },
    action,
  };
  return fit(state, () => String(action.untrusted_args ?? ''), v => { action.untrusted_args = v; });
}

/** State for the injection battery over a tool result (secret-masked, truncated). */
export function injectionState(i: { toolOutput: string; goal?: string; tool?: string; category?: string }): JevState {
  const state: JevState = {
    source: {
      tool: i.tool ? clean(i.tool, 200) : null,
      category: i.category ? clean(i.category, 50) : null,
    },
    session_goal: i.goal ? clean(i.goal, MAX_FIELD_CHARS) : null,
    untrusted_tool_output: clean(i.toolOutput, MAX_TOOL_OUTPUT_CHARS),
  };
  return fit(state, () => String(state.untrusted_tool_output ?? ''), v => { state.untrusted_tool_output = v; });
}

export interface SessionDigest {
  sessionId: string;
  agent?: string;
  goal?: string;
  /** One line per action, oldest first (e.g. "Bash: npm test"). */
  actions: string[];
  /** Deterministic finding counts (e.g. { secrets: 2, pii: 0 }). */
  findings: Record<string, number>;
  domains: string[];
  mcpServers: string[];
  /** Risk rule ids that matched in the session. */
  riskHits: string[];
}

/** State for the session battery. Counts are given as facts; the model is never asked to count. */
export function sessionState(d: SessionDigest): JevState {
  const recent = d.actions.slice(-MAX_SESSION_ACTIONS).map(l => clean(l, MAX_ACTION_LINE_CHARS));
  const findings: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(d.findings ?? {}).slice(0, MAX_LIST_ITEMS)) {
    if (typeof v === 'number' && Number.isFinite(v)) findings[clean(k, 100)] = v;
  }
  const state: JevState = {
    session: {
      agent: d.agent ? clean(d.agent, 200) : null,
      goal: d.goal ? clean(d.goal, MAX_FIELD_CHARS) : null,
      total_actions: d.actions.length,
      actions_shown: recent.length,
    },
    actions: recent,
    findings,
    domains: list(d.domains, 100, 200),
    mcp_servers: list(d.mcpServers, 50, 200),
    risk_hits: list(d.riskHits, 100, 100),
  };
  let size = JSON.stringify(state).length;
  while (size > MAX_STATE_CHARS && recent.length > 1) {
    recent.splice(0, Math.max(1, Math.ceil(recent.length / 4)));
    (state.session as { [key: string]: JsonValue }).actions_shown = recent.length;
    size = JSON.stringify(state).length;
  }
  return state;
}
