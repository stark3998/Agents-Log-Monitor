import crypto from 'crypto';
import { govBus } from '../events';
import { govStore } from '../store';
import { appliesToMatches } from '../lanes/glob';
import type { ActionRequest, Lane, LaneCondition, Policy, PolicyAction, RegisteredAgent } from '../types';

const BUCKETS: PolicyAction[] = ['deny', 'approve', 'judge', 'allow', 'alert'];
const CACHE_TTL_MS = 5_000;

let cached: { at: number; policies: Policy[] } | null = null;
govBus.on('policy.updated', () => { cached = null; });

export function invalidatePolicyCache(): void { cached = null; }

/** Active + enabled policies (short TTL cache so multi-replica cloud deployments converge). */
export async function activePolicies(): Promise<Policy[]> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.policies;
  const recs = await govStore().listPolicies(['active']);
  const policies = recs.filter(r => r.status === 'active' && r.policy.enabled !== false).map(r => r.policy);
  cached = { at: Date.now(), policies };
  return policies;
}

/** Policies that apply to this lane and request: global ones in scope, plus those the lane attaches. */
export function applicablePolicies(lane: Lane, policies: Policy[], agent: RegisteredAgent, req: ActionRequest): Policy[] {
  const attached = new Set(lane.policies ?? []);
  return policies.filter(p => p.enabled !== false
    && (p.global || attached.has(p.id))
    && appliesToMatches(p.scope, agent, req));
}

function policyRuleToCondition(p: Policy, rule: Policy['rules'][number]): LaneCondition {
  const { action: _action, id, ...cond } = rule;
  return {
    ...cond,
    id: `policy:${p.id}/${id}`,
    description: rule.description ?? `${p.name ?? p.id}: ${id}`,
    policyId: p.id,
    policyVersion: p.version,
    modeOverride: p.mode === 'enforce' || p.mode === 'observe' ? p.mode : undefined,
  };
}

/**
 * Merge policy rules into a copy of the lane. Lane rules keep their position; policy rules are
 * appended per bucket in policy id order. `meta.policyStamp` changes whenever the applied set does,
 * so decision caches keyed on the lane stay correct.
 */
export function mergePolicies(lane: Lane, policies: Policy[]): Lane {
  if (!policies.length) return lane;
  const sorted = [...policies].sort((a, b) => a.id.localeCompare(b.id));
  const rules: Lane['rules'] = {
    deny: [...(lane.rules?.deny ?? [])],
    approve: [...(lane.rules?.approve ?? [])],
    judge: [...(lane.rules?.judge ?? [])],
    allow: [...(lane.rules?.allow ?? [])],
    alert: [...(lane.rules?.alert ?? [])],
  };
  for (const p of sorted) {
    for (const r of p.rules ?? []) {
      if (!BUCKETS.includes(r.action)) continue;
      rules[r.action]!.push(policyRuleToCondition(p, r));
    }
  }
  const applied = sorted.map(p => ({ id: p.id, version: p.version, global: p.global }));
  const policyStamp = crypto.createHash('sha1').update(applied.map(a => `${a.id}@${a.version}`).join(',')).digest('hex').slice(0, 12);
  return { ...lane, rules, meta: { ...lane.meta, appliedPolicies: applied, policyStamp } };
}

export async function withPolicies(lane: Lane, agent: RegisteredAgent, req: ActionRequest): Promise<Lane> {
  const policies = await activePolicies();
  return mergePolicies(lane, applicablePolicies(lane, policies, agent, req));
}
