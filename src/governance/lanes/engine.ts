import path from 'path';
import { govStore } from '../store';
import type { ActionFeatures } from '../features';
import type { LaneEngine, RuleEvaluation, RuleMatch } from '../contracts';
import type { ActionRequest, Lane, LaneCondition, RegisteredAgent, RiskLevel } from '../types';
import { riskRank } from '../../analytics/risk';
import { resolveClassifierCode } from '../../analytics/classifiers/config';
import {
  capabilityMatches, expandHostValues, expandPathValues, hostMatches, mcpCategoryMatches,
} from '../../policies/presets';
import { withPolicies } from '../policies';
import { syncLaneFilesOnce } from './loader';
import { syncPolicyFilesOnce } from '../policies/loader';
import { anyGlob, appliesToMatches, globMatch, globToRegExp } from './glob';

export { anyGlob, appliesToMatches, globMatch, globToRegExp };

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const commandRegexCache = new Map<string, RegExp | null>();
const warnedInvalidCommandRegex = new Set<string>();
const expansionCache = new Map<string, string[]>();

export function expandPattern(input: string, workspace?: string): string {
  let out = input;
  if (workspace) out = out.replace(/\$\{workspace\}/g, workspace);
  if (out === '~' || out.startsWith('~/') || out.startsWith('~\\')) {
    out = path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', out.slice(2));
  }
  return out.replace(/\\/g, '/');
}

function commandRegex(pattern: string): RegExp | null {
  if (commandRegexCache.has(pattern)) return commandRegexCache.get(pattern) ?? null;
  try {
    const re = new RegExp(pattern, 'i');
    commandRegexCache.set(pattern, re);
    return re;
  } catch (err) {
    commandRegexCache.set(pattern, null);
    if (!warnedInvalidCommandRegex.has(pattern)) {
      warnedInvalidCommandRegex.add(pattern);
      console.warn(`[lanes] invalid command regex "${pattern}" skipped: ${(err as Error).message}`);
    }
    return null;
  }
}

function applies(lane: Lane, agent: RegisteredAgent, req: ActionRequest): boolean {
  return appliesToMatches(lane.appliesTo, agent, req);
}

function cachedExpansion(key: string, compute: () => string[]): string[] {
  let hit = expansionCache.get(key);
  if (!hit) {
    hit = compute();
    if (expansionCache.size > 2000) expansionCache.clear();
    expansionCache.set(key, hit);
  }
  return hit;
}

