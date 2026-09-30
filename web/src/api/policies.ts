import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, apiSend } from './client';
import type { Lane } from './governance';

export type PolicyAction = 'deny' | 'approve' | 'judge' | 'allow' | 'alert';
export type PolicyMode = 'inherit' | 'observe' | 'enforce';
export type PolicySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type PolicyStatus = 'active' | 'draft' | 'proposed' | 'archived';
export type Operation = 'read' | 'write' | 'delete' | 'execute';

export interface LaneCondition {
  id?: string; category?: string; tool?: string; mcpServer?: string; risk?: string; path?: string; domain?: string; command?: string; detector?: string; tainted?: boolean; description?: string;
  filesystem?: string[]; network?: string[]; credential?: string[]; capability?: string[]; mcpCategory?: string[]; classifier?: string[]; operation?: Operation[];
  policyId?: string; policyVersion?: number; modeOverride?: 'observe' | 'enforce';
}
export interface PolicyRule extends LaneCondition { id: string; action: PolicyAction }
export interface PolicyScope { surfaces?: string[]; agents?: string[]; repos?: string[]; users?: string[] }
export interface Policy { id: string; version: number; name?: string; description?: string; enabled: boolean; global: boolean; scope?: PolicyScope; mode?: PolicyMode; severity?: PolicySeverity; tags?: string[]; rules: PolicyRule[]; meta?: Record<string, unknown> }
export interface PolicyRecord { policy: Policy; status: PolicyStatus; updatedAt: string; updatedBy?: string; yaml?: string }
export interface PresetEntry { id: string; group: string; label: string; pattern: string | string[]; description: string; subsetOf?: string; identities?: string[] }
export type PresetCatalog = { filesystem: PresetEntry[]; network: PresetEntry[]; credential: PresetEntry[]; capability: PresetEntry[]; mcpCategory: PresetEntry[] };
export type ClassifierCategory = 'Secrets' | 'PII' | 'Financial' | 'Healthcare' | 'Legal' | 'Government' | 'Infrastructure' | 'Code' | 'Prompt Injection' | 'Education';
export type ClassifierSensitivity = 'Low' | 'Medium' | 'High';
export interface Classifier { code: string; label: string; description: string; category: ClassifierCategory; sensitivity: ClassifierSensitivity; contextRequired: boolean; isActive: boolean; enforceable: boolean; source: 'builtin' | 'custom'; aliasOf?: string; pattern: string; contextPattern?: string }
export interface CustomClassifierDef { code: string; label: string; description?: string; category: ClassifierCategory; sensitivity: ClassifierSensitivity; pattern: string; flags?: string; contextPattern?: string; isActive: boolean; enforceable: boolean }
export interface ClassifierConfig { overrides: Record<string, { isActive?: boolean; enforceable?: boolean }>; custom: CustomClassifierDef[] }
export interface ClassifiersResponse { items: Classifier[]; config: ClassifierConfig }
export interface ClassifierDetection { key: string; label: string; cls: string; maskedSample: string; category?: string; sensitivity?: string }
export interface ClassifierTestResult { detections: ClassifierDetection[]; errors: string[] }
export interface SimulationSample { eventId: string | number; sessionId: string; tool?: string; summary: string; verdict: string; ruleIds: string[] }
export interface SimulationResult { evaluated: number; wouldAllow: number; wouldDeny: number; wouldJudge: number; wouldApprove: number; wouldAlert: number; ruleHits: Record<string, number>; samples: SimulationSample[] }
export interface PolicyValidation { ok: boolean; policy?: Policy; errors: string[] }
export interface EffectivePolicies { lane: Lane; policies: { id: string; version: number; global: boolean; scope?: PolicyScope; mode?: PolicyMode }[]; missing: string[] }

export const policyKeys = {
  all: ['gov', 'policies'] as const,
  lists: () => ['gov', 'policies', 'list'] as const,
  list: (status?: string) => ['gov', 'policies', 'list', status ?? 'all'] as const,
  detail: (id: string, version?: number) => ['gov', 'policies', 'detail', id, version ?? 'current'] as const,
  versions: (id: string) => ['gov', 'policies', 'versions', id] as const,
  presets: ['gov', 'policies', 'presets'] as const,
  classifiers: ['gov', 'policies', 'classifiers'] as const,
  effective: (laneId?: string) => ['gov', 'policies', 'effective', laneId ?? ''] as const,
};
const enc = encodeURIComponent;
const invalidate = (qc: QueryClient, ...keys: (readonly unknown[])[]) => Promise.all(keys.map(k => qc.invalidateQueries({ queryKey: k })));

