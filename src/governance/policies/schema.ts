import YAML from 'yaml';
import { z } from 'zod';
import { isClassifierEnforceable, listClassifiers, resolveClassifierCode } from '../../analytics/classifiers/config';
import { isKnownCapability } from '../../policies/presets';
import type { LaneCondition, Policy, PolicyRule, Surface } from '../types';

const categories = ['READ', 'WRITE', 'EXEC', 'NETWORK', 'AGENT', 'MCP', 'OTHER'] as const;
const surfaces = ['claude-code', 'copilot-cli', 'copilot-cloud-agent', 'vscode', 'mcp-gateway', 'sdk', 'foundry', 'copilot-studio', 'monitor', 'unknown'] as const;

const strArray = z.array(z.string()).default([]);
const commandArray = z.array(z.string()).superRefine((patterns, ctx) => {
  for (let i = 0; i < patterns.length; i++) {
    try { new RegExp(patterns[i]); } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid command regex "${patterns[i]}": ${(err as Error).message}`, path: [i] });
    }
  }
}).default([]);

/** Condition fields shared by lane rules and policy rules. */
export const conditionShape = {
  id: z.string().optional(),
  category: z.array(z.enum(categories)).optional(),
  tool: strArray.optional(),
  mcpServer: strArray.optional(),
  risk: strArray.optional(),
  path: strArray.optional(),
  domain: strArray.optional(),
  command: commandArray.optional(),
  detector: strArray.optional(),
  tainted: z.boolean().optional(),
  filesystem: strArray.optional(),
  network: strArray.optional(),
  credential: strArray.optional(),
  capability: strArray.optional(),
  mcpCategory: strArray.optional(),
  classifier: strArray.optional(),
  operation: z.array(z.enum(['read', 'write', 'delete', 'execute'])).optional(),
  description: z.string().optional(),
};

export const appliesToSchema = z.object({
  surfaces: z.array(z.union([z.enum(surfaces), z.literal('*')])).optional(),
  agents: strArray.optional(), repos: strArray.optional(), users: strArray.optional(),
}).passthrough();

const ruleSchema = z.object({
  ...conditionShape,
  id: z.string().min(1),
  action: z.enum(['deny', 'approve', 'judge', 'allow', 'alert']),
}).passthrough();

const policySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/, 'lowercase letters, digits, dot, dash, underscore'),
  version: z.number().int().positive().default(1),
  name: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  global: z.boolean().default(false),
  scope: appliesToSchema.optional(),
  mode: z.enum(['inherit', 'observe', 'enforce']).default('inherit'),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  tags: z.array(z.string()).optional(),
  rules: z.array(ruleSchema).default([]),
  meta: z.object({
    owner: z.string().optional(), createdBy: z.string().optional(),
    source: z.enum(['file', 'ui', 'ai-draft', 'builtin']).optional(), notes: z.string().optional(),
  }).optional(),
}).passthrough();

const MATCH_FIELDS: (keyof LaneCondition)[] = [
  'category', 'tool', 'mcpServer', 'risk', 'path', 'domain', 'command', 'detector', 'tainted',
  'filesystem', 'network', 'credential', 'capability', 'mcpCategory', 'classifier', 'operation',
];

function hasMatchField(c: LaneCondition): boolean {
  return MATCH_FIELDS.some(k => {
    const v = c[k];
    return Array.isArray(v) ? v.length > 0 : v != null;
  });
}

/** Semantic checks on preset-aware condition fields. Returns human-readable problems. */
export function conditionProblems(c: LaneCondition, where: string): string[] {
  const out: string[] = [];
  for (const cap of c.capability ?? []) {
    if (!isKnownCapability(cap)) out.push(`${where}.capability: unknown capability "${cap}"`);
  }
  if (c.classifier?.length) {
    const known = new Set(listClassifiers().map(x => x.code));
    for (const code of c.classifier) {
      if (!known.has(code)) out.push(`${where}.classifier: unknown classifier "${code}"`);
      else if (!isClassifierEnforceable(code) && !isClassifierEnforceable(resolveClassifierCode(code))) out.push(`${where}.classifier: "${code}" is not enforceable`);
    }
  }
  return out;
}

export function validatePolicy(input: unknown): { ok: boolean; policy?: Policy; errors: string[] } {
  try {
    const parsed = policySchema.parse(input) as Policy;
    const errors: string[] = [];
    const ids = new Set<string>();
    parsed.rules.forEach((r, i) => {
      if (ids.has(r.id)) errors.push(`rules.${i}.id: duplicate rule id "${r.id}"`);
      ids.add(r.id);
      if (!hasMatchField(r as LaneCondition)) errors.push(`rules.${i}: needs at least one match field (a rule with no conditions would match every action)`);
      errors.push(...conditionProblems(r as LaneCondition, `rules.${i}`));
    });
    const scope = parsed.scope ?? {};
    const policy: Policy = {
      ...parsed,
      scope: {
        surfaces: (scope.surfaces?.length ? scope.surfaces : ['*']) as (Surface | '*')[],
        agents: scope.agents?.length ? scope.agents : ['*'],
        repos: scope.repos?.length ? scope.repos : ['*'],
        users: scope.users?.length ? scope.users : ['*'],
      },
    };
    return errors.length ? { ok: false, errors } : { ok: true, policy, errors: [] };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, errors: err.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
    return { ok: false, errors: [(err as Error).message] };
  }
}

export function parsePolicyYaml(yaml: string): Policy {
  const v = validatePolicy(YAML.parse(yaml));
  if (!v.ok || !v.policy) throw new Error(v.errors.join('; '));
  return v.policy;
}

export function validatePolicyYaml(yaml: string): { ok: boolean; policy?: Policy; errors: string[] } {
  try { return validatePolicy(YAML.parse(yaml)); } catch (err) { return { ok: false, errors: [(err as Error).message] }; }
}

export type { PolicyRule };
