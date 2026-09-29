import crypto from 'crypto';
import type { Registry as RegistryContract } from '../contracts';
import type { AgentIdentity, RegisteredAgent } from '../types';
import { govBus } from '../events';
import { govStore } from '../store';

const CACHE_TTL_MS = 10_000;
const LAST_SEEN_MIN_MS = 60_000;
interface CacheEntry { agent: RegisteredAgent; expires: number }

function nowIso(): string { return new Date().toISOString(); }
const PLACEHOLDER_EXTERNAL_IDS = new Set(['', 'main', 'copilot-cli', 'copilot-cloud-agent', 'local']);
function isIdentifyingExternalId(externalId?: string): externalId is string {
  const id = externalId?.trim() ?? '';
  return id.length > 0 && !PLACEHOLDER_EXTERNAL_IDS.has(id.toLowerCase());
}
function stableId(a: AgentIdentity): string {
  const basis = [a.surface, a.user || '', a.endpoint || '', isIdentifyingExternalId(a.externalId) ? a.externalId : ''].join('|');
  return `${a.surface}-${crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16)}`;
}

class DefaultRegistry implements RegistryContract {
  private byId = new Map<string, CacheEntry>();
  private byExt = new Map<string, CacheEntry>();

  private cache(a: RegisteredAgent): RegisteredAgent {
    const e = { agent: a, expires: Date.now() + CACHE_TTL_MS };
    this.byId.set(a.id, e);
    if (isIdentifyingExternalId(a.externalId)) this.byExt.set(`${a.surface}|${a.externalId}`, e);
    return a;
  }

  private cachedById(id?: string): RegisteredAgent | undefined {
    if (!id) return undefined;
    const e = this.byId.get(id);
    return e && e.expires > Date.now() ? e.agent : undefined;
  }

  private cachedByExt(surface: string, externalId?: string): RegisteredAgent | undefined {
    if (!externalId) return undefined;
    const e = this.byExt.get(`${surface}|${externalId}`);
    return e && e.expires > Date.now() ? e.agent : undefined;
  }

  async identify(identity: AgentIdentity): Promise<RegisteredAgent> {
    const identifyingExternalId = isIdentifyingExternalId(identity.externalId) ? identity.externalId : undefined;
    const cached = this.cachedById(identity.agentId) ?? (identifyingExternalId ? this.cachedByExt(identity.surface, identifyingExternalId) : undefined);
    if (cached) return this.touch(cached);
    let agent = identity.agentId ? await govStore().getAgent(identity.agentId) : undefined;
    if (!agent && identifyingExternalId) agent = await govStore().findAgentByExternalId(identity.surface, identifyingExternalId);
    const now = nowIso();
    if (!agent) {
      agent = {
        id: identity.agentId ?? stableId(identity),
        name: identity.name || identity.externalId || identity.surface,
        surface: identity.surface,
        externalId: identity.externalId,
        entraAgentId: identity.entraAgentId,
        owner: identity.user,
        status: 'active',
        discovered: true,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      agent = await govStore().upsertAgent(agent);
      govBus.emit('agent.updated', agent);
      return this.cache(agent);
    }
    return this.touch(agent);
  }

  private async touch(agent: RegisteredAgent): Promise<RegisteredAgent> {
    if (Date.now() - Date.parse(agent.lastSeenAt) < LAST_SEEN_MIN_MS) return this.cache(agent);
    const next = { ...agent, lastSeenAt: nowIso() };
    const saved = await govStore().upsertAgent(next);
    govBus.emit('agent.updated', saved);
    return this.cache(saved);
  }

  async setStatus(agentId: string, status: RegisteredAgent['status'], reason: string, by: string): Promise<RegisteredAgent | undefined> {
    const agent = await govStore().getAgent(agentId);
    if (!agent) return undefined;
    const next = { ...agent, status, statusReason: reason || `${status} by ${by}`, lastSeenAt: nowIso() };
    const saved = await govStore().upsertAgent(next);
    govBus.emit('agent.updated', saved);
    return this.cache(saved);
  }
}

let current: RegistryContract = new DefaultRegistry();
export function setRegistry(next: RegistryContract): void { current = next; }
export const registry: RegistryContract = {
  identify: (...args) => current.identify(...args),
  setStatus: (...args) => current.setStatus(...args),
};
export default registry;
