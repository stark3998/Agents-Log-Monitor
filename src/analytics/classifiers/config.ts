import { isDetectorEnabled, rules } from '../rules';
import { BUILTIN_CLASSIFIERS, type ClassifierCategory, type ClassifierEntry, type ClassifierSensitivity } from './catalog';

export interface ClassifierOverride { isActive?: boolean; enforceable?: boolean }
export interface CustomClassifierDef {
  code: string;
  label: string;
  description?: string;
  category: ClassifierCategory;
  sensitivity: ClassifierSensitivity;
  pattern: string;
  flags?: string;
  contextPattern?: string;
  isActive: boolean;
  enforceable: boolean;
}
export interface ClassifierConfig {
  overrides: Record<string, ClassifierOverride>;
  custom: CustomClassifierDef[];
}
export type ListedClassifier = Omit<ClassifierEntry, 're' | 'context' | 'validate'> & { pattern: string; contextPattern?: string; isActive: boolean; enforceable: boolean };

const EMPTY_CONFIG: ClassifierConfig = { overrides: {}, custom: [] };
let current: ClassifierConfig = EMPTY_CONFIG;

function cloneConfig(cfg: ClassifierConfig): ClassifierConfig {
  return { overrides: { ...(cfg.overrides ?? {}) }, custom: [...(cfg.custom ?? [])] };
}

function builtinCodes(): Set<string> {
  return new Set(BUILTIN_CLASSIFIERS.map(c => c.code));
}

function regexFlags(flags?: string): string {
  const unique = new Set((flags || 'i').replace(/[gy]/g, '').split('').filter(Boolean));
  unique.add('g');
  return [...unique].join('');
}

/**
 * Conservative ReDoS guard for user-supplied patterns (JS regexes cannot be interrupted, and
 * custom classifiers run inline on every event). Rejects backreferences, repeated groups that
 * contain alternation or inner quantifiers (`(a|a)*`, `(a+)+`), and more than 4 unbounded quantifiers.
 */
export function unsafePatternReason(pattern: string): string | null {
  if (pattern.length > 500) return 'too long';
  if (/\\[1-9]|\\k</.test(pattern)) return 'backreferences are not allowed';
  const stack: { alt: boolean; quant: boolean }[] = [];
  let unbounded = 0;
  let inClass = false;
  const quantAt = (i: number): { unbounded: boolean; repeating: boolean } | null => {
    const c = pattern[i];
    if (c === '*' || c === '+') return { unbounded: true, repeating: true };
    if (c === '{') {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(pattern.slice(i));
      if (!m) return null;
      const max = m[2] ? (m[3] ? Number(m[3]) : Infinity) : Number(m[1]);
      return { unbounded: max === Infinity, repeating: max > 1 };
    }
    return null;
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '(') { stack.push({ alt: false, quant: false }); continue; }
    if (c === '|' && stack.length) { stack[stack.length - 1].alt = true; continue; }
    const q = quantAt(i);
    if (q) {
      if (q.unbounded) unbounded++;
      if (stack.length && q.repeating) stack[stack.length - 1].quant = true;
      continue;
    }
    if (c === ')') {
      const g = stack.pop();
      const after = quantAt(i + 1);
      if (g && after?.repeating && (g.alt || g.quant)) return 'repeated group containing alternation or a quantifier';
      if (g && stack.length && (g.alt || g.quant)) { const top = stack[stack.length - 1]; top.quant ||= g.quant; top.alt ||= g.alt; }
    }
  }
  if (unbounded > 4) return 'too many unbounded quantifiers';
  return null;
}

function hasCatastrophicShape(pattern: string): boolean {
  return unsafePatternReason(pattern) !== null;
}

function compileCustom(c: CustomClassifierDef): ClassifierEntry {
  return {
    code: c.code,
    label: c.label,
    description: c.description ?? c.label,
    category: c.category,
    sensitivity: c.sensitivity,
    contextRequired: !!c.contextPattern,
    isActive: c.isActive,
    enforceable: c.enforceable,
    source: 'custom',
    re: new RegExp(c.pattern, regexFlags(c.flags)),
    context: c.contextPattern ? new RegExp(c.contextPattern, regexFlags(c.flags).replace('g', '')) : undefined,
  };
}

function compiledCustom(): ClassifierEntry[] {
  const builtins = builtinCodes();
  const out: ClassifierEntry[] = [];
  for (const c of current.custom ?? []) {
    if (builtins.has(c.code) || c.pattern.length > 500 || hasCatastrophicShape(c.pattern) || (c.contextPattern && hasCatastrophicShape(c.contextPattern))) continue;
    try { out.push(compileCustom(c)); } catch { /* already reported by validation callers */ }
  }
  return out;
}

export function setClassifierConfig(cfg: Partial<ClassifierConfig> | null | undefined): void {
  current = { overrides: { ...(cfg?.overrides ?? {}) }, custom: [...(cfg?.custom ?? [])] };
  configVersion++;
  effectiveCache.clear();
}

export function getClassifierConfig(): ClassifierConfig {
  return cloneConfig(current);
}

