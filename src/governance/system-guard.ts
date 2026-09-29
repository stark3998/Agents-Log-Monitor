import path from 'path';
import type { ActionFeatures } from './features';
import type { ActionRequest } from './types';

export interface SystemGuardContext {
  port: number;
  dbPath: string;
  lanesDir: string;
  /** The `.env` file the monitor loads its configuration from (null when disabled). */
  envFile?: string | null;
}

export interface SystemGuardHit {
  ruleId: string;
  reason: string;
}

const ENV_PREFIX_RE = /\b(?:GOVERNANCE_|AGENT_GOVERNANCE_|AGENT_MONITOR_)[A-Z0-9_]*\b/i;
const LOOPBACK_HOST_RE = String.raw`(?:127\.0\.0\.1|localhost|\[?::1\]?)`;
const GOV_PATH_RE = /^\/(?:api\/gov|v1|mcp)(?:\/|$)/i;

function textOf(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/^file:\/+/i, '');
  if (/^[a-z]:/i.test(s)) s = s[0].toLowerCase() + s.slice(1);
  s = s.replace(/\/+/g, '/').replace(/\/$/, '');
  return s.toLowerCase();
}

function isSameOrUnder(candidate: string, root: string): boolean {
  const c = norm(candidate);
  const r = norm(root);
  return c === r || c.startsWith(`${r}/`);
}

function forwarderPaths(): string[] {
  return [
    path.join(process.cwd(), 'scripts', 'copilot-hook-forward.ps1'),
    path.join(process.cwd(), 'scripts', 'copilot-hook-forward.sh'),
  ];
}

function isDbPath(p: string, dbPath: string): boolean {
  const n = norm(p);
  const db = norm(dbPath);
  return n === db || n === `${db}-wal` || n === `${db}-shm`;
}

function isProfilePath(p: string): boolean {
  const n = norm(p);
  return /(^|\/)(?:\.bashrc|\.zshrc|\.profile|\.bash_profile|profile\.ps1|microsoft\.powershell_profile\.ps1|microsoft\.vscode_profile\.ps1)$/i.test(n)
    || /\/powershell\/[^/]*profile[^/]*\.ps1$/i.test(n);
}

function isHookConfigPath(p: string): boolean {
  const n = norm(p);
  if (/(^|\/)\.claude\/settings[^/]*\.json$/i.test(n)) return true;
  if (/(^|\/)\.copilot\/hooks\/.+\.json$/i.test(n)) return true;
  if (/(^|\/)policy\.d\/.+\.json$/i.test(n)) return true;
  if (/(^|\/)\.github\/hooks\/.+\.json$/i.test(n)) return true;
  if (/(^|\/)\.vscode\/settings\.json$/i.test(n)) return true;
  if (/(^|\/)agent-governance-vscode\.json$/i.test(n)) return true;
  return false;
}

function isForwarderPath(p: string): boolean {
  return forwarderPaths().some(f => norm(p) === norm(f)) || /(^|\/)scripts\/copilot-hook-forward\.(?:ps1|sh)$/i.test(norm(p));
}

function sensitivePathKind(p: string, ctx: SystemGuardContext): string | null {
  if (isSameOrUnder(p, ctx.lanesDir)) return 'lanes directory';
  if (isDbPath(p, ctx.dbPath)) return 'governance database';
  if (isHookConfigPath(p)) return 'governance hook configuration';
  if (isForwarderPath(p)) return 'governance hook forwarder';
  if (ctx.envFile && norm(p) === norm(ctx.envFile)) return 'Agent Monitor configuration (.env)';
  return null;
}

function commandWrites(command: string): boolean {
  return /\b(?:rm|del|erase|move|mv|copy|cp|ren|rename|set-content|add-content|out-file|new-item|ni|tee|sed\s+-i)\b/i.test(command)
    || />{1,2}\s*["']?[^"'&|;\s]+/.test(command);
}

function toolWrites(req: ActionRequest, f: ActionFeatures): boolean {
  const t = `${req.toolName ?? ''} ${f.toolName} ${f.canonicalTool}`.toLowerCase();
  return f.category === 'WRITE' || /\b(?:edit|write|create|delete|move|rename|patch)\b/.test(t);
}

function targetsMonitorNetwork(text: string, port: number): boolean {
  const urlRe = new RegExp(String.raw`\b(?:https?|wss?)://${LOOPBACK_HOST_RE}(?::(\d+))?([^'"<>\s)]*)`, 'ig');
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    if (Number(m[1] ?? 0) === port) return true;
    if (!m[1] && GOV_PATH_RE.test(m[2] ?? '')) return true;
  }
  const bare = new RegExp(String.raw`\b${LOOPBACK_HOST_RE}\s*:\s*${port}\b`, 'i');
  return bare.test(text);
}

function killsMonitor(command: string): boolean {
  if (!/\b(?:stop-process|taskkill|kill|pkill)\b/i.test(command)) return false;
  if (new RegExp(String.raw`\b${process.pid}\b`).test(command)) return true;
  return /\b(?:node(?:\.exe)?|agent-monitor|electron(?:\.exe)?)\b/i.test(command);
}

function setsGovernanceEnv(command: string): boolean {
  if (!ENV_PREFIX_RE.test(command)) return false;
  return /\b(?:export|setx?|set-item|new-itemproperty)\b/i.test(command)
    || /\$env:/i.test(command)
    || /\b(?:GOVERNANCE_|AGENT_GOVERNANCE_|AGENT_MONITOR_)[A-Z0-9_]*\s*=/i.test(command);
}

export function systemGuard(req: ActionRequest, f: ActionFeatures, ctx: SystemGuardContext): SystemGuardHit | null {
  const argText = textOf(req.args);
  const command = f.command || '';
  const allText = `${command}\n${argText}`;

  if ((f.category === 'NETWORK' || f.category === 'EXEC' || targetsMonitorNetwork(argText, ctx.port)) && targetsMonitorNetwork(allText, ctx.port)) {
    return { ruleId: 'system.self.network', reason: `Action targets the Agent Monitor governance endpoint on loopback port ${ctx.port}.` };
  }

  if (command && killsMonitor(command)) {
    return { ruleId: 'system.self.process', reason: 'Action attempts to stop the Agent Monitor process or runtime.' };
  }

  if (command && setsGovernanceEnv(command)) {
    return { ruleId: 'system.self.env', reason: 'Action attempts to set Agent Monitor governance environment variables.' };
  }

  const paths = f.paths.filter(Boolean);
  const writes = toolWrites(req, f) || (f.category === 'EXEC' && commandWrites(command));
  if (writes) {
    for (const p of paths) {
      const kind = sensitivePathKind(p, ctx);
      if (kind) return { ruleId: 'system.self.files', reason: `Action attempts to modify the ${kind}.` };
    }
  }

  if (writes && ENV_PREFIX_RE.test(allText)) {
    for (const p of paths) {
      if (isProfilePath(p)) return { ruleId: 'system.self.profile-env', reason: 'Action attempts to persist governance environment changes in a shell profile.' };
    }
  }

  return null;
}