export const usePolicies = (status?: string) => useQuery({ queryKey: policyKeys.list(status), queryFn: () => api<PolicyRecord[]>('gov/policies', { status }) });
export const usePolicy = (id: string | null, version?: number) => useQuery({ queryKey: policyKeys.detail(id ?? '', version), queryFn: () => api<PolicyRecord>(`gov/policies/${enc(id!)}`, { version: version != null ? String(version) : undefined }), enabled: !!id });
export const usePolicyVersions = (id: string | null) => useQuery({ queryKey: policyKeys.versions(id ?? ''), queryFn: () => api<PolicyRecord[]>(`gov/policies/${enc(id!)}/versions`), enabled: !!id });
export const usePresets = () => useQuery({ queryKey: policyKeys.presets, queryFn: () => api<PresetCatalog>('gov/presets') });
export const useClassifiers = () => useQuery({ queryKey: policyKeys.classifiers, queryFn: () => api<ClassifiersResponse>('gov/classifiers') });
export const useEffectivePolicies = (laneId: string | null) => useQuery({ queryKey: policyKeys.effective(laneId ?? ''), queryFn: () => api<EffectivePolicies>('gov/policies/effective', { laneId: laneId ?? undefined }), enabled: !!laneId });

export const validatePolicyYaml = (yaml: string) => apiSend<PolicyValidation>('POST', 'gov/policies/validate', { yaml });
export const validatePolicyObject = (policy: Policy) => apiSend<PolicyValidation>('POST', 'gov/policies/validate', { policy });
export const simulatePolicy = (body: { yaml?: string; policy?: Policy; from?: string; to?: string; limit?: number }) => apiSend<SimulationResult>('POST', 'gov/policies/simulate', body);
export const testClassifiers = (body: { text: string; codes?: string[]; custom?: CustomClassifierDef }) => apiSend<ClassifierTestResult>('POST', 'gov/classifiers/test', body);

export function useSavePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { yaml?: string; policy?: Policy; status?: PolicyStatus }) => apiSend<PolicyRecord>('POST', 'gov/policies', body),
    onSuccess: rec => invalidate(qc, policyKeys.lists(), policyKeys.versions(rec.policy.id), policyKeys.detail(rec.policy.id)),
  });
}
export function usePolicyVersionAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, version, action }: { id: string; version: number; action: 'activate' | 'archive' }) => apiSend<PolicyRecord>('POST', `gov/policies/${enc(id)}/versions/${version}/${action}`),
    onSuccess: (_rec, v) => invalidate(qc, policyKeys.lists(), policyKeys.versions(v.id), policyKeys.detail(v.id)),
  });
}
export function usePatchClassifier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, patch }: { code: string; patch: { isActive?: boolean; enforceable?: boolean } }) => apiSend<Classifier>('PATCH', `gov/classifiers/${enc(code)}`, patch),
    onMutate: async ({ code, patch }) => {
      await qc.cancelQueries({ queryKey: policyKeys.classifiers });
      const prev = qc.getQueryData<ClassifiersResponse>(policyKeys.classifiers);
      if (prev) qc.setQueryData<ClassifiersResponse>(policyKeys.classifiers, { ...prev, items: prev.items.map(c => c.code === code ? { ...c, ...patch } : c) });
      return { prev };
    },
    onError: (_err, _vars, ctx) => { if (ctx?.prev) qc.setQueryData(policyKeys.classifiers, ctx.prev); },
    onSettled: () => { void qc.invalidateQueries({ queryKey: policyKeys.classifiers }); },
  });
}
export function usePutClassifiersConfig() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (config: ClassifierConfig) => apiSend<ClassifiersResponse>('PUT', 'gov/classifiers/config', config), onSuccess: r => qc.setQueryData(policyKeys.classifiers, r) });
}
