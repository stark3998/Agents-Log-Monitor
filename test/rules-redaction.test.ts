import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The rules file is read when the module loads, so write it before importing the analytics code.
const rulesFile = path.join(os.tmpdir(), `am-rules-${process.pid}-${Date.now()}.json`);
fs.writeFileSync(rulesFile, JSON.stringify({
  risk: {
    overrides: { 'git-push': 'off', 'pkg-install': 'high', 'bogus': 'extreme' },
    custom: [
      { rule: 'prod-kube', label: 'Touches prod cluster', level: 'critical', pattern: 'kubectl .*--context\\s+prod', target: 'command' },
      { rule: 'bad-regex', label: 'x', level: 'low', pattern: '(' },
    ],
  },
  detectors: { disabled: ['email'] },
  domains: { ignore: ['*.contoso.com', 'example.org'] },
  severity: { highSecretDetections: 2 },
}));
process.env.AGENT_MONITOR_RULES = rulesFile;

type Mods = {
  risk: typeof import('../src/analytics/risk');
  detectors: typeof import('../src/analytics/detectors');
  domains: typeof import('../src/analytics/domains');
  severity: typeof import('../src/analytics/severity');
  rules: typeof import('../src/analytics/rules');
  redact: typeof import('../src/analytics/redact');
};
let m: Mods;

beforeAll(async () => {
  m = {
    risk: await import('../src/analytics/risk'),
    detectors: await import('../src/analytics/detectors'),
    domains: await import('../src/analytics/domains'),
    severity: await import('../src/analytics/severity'),
    rules: await import('../src/analytics/rules'),
    redact: await import('../src/analytics/redact'),
  };
});

afterAll(() => { try { fs.unlinkSync(rulesFile); } catch { /* ignore */ } });

const exec = (command: string) => m.risk.assessRisk({ toolName: 'powershell', category: 'EXEC', input: { command } });

describe('rules file', () => {
  it('reports invalid entries without failing the load', () => {
    const r = m.rules.rules();
    expect(r.exists).toBe(true);
    expect(r.error).toMatch(/bogus/);
    expect(r.error).toMatch(/risk\.custom\[1\]/);
  });

  it('applies risk overrides and custom rules', () => {
    expect(exec('git push origin main').map(h => h.rule)).not.toContain('git-push');
    expect(exec('npm install left-pad')[0]).toMatchObject({ rule: 'pkg-install', level: 'high' });
    expect(exec('kubectl get pods --context prod')[0]).toMatchObject({ rule: 'prod-kube', level: 'critical' });
    const listed = m.risk.listRiskRules();
    expect(listed.find(r => r.rule === 'git-push')).toMatchObject({ level: 'off', defaultLevel: 'medium' });
    expect(listed.find(r => r.rule === 'prod-kube')).toMatchObject({ source: 'custom', level: 'critical' });
  });

  it('disables detectors and ignores domains', () => {
    expect(m.detectors.detect('mail jane.doe@contoso.com').map(d => d.key)).not.toContain('email');
    expect(m.detectors.listDetectors().find(d => d.key === 'email')?.enabled).toBe(false);
    expect(m.domains.extractDomains('curl https://api.contoso.com/x https://example.org https://github.com')).toEqual(['github.com']);
  });

  it('uses severity thresholds from the file', () => {
    const base = { criticalActions: 0, highActions: 0, mediumActions: 0, piiDetections: 0, externalDomains: 0, policyBlocks: 0 };
    expect(m.severity.scoreSession({ ...base, secretDetections: 2 }).severity).toBe('high');
    expect(m.rules.thresholds().mediumRiskActions).toBe(10);
  });
});

describe('redaction', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  it('masks secrets in nested payloads and keeps emails in "secrets" mode', () => {
    const out = m.redact.redactDeep({
      tool_input: { command: `curl -H "Authorization: token ${secret}" https://api.github.com` },
      env: { API_KEY: 'abc123def456ghi789' },
      note: 'contact jane.doe@contoso.com',
      list: [`AWS=AKIAABCDEFGHIJKLMNOP`],
    }, 'secrets');
    const json = JSON.stringify(out);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('abc123def456ghi789');
    expect(json).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(json).toContain('jane.doe@contoso.com');
  });

  it('masks personal data too in "all" mode and is idempotent', () => {
    const once = m.redact.redactString(`mail jane.doe@contoso.com with ${secret}`, 'all');
    expect(once).toContain('j***@contoso.com');
    expect(m.redact.redactString(once, 'all')).toBe(once);
  });

  it('replaces private key blocks entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabc\n-----END RSA PRIVATE KEY-----';
    const out = m.redact.redactString(`key:\n${pem}`, 'secrets');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('MIIEowIBAAKCAQEAabc');
  });

  it('leaves text untouched when off', () => {
    expect(m.redact.redactString(secret, 'off')).toBe(secret);
  });

  it('builds the SQL filter for rows stored with weaker redaction', () => {
    expect(m.redact.weakerRedactionSql('all')).toBe(`(redaction IS NULL OR redaction IN ('off','secrets'))`);
    expect(m.redact.weakerRedactionSql('off')).toBe('redaction IS NULL');
  });
});
