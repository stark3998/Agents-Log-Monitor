import { isDetectorEnabled } from './rules';

export type DetectorClass = 'secret' | 'pii';

export interface Detection {
  key: string;
  label: string;
  cls: DetectorClass;
  maskedSample: string;
}

interface Detector {
  key: string;
  label: string;
  cls: DetectorClass;
  re: RegExp;
  /** Capture group holding the sensitive value (default: whole match). */
  group?: number;
  accept?: (value: string, match: RegExpExecArray) => boolean;
}

const MAX_SCAN = 256 * 1024;

function looksLikePlaceholder(v: string): boolean {
  if (v.includes('****') || /\[REDACTED\]/.test(v)) return true;  // already masked by redaction
  if (/^[$<{%[(]/.test(v)) return true;                       // ${VAR}, <secret>, {{x}}, %VAR%
  if (/^(x+|\*+|\.+|-+|_+|0+|changeme|placeholder|redacted|your[-_a-z]*|example|dummy|test|none|null|undefined|true|false)$/i.test(v)) return true;
  if (/^(.)\1+$/.test(v)) return true;
  if (/(process\.env|os\.environ|getenv|\$env:)/i.test(v)) return true;
  return false;
}

const EMAIL_IGNORE = /(^git@|noreply|no-reply|@example\.(com|org|net)$|@users\.noreply\.github\.com$|@localhost$|@anthropic\.com$|@copilot\.)/i;

const DETECTORS: Detector[] = [
  { key: 'private_key', label: 'Private Key', cls: 'secret', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g },
  { key: 'github_token', label: 'Secret Key (GitHub)', cls: 'secret', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g },
  { key: 'aws_key', label: 'Secret Key (AWS)', cls: 'secret', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { key: 'ai_key', label: 'Secret Key (AI provider)', cls: 'secret', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/g },
  { key: 'slack_token', label: 'Secret Key (Slack)', cls: 'secret', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { key: 'google_key', label: 'Secret Key (Google)', cls: 'secret', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    key: 'azure_conn', label: 'Azure Connection String', cls: 'secret',
    re: /(?:DefaultEndpointsProtocol=https?;AccountName=[^;"\s]+;AccountKey=[^;"\s]{20,}|Endpoint=sb:\/\/[^;"\s]+;SharedAccessKeyName=[^;"\s]+;SharedAccessKey=[^;"\s]{20,}|AccountEndpoint=https:\/\/[^;"\s]+;AccountKey=[^;"\s]{20,}|InstrumentationKey=[0-9a-f-]{36};)/gi,
  },
  { key: 'jwt', label: 'JSON Web Token', cls: 'secret', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    key: 'env_secret', label: 'Secret in env var', cls: 'secret', group: 2,
    re: /\b((?=[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CLIENT_SECRET|CONN(?:ECTION)?_?STRING))[A-Z][A-Z0-9_]*)\s*[=:]\s*\\?["']?([^\s"'\\,;]{8,})/g,
    accept: v => !looksLikePlaceholder(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v),
  },
  {
    key: 'password_url', label: 'Password in URL', cls: 'secret', group: 1,
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:([^\s@/"']{3,})@[a-z0-9.-]+/gi,
    accept: v => !looksLikePlaceholder(v),
  },
  {
    key: 'email', label: 'Email Address', cls: 'pii',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: v => !EMAIL_IGNORE.test(v) && !/\.(png|jpe?g|gif|svg|webp|js|ts|css)$/i.test(v),
  },
];

export function mask(value: string, cls: DetectorClass = 'secret'): string {
  if (cls === 'pii' && value.includes('@')) {
    const [local, domain] = value.split('@');
    return (local[0] ?? '') + '***@' + domain;
  }
  if (value.length <= 8) return value.slice(0, 2) + '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Run all enabled detectors over text; returns at most one detection per detector key. */
export function detect(text: string | null | undefined): Detection[] {
  if (!text) return [];
  const t = text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text;
  const out: Detection[] = [];
  for (const d of DETECTORS) {
    if (!isDetectorEnabled(d.key)) continue;
    d.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = d.re.exec(t)) !== null && guard++ < 50) {
      const value = m[d.group ?? 0] ?? m[0];
      if (d.accept && !d.accept(value, m)) continue;
      const sample = d.key === 'private_key' ? m[0].replace(/-/g, '').trim() : mask(value, d.cls);
      out.push({ key: d.key, label: d.label, cls: d.cls, maskedSample: sample });
      break;
    }
  }
  return out;
}

export function detectorClass(key: string): DetectorClass {
  return DETECTORS.find(d => d.key === key)?.cls ?? 'secret';
}

export function listDetectors(): { key: string; label: string; cls: DetectorClass; enabled: boolean }[] {
  return DETECTORS.map(d => ({ key: d.key, label: d.label, cls: d.cls, enabled: isDetectorEnabled(d.key) }));
}

const PEM_BLOCK_RE = /-----BEGIN ((?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

/**
 * Replace every sensitive value of the given classes with its masked form (private keys become a
 * `[REDACTED]` block). Redaction is independent of the detectors disabled in the rules file.
 */
export function redactText(text: string, classes: ReadonlySet<DetectorClass>): string {
  if (!text || classes.size === 0) return text;
  let out = text;
  if (classes.has('secret')) out = out.replace(PEM_BLOCK_RE, (_m, kind: string) => `-----BEGIN ${kind}----- [REDACTED] -----END ${kind}-----`);
  for (const d of DETECTORS) {
    if (!classes.has(d.cls) || d.key === 'private_key') continue;
    d.re.lastIndex = 0;
    out = out.replace(d.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const value = (d.group ? (args[d.group] as string | undefined) : match) ?? match;
      if (value.includes('****')) return match;
      const fake = [match, ...args.slice(1, -2)] as unknown as RegExpExecArray;
      if (d.accept && !d.accept(value, fake)) return match;
      return match.replace(value, mask(value, d.cls));
    });
  }
  return out;
}
