import path from 'path';
import { govStore } from '../store';
import type { ActionFeatures } from '../features';
import type { LaneEngine, RuleEvaluation, RuleMatch } from '../contracts';
import type { ActionRequest, Lane, LaneCondition, RegisteredAgent, RiskLevel } from '../types';
import { riskRank } from '../../analytics/risk';
import { syncLaneFilesOnce } from './loader';

const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const commandRegexCache = new Map<string, RegExp | null>();
const warnedInvalidCommandRegex = new Set<string>();

export function globToRegExp(glob: string): RegExp {
  let s = glob.replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '.';
    else out += c.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}

export function globMatch(pattern: string, value: string | undefined | null): boolean {
  if (!value) return false;
  const p = pattern === '*' ? '**' : pattern;
  return globToRegExp(p).test(String(value).replace(/\\/g, '/'));
}

function anyGlob(patterns: string[] | undefined, values: (string | undefined | null)[]): boolean {
  if (!patterns?.length) return true;
  return patterns.some(p => values.some(v => globMatch(p, v)));
}

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
  const a = lane.appliesTo ?? {};
  if (a.surfaces?.length && !a.surfaces.includes('*') && !a.surfaces.includes(agent.surface)) return false;
  if (a.agents?.length && !a.agents.includes('*') && !anyGlob(a.agents, [agent.id, agent.externalId, agent.name, req.agent.externalId, req.agent.name])) return false;
  if (a.repos?.length && !a.repos.includes('*') && !anyGlob(a.repos, [req.agent.repo, req.agent.cwd])) return false;
  if (a.users?.length && !a.users.includes('*') && !anyGlob(a.users, [req.agent.user])) return false;
  return true;
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
  }

  async resolve(agent: RegisteredAgent, req: ActionRequest): Promise<Lane> {
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
    const deny = evalBucket('deny')[0];
    return { deny, approve: evalBucket('approve'), judge: evalBucket('judge'), allow: evalBucket('allow') };
  }
}

export const laneEngine: LaneEngine = new DefaultLaneEngine();
export default laneEngine;