export function validateClassifierConfig(raw: unknown): { config: ClassifierConfig; problems: string[] } {
  const problems: string[] = [];
  const obj = (raw ?? {}) as Record<string, unknown>;
  const overrides: Record<string, ClassifierOverride> = {};
  const rawOverrides = (obj.overrides ?? {}) as Record<string, unknown>;
  for (const [code, value] of Object.entries(rawOverrides)) {
    if (!value || typeof value !== 'object') {
      problems.push(`overrides.${code}: expected object`);
      continue;
    }
    const v = value as Record<string, unknown>;
    const o: ClassifierOverride = {};
    if (v.isActive !== undefined) {
      if (typeof v.isActive === 'boolean') o.isActive = v.isActive;
      else problems.push(`overrides.${code}.isActive: expected boolean`);
    }
    if (v.enforceable !== undefined) {
      if (typeof v.enforceable === 'boolean') o.enforceable = v.enforceable;
      else problems.push(`overrides.${code}.enforceable: expected boolean`);
    }
    overrides[code] = o;
  }

  const builtins = builtinCodes();
  const custom: CustomClassifierDef[] = [];
  const rawCustom = Array.isArray(obj.custom) ? obj.custom as Record<string, unknown>[] : [];
  rawCustom.forEach((c, i) => {
    const code = typeof c.code === 'string' ? c.code.trim() : '';
    const label = typeof c.label === 'string' ? c.label : '';
    const pattern = typeof c.pattern === 'string' ? c.pattern : '';
    const category = c.category as ClassifierCategory;
    const sensitivity = c.sensitivity as ClassifierSensitivity;
    if (!/^[a-z][a-z0-9_]{1,80}$/.test(code)) problems.push(`custom[${i}].code: invalid code`);
    if (builtins.has(code)) problems.push(`custom[${i}].code: collides with built-in classifier`);
    if (!label) problems.push(`custom[${i}].label: required`);
    if (!pattern) problems.push(`custom[${i}].pattern: required`);
    if (pattern.length > 500) problems.push(`custom[${i}].pattern: too long`);
    const unsafe = unsafePatternReason(pattern);
    if (unsafe) problems.push(`custom[${i}].pattern: rejected (${unsafe})`);
    const ctxUnsafe = typeof c.contextPattern === 'string' ? unsafePatternReason(c.contextPattern) : null;
    if (ctxUnsafe) problems.push(`custom[${i}].contextPattern: rejected (${ctxUnsafe})`);
    if (!['Secrets', 'PII', 'Financial', 'Healthcare', 'Legal', 'Government', 'Infrastructure', 'Code', 'Prompt Injection', 'Education'].includes(String(category))) problems.push(`custom[${i}].category: invalid`);
    if (!['Low', 'Medium', 'High'].includes(String(sensitivity))) problems.push(`custom[${i}].sensitivity: invalid`);
    try { new RegExp(pattern, regexFlags(typeof c.flags === 'string' ? c.flags : undefined)); } catch (err) { problems.push(`custom[${i}].pattern: invalid regex (${(err as Error).message})`); }
    if (typeof c.contextPattern === 'string') {
      try { new RegExp(c.contextPattern, regexFlags(typeof c.flags === 'string' ? c.flags : undefined).replace('g', '')); } catch (err) { problems.push(`custom[${i}].contextPattern: invalid regex (${(err as Error).message})`); }
    }
    if (problems.some(p => p.startsWith(`custom[${i}]`))) return;
    custom.push({
      code, label,
      description: typeof c.description === 'string' ? c.description : undefined,
      category, sensitivity, pattern,
      flags: typeof c.flags === 'string' ? c.flags : undefined,
      contextPattern: typeof c.contextPattern === 'string' ? c.contextPattern : undefined,
      isActive: typeof c.isActive === 'boolean' ? c.isActive : true,
      enforceable: typeof c.enforceable === 'boolean' ? c.enforceable : true,
    });
  });
  return { config: { overrides, custom }, problems };
}

export function resolveClassifierCode(code: string): string {
  const entry = BUILTIN_CLASSIFIERS.find(c => c.code === code);
  return entry?.aliasOf ?? code;
}

function withOverrides(entry: ClassifierEntry, applyRules: boolean): ClassifierEntry {
  const override = current.overrides?.[entry.code] ?? (entry.aliasOf ? current.overrides?.[entry.aliasOf] : undefined);
  const active = (override?.isActive ?? entry.isActive) && (!applyRules || (isDetectorEnabled(entry.code) && isDetectorEnabled(resolveClassifierCode(entry.code))));
  return { ...entry, isActive: active, enforceable: override?.enforceable ?? entry.enforceable };
}

let configVersion = 0;
const effectiveCache = new Map<string, ClassifierEntry[]>();

export function getEffectiveClassifiers(applyRules = true): ClassifierEntry[] {
  const key = `${configVersion}|${applyRules ? rules().fingerprint : '-'}`;
  let hit = effectiveCache.get(key);
  if (!hit) {
    if (effectiveCache.size > 8) effectiveCache.clear();
    hit = [...BUILTIN_CLASSIFIERS, ...compiledCustom()].map(c => withOverrides(c, applyRules));
    effectiveCache.set(key, hit);
  }
  return hit;
}

export function listClassifiers(): ListedClassifier[] {
  return getEffectiveClassifiers(true).map(({ re, context, validate: _validate, ...rest }) => ({
    ...rest,
    pattern: re.source,
    contextPattern: context?.source,
  }));
}

export function isClassifierActive(code: string): boolean {
  return !!getEffectiveClassifiers(true).find(c => c.code === code)?.isActive;
}

export function isClassifierEnforceable(code: string): boolean {
  return !!getEffectiveClassifiers(true).find(c => c.code === code)?.enforceable;
}
