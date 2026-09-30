/**
 * Installs / removes the Copilot hook configs that forward agent events to this monitor (the same files
 * `install.ps1 -CopilotHooks` / `-VSCodeHooks` and `install.sh --copilot-hooks` write). Local mode only:
 * the files live in the signed-in user's Copilot home (`COPILOT_HOME` or `~/.copilot/hooks`).
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

export type HookTarget = 'copilot-cli' | 'vscode';
export type HookFailMode = 'auto' | 'open' | 'closed';

export const HOOK_TARGETS: readonly HookTarget[] = ['copilot-cli', 'vscode'];
export const HOOK_FAIL_MODES: readonly HookFailMode[] = ['auto', 'open', 'closed'];

const FILE_NAME: Record<HookTarget, string> = {
  'copilot-cli': 'agent-governance.json',
  vscode: 'agent-governance-vscode.json',
};

const COPILOT_EVENTS = [
  'sessionStart', 'sessionEnd', 'userPromptSubmitted',
  'preToolUse', 'permissionRequest', 'postToolUse', 'postToolUseFailure',
  'agentStop', 'subagentStart', 'subagentStop', 'errorOccurred',
];
const VSCODE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'PreCompact'];
const HOOK_TIMEOUT_SEC = 120;

export interface HookInstallOptions {
  failMode?: HookFailMode;
  port?: number;
  /** Overrides for tests. */
  copilotHome?: string;
  repoRoot?: string;
}

export interface HookTargetStatus {
  target: HookTarget;
  path: string;
  installed: boolean;
  /** The file exists and forwards to this monitor's scripts (vs. an unrecognised file with the same name). */
  managed: boolean;
  failMode?: string;
  port?: number;
  modifiedAt?: string;
}

export interface HooksStatus {
  copilotHome: string;
  forwarder: { powershell: string; bash: string; present: boolean };
  targets: HookTargetStatus[];
}

export function copilotHome(override?: string): string {
  return override ?? (process.env.COPILOT_HOME?.trim() || path.join(os.homedir(), '.copilot'));
}

function repoRoot(override?: string): string {
  if (override) return override;
  // src/governance/hooks (ts-node) and dist/governance/hooks (build) are three levels below the repo root.
  const fromModule = path.resolve(__dirname, '..', '..', '..');
  return existsSync(path.join(fromModule, 'scripts', 'copilot-hook-forward.ps1')) ? fromModule : process.cwd();
}

function forwarders(root: string): { powershell: string; bash: string } {
  return {
    powershell: path.join(root, 'scripts', 'copilot-hook-forward.ps1'),
    bash: path.join(root, 'scripts', 'copilot-hook-forward.sh').replace(/\\/g, '/'),
  };
}

function hookPath(target: HookTarget, home: string): string {
  return path.join(home, 'hooks', FILE_NAME[target]);
}

/** Same shape as install.ps1 `New-CopilotHookConfig`. */
export function buildHookConfig(target: HookTarget, opts: HookInstallOptions = {}): Record<string, unknown> {
  const port = opts.port ?? Number(process.env.PORT ?? 4317);
  const failMode = opts.failMode ?? 'open';
  const { powershell, bash } = forwarders(repoRoot(opts.repoRoot));
  const deadline = Math.max(1, HOOK_TIMEOUT_SEC - 5);
  const env = { AGENT_GOVERNANCE_FAIL_MODE: failMode, AGENT_GOVERNANCE_SURFACE: target };
  const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${powershell}" -Port ${port} -TimeoutSec ${deadline} -Surface ${target}`;
  const shCmd = `sh '${bash}' --port ${port} --timeout ${deadline} --surface ${target}`;

  if (target === 'vscode') {
    const hooks: Record<string, unknown[]> = {};
    for (const ev of VSCODE_EVENTS) {
      const timeout = ev === 'PreToolUse' || ev === 'UserPromptSubmit' ? HOOK_TIMEOUT_SEC : 5;
      hooks[ev] = [{ type: 'command', command: shCmd, windows: psCmd, timeout, env }];
    }
    return { hooks };
  }
  const commandHook = { type: 'command', powershell: psCmd, bash: shCmd, timeoutSec: HOOK_TIMEOUT_SEC, env };
  const hooks: Record<string, unknown[]> = {};
  for (const ev of COPILOT_EVENTS) hooks[ev] = [commandHook];
  return { version: 1, hooks };
}

async function readStatus(target: HookTarget, home: string): Promise<HookTargetStatus> {
  const p = hookPath(target, home);
  const out: HookTargetStatus = { target, path: p, installed: false, managed: false };
  let raw: string;
  let mtime: Date;
  try {
    [raw, mtime] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p).then(s => s.mtime)]);
  } catch { return out; }
  out.installed = true;
  out.modifiedAt = mtime.toISOString();
  out.managed = /copilot-hook-forward\.(?:ps1|sh)/.test(raw);
  const fm = /"AGENT_GOVERNANCE_FAIL_MODE"\s*:\s*"(\w+)"/.exec(raw);
  if (fm) out.failMode = fm[1];
  const port = /-Port (\d+)|--port (\d+)/.exec(raw);
  if (port) out.port = Number(port[1] ?? port[2]);
  return out;
}

export async function hooksStatus(opts: HookInstallOptions = {}): Promise<HooksStatus> {
  const home = copilotHome(opts.copilotHome);
  const fw = forwarders(repoRoot(opts.repoRoot));
  return {
    copilotHome: home,
    forwarder: { ...fw, present: existsSync(fw.powershell) || existsSync(fw.bash) },
    targets: await Promise.all(HOOK_TARGETS.map(t => readStatus(t, home))),
  };
}

export async function installHooks(targets: HookTarget[], opts: HookInstallOptions = {}): Promise<HooksStatus> {
  const home = copilotHome(opts.copilotHome);
  await fs.mkdir(path.join(home, 'hooks'), { recursive: true });
  for (const t of new Set(targets)) {
    await fs.writeFile(hookPath(t, home), `${JSON.stringify(buildHookConfig(t, opts), null, 2)}\n`, 'utf8');
  }
  return hooksStatus(opts);
}

/** Removes only this monitor's hook files (the fixed file names above). */
export async function uninstallHooks(targets: HookTarget[] = [...HOOK_TARGETS], opts: HookInstallOptions = {}): Promise<HooksStatus> {
  const home = copilotHome(opts.copilotHome);
  for (const t of new Set(targets)) {
    await fs.rm(hookPath(t, home), { force: true });
  }
  return hooksStatus(opts);
}
