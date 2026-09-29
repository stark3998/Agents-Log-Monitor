import type { Decision } from '../api/governance';
import type { ToolItem } from '../api/types';

/** Max distance between a tool call's timestamp and its decision when matching by name + time. */
export const MATCH_WINDOW_MS = 15_000;

const canon = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/^mcp__[^_]+__/, '').replace(/[^a-z0-9]/g, '');

/**
 * Match governance decisions to timeline tool calls.
 * 1. Exact: decision.requestId === tool.toolUseId (Claude tool_use_id / Copilot toolCallId).
 * 2. Fallback: same (canonicalised) tool name and nearest createdAt within MATCH_WINDOW_MS; each
 *    decision is used at most once. Decisions for non-tool checkpoints are ignored.
 */
export function matchDecisions(tools: readonly ToolItem[], decisions: readonly Decision[]): Map<number, Decision> {
  const out = new Map<number, Decision>();
  const pool = decisions.filter(d => d.checkpoint === 'pre_tool' || d.checkpoint == null);
  const used = new Set<string>();
  const byRequest = new Map(pool.map(d => [d.requestId, d]));

  for (const t of tools) {
    if (!t.toolUseId) continue;
    const d = byRequest.get(t.toolUseId);
    if (d && !used.has(d.id)) { out.set(t.id, d); used.add(d.id); }
  }

  // Greedy nearest-in-time pairing over all (tool, decision) candidates.
  const candidates: { tool: number; d: Decision; dist: number }[] = [];
  for (const t of tools) {
    if (out.has(t.id)) continue;
    const name = canon(t.name);
    const ts = Date.parse(t.t);
    for (const d of pool) {
      if (used.has(d.id) || canon(d.toolName) !== name) continue;
      const dist = Math.abs(Date.parse(d.createdAt) - ts);
      if (dist <= MATCH_WINDOW_MS) candidates.push({ tool: t.id, d, dist });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);
  for (const c of candidates) {
    if (out.has(c.tool) || used.has(c.d.id)) continue;
    out.set(c.tool, c.d);
    used.add(c.d.id);
  }
  return out;
}
