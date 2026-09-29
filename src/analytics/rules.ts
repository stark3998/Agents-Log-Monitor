import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DB_PATH } from '../db';

/**
 * Optional user tuning for the heuristics, loaded from `agent-monitor.rules.json` (next to the
 * database, or AGENT_MONITOR_RULES). Everything is optional; missing keys keep the built-in defaults.
 *
 * {
 *   "risk": {
 *     "overrides": { "git-push": "low", "pkg-install": "off" },
 *     "custom": [{ "rule": "prod-kube", "label": "Touches prod cluster", "level": "high",
 *                  "pattern": "kubectl .*--context\\s+prod", "flags": "i", "target": "command" }]
 *   },
 *   "detectors": { "disabled": ["email"] },
 *   "domains": { "ignore": ["*.internal.contoso.com", "example.org"] },
 *   "severity": { "criticalHighActionsWithSecrets": 3, "highSecretDetections": 5, "mediumRiskActions": 10 }
 * }
 */

export type Level = 'critical' | 'high' | 'medium' | 'low';

export interface CustomRiskRule {
  rule: string;
  label: string;
  level: Level;
  pattern: string;
  flags?: string;
  /** What the pattern is tested against: shell command text, file path, or the whole tool input. */
  target?: 'command' | 'path' | 'any';
}

export interface SeverityThresholds {
  /** Secrets + at least this many high-risk actions → critical. */
  criticalHighActionsWithSecrets: number;
  /** At least this many secret detections → high. */
  highSecretDetections: number;
  /** At least this many medium-risk actions → medium. */
  mediumRiskActions: number;
}

export interface RulesConfig {
  risk?: { overrides?: Record<string, Level | 'off'>; custom?: CustomRiskRule[] };
  detectors?: { disabled?: string[] };
  domains?: { ignore?: string[] };
  severity?: Partial<SeverityThresholds>;
}

export const DEFAULT_THRESHOLDS: SeverityThresholds = {
  criticalHighActionsWithSecrets: 3,
  highSecretDetections: 5,
  mediumRiskActions: 10,
};

const LEVELS = new Set(['critical', 'high', 'medium', 'low', 'off']);

export interface LoadedRules {
  path: string;
  exists: boolean;
  error: string | null;
  config: RulesConfig;
  customCompiled: (CustomRiskRule & { re: RegExp })[];
  /** Hash of everything that changes stored analysis (not severity thresholds, which apply at read time). */
  fingerprint: string;
}

export const RULES_PATH = process.env.AGENT_MONITOR_RULES ?? path.join(path.dirname(DB_PATH), 'agent-monitor.rules.json');

function validate(raw: unknown): { config: RulesConfig; compiled: LoadedRules['customCompiled']; problems: string[] } {
  const problems: string[] = [];
  const cfg: RulesConfig = {};
  const r = (raw ?? {}) as Record<string, unknown>;
  const risk = (r.risk ?? {}) as Record<string, unknown>;
  const overrides: Record<string, Level | 'off'> = {};
  for (const [k, v] of Object.entries((risk.overrides ?? {}) as Record<string, unknown>)) {
    if (typeof v === 'string' && LEVELS.has(v)) overrides[k] = v as Level | 'off';
    else problems.push(`risk.overrides.${k}: expected critical|high|medium|low|off`);
  }
  const compiled: LoadedRules['customCompiled'] = [];
  for (const [i, c] of ((Array.isArray(risk.custom) ? risk.custom : []) as Record<string, unknown>[]).entries()) {
    if (typeof c?.rule !== 'string' || typeof c.pattern !== 'string' || !LEVELS.has(String(c.level)) || c.level === 'off') {
      problems.push(`risk.custom[${i}]: needs rule, pattern and level`);
      continue;
    }
    try {
      const flags = typeof c.flags === 'string' ? c.flags.replace(/[gy]/g, '') : 'i';
      const target = c.target === 'path' || c.target === 'any' ? c.target : 'command';
      compiled.push({ rule: c.rule, label: typeof c.label === 'string' ? c.label : c.rule, level: c.level as Level, pattern: c.pattern, flags, target, re: new RegExp(c.pattern, flags) });
    } catch (err) {
      problems.push(`risk.custom[${i}]: invalid pattern (${(err as Error).message})`);
    }
  }
  cfg.risk = { overrides, custom: compiled.map(({ re: _re, ...rest }) => rest) };
  const det = (r.detectors ?? {}) as Record<string, unknown>;
  cfg.detectors = { disabled: Array.isArray(det.disabled) ? det.disabled.filter((x): x is string => typeof x === 'string') : [] };
  const dom = (r.domains ?? {}) as Record<string, unknown>;
  cfg.domains = { ignore: Array.isArray(dom.ignore) ? dom.ignore.filter((x): x is string => typeof x === 'string').map(s => s.toLowerCase()) : [] };
  const sev = (r.severity ?? {}) as Record<string, unknown>;
  cfg.severity = {};
  for (const k of Object.keys(DEFAULT_THRESHOLDS) as (keyof SeverityThresholds)[]) {
    if (sev[k] == null) continue;
    if (typeof sev[k] === 'number' && (sev[k] as number) >= 1) cfg.severity[k] = sev[k] as number;
    else problems.push(`severity.${k}: expected a number ≥ 1`);
  }
  return { config: cfg, compiled, problems };
}

function load(): LoadedRules {
  let raw: unknown = {};
  let error: string | null = null;
  const exists = fs.existsSync(RULES_PATH);
  if (exists) {
    try { raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8')); } catch (err) { error = `Could not parse ${path.basename(RULES_PATH)}: ${(err as Error).message}`; }
  }
  const { config, compiled, problems } = validate(error ? {} : raw);
  if (!error && problems.length) error = problems.join('; ');
  const { severity: _sev, ...analysisRelevant } = config;
  const fingerprint = crypto.createHash('sha1').update(JSON.stringify(analysisRelevant)).digest('hex').slice(0, 12);
  return { path: RULES_PATH, exists, error, config, customCompiled: compiled, fingerprint };
}

let current: LoadedRules = load();
if (current.error) console.warn(`[rules] ${current.error}`);

export function rules(): LoadedRules { return current; }

export function thresholds(): SeverityThresholds {
  return { ...DEFAULT_THRESHOLDS, ...current.config.severity };
}

export function isDetectorEnabled(key: string): boolean {
  return !current.config.detectors?.disabled?.includes(key);
}

export function isDomainIgnored(host: string): boolean {
  return (current.config.domains?.ignore ?? []).some(p =>
    p.startsWith('*.') ? host === p.slice(2) || host.endsWith(p.slice(1)) : host === p);
}

export function riskOverride(rule: string): Level | 'off' | undefined {
  return current.config.risk?.overrides?.[rule];
}

/** Reload from disk; returns true when stored analysis must be recomputed. */
export function reloadRules(): { changed: boolean; reanalyze: boolean } {
  const prev = current;
  current = load();
  if (current.error) console.warn(`[rules] ${current.error}`);
  const changed = JSON.stringify(prev.config) !== JSON.stringify(current.config);
  return { changed, reanalyze: prev.fingerprint !== current.fingerprint };
}

/** Poll the rules file for edits (fs.watchFile works across editors that replace files). */
export function watchRules(onChange: (r: { reanalyze: boolean }) => void): void {
  fs.watchFile(RULES_PATH, { interval: 2000 }, () => {
    const r = reloadRules();
    if (r.changed) {
      console.log(`[rules] reloaded ${RULES_PATH}${r.reanalyze ? ' — re-analyzing stored events' : ''}`);
      onChange(r);
    }
  });
}
