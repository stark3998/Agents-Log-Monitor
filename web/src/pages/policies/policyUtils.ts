import type { Policy, PolicyRecord } from '../../api/policies';
import { toYaml } from '../../lib/yaml';

export function newPolicy(id = ''): Policy {
  return { id, version: 1, name: '', description: '', enabled: true, global: false, mode: 'inherit', severity: 'medium', tags: [], scope: { surfaces: [], agents: [], repos: [], users: [] }, rules: [], meta: { source: 'ui' } };
}
export function policyToYaml(policy: Policy): string {
  const clean: Policy = { ...policy, name: policy.name?.trim() || undefined, description: policy.description?.trim() || undefined, tags: policy.tags?.filter(Boolean), scope: { surfaces: policy.scope?.surfaces?.filter(Boolean), agents: policy.scope?.agents?.filter(s => s.trim()), repos: policy.scope?.repos?.filter(s => s.trim()), users: policy.scope?.users?.filter(s => s.trim()) }, rules: policy.rules.map(r => ({ ...r, description: r.description?.trim() || undefined })) };
  return toYaml(clean as unknown as Record<string, unknown>);
}
export function recordYaml(rec: PolicyRecord): string { return rec.yaml ?? policyToYaml(rec.policy); }
