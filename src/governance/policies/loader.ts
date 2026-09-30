import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import YAML from 'yaml';
import { govBus } from '../events';
import { govStore } from '../store';
import type { Policy, PolicyRecord } from '../types';
import { parsePolicyYaml } from './schema';

export function policyDir(): string {
  return process.env.GOVERNANCE_POLICIES_DIR || path.join(process.cwd(), 'policies');
}

function contentHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function autoActivate(): boolean {
  return (process.env.GOVERNANCE_POLICIES_AUTO_ACTIVATE ?? process.env.GOVERNANCE_LANES_AUTO_ACTIVATE ?? '').toLowerCase() === 'true';
}

/**
 * Import a policy file. Same rules as lanes: first import is active; later file changes become
 * `proposed` versions a PolicyAdmin must activate (unless auto-activation is on), so an agent that
 * can write the policies folder cannot silently change its own active policy.
 */
async function saveFilePolicy(file: string): Promise<PolicyRecord | null> {
  const yaml = fs.readFileSync(file, 'utf8');
  const policy = parsePolicyYaml(yaml);
  const versions = await govStore().listPolicyVersions(policy.id);
  if (versions.some(v => v.yaml != null && contentHash(v.yaml) === contentHash(yaml))) return null;
  policy.version = versions.length ? Math.max(...versions.map(v => v.policy.version)) + 1 : policy.version;
  policy.meta = { ...policy.meta, source: policy.meta?.source ?? 'file' };
  const status: PolicyRecord['status'] = versions.length === 0 || autoActivate() ? 'active' : 'proposed';
  const rec: PolicyRecord = { policy, status, yaml, updatedAt: new Date().toISOString(), updatedBy: 'file-sync' };
  const saved = await govStore().savePolicy(rec);
  govBus.emit('policy.updated', saved);
  return saved;
}

export async function syncPolicyFilesOnce(): Promise<PolicyRecord[]> {
  const dir = policyDir();
  const saved: PolicyRecord[] = [];
  if (!fs.existsSync(dir)) return saved;
  for (const name of fs.readdirSync(dir).filter(f => /\.ya?ml$/i.test(f)).sort()) {
    try {
      const rec = await saveFilePolicy(path.join(dir, name));
      if (rec) saved.push(rec);
    } catch (err) {
      console.warn(`[policies] ${name}: ${(err as Error).message}`);
    }
  }
  return saved;
}

let watching = false;
export function startPolicyFileSync(): void {
  if (watching) return;
  watching = true;
  const resync = () => {
    void syncPolicyFilesOnce().catch(err => {
      if (String((err as Error).message ?? err).includes('not initialised')) setTimeout(resync, 1000).unref?.();
      else console.warn('[policies] sync failed:', err);
    });
  };
  resync();
  const dir = policyDir();
  if (!fs.existsSync(dir)) return;
  try { fs.watch(dir, { persistent: false }, (_event, file) => { if (!file || /\.ya?ml$/i.test(String(file))) resync(); }); } catch { /* ignore */ }
}

export function policyToYaml(p: Policy): string {
  return YAML.stringify(p);
}
