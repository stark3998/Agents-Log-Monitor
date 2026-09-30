import fs from 'fs/promises';
import path from 'path';
import type { ScanContext } from './types';
import { defaultScanContext } from './context';
import { evaluateEndpoint } from './checks';
import { collectInventory } from './inventory';
import { checkDef } from './checks/defs';
import { fileFromSubject } from './utils';

export async function applyAutoFix(checkId: string, subject: string, ctxOverrides: Partial<ScanContext> = {}): Promise<{ ok: boolean; changedFiles: string[]; backups: string[]; message: string }> {
  const def = checkDef(checkId);
  if (!def.remediation.autoFix) return { ok: false, changedFiles: [], backups: [], message: `Check ${checkId} does not support auto-fix` };
  const ctx = defaultScanContext(ctxOverrides);
  const before = await evaluateEndpoint(await collectInventory(ctx), ctx);
  if (!before.some(f => f.checkId === checkId && (f.subject === subject || !subject))) return { ok: true, changedFiles: [], backups: [], message: 'already compliant' };
  const file = fileFromSubject(subject) ?? await findFixFile(checkId, ctx);
  if (!file) return { ok: false, changedFiles: [], backups: [], message: 'No fixable configuration file found for subject' };
  const original = await ctx.readFile(file);
  if (original === null) return { ok: false, changedFiles: [], backups: [], message: 'Configuration file not found' };
  if (checkId === 'gemini-oauth-tokens-exposed') return fixGeminiPerms(file, ctx);
  const changed = editText(checkId, original);
  if (changed === original) return { ok: true, changedFiles: [], backups: [], message: 'already compliant' };
  const backup = await backupFile(file);
  await atomicWrite(file, changed);
  const after = await evaluateEndpoint(await collectInventory(ctx), ctx);
  const still = after.some(f => f.checkId === checkId && (f.subject === subject || f.subject.startsWith(`file:${file}`)));
  if (still) return { ok: false, changedFiles: [file], backups: [backup], message: 'Auto-fix applied but verification still reports the finding' };
  return { ok: true, changedFiles: [file], backups: [backup], message: 'fixed' };
}

async function findFixFile(checkId: string, ctx: ScanContext): Promise<string | null> {
  const inv = await collectInventory(ctx); const hits = await evaluateEndpoint(inv, ctx);
  return fileFromSubject(hits.find(f => f.checkId === checkId)?.subject ?? '');
}

function editText(checkId: string, text: string): string {
  if (checkId === 'aider-yes-mode-enabled') return setYamlBool(setYamlBool(text, 'yes-always', false), 'yes', false);
  // Aider auto-commits defaults to on, so an absent key must be written explicitly.
  if (checkId === 'auto-commits-enabled') return setYamlBool(text, 'auto-commits', false, true);
  if (checkId === 'openhands-confirmation-disabled') return text.trimStart().startsWith('{') ? setJsonc(text, 'confirmation_mode', true) : text.replace(/confirmation_mode\s*=\s*false/ig, 'confirmation_mode = true');
  if (checkId === 'ide-workspace-trust-disabled') return setJsonc(text, 'security.workspace.trust.enabled', true);
  if (checkId === 'vscode-global-auto-approve-enabled') return setJsonc(setJsonc(setJsonc(text, 'chat.tools.global.autoApprove', false), 'chat.tools.autoApprove', false), 'chat.permissions.default', 'default');
  if (checkId === 'claude-code-extension-bypass-permission-prompts') return setJsonc(setJsonc(text, 'claudeCode.allowDangerouslySkipPermissions', false), 'claudeCode.initialPermissionMode', 'default');
  return text;
}

function setYamlBool(text: string, key: string, value: boolean, insertIfMissing = false): string {
  const re = new RegExp(`^(\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*).*$`, 'm');
  if (re.test(text)) return text.replace(re, `$1${value ? 'true' : 'false'}`);
  if (!insertIfMissing) return text;
  return `${text.replace(/\s*$/, '')}\n${key}: ${value ? 'true' : 'false'}\n`;
}

/** Replace the value of an existing top-level key in JSONC text; comments and layout are preserved. */
function setJsonc(text: string, dotted: string, value: boolean | string): string {
  const literal = typeof value === 'string' ? JSON.stringify(value) : String(value);
  const key = dotted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${key}"\\s*:\\s*)(true|false|"[^"]*"|[^,}\\r\\n]+)`);
  return re.test(text) ? text.replace(re, `$1${literal}`) : text;
}

async function backupFile(file: string): Promise<string> {
  let candidate = `${file}.agent-monitor.bak`;
  for (let i = 1; ; i++) {
    try { await fs.access(candidate); candidate = `${file}.agent-monitor.bak.${i}`; } catch { break; }
  }
  await fs.copyFile(file, candidate);
  return candidate;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.agent-monitor.${process.pid}.tmp`);
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, file);
}

async function fixGeminiPerms(file: string, ctx: ScanContext): Promise<{ ok: boolean; changedFiles: string[]; backups: string[]; message: string }> {
  if (ctx.platform === 'win32') {
    const r = await ctx.exec('icacls.exe', [file, '/inheritance:r', '/grant:r', `${ctx.user}:F`], 5000);
    return { ok: !!r && r.code === 0, changedFiles: [file], backups: [], message: r && r.code === 0 ? 'permissions fixed' : 'icacls failed' };
  }
  await fs.chmod(file, 0o600);
  return { ok: true, changedFiles: [file], backups: [], message: 'permissions fixed' };
}
