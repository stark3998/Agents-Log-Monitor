import { getEffectiveClassifiers, listClassifiers as listClassifierCatalog, resolveClassifierCode } from './classifiers/config';
import type { ClassifierCategory, ClassifierEntry, ClassifierSensitivity } from './classifiers/catalog';

export type DetectorClass = 'secret' | 'pii' | 'other';

export interface Detection {
  key: string;
  label: string;
  cls: DetectorClass;
  maskedSample: string;
  category?: ClassifierCategory;
  sensitivity?: ClassifierSensitivity;
}

const MAX_SCAN = 256 * 1024;
const CONTEXT_RADIUS = 80;
const PEM_BLOCK_RE = /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

function classForCategory(category: ClassifierCategory): DetectorClass {
  if (category === 'Secrets') return 'secret';
  if (category === 'Infrastructure' || category === 'Code' || category === 'Prompt Injection') return 'other';
  return 'pii';
}

function contextMatches(d: ClassifierEntry, text: string, m: RegExpExecArray): boolean {
  if (!d.context) return true;
  const start = Math.max(0, m.index - CONTEXT_RADIUS);
  const end = Math.min(text.length, m.index + m[0].length + CONTEXT_RADIUS);
  d.context.lastIndex = 0;
  return d.context.test(text.slice(start, end));
}

function activeDetectors(): ClassifierEntry[] {
  return getEffectiveClassifiers(true).filter(d => d.isActive && !d.aliasOf);
}

// Active classifiers (catalog defaults + overrides), ignoring rules-file disables.
function redactionDetectors(): ClassifierEntry[] {
  return getEffectiveClassifiers(false).filter(d => d.isActive && !d.aliasOf);
}

export function mask(value: string, cls: DetectorClass = 'secret'): string {
  if (cls === 'pii' && value.includes('@')) {
    const [local, domain] = value.split('@');
    return (local[0] ?? '') + '***@' + domain;
  }
  if (value.length <= 8) return value.slice(0, 2) + '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Run all active classifiers over text; returns at most one detection per canonical key. */
export function detect(text: string | null | undefined): Detection[] {
  return runClassifiers(text, activeDetectors());
}

/**
 * Run specific classifier codes regardless of whether they are active (policy rules may reference
 * enforceable classifiers that are switched off for passive analytics).
 */
export function detectCodes(text: string | null | undefined, codes: string[]): Detection[] {
  if (!codes.length) return [];
  const wanted = new Set(codes.map(resolveClassifierCode));
  return runClassifiers(text, getEffectiveClassifiers(false).filter(d => !d.aliasOf && wanted.has(d.code)));
}

function runClassifiers(text: string | null | undefined, classifiers: ClassifierEntry[]): Detection[] {
  if (!text) return [];
  const t = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const out: Detection[] = [];
  const seen = new Set<string>();
  for (const d of classifiers) {
    const key = resolveClassifierCode(d.code);
    if (seen.has(key)) continue;
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = d.re.exec(t)) !== null && guard++ < 50) {
      const value = m[d.group ?? 0] ?? m[0];
      if (!contextMatches(d, t, m)) continue;
      if (d.validate && !d.validate(value, m, t)) continue;
      const cls = classForCategory(d.category);
      const sample = key === 'private_key' ? m[0].replace(/-/g, '').trim() : mask(value, cls);
      out.push({ key, label: d.label, cls, maskedSample: sample, category: d.category, sensitivity: d.sensitivity });
      seen.add(key);
      break;
    }
  }
  return out;
}

export function detectorClass(key: string): DetectorClass {
  const resolved = resolveClassifierCode(key);
  const found = getEffectiveClassifiers(false).find(d => d.code === resolved || d.code === key);
  return found ? classForCategory(found.category) : 'secret';
}

export function listDetectors(): { key: string; label: string; cls: DetectorClass; enabled: boolean; category: ClassifierCategory; sensitivity: ClassifierSensitivity; enforceable: boolean; source: string; description: string }[] {
  return listClassifierCatalog().map(d => ({
    key: d.code,
    label: d.label,
    cls: classForCategory(d.category),
    enabled: d.isActive,
    category: d.category,
    sensitivity: d.sensitivity,
    enforceable: d.enforceable,
    source: d.source,
    description: d.description,
  }));
}

/**
 * Replace every sensitive value of the given classes with its masked form (private keys become a
 * `[REDACTED]` block). Redaction is independent of the detectors disabled in the rules file.
 */
export function redactText(text: string, classes: ReadonlySet<DetectorClass>): string {
  if (!text || classes.size === 0) return text;
  let out = text;
  if (classes.has('secret')) out = out.replace(PEM_BLOCK_RE, (_m, kind: string) => `-----BEGIN ${kind}----- [REDACTED] -----END ${kind}-----`);
  for (const d of redactionDetectors()) {
    const cls = classForCategory(d.category);
    if (cls === 'other' || !classes.has(cls) || d.code === 'private_key') continue;
    d.re.lastIndex = 0;
    out = out.replace(d.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const offset = args[args.length - 2] as number;
      const value = (d.group ? (args[d.group] as string | undefined) : match) ?? match;
      if (value.includes('****')) return match;
      const fake = [match, ...args.slice(1, -2)] as unknown as RegExpExecArray;
      fake.index = offset;
      if (!contextMatches(d, out, fake)) return match;
      if (d.validate && !d.validate(value, fake, out)) return match;
      return match.replace(value, mask(value, cls));
    });
  }
  return out;
}
