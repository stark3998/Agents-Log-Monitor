import type { ActionRequest, Lane, RegisteredAgent } from '../types';

export function globToRegExp(glob: string): RegExp {
  const s = glob.replace(/\\/g, '/');
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

const globCache = new Map<string, RegExp>();

export function globMatch(pattern: string, value: string | undefined | null): boolean {
  if (!value) return false;
  const p = pattern === '*' ? '**' : pattern;
  let re = globCache.get(p);
  if (!re) {
    re = globToRegExp(p);
    if (globCache.size > 5000) globCache.clear();
    globCache.set(p, re);
  }
  return re.test(String(value).replace(/\\/g, '/'));
}

export function anyGlob(patterns: string[] | undefined, values: (string | undefined | null)[]): boolean {
  if (!patterns?.length) return true;
  return patterns.some(p => values.some(v => globMatch(p, v)));
}

/** Lane `appliesTo` / policy `scope` matching. Empty or `*` lists match everything. */
export function appliesToMatches(a: Lane['appliesTo'] | undefined, agent: RegisteredAgent, req: ActionRequest): boolean {
  const s = a ?? {};
  if (s.surfaces?.length && !s.surfaces.includes('*') && !s.surfaces.includes(agent.surface)) return false;
  if (s.agents?.length && !s.agents.includes('*') && !anyGlob(s.agents, [agent.id, agent.externalId, agent.name, req.agent.externalId, req.agent.name])) return false;
  if (s.repos?.length && !s.repos.includes('*') && !anyGlob(s.repos, [req.agent.repo, req.agent.cwd])) return false;
  if (s.users?.length && !s.users.includes('*') && !anyGlob(s.users, [req.agent.user])) return false;
  return true;
}
