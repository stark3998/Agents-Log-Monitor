import { redactText, type DetectorClass } from './detectors';

/**
 * Payload redaction applied before events are stored.
 *   off      — store payloads as received
 *   secrets  — mask secret-class values (keys, tokens, connection strings, private keys) — default
 *   all      — also mask personal data (email addresses)
 */
export type RedactionMode = 'off' | 'secrets' | 'all';

const RANK: Record<RedactionMode, number> = { off: 0, secrets: 1, all: 2 };

function parseMode(v: string | undefined): RedactionMode {
  const m = (v ?? '').trim().toLowerCase();
  if (m === 'off' || m === 'none' || m === 'false' || m === '0') return 'off';
  if (m === 'all' || m === 'pii') return 'all';
  return 'secrets';
}

export const REDACTION_MODE: RedactionMode = parseMode(process.env.REDACT_PAYLOADS);

function classesFor(mode: RedactionMode): ReadonlySet<DetectorClass> {
  return new Set<DetectorClass>(mode === 'all' ? ['secret', 'pii'] : mode === 'secrets' ? ['secret'] : []);
}

export function redactString(s: string, mode: RedactionMode = REDACTION_MODE): string {
  return mode === 'off' ? s : redactText(s, classesFor(mode));
}

/** Redact every string leaf (and object key-value pairs rendered as text) of a JSON-like value. */
export function redactDeep<T>(v: T, mode: RedactionMode = REDACTION_MODE, depth = 0): T {
  if (mode === 'off') return v;
  if (typeof v === 'string') return redactString(v, mode) as unknown as T;
  if (v == null || typeof v !== 'object' || depth > 12) return v;
  if (Array.isArray(v)) return v.map(x => redactDeep(x, mode, depth + 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    // `{ "API_KEY": "abc123…" }` has no "KEY=value" text for the env-var detector, so test the pair.
    if (typeof x === 'string' && /[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CONN(?:ECTION)?_?STRING)[A-Z0-9_]*$/.test(k)) {
      const joined = redactString(`${k}=${x}`, mode);
      out[k] = joined.startsWith(`${k}=`) ? joined.slice(k.length + 1) : redactDeep(x, mode, depth + 1);
    } else {
      out[k] = redactDeep(x, mode, depth + 1);
    }
  }
  return out as T;
}

/** SQL fragment matching rows stored with a weaker redaction than `mode` (or never processed). */
export function weakerRedactionSql(mode: RedactionMode = REDACTION_MODE): string {
  const weaker = (Object.keys(RANK) as RedactionMode[]).filter(m => RANK[m] < RANK[mode]);
  return weaker.length ? `(redaction IS NULL OR redaction IN (${weaker.map(m => `'${m}'`).join(',')}))` : 'redaction IS NULL';
}