/** Action paths made absolute: `~` expanded, relative paths resolved against the workspace. */
function absolutePaths(paths: string[], workspace?: string): string[] {
  return paths.map(p => {
    const e = expandPattern(p, workspace);
    if (/^([a-z]:)?\//i.test(e)) return e;
    return workspace ? path.posix.join(workspace.replace(/\\/g, '/'), e) : `./${e.replace(/^\.\//, '')}`;
  });
}

function presetPathMatch(kind: 'filesystem' | 'credential', values: string[], f: ActionFeatures, workspace?: string): boolean {
  const globs = cachedExpansion(`${kind}|${workspace ?? ''}|${values.join('\n')}`, () => expandPathValues(kind, values, { workspace }));
  if (!globs.length) return false;
  const paths = absolutePaths(f.paths, workspace);
  return globs.some(g => paths.some(p => globMatch(g, p)));
}

function ruleId(bucket: RuleMatch['bucket'], c: LaneCondition, i: number): string {
  return c.id ?? `${bucket}-${i + 1}`;
}

function riskMatches(want: string[], f: ActionFeatures): boolean {
  const hits = f.risk ?? [];
  const max = riskRank(f.riskLevel);
  return want.some(r => {
    const key = r.toLowerCase();
    if (RISK_LEVELS.has(key)) return max >= riskRank(key as RiskLevel);
    return hits.some(h => h.rule === r);
  });
}

function conditionMatches(c: LaneCondition, req: ActionRequest, f: ActionFeatures, ctx: { tainted: boolean; workspace?: string }): boolean {
  if (c.category?.length && !c.category.includes(f.category)) return false;
  if (c.tool?.length && !c.tool.some(g => globMatch(g, f.toolName) || globMatch(g, f.canonicalTool))) return false;
  if (c.mcpServer?.length && !c.mcpServer.some(g => globMatch(g, f.mcpServer))) return false;
  if (c.risk?.length && !riskMatches(c.risk, f)) return false;
  if (c.path?.length) {
    const paths = f.paths.map(p => expandPattern(p, ctx.workspace));
    const patterns = c.path.map(p => expandPattern(p, ctx.workspace));
    if (!patterns.some(p => paths.some(v => globMatch(p, v)))) return false;
  }
  if (c.domain?.length) {
    const hosts = [...f.hosts, ...f.domains];
    if (!c.domain.some(g => hosts.some(h => globMatch(g, h)))) return false;
  }
  if (c.command?.length) {
    if (!f.command || !c.command.some(r => commandRegex(r)?.test(f.command))) return false;
  }
  if (c.detector?.length) {
    const keys = f.detections.map(d => d.key);
    if (!c.detector.some(d => keys.includes(d))) return false;
  }
  if (c.tainted != null && c.tainted !== ctx.tainted) return false;
  if (c.filesystem?.length && !presetPathMatch('filesystem', c.filesystem, f, ctx.workspace)) return false;
  if (c.credential?.length && !presetPathMatch('credential', c.credential, f, ctx.workspace)) return false;
  if (c.network?.length) {
    const globs = cachedExpansion(`net|${c.network.join('\n')}`, () => expandHostValues(c.network!));
    const hosts = [...f.hosts, ...f.domains];
    if (!globs.some(g => hosts.some(h => hostMatches(g, h)))) return false;
  }
  if (c.capability?.length && !capabilityMatches(c.capability, new Set(f.capabilities ?? []))) return false;
  if (c.mcpCategory?.length && !mcpCategoryMatches(c.mcpCategory, { server: f.mcpServer, identities: f.mcpIdentities ?? [] })) return false;
  if (c.operation?.length && !c.operation.some(o => (f.operations ?? []).includes(o))) return false;
  if (c.classifier?.length) {
    const wanted = c.classifier.map(resolveClassifierCode);
    const found = new Set(f.detections.map(d => d.key));
    if (!wanted.some(w => found.has(w))) {
      const missing = wanted.filter(w => !found.has(w));
      const extra = f.classify ? f.classify(missing) : [];
      if (!extra.some(d => wanted.includes(d.key))) return false;
    }
  }
  return true;
}

export const BUILTIN_DEFAULT_LANE: Lane = {
  id: 'default', version: 1, name: 'Default governance lane', priority: -1000,
  appliesTo: { surfaces: ['*'], agents: ['*'], repos: ['*'], users: ['*'] },
  purpose: 'Baseline safety lane for newly discovered agents.',
  dos: ['Read and search within the current workspace.', 'Run low-risk local development commands.'],
  never: ['Read or transmit credentials.', 'Contact cloud metadata endpoints.', 'Run destructive shell commands.'],
  rules: {
    deny: [
      { id: 'dangerous-command', risk: ['rm-root', 'pipe-to-shell', 'disk-wipe', 'disable-security', 'secret-egress'] },
      { id: 'metadata-endpoint', domain: ['169.254.169.254', 'metadata.google.internal', '100.100.100.200'] },
      { id: 'credential-paths', path: ['~/.ssh/**', '~/.aws/**', '~/.azure/**', '**/.env'] },
    ],
    allow: [{ id: 'read-workspace', category: ['READ'], path: ['${workspace}/**'] }, { id: 'search-tools', tool: ['Grep', 'Glob', 'grep', 'glob', 'rg'] }],
    judge: [{ id: 'judge-active-actions', category: ['EXEC', 'NETWORK', 'MCP'] }, { id: 'judge-medium-risk', risk: ['medium'] }],
    approve: [],
  },
  defaultVerdict: 'allow', mode: 'observe', failMode: { default: 'closed', READ: 'open' },
  approval: { channels: ['native', 'dashboard'], timeoutSec: 120 },
  judge: { model: 'fast', escalateBelow: 0.7, humanBelow: 0.45, dataPolicy: 'redacted' },
  limits: { actionsPerMin: 120, maxSubagents: 5, maxDepth: 2, tokenBudget: 2_000_000, loopThreshold: 8, maxSessionMinutes: 480 },
  promptShields: { enabled: true, scan: ['NETWORK', 'MCP'], taintTtlActions: 20 },
  meta: { source: 'file' },
};

class DefaultLaneEngine implements LaneEngine {
  private synced = false;

  private async ensureSynced(): Promise<void> {
    if (this.synced) return;
    this.synced = true;
    await syncLaneFilesOnce().catch(err => console.warn('[lanes] initial sync failed:', err));
    await syncPolicyFilesOnce().catch(err => console.warn('[policies] initial sync failed:', err));
  }

  async resolve(agent: RegisteredAgent, req: ActionRequest): Promise<Lane> {
    return withPolicies(await this.resolveBase(agent, req), agent, req);
  }

  private async resolveBase(agent: RegisteredAgent, req: ActionRequest): Promise<Lane> {
    await this.ensureSynced();
    if (agent.laneId) {
      const explicit = await govStore().getLane(agent.laneId);
      if (explicit?.status === 'active') return explicit.lane;
    }
    const lanes = (await govStore().listLanes(['active'])).map(r => r.lane);
    const candidates = lanes.filter(l => applies(l, agent, req));
    candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || b.version - a.version || a.id.localeCompare(b.id));
    return candidates[0] ?? (await govStore().getLane('default'))?.lane ?? BUILTIN_DEFAULT_LANE;
  }

  evaluate(lane: Lane, req: ActionRequest, f: ActionFeatures, ctx: { tainted: boolean; workspace?: string }): RuleEvaluation {
    const evalBucket = (bucket: RuleMatch['bucket']): RuleMatch[] => {
      const rules = lane.rules?.[bucket] ?? [];
      const out: RuleMatch[] = [];
      for (let i = 0; i < rules.length; i++) {
        const c = rules[i];
        if (conditionMatches(c, req, f, ctx)) out.push({ bucket, ruleId: ruleId(bucket, c, i), description: c.description ?? c.id ?? `${bucket} rule`, condition: c });
      }
      return out;
    };
    const denies = evalBucket('deny');
    // Deny always wins; among denies prefer one that actually enforces over an observe-only policy.
    const enforcing = (m: RuleMatch) => m.condition.modeOverride === 'enforce' || (m.condition.modeOverride !== 'observe' && lane.mode !== 'observe');
    const deny = denies.find(enforcing) ?? denies[0];
    return { deny, approve: evalBucket('approve'), judge: evalBucket('judge'), allow: evalBucket('allow'), alert: evalBucket('alert') };
  }
}

export const laneEngine: LaneEngine = new DefaultLaneEngine();
export default laneEngine;
