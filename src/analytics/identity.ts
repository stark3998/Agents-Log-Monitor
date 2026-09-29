import os from 'os';
import { execFileSync } from 'child_process';

export interface AgentInfo {
  key: string;
  name: string;
  kind: string;
}

// Collector id → agent identity. Several capture channels can feed one agent.
const AGENTS: Record<string, AgentInfo> = {
  'claude-code':       { key: 'claude-code',    name: 'Claude Code',      kind: 'Coding Agent' },
  'copilot-cli':       { key: 'copilot-cli',    name: 'Copilot CLI',      kind: 'Coding Agent' },
  'copilot-cli-hooks': { key: 'copilot-cli',    name: 'Copilot CLI',      kind: 'Coding Agent' },
  'foundry':           { key: 'foundry',        name: 'Azure AI Foundry', kind: 'General Agent' },
  'copilot-studio':    { key: 'copilot-studio', name: 'Copilot Studio',   kind: 'General Agent' },
};

export function agentFor(collectorId: string): AgentInfo {
  return AGENTS[collectorId] ?? { key: collectorId, name: collectorId, kind: 'Agent' };
}

export function listAgentInfos(): AgentInfo[] {
  const seen = new Map<string, AgentInfo>();
  for (const a of Object.values(AGENTS)) seen.set(a.key, a);
  return [...seen.values()];
}

/** Collectors that run on this machine (identity = local user / hostname). */
export const LOCAL_COLLECTORS = new Set(['claude-code', 'copilot-cli', 'copilot-cli-hooks']);

let _identity: { user: string; endpoint: string } | null = null;

export function localIdentity(): { user: string; endpoint: string } {
  if (_identity) return _identity;
  let user = '';
  try {
    user = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', timeout: 2000, windowsHide: true }).trim();
  } catch { /* git not installed or not configured */ }
  if (!user) {
    try { user = os.userInfo().username; } catch { user = process.env.USERNAME ?? process.env.USER ?? ''; }
  }
  _identity = { user, endpoint: os.hostname() };
  return _identity;
}

/** Claude Code permission_mode → autonomy level. */
export function autonomyFromPermissionMode(mode: unknown): number | undefined {
  if (typeof mode !== 'string') return undefined;
  switch (mode) {
    case 'bypassPermissions': return 3;
    case 'acceptEdits': return 2;
    case 'default': case 'plan': return 1;
    default: return undefined;
  }
}

export const AUTONOMY_LABELS: Record<number, string> = { 1: 'Supervised', 2: 'Assisted', 3: 'Autonomous' };
