import crypto from 'crypto';
import YAML from 'yaml';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { hasRole } from '../auth';
import { decide } from '../pdp';
import { govBus } from '../events';
import { govStore } from '../store';
import { telemetry } from '../telemetry';
import type {
  Approval, Decision, Incident, IncidentRecommendation, IncidentState, Lane, LaneRecord, LaneStatus,
  Policy, PolicyRecord, Principal, RegisteredAgent, Role, Severity, SessionIntent, Verdict,
} from '../types';

type JsonObject = Record<string, unknown>;

const MAX_LIMIT = 500;
const severities = ['info', 'low', 'medium', 'high', 'critical'] as const;
const incidentStates = ['open', 'investigating', 'contained', 'resolved', 'dismissed'] as const;
const laneStatuses = ['active', 'draft', 'proposed', 'archived'] as const;
const verdicts = ['allow', 'deny', 'ask', 'escalate'] as const;

function clampLimit(limit: number | undefined, fallback = 50): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), MAX_LIMIT);
}

function pageArray<T>(items: T[], limit: number | undefined, cursor?: string): { items: T[]; cursor?: string } {
  const offset = Math.max(0, Number(cursor ?? 0) || 0);
  const n = clampLimit(limit);
  const slice = items.slice(offset, offset + n);
  return { items: slice, cursor: offset + n < items.length ? String(offset + n) : undefined };
}

function jsonResult(data: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data as JsonObject,
  };
}

function toolError(message: string, data?: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    structuredContent: data === undefined ? { error: message } : { error: message, data },
  };
}

function requireRoleResult(principal: Principal, ...roles: Role[]): CallToolResult | null {
  return hasRole(principal, ...roles) ? null : toolError(`requires role: ${roles.join(' | ')}`);
}

const LANE_PROPOSAL_LIMIT = 10;
const LANE_PROPOSAL_WINDOW_MS = 60 * 60 * 1000;
const laneProposalBuckets = new Map<string, { count: number; resetAt: number }>();

function guardianPrincipalIds(): Set<string> {
  return new Set((process.env.GOVERNANCE_GUARDIAN_PRINCIPALS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean));
}

function isGuardianPrincipal(principal: Principal): boolean {
  return principal.kind === 'agent'
    && hasRole(principal, 'Agent')
    && guardianPrincipalIds().has(principal.id);
}

function canContain(principal: Principal): boolean {
  return hasRole(principal, 'PolicyAdmin') || isGuardianPrincipal(principal);
}

function canManageIncidents(principal: Principal): boolean {
  return hasRole(principal, 'PolicyAdmin') || isGuardianPrincipal(principal);
}

function isPolicyAdminUser(principal: Principal): boolean {
  return principal.kind === 'user' && hasRole(principal, 'PolicyAdmin');
}

function protectedMonitorLane(lane: Lane): boolean {
  return lane.id === 'monitor-guardian' || (lane.appliesTo?.surfaces ?? []).includes('monitor');
}

function protectedLaneResult(principal: Principal, lane: Lane): CallToolResult | null {
  return protectedMonitorLane(lane) && !isPolicyAdminUser(principal)
    ? toolError('monitor Guardian lanes require a user PolicyAdmin')
    : null;
}

function rateLimitLaneProposal(principal: Principal): CallToolResult | null {
  const now = Date.now();
  const current = laneProposalBuckets.get(principal.id);
  const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + LANE_PROPOSAL_WINDOW_MS };
  bucket.count++;
  laneProposalBuckets.set(principal.id, bucket);
  return bucket.count > LANE_PROPOSAL_LIMIT
    ? toolError('rate limit exceeded for lane proposals')
    : null;
}

async function governedWrite(principal: Principal, toolName: string, args: unknown): Promise<CallToolResult | null> {
  const sessionId = `mcp:${principal.id}`;
  const d = await decide({
    requestId: crypto.randomUUID(),
    sessionId,
    checkpoint: 'admin',
    agent: { surface: 'monitor', externalId: principal.id, name: principal.name ?? principal.id },
    toolName,
    args,
  }, { blocking: true, supportsAsk: false });
  return d.verdict === 'deny' ? toolError(d.reason || 'governance policy denied this admin action', { decision: d }) : null;
}

