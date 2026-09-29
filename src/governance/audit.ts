import crypto from 'crypto';
import type { Decision } from './types';

/** Genesis value for the first link in the decision hash chain. */
export const GENESIS_HASH = '0'.repeat(64);

/** Deterministic JSON: object keys sorted, undefined dropped. Used for hashing only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The hashed body excludes the chain fields themselves. */
export function decisionBody(d: Decision): Omit<Decision, 'seq' | 'prevHash' | 'hash'> {
  const { seq: _s, prevHash: _p, hash: _h, ...body } = d;
  return body;
}

export function hashDecision(prevHash: string, seq: number, d: Decision): string {
  return crypto.createHash('sha256')
    .update(prevHash)
    .update('\n')
    .update(String(seq))
    .update('\n')
    .update(canonicalJson(decisionBody(d)))
    .digest('hex');
}

/** Verify a contiguous, seq-ordered run of decisions. `prevHash` is the hash before the first item. */
export function verifyChain(items: Decision[], prevHash: string = GENESIS_HASH): { ok: boolean; brokenAt?: number; headHash: string } {
  let prev = prevHash;
  for (const d of items) {
    if (d.seq == null || d.prevHash !== prev || d.hash !== hashDecision(prev, d.seq, d)) {
      return { ok: false, brokenAt: d.seq ?? -1, headHash: prev };
    }
    prev = d.hash;
  }
  return { ok: true, headHash: prev };
}
