import type { ActionRequest, AgentIdentity, Approval, Checkpoint, Decision, DecideOptions, FailMode, FailModeConfig, GoalResponse, ResultResponse, ToolCategory, Verdict } from './types.js';

export interface GovernanceClientOptions {
  baseUrl: string;
  token?: string;
  getToken?: () => string | Promise<string>;
  agent: AgentIdentity;
  failMode?: FailModeConfig;
  timeoutMs?: number;
  approvalPollIntervalMs?: number;
  onDecision?: (decision: Decision) => void | Promise<void>;
}

export type CheckInput = Omit<Partial<ActionRequest>, 'agent'> & { sessionId: string; requestId?: string; checkpoint?: Checkpoint; agent?: Partial<AgentIdentity> };
export interface GuardContext extends Omit<CheckInput, 'args' | 'toolName'> { args?: unknown }
type FetchLike = typeof fetch;

function randomId(prefix: string): string {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (cryptoObj?.randomUUID) return `${prefix}_${cryptoObj.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('Aborted')); }, { once: true });
  });
}

function verdictForFailMode(mode: FailMode): Verdict { return mode === 'open' ? 'allow' : 'deny'; }

export class GovernanceDeniedError extends Error {
  readonly decision: Decision;
  constructor(decision: Decision) {
    super(decision.reason || 'Governance denied the action');
    this.name = 'GovernanceDeniedError';
    this.decision = decision;
  }
}

export class GovernanceClient {
  readonly baseUrl: string;
  readonly agent: AgentIdentity;
  readonly timeoutMs: number;
  readonly approvalPollIntervalMs: number;
  private readonly token?: string;
  private readonly getToken?: () => string | Promise<string>;
  private readonly failMode: FailModeConfig;
  private readonly onDecision?: (decision: Decision) => void | Promise<void>;
  private readonly fetchImpl: FetchLike;

  constructor(options: GovernanceClientOptions & { fetch?: FetchLike }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.agent = options.agent;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.approvalPollIntervalMs = options.approvalPollIntervalMs ?? 1_000;
    this.token = options.token;
    this.getToken = options.getToken;
    this.failMode = options.failMode ?? { default: 'closed', READ: 'open' };
    this.onDecision = options.onDecision;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error('global fetch is required; provide options.fetch in older runtimes');
  }

  async goal(sessionId: string, text: string, source?: string): Promise<GoalResponse> {
    return this.request<GoalResponse>('/v1/goal', { method: 'POST', body: { sessionId, agent: this.agent, text, ...(source ? { source } : {}) } });
  }

  async check(action: CheckInput, options: DecideOptions = { blocking: true, supportsAsk: false }): Promise<Decision> {
    const started = Date.now();
    const request = this.normalizeAction(action);
    const deadlineMs = options.deadlineMs ?? this.timeoutMs;
    try {
      let decision = await this.request<Decision>('/v1/decide', {
        method: 'POST',
        timeoutMs: deadlineMs,
        body: { ...request, options: { blocking: options.blocking ?? true, supportsAsk: options.supportsAsk ?? false, deadlineMs } }
      });
      if (decision.verdict === 'escalate' && decision.approvalId) {
        const remaining = Math.max(0, deadlineMs - (Date.now() - started));
        decision = await this.resolveEscalation(decision, remaining);
      }
      await this.emitDecision(decision);
      return decision;
    } catch (error) {
      const decision = this.failModeDecision(request, error);
      await this.emitDecision(decision);
      return decision;
    }
  }

  async observeResult(input: { requestId: string; sessionId: string; toolName?: string; result: string; agent?: Partial<AgentIdentity> }): Promise<ResultResponse> {
    try {
      return await this.request<ResultResponse>('/v1/result', {
        method: 'POST',
        body: { requestId: input.requestId, sessionId: input.sessionId, agent: { ...this.agent, ...input.agent }, toolName: input.toolName, result: input.result }
      });
    } catch (error) {
      return { tainted: false, reason: error instanceof Error ? error.message : 'PDP unavailable' };
    }
  }

  async checkResponse(input: { sessionId: string; text: string; requestId?: string; tokens?: ActionRequest['tokens']; meta?: Record<string, unknown> }): Promise<Decision> {
    return this.check({ sessionId: input.sessionId, requestId: input.requestId, checkpoint: 'response', text: input.text, tokens: input.tokens, meta: input.meta });
  }

  guard<Args extends unknown[], R>(toolName: string, fn: (...args: Args) => R | Promise<R>) {
    return async (...args: Args): Promise<Awaited<R>> => {
      const context = this.extractGuardContext(args);
      const decision = await this.check({ ...context, toolName, args: context.args ?? (args.length <= 1 ? args[0] : args), checkpoint: context.checkpoint ?? 'pre_tool' });
      if (decision.verdict === 'deny') throw new GovernanceDeniedError(decision);
      return await fn(...args);
    };
  }

  private extractGuardContext(args: unknown[]): GuardContext {
    const last = args[args.length - 1] as { governance?: GuardContext; sessionId?: string; requestId?: string } | undefined;
    const context = last?.governance ?? (last?.sessionId ? last as GuardContext : undefined);
    if (!context?.sessionId) throw new Error('guarded tool calls require a sessionId on the last argument or last.governance');
    return { ...context, args: context.args ?? (args.length === 1 ? args[0] : args.slice(0, -1)) };
  }

  private normalizeAction(action: CheckInput): ActionRequest {
    return {
      requestId: action.requestId ?? randomId('gov_req'),
      sessionId: action.sessionId,
      checkpoint: action.checkpoint ?? 'pre_tool',
      agent: { ...this.agent, ...action.agent },
      ...(action.toolName !== undefined ? { toolName: action.toolName } : {}),
      ...(action.category !== undefined ? { category: action.category } : {}),
      ...(action.mcpServer !== undefined ? { mcpServer: action.mcpServer } : {}),
      ...(action.args !== undefined ? { args: action.args } : {}),
      ...(action.result !== undefined ? { result: action.result } : {}),
      ...(action.text !== undefined ? { text: action.text } : {}),
      ...(action.tokens !== undefined ? { tokens: action.tokens } : {}),
      ...(action.occurredAt !== undefined ? { occurredAt: action.occurredAt } : {}),
      ...(action.meta !== undefined ? { meta: action.meta } : {})
    };
  }

  private failModeFor(category?: ToolCategory): FailMode {
    if (typeof this.failMode === 'string') return this.failMode;
    if (category && this.failMode[category]) return this.failMode[category]!;
    return this.failMode.default ?? 'closed';
  }

  private failModeDecision(request: ActionRequest, error: unknown): Decision {
    const failMode = this.failModeFor(request.category);
    const verdict = verdictForFailMode(failMode);
    const reason = error instanceof Error ? error.message : 'PDP unavailable';
    return {
      id: randomId('local_decision'),
      requestId: request.requestId,
      sessionId: request.sessionId,
      agentId: request.agent.agentId ?? request.agent.externalId ?? request.agent.name ?? 'unknown',
      laneId: 'local-fail-mode',
      laneVersion: 0,
      mode: 'enforce',
      checkpoint: request.checkpoint,
      ...(request.toolName !== undefined ? { toolName: request.toolName } : {}),
      ...(request.category !== undefined ? { category: request.category } : {}),
      verdict,
      effectiveVerdict: verdict,
      wouldDeny: verdict === 'deny',
      stage: 'fail_mode',
      reason: `PDP unavailable; fail-${failMode}: ${reason}`,
      ruleIds: ['local-fail-mode'],
      riskLevel: null,
      tainted: false,
      latencyMs: 0,
      createdAt: new Date().toISOString()
    };
  }

  private async resolveEscalation(decision: Decision, timeoutMs: number): Promise<Decision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('approval polling timed out')), timeoutMs);
    try {
      while (!controller.signal.aborted) {
        const approval = await this.request<Approval>(`/v1/approvals/${encodeURIComponent(decision.approvalId!)}`, { method: 'GET', signal: controller.signal, timeoutMs: Math.min(this.approvalPollIntervalMs, timeoutMs) });
        if (approval.state !== 'pending') return this.decisionFromApproval(decision, approval);
        await sleep(this.approvalPollIntervalMs, controller.signal);
      }
      throw new Error('approval polling timed out');
    } finally {
      clearTimeout(timer);
    }
  }

  private decisionFromApproval(decision: Decision, approval: Approval): Decision {
    const allowed = approval.state === 'approved';
    return {
      ...decision,
      verdict: allowed ? 'allow' : 'deny',
      effectiveVerdict: allowed ? 'allow' : 'deny',
      wouldDeny: !allowed,
      stage: 'human',
      reason: approval.resolutionNote ?? (allowed ? 'Human approval granted' : `Human approval ${approval.state}`),
      approver: approval.resolvedBy ?? decision.approver
    };
  }

  private async request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('PDP request timed out')), init.timeoutMs ?? this.timeoutMs);
    init.signal?.addEventListener('abort', () => controller.abort(init.signal?.reason), { once: true });
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const token = this.token ?? (this.getToken ? await this.getToken() : undefined);
      if (token) headers.authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`PDP ${init.method} ${path} failed: ${response.status} ${response.statusText}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async emitDecision(decision: Decision): Promise<void> {
    if (this.onDecision) await this.onDecision(decision);
  }
}