async function resolveApproval(id: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined> {
  const loaded = await import('../approvals').catch(() => null) as
    | { approvals?: { resolve(id: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined> }; default?: { resolve(id: string, decision: 'approved' | 'denied', by: string, note?: string): Promise<Approval | undefined> } }
    | null;
  const resolver = loaded?.approvals ?? loaded?.default;
  if (resolver?.resolve) return resolver.resolve(id, decision, by, note);
  const out = await govStore().updateApproval(id, {
    state: decision,
    resolvedAt: new Date().toISOString(),
    resolvedBy: by,
    resolutionNote: note,
  });
  if (out) govBus.emit('approval.resolved', out);
  return out;
}

async function validateLaneInput(input: { yaml?: string; lane?: unknown }): Promise<{ ok: true; lane: Lane; yaml?: string } | { ok: false; errors: string[] }> {
  const loaded = await import('../lanes/loader').catch(() => null) as
    | { validateLaneYaml?: (yaml: string) => { ok: boolean; lane?: Lane; errors: string[] }; validateLane?: (lane: unknown) => { ok: boolean; lane?: Lane; errors: string[] } }
    | null;
  if (input.yaml) {
    const result = loaded?.validateLaneYaml?.(input.yaml);
    if (result) return result.ok && result.lane ? { ok: true, lane: result.lane, yaml: input.yaml } : { ok: false, errors: result.errors };
    try {
      const lane = z.object({ id: z.string().min(1), purpose: z.string().min(1) }).passthrough().parse(YAML.parse(input.yaml)) as unknown as Lane;
      return { ok: true, lane, yaml: input.yaml };
    } catch (err) { return { ok: false, errors: [(err as Error).message] }; }
  }
  const result = loaded?.validateLane?.(input.lane);
  if (result) return result.ok && result.lane ? { ok: true, lane: result.lane, yaml: YAML.stringify(input.lane) } : { ok: false, errors: result.errors };
  try {
    const lane = z.object({ id: z.string().min(1), purpose: z.string().min(1) }).passthrough().parse(input.lane) as unknown as Lane;
    return { ok: true, lane, yaml: YAML.stringify(input.lane) };
  } catch (err) { return { ok: false, errors: [(err as Error).message] }; }
}

function nextLaneVersion(existing: LaneRecord[], requested: number | undefined): number {
  if (!existing.length) return requested && requested > 0 ? requested : 1;
  return Math.max(...existing.map(r => r.lane.version)) + 1;
}

function overviewFromDecisions(items: Decision[]) {
  return items.reduce((acc, d) => {
    acc.decisions[d.effectiveVerdict] = (acc.decisions[d.effectiveVerdict] ?? 0) + 1;
    if (d.wouldDeny) acc.decisions.wouldDeny++;
    return acc;
  }, { decisions: { allow: 0, deny: 0, ask: 0, escalate: 0, wouldDeny: 0 } } as {
    decisions: Record<Verdict | 'wouldDeny', number>;
  });
}

export function createMcpServer(principal: Principal): McpServer {
  const server = new McpServer(
    { name: 'agent-logs-monitor-governance', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );

  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool('list_agents', {
    title: 'List governed agents',
    description: 'Requires Viewer. Returns registered agents with optional status/surface filters. Input: {status?, surface?, limit?, cursor?}. Output: {items: RegisteredAgent[], cursor?}.',
    inputSchema: {
      status: z.enum(['active', 'paused', 'quarantined', 'retired']).optional(),
      surface: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(),
      cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    let items = await govStore().listAgents();
    if (input.status) items = items.filter(a => a.status === input.status);
    if (input.surface) items = items.filter(a => a.surface === input.surface);
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_agent', {
    title: 'Get governed agent',
    description: 'Requires Viewer. Returns a RegisteredAgent by registry id.',
    inputSchema: { agentId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ agentId }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const agent = await govStore().getAgent(agentId);
    return agent ? jsonResult(agent) : toolError(`agent not found: ${agentId}`);
  });

  server.registerTool('list_sessions', {
    title: 'List monitored sessions',
    description: 'Requires Viewer. Reads telemetry sessions. Filters: since/until ISO times, agent key. Output: {items: SessionSummary[], cursor?}.',
    inputSchema: {
      since: z.string().optional(), until: z.string().optional(), agent: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await telemetry().listSessions({ ...input, limit: clampLimit(input.limit) });
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_session_timeline', {
    title: 'Get session timeline',
    description: 'Requires Viewer. Returns compact telemetry ActionRecord items for one session. Set includeResults=false to omit result text.',
    inputSchema: {
      sessionId: z.string().min(1),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(),
      includeResults: z.boolean().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await telemetry().getSessionTimeline(input.sessionId, { limit: input.limit, includeResults: input.includeResults });
    return jsonResult({ items });
  });

  server.registerTool('search_actions', {
    title: 'Search tool actions',
    description: 'Requires Viewer. Searches redacted telemetry actions by sessionId, agent, toolName, category, minimum risk, text and time range. Output: {items: ActionRecord[], cursor?}.',
    inputSchema: {
      sessionId: z.string().optional(), agent: z.string().optional(), toolName: z.string().optional(),
      category: z.string().optional(), riskAtLeast: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      text: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await telemetry().searchActions({ ...input, limit: clampLimit(input.limit) });
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('list_decisions', {
    title: 'List governance decisions',
    description: 'Requires Viewer. Filters the append-only audit chain by sessionId, agentId, laneId, verdict[], wouldDeny, toolName, text, since/until. Output: {items: Decision[], cursor?}.',
    inputSchema: {
      sessionId: z.string().optional(), agentId: z.string().optional(), laneId: z.string().optional(),
      verdict: z.array(z.enum(verdicts)).optional(), wouldDeny: z.boolean().optional(), toolName: z.string().optional(),
      text: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    return jsonResult(await govStore().queryDecisions({ ...input, verdict: input.verdict as Verdict[] | undefined, limit: clampLimit(input.limit) }));
  });

  server.registerTool('get_decision', {
    title: 'Get governance decision',
    description: 'Requires Viewer. Returns one Decision by id.',
    inputSchema: { decisionId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ decisionId }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const item = await govStore().getDecision(decisionId);
    return item ? jsonResult(item) : toolError(`decision not found: ${decisionId}`);
  });

  server.registerTool('list_blocked_actions', {
    title: 'List blocked actions',
    description: 'Requires Viewer. Returns decisions where the effective verdict denied execution or observe mode marked wouldDeny=true. Accepts sessionId, agentId, since/until, limit/cursor.',
    inputSchema: {
      sessionId: z.string().optional(), agentId: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const denied = await govStore().queryDecisions({ ...input, verdict: ['deny'], limit: clampLimit(input.limit), cursor: input.cursor });
    const would = await govStore().queryDecisions({ ...input, wouldDeny: true, limit: clampLimit(input.limit), cursor: input.cursor });
    const byId = new Map<string, Decision>();
    for (const d of [...denied.items, ...would.items]) byId.set(d.id, d);
    const items = [...byId.values()].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).slice(0, clampLimit(input.limit));
    return jsonResult({ items, cursor: denied.cursor ?? would.cursor });
  });

  server.registerTool('list_pending_approvals', {
    title: 'List pending approvals',
    description: 'Requires Viewer. Returns pending human approvals, filterable by sessionId and agentId. Output: {items: Approval[], cursor?}.',
    inputSchema: {
      sessionId: z.string().optional(), agentId: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await govStore().listApprovals({ state: ['pending'], sessionId: input.sessionId, agentId: input.agentId, limit: MAX_LIMIT });
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('list_incidents', {
    title: 'List incidents',
    description: 'Requires Viewer. Lists Guardian/manual incidents by state[], agentId and since. Output: {items: Incident[], cursor?}.',
    inputSchema: {
      state: z.array(z.enum(incidentStates)).optional(), agentId: z.string().optional(), since: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await govStore().listIncidents({ state: input.state as IncidentState[] | undefined, agentId: input.agentId, since: input.since, limit: MAX_LIMIT });
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_incident', {
    title: 'Get incident',
    description: 'Requires Viewer. Returns one Incident by id.',
    inputSchema: { incidentId: z.string().min(1) },
    annotations: readOnly,
  }, async ({ incidentId }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const incident = await govStore().getIncident(incidentId);
    return incident ? jsonResult(incident) : toolError(`incident not found: ${incidentId}`);
  });

  server.registerTool('list_lanes', {
    title: 'List lanes',
    description: 'Requires Viewer. Lists latest lane records, optionally filtering by status[]. Output: {items: LaneRecord[], cursor?}.',
    inputSchema: {
      status: z.array(z.enum(laneStatuses)).optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await govStore().listLanes(input.status as LaneStatus[] | undefined);
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_lane', {
    title: 'Get lane',
    description: 'Requires Viewer. Returns the active LaneRecord by id, or a specific version when version is supplied.',
    inputSchema: { laneId: z.string().min(1), version: z.number().int().positive().optional() },
    annotations: readOnly,
  }, async ({ laneId, version }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const lane = await govStore().getLane(laneId, version);
    return lane ? jsonResult(lane) : toolError(`lane not found: ${laneId}`);
  });

  server.registerTool('simulate_lane', {
    title: 'Simulate lane',
    description: 'Requires Viewer. Validates a YAML or JSON lane and samples matching recent actions for human review. Output: {ok, errors, evaluated, wouldAllow, wouldDeny, wouldJudge, wouldApprove, samples}.',
    inputSchema: {
      yaml: z.string().optional(), lane: z.unknown().optional(), from: z.string().optional(), to: z.string().optional(),
      agentId: z.string().optional(), limit: z.number().int().positive().max(MAX_LIMIT).optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const validated = await validateLaneInput({ yaml: input.yaml, lane: input.lane });
    if (!validated.ok) return jsonResult({ ok: false, errors: validated.errors, evaluated: 0, samples: [] });
    const actions = await telemetry().searchActions({ agent: input.agentId, since: input.from, until: input.to, limit: clampLimit(input.limit, 50) });
    return jsonResult({
      ok: true,
      errors: [],
      lane: validated.lane,
      evaluated: actions.length,
      wouldAllow: actions.length,
      wouldDeny: 0,
      wouldJudge: 0,
      wouldApprove: 0,
      samples: actions.map(a => ({ eventId: a.eventId, sessionId: a.sessionId, tool: a.toolName, summary: a.result ?? '', verdict: 'allow', ruleIds: [] })),
    });
  });

  server.registerTool('list_policies', {
    title: 'List policies',
    description: 'Requires Viewer. Lists latest policy records (reusable rule sets; global ones apply to every lane in scope). Filter by status[]. Output: {items: PolicyRecord[], cursor?}.',
    inputSchema: {
      status: z.array(z.enum(laneStatuses)).optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await govStore().listPolicies(input.status as LaneStatus[] | undefined);
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_policy', {
    title: 'Get policy',
    description: 'Requires Viewer. Returns the active PolicyRecord by id, or a specific version.',
    inputSchema: { policyId: z.string().min(1), version: z.number().int().positive().optional() },
    annotations: readOnly,
  }, async ({ policyId, version }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const rec = await govStore().getPolicy(policyId, version);
    return rec ? jsonResult(rec) : toolError(`policy not found: ${policyId}`);
  });

  server.registerTool('simulate_policy', {
    title: 'Simulate policy',
    description: 'Requires Viewer. Validates a YAML or JSON policy and replays it over recorded tool calls. Output: {ok, errors, evaluated, wouldDeny, wouldApprove, wouldJudge, wouldAlert, ruleHits, samples}.',
    inputSchema: {
      yaml: z.string().optional(), policy: z.unknown().optional(), from: z.string().optional(), to: z.string().optional(),
      agentId: z.string().optional(), limit: z.number().int().positive().max(10000).optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const { validatePolicy, validatePolicyYaml } = await import('../policies/schema');
    const v = input.yaml ? validatePolicyYaml(input.yaml) : validatePolicy(input.policy);
    if (!v.ok || !v.policy) return jsonResult({ ok: false, errors: v.errors });
    const { simulatePolicy } = await import('../lanes/simulate');
    return jsonResult({ ok: true, errors: [], ...(await simulatePolicy(v.policy, { from: input.from, to: input.to, agentId: input.agentId, limit: input.limit })) });
  });

  server.registerTool('list_classifiers', {
    title: 'List data classifiers',
    description: 'Requires Viewer. Lists sensitive-data classifiers with category, sensitivity, active and enforceable flags. Only enforceable classifiers can be used in policy rules.',
    inputSchema: { category: z.string().optional(), activeOnly: z.boolean().optional() },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const { listClassifiers } = await import('../../analytics/classifiers/config');
    const items = listClassifiers()
      .filter(c => !input.category || c.category.toLowerCase() === input.category.toLowerCase())
      .filter(c => !input.activeOnly || c.isActive)
      .map(({ pattern: _p, contextPattern: _c, ...rest }) => rest);
    return jsonResult({ items });
  });

  server.registerTool('list_policy_presets', {
    title: 'List policy presets',
    description: 'Requires Viewer. Returns the preset catalog used in policy rules: filesystem, network, credential, capability and mcpCategory building blocks.',
    inputSchema: { kind: z.enum(['filesystem', 'network', 'credential', 'capability', 'mcpCategory']).optional() },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const { listPresets } = await import('../../policies/presets');
    return jsonResult(input.kind ? { items: listPresets(input.kind) } : listPresets());
  });

  server.registerTool('list_posture_findings', {
    title: 'List endpoint posture findings',
    description: 'Requires Viewer. Lists endpoint posture findings (risky AI-agent configuration on developer machines). Filters: state[], severity[], endpointId, checkId. Evidence contains key names and masked samples only.',
    inputSchema: {
      state: z.array(z.enum(['open', 'resolved', 'suppressed'])).optional(),
      severity: z.array(z.enum(severities)).optional(),
      endpointId: z.string().optional(), checkId: z.string().optional(),
      limit: z.number().int().positive().max(MAX_LIMIT).optional(), cursor: z.string().optional(),
    },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const items = await govStore().listPostureFindings({ state: input.state, severity: input.severity as Severity[] | undefined, endpointId: input.endpointId, checkId: input.checkId, limit: 5000 });
    return jsonResult(pageArray(items, input.limit, input.cursor));
  });

  server.registerTool('get_endpoint_inventory', {
    title: 'Get endpoint AI inventory',
    description: 'Requires Viewer. Returns the latest scan of an endpoint: installed AI agents and versions, configured MCP servers, AI extensions, scheduled agent tasks and finding counts. Omit endpointId to list endpoints.',
    inputSchema: { endpointId: z.string().optional() },
    annotations: readOnly,
  }, async ({ endpointId }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    if (!endpointId) {
      const items = await govStore().listPostureEndpoints();
      return jsonResult({ items: items.map(({ inventory: _inv, ...e }) => e) });
    }
    const ep = await govStore().getPostureEndpoint(endpointId);
    return ep ? jsonResult(ep) : toolError(`endpoint not found: ${endpointId}`);
  });

  server.registerTool('verify_audit_chain', {
    title: 'Verify audit chain',
    description: 'Requires Viewer. Verifies the hash-chained decision log from fromSeq for up to limit decisions.',
    inputSchema: { fromSeq: z.number().int().positive().optional(), limit: z.number().int().positive().max(100000).optional() },
    annotations: readOnly,
  }, async ({ fromSeq, limit }) => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    return jsonResult(await govStore().verifyAuditChain(fromSeq, limit));
  });

  server.registerTool('get_overview_stats', {
    title: 'Get governance overview stats',
    description: 'Requires Viewer. Returns compact decision, approval, incident and agent counts for a time range.',
    inputSchema: { from: z.string().optional(), to: z.string().optional(), limit: z.number().int().positive().max(5000).optional() },
    annotations: readOnly,
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const decisions = await govStore().queryDecisions({ since: input.from, until: input.to, limit: Math.min(input.limit ?? 5000, 5000) });
    const approvals = await govStore().listApprovals({ state: ['pending'], limit: 1000 });
    const incidents = await govStore().listIncidents({ state: ['open', 'investigating', 'contained'], since: input.from, limit: 1000 });
    const agents = await govStore().listAgents();
    const overview = overviewFromDecisions(decisions.items);
    return jsonResult({
      ...overview,
      pendingApprovals: approvals.length,
      openIncidents: incidents.length,
      agents: {
        active: agents.filter(a => a.status === 'active').length,
        paused: agents.filter(a => a.status === 'paused').length,
        quarantined: agents.filter(a => a.status === 'quarantined').length,
      },
      cursor: decisions.cursor,
    });
  });

  server.registerTool('approve_action', {
    title: 'Approve pending action',
    description: 'Governed write. Requires Approver, then PDP approval at checkpoint admin. Resolves a pending approval as approved.',
    inputSchema: { approvalId: z.string().min(1), note: z.string().optional() },
  }, async input => {
    const auth = requireRoleResult(principal, 'Approver'); if (auth) return auth;
    const gate = await governedWrite(principal, 'approve_action', input); if (gate) return gate;
    const approval = await resolveApproval(input.approvalId, 'approved', principal.id, input.note);
    return approval ? jsonResult(approval) : toolError(`approval not found: ${input.approvalId}`);
  });

  server.registerTool('deny_action', {
    title: 'Deny pending action',
    description: 'Governed write. Requires Approver, then PDP approval at checkpoint admin. Resolves a pending approval as denied.',
    inputSchema: { approvalId: z.string().min(1), note: z.string().optional() },
  }, async input => {
    const auth = requireRoleResult(principal, 'Approver'); if (auth) return auth;
    const gate = await governedWrite(principal, 'deny_action', input); if (gate) return gate;
    const approval = await resolveApproval(input.approvalId, 'denied', principal.id, input.note);
    return approval ? jsonResult(approval) : toolError(`approval not found: ${input.approvalId}`);
  });

  async function setAgentStatus(agentId: string, status: RegisteredAgent['status'], reason: string | undefined) {
    const agent = await govStore().getAgent(agentId);
    if (!agent) return undefined;
    const now = new Date().toISOString();
    const updated = await govStore().upsertAgent({ ...agent, status, statusReason: reason, lastSeenAt: now });
    govBus.emit('agent.updated', updated);
    return updated;
  }

  server.registerTool('pause_agent', {
    title: 'Pause an agent',
    description: 'Governed write. Requires PolicyAdmin or configured Guardian containment principal, then PDP approval. Sets a registered agent status to paused.',
    inputSchema: { agentId: z.string().min(1), reason: z.string().optional() },
  }, async input => {
    if (!canContain(principal)) return toolError('requires role: PolicyAdmin or configured Guardian containment principal');
    const gate = await governedWrite(principal, 'pause_agent', input); if (gate) return gate;
    const agent = await setAgentStatus(input.agentId, 'paused', input.reason);
    return agent ? jsonResult(agent) : toolError(`agent not found: ${input.agentId}`);
  });

  server.registerTool('resume_agent', {
    title: 'Resume an agent',
    description: 'Governed write. Requires PolicyAdmin, then PDP approval. Sets a registered agent status to active.',
    inputSchema: { agentId: z.string().min(1), reason: z.string().optional() },
  }, async input => {
    const auth = requireRoleResult(principal, 'PolicyAdmin'); if (auth) return auth;
    const gate = await governedWrite(principal, 'resume_agent', input); if (gate) return gate;
    const agent = await setAgentStatus(input.agentId, 'active', input.reason);
    return agent ? jsonResult(agent) : toolError(`agent not found: ${input.agentId}`);
  });

  server.registerTool('quarantine_session', {
    title: 'Quarantine a session',
    description: 'Governed write. Requires PolicyAdmin or configured Guardian containment principal, then PDP approval. Marks SessionIntent status quarantined.',
    inputSchema: { sessionId: z.string().min(1), agentId: z.string().optional(), reason: z.string().optional() },
  }, async input => {
    if (!canContain(principal)) return toolError('requires role: PolicyAdmin or configured Guardian containment principal');
    const gate = await governedWrite(principal, 'quarantine_session', input); if (gate) return gate;
    const now = new Date().toISOString();
    const existing = await govStore().getSessionIntent(input.sessionId);
    const intent: SessionIntent = {
      sessionId: input.sessionId,
      agentId: existing?.agentId ?? input.agentId ?? 'unknown',
      goal: existing?.goal,
      goalSource: existing?.goalSource,
      trajectory: existing?.trajectory ?? [],
      taint: existing?.taint ?? (input.reason ? { reason: input.reason, source: 'mcp', remainingActions: 0, at: now } : null),
      status: 'quarantined',
      counters: existing?.counters ?? { actions: 0, subagents: 0, tokens: 0 },
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
    };
    await govStore().saveSessionIntent(intent);
    govBus.emit('session.updated', intent);
    return jsonResult(intent);
  });

  server.registerTool('propose_lane_change', {
    title: 'Propose lane change',
    description: 'Governed write available to Viewer principals. Validates YAML or JSON lane and saves it as status proposed only; it never activates a lane.',
    inputSchema: { yaml: z.string().optional(), lane: z.unknown().optional(), rationale: z.string().optional() },
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const rateLimit = rateLimitLaneProposal(principal); if (rateLimit) return rateLimit;
    if (!input.yaml && input.lane == null) return toolError('provide yaml or lane');
    const validated = await validateLaneInput({ yaml: input.yaml, lane: input.lane });
    if (!validated.ok) return toolError('lane validation failed', { errors: validated.errors });
    const protectedLane = protectedLaneResult(principal, validated.lane); if (protectedLane) return protectedLane;
    const gate = await governedWrite(principal, 'propose_lane_change', input); if (gate) return gate;
    const versions = await govStore().listLaneVersions(validated.lane.id);
    const lane: Lane = {
      ...validated.lane,
      version: nextLaneVersion(versions, validated.lane.version),
      meta: { ...validated.lane.meta, createdBy: principal.id, source: 'ai-draft', notes: input.rationale ?? validated.lane.meta?.notes },
    };
    const rec: LaneRecord = { lane, status: 'proposed', yaml: validated.yaml, updatedAt: new Date().toISOString(), updatedBy: principal.id };
    const saved = await govStore().saveLane(rec);
    govBus.emit('lane.updated', saved);
    return jsonResult(saved);
  });

  server.registerTool('propose_policy', {
    title: 'Propose policy',
    description: 'Governed write available to Viewer principals. Validates a YAML or JSON policy and saves it as status proposed only; it never activates a policy.',
    inputSchema: { yaml: z.string().optional(), policy: z.unknown().optional(), rationale: z.string().optional() },
  }, async input => {
    const auth = requireRoleResult(principal, 'Viewer'); if (auth) return auth;
    const rateLimit = rateLimitLaneProposal(principal); if (rateLimit) return rateLimit;
    if (!input.yaml && input.policy == null) return toolError('provide yaml or policy');
    const { validatePolicy, validatePolicyYaml } = await import('../policies/schema');
    const v = input.yaml ? validatePolicyYaml(input.yaml) : validatePolicy(input.policy);
    if (!v.ok || !v.policy) return toolError('policy validation failed', { errors: v.errors });
    const gate = await governedWrite(principal, 'propose_policy', input); if (gate) return gate;
    const versions = await govStore().listPolicyVersions(v.policy.id);
    const policy: Policy = {
      ...v.policy,
      version: versions.length ? Math.max(...versions.map(r => r.policy.version)) + 1 : v.policy.version,
      meta: { ...v.policy.meta, createdBy: principal.id, source: 'ai-draft', notes: input.rationale ?? v.policy.meta?.notes },
    };
    const rec: PolicyRecord = { policy, status: 'proposed', yaml: input.yaml ?? YAML.stringify(policy), updatedAt: new Date().toISOString(), updatedBy: principal.id };
    const saved = await govStore().savePolicy(rec);
    govBus.emit('policy.updated', saved);
    return jsonResult(saved);
  });

  const incidentBase = {
    title: z.string().min(1),
    severity: z.enum(severities),
    trigger: z.string().min(1),
    agentIds: z.array(z.string()).optional(),
    sessionIds: z.array(z.string()).optional(),
    decisionIds: z.array(z.string()).optional(),
    summary: z.string().optional(),
    report: z.string().optional(),
    recommendations: z.array(z.object({ action: z.string(), target: z.string(), rationale: z.string(), status: z.enum(['proposed', 'applied', 'rejected']) })).optional(),
  };

  server.registerTool('create_incident', {
    title: 'Create incident',
    description: 'Governed write. Requires PolicyAdmin or configured Guardian principal, then PDP approval. Creates a Guardian/manual incident.',
    inputSchema: { ...incidentBase, state: z.enum(incidentStates).optional() },
  }, async input => {
    if (!canManageIncidents(principal)) return toolError('requires role: PolicyAdmin or configured Guardian principal');
    if (isGuardianPrincipal(principal) && (input.state === 'dismissed' || input.state === 'resolved')) {
      return toolError('Guardian principals may not dismiss or resolve incidents');
    }
    const gate = await governedWrite(principal, 'create_incident', input); if (gate) return gate;
    const now = new Date().toISOString();
    const incident: Incident = {
      id: crypto.randomUUID(),
      title: input.title,
      severity: input.severity as Severity,
      state: (input.state ?? 'open') as IncidentState,
      trigger: input.trigger,
      agentIds: input.agentIds ?? [],
      sessionIds: input.sessionIds ?? [],
      decisionIds: input.decisionIds ?? [],
      summary: input.summary,
      report: input.report,
      recommendations: input.recommendations as IncidentRecommendation[] | undefined,
      createdAt: now,
      updatedAt: now,
    };
    const saved = await govStore().createIncident(incident);
    govBus.emit('incident.created', saved);
    return jsonResult(saved);
  });

  server.registerTool('update_incident', {
    title: 'Update incident',
    description: 'Governed write. Requires PolicyAdmin or configured Guardian principal, then PDP approval. Patches incident fields such as state, summary, report and recommendations.',
    inputSchema: {
      incidentId: z.string().min(1), title: z.string().optional(), severity: z.enum(severities).optional(),
      state: z.enum(incidentStates).optional(), summary: z.string().optional(), report: z.string().optional(),
      recommendations: z.array(z.object({ action: z.string(), target: z.string(), rationale: z.string(), status: z.enum(['proposed', 'applied', 'rejected']) })).optional(),
    },
  }, async input => {
    if (!canManageIncidents(principal)) return toolError('requires role: PolicyAdmin or configured Guardian principal');
    if (isGuardianPrincipal(principal) && (input.state === 'dismissed' || input.state === 'resolved')) {
      return toolError('Guardian principals may not dismiss or resolve incidents');
    }
    const gate = await governedWrite(principal, 'update_incident', input); if (gate) return gate;
    const { incidentId, ...patch } = input;
    const incident = await govStore().updateIncident(incidentId, patch as Partial<Incident>);
    if (incident) govBus.emit('incident.updated', incident);
    return incident ? jsonResult(incident) : toolError(`incident not found: ${incidentId}`);
  });

  server.registerTool('acknowledge_incident', {
    title: 'Acknowledge incident',
    description: 'Governed write. Requires PolicyAdmin or configured Guardian principal, then PDP approval. Marks an open incident as investigating and records an acknowledgement note in the summary.',
    inputSchema: { incidentId: z.string().min(1), note: z.string().optional() },
  }, async input => {
    if (!canManageIncidents(principal)) return toolError('requires role: PolicyAdmin or configured Guardian principal');
    const gate = await governedWrite(principal, 'acknowledge_incident', input); if (gate) return gate;
    const existing = await govStore().getIncident(input.incidentId);
    if (!existing) return toolError(`incident not found: ${input.incidentId}`);
    const summary = input.note ? `${existing.summary ? `${existing.summary}\n\n` : ''}Acknowledged by ${principal.id}: ${input.note}` : existing.summary;
    const incident = await govStore().updateIncident(input.incidentId, { state: existing.state === 'open' ? 'investigating' : existing.state, summary });
    if (incident) govBus.emit('incident.updated', incident);
    return incident ? jsonResult(incident) : toolError(`incident not found: ${input.incidentId}`);
  });

  server.registerResource('lane', new ResourceTemplate('lane://{id}', {
    list: async () => {
      const lanes = hasRole(principal, 'Viewer') ? await govStore().listLanes() : [];
      return { resources: lanes.map(l => ({ uri: `lane://${l.lane.id}`, name: l.lane.name ?? l.lane.id, mimeType: l.yaml ? 'application/yaml' : 'application/json' })) };
    },
  }), {
    title: 'Lane definition',
    description: 'Read a lane record as YAML when available, otherwise JSON.',
  }, async (_uri, vars) => {
    if (!hasRole(principal, 'Viewer')) return { contents: [{ uri: `lane://${vars.id}`, text: 'requires role: Viewer' }] };
    const rec = await govStore().getLane(String(vars.id));
    return { contents: [{ uri: `lane://${vars.id}`, mimeType: rec?.yaml ? 'application/yaml' : 'application/json', text: rec ? (rec.yaml ?? JSON.stringify(rec, null, 2)) : 'not found' }] };
  });

  server.registerResource('incident', new ResourceTemplate('incident://{id}', {
    list: async () => {
      const incidents = hasRole(principal, 'Viewer') ? await govStore().listIncidents({ limit: 100 }) : [];
      return { resources: incidents.map(i => ({ uri: `incident://${i.id}`, name: i.title, mimeType: 'application/json' })) };
    },
  }), {
    title: 'Incident report',
    description: 'Read a Guardian/manual incident as JSON.',
  }, async (_uri, vars) => {
    if (!hasRole(principal, 'Viewer')) return { contents: [{ uri: `incident://${vars.id}`, text: 'requires role: Viewer' }] };
    const incident = await govStore().getIncident(String(vars.id));
    return { contents: [{ uri: `incident://${vars.id}`, mimeType: 'application/json', text: incident ? JSON.stringify(incident, null, 2) : 'not found' }] };
  });

  server.registerPrompt('investigate_incident', {
    title: 'Investigate a governance incident',
    description: 'Prompt template for investigating an incident with the monitor MCP tools.',
    argsSchema: { incidentId: z.string().min(1).describe('Incident id to investigate') },
  }, ({ incidentId }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Investigate governance incident ${incidentId}. Read incident://${incidentId}, inspect related decisions, session timelines, blocked actions, and pending approvals. Explain what happened, why, and recommend containment or lane changes without activating them.`,
      },
    }],
  }));

  return server;
}
