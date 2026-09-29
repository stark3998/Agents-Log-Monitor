import crypto from 'crypto';
import { classifyTool, type ToolCategory } from '../analytics/classify';
import type { ActionRequest, AgentIdentity, Decision, FailMode, Lane } from '../governance/types';
import type { GatewayConfig } from './config';

export interface ResultScanRequest {
  requestId: string;
  sessionId: string;
  agent: AgentIdentity;
  toolName?: string;
  result: string;
  authorization?: string;
}

export interface ResultScanResponse {
  tainted: boolean;
  reason?: string;
}

export type PdpTokenProvider = () => Promise<string | undefined>;

interface LaneCacheEntry { lane: Lane; expires: number; lastUsed: number }
const LANE_CACHE_TTL_MS = 60_000;
const LANE_CACHE_MAX = 1_000;

export class PdpClient {
  private readonly laneCache = new Map<string, LaneCacheEntry>();

  /**
   * `credential` is a static bearer token, or a provider (managed identity). With a provider, the
   * gateway always authenticates as itself; caller identity travels in the ActionRequest.
   */
  constructor(private readonly config: GatewayConfig, private readonly credential?: string | PdpTokenProvider) {}

  async decide(
    request: ActionRequest,
    authorization?: string,
    timeoutMs = this.config.decideTimeoutMs,
  ): Promise<Decision> {
    const category = request.category ?? this.deriveCategory(request.toolName, request.mcpServer);
    const body = {
      ...request,
      category,
      options: { blocking: true, supportsAsk: false, deadlineMs: timeoutMs },
    };
    try {
      const decision = await this.fetchJson<Decision>('/v1/decide', {
        method: 'POST',
        body: JSON.stringify(body),
        authorization,
        timeoutMs,
      });
      if (decision.verdict === 'ask' || decision.verdict === 'escalate') {
        return { ...decision, verdict: 'deny', effectiveVerdict: 'deny', reason: decision.reason || 'Decision is pending approval' };
      }
      return decision;
    } catch (error) {
      return this.failModeDecision(request, category, error);
    }
  }

  async observeResult(request: ResultScanRequest, timeoutMs = this.config.resultTimeoutMs): Promise<ResultScanResponse | null> {
    try {
      return await this.fetchJson<ResultScanResponse>('/v1/result', {
        method: 'POST',
        body: JSON.stringify({
          requestId: request.requestId,
          sessionId: request.sessionId,
          agent: request.agent,
          toolName: request.toolName,
          result: request.result,
        }),
        authorization: request.authorization,
        timeoutMs,
      });
    } catch (error) {
      console.warn(`PDP result scan failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async getEffectiveLane(agent: AgentIdentity, authorization?: string, timeoutMs = 2_000): Promise<Lane | null> {
    const key = this.laneCacheKey(agent);
    const cached = this.getCachedLane(key);
    if (cached) return cached;
    const query = new URLSearchParams();
    query.set('surface', agent.surface);
    if (agent.externalId ?? agent.agentId) query.set('externalId', agent.externalId ?? agent.agentId ?? '');
    try {
      const lane = await this.fetchJson<Lane>(`/v1/lanes/effective?${query.toString()}`, {
        method: 'GET',
        authorization,
        timeoutMs,
      });
      this.setCachedLane(key, lane);
      return lane;
    } catch {
      return null;
    }
  }

  categoryFailMode(agent: AgentIdentity, category: ToolCategory): FailMode {
    const lane = this.getCachedLane(this.laneCacheKey(agent));
    return lane?.failMode?.[category] ?? lane?.failMode?.default ?? this.config.failModeDefault;
  }

  deriveCategory(toolName?: string, mcpServer?: string): ToolCategory {
    const category = classifyTool(toolName);
    return category === 'OTHER' && mcpServer ? 'MCP' : category;
  }

  private failModeDecision(request: ActionRequest, category: ToolCategory, error: unknown): Decision {
    const failMode = this.categoryFailMode(request.agent, category);
    const allow = failMode === 'open';
    const reason = `PDP unavailable; fail-${failMode} applied (${error instanceof Error ? error.message : String(error)})`;
    return {
      id: `fail-${crypto.randomUUID()}`,
      requestId: request.requestId,
      sessionId: request.sessionId,
      agentId: request.agent.agentId ?? request.agent.externalId ?? 'unknown',
      laneId: 'cached-or-default',
      laneVersion: 0,
      mode: 'enforce',
      checkpoint: request.checkpoint,
      toolName: request.toolName,
      category,
      verdict: allow ? 'allow' : 'deny',
      effectiveVerdict: allow ? 'allow' : 'deny',
      wouldDeny: !allow,
      stage: 'fail_mode',
      reason,
      ruleIds: [],
      tainted: false,
      latencyMs: 0,
      createdAt: new Date().toISOString(),
    };
  }

  private async fetchJson<T>(path: string, options: {
    method: 'GET' | 'POST';
    body?: string;
    authorization?: string;
    timeoutMs: number;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (options.body) headers['content-type'] = 'application/json';
      const auth = typeof this.credential === 'function'
        ? await this.credential().then(t => (t ? `Bearer ${t}` : options.authorization))
        : options.authorization ?? (this.credential ? `Bearer ${this.credential}` : undefined);
      if (auth) headers.authorization = auth;
      const response = await fetch(`${this.config.pdpUrl}${path}`, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private laneCacheKey(agent: AgentIdentity): string {
    return `${agent.surface}:${agent.externalId ?? agent.agentId ?? agent.name ?? ''}`;
  }

  private getCachedLane(key: string): Lane | null {
    const cached = this.laneCache.get(key);
    if (!cached) return null;
    const now = Date.now();
    if (cached.expires <= now) {
      this.laneCache.delete(key);
      return null;
    }
    cached.lastUsed = now;
    this.laneCache.delete(key);
    this.laneCache.set(key, cached);
    return cached.lane;
  }

  private setCachedLane(key: string, lane: Lane): void {
    const now = Date.now();
    this.laneCache.delete(key);
    this.laneCache.set(key, { lane, expires: now + LANE_CACHE_TTL_MS, lastUsed: now });
    while (this.laneCache.size > LANE_CACHE_MAX) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [candidate, entry] of this.laneCache) {
        if (entry.expires <= now) { oldestKey = candidate; break; }
        if (entry.lastUsed < oldest) { oldest = entry.lastUsed; oldestKey = candidate; }
      }
      if (!oldestKey) break;
      this.laneCache.delete(oldestKey);
    }
  }
}
