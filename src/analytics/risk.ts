import { canonicalToolName, ToolCategory } from './classify';
import { riskOverride, rules } from './rules';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RiskHit {
  level: RiskLevel;
  rule: string;
  label: string;
}

interface CommandRule {
  rule: string;
  label: string;
  level: RiskLevel;
  re: RegExp;
}

// Shell command rules — ordered most severe first. Tune here.
const COMMAND_RULES: CommandRule[] = [
  { rule: 'rm-root', label: 'Recursive delete of root/home', level: 'critical', re: /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)(?:\s|$|\*)|Remove-Item\b[^\n|;]*-Recurse[^\n|;]*\s(?:[A-Z]:\\?|~|\$env:USERPROFILE)(?:\s|$)/i },
  { rule: 'pipe-to-shell', label: 'Remote script piped to shell', level: 'critical', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b|\b(?:iex|Invoke-Expression)\b[^\n]*\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|DownloadString)\b|\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i },
  { rule: 'disk-wipe', label: 'Disk format / wipe', level: 'critical', re: /\b(?:mkfs(?:\.\w+)?|Format-Volume|diskpart|dd\s+if=[^\n]*\bof=\/dev\/)/i },
  { rule: 'disable-security', label: 'Disables security tooling', level: 'critical', re: /Set-MpPreference\s+-Disable|Add-MpPreference\s+-ExclusionPath|setenforce\s+0|ufw\s+disable|netsh\s+advfirewall\s+set\s+\w+\s+state\s+off/i },
  { rule: 'force-push', label: 'Force push', level: 'high', re: /\bgit\s+push\b[^\n]*(?:--force\b|-f\b|--force-with-lease\b)/i },
  { rule: 'history-rewrite', label: 'Destructive git operation', level: 'high', re: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|filter-branch|branch\s+-D|checkout\s+--\s+\.)/i },
  { rule: 'recursive-delete', label: 'Recursive force delete', level: 'medium', re: /\brm\s+-[a-z]*(?:rf|fr)\b|Remove-Item\b[^\n|;]*-Recurse[^\n|;]*-Force|Remove-Item\b[^\n|;]*-Force[^\n|;]*-Recurse|\brd\s+\/s\s+\/q\b|\brmdir\s+\/s\b/i },
  { rule: 'cred-read', label: 'Reads credential material', level: 'high', re: /(?:^|[\s"'\\/=])\.env(?:\.(?!example\b|sample\b|template\b|dist\b)[a-z]+)?(?=$|[\s"';|)])|\bid_(?:rsa|ed25519|ecdsa)\b(?!\.pub)|\.aws[\\/]credentials|[\\/]\.azure[\\/]|\.git-credentials|[\\/]\.npmrc\b|\.pypirc\b|[\\/]\.netrc\b|\.kube[\\/]config|\.(?:pem|pfx|p12|key)(?=$|[\s"'])/im },
  { rule: 'secret-dump', label: 'Dumps secrets or environment', level: 'high', re: /\baz\s+keyvault\s+secret\s+(?:show|download)|\baz\s+(?:ad\s+(?:sp|app)\s+credential\s+reset|account\s+get-access-token)|\bgh\s+auth\s+token\b|\bprintenv\b|Get-ChildItem\s+env:|\bgci\s+env:|\bset\s*$|\benv\s*$|\bkubectl\s+get\s+secrets?\b/im },
  { rule: 'privilege', label: 'Privilege escalation / permissive chmod', level: 'high', re: /\bsudo\b|\bchmod\s+(?:-R\s+)?777\b|Start-Process\b[^\n]*-Verb\s+RunAs|\brunas\b/i },
  { rule: 'db-drop', label: 'Drops database objects', level: 'high', re: /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i },
  { rule: 'publish', label: 'Publishes a package or image', level: 'high', re: /\b(?:npm\s+publish|twine\s+upload|docker\s+push|dotnet\s+nuget\s+push|cargo\s+publish|gh\s+release\s+create)\b/i },
  { rule: 'cloud-delete', label: 'Deletes cloud resources', level: 'medium', re: /\b(?:az\s+[a-z- ]*\bdelete\b|kubectl\s+delete|terraform\s+destroy|aws\s+[a-z0-9-]+\s+(?:delete|terminate)-)/i },
  { rule: 'git-push', label: 'Pushes to remote', level: 'medium', re: /\bgit\s+push\b/i },
  { rule: 'pkg-install', label: 'Installs packages', level: 'medium', re: /\b(?:npm\s+(?:i|install|add)|pnpm\s+add|yarn\s+add|pip3?\s+install|uv\s+(?:pip\s+install|add)|dotnet\s+add\s+package|Install-Module|winget\s+install|choco\s+install|apt(?:-get)?\s+install|brew\s+install)\b/i },
  { rule: 'net-egress', label: 'Network request from shell', level: 'medium', re: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|scp|rsync|ssh|ftp)\b/i },
  { rule: 'dynamic-exec', label: 'Dynamic code execution', level: 'medium', re: /\b(?:Invoke-Expression|iex|eval)\b/i },
];

const RANK: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export function maxRisk(a: RiskLevel | null, b: RiskLevel | null): RiskLevel | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}
export function riskRank(l: string | null | undefined): number { return l ? (RANK[l as RiskLevel] ?? 0) : 0; }

function commandText(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const o = input as Record<string, unknown>;
  const c = o.command ?? o.cmd ?? o.script ?? o.input;
  return typeof c === 'string' ? c : '';
}

function pathText(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.path ?? o.filePath ?? o.notebook_path;
  return typeof p === 'string' ? p : '';
}

function isOutside(p: string, cwd: string | null | undefined): boolean {
  if (!p || !cwd) return false;
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const isAbs = /^([a-z]:)?\//i.test(p.replace(/\\/g, '/'));
  if (!isAbs) return false;
  return !norm(p).startsWith(norm(cwd));
}

export interface RiskInput {
  toolName: string | null | undefined;
  category: ToolCategory;
  input: unknown;
  cwd?: string | null;
  secretDetected?: boolean;
  externalDomains?: string[];
}

/** Evaluate risk rules for one tool call. Returns all hits (most severe first). */
export function assessRisk(r: RiskInput): RiskHit[] {
  const hits: RiskHit[] = [];
  const canon = canonicalToolName(r.toolName);
  const cmd = commandText(r.input);

  if (r.category === 'EXEC' && cmd) {
    for (const rule of COMMAND_RULES) {
      if (rule.re.test(cmd)) hits.push({ level: rule.level, rule: rule.rule, label: rule.label });
    }
    if (r.secretDetected && hits.some(h => h.rule === 'net-egress' || h.rule === 'git-push')) {
      hits.push({ level: 'critical', rule: 'secret-egress', label: 'Secret sent over the network' });
    }
  }

  const p = pathText(r.input);
  if (p && (r.category === 'READ' || r.category === 'WRITE')) {
    const credRule = COMMAND_RULES.find(x => x.rule === 'cred-read')!;
    if (credRule.re.test(p)) hits.push({ level: 'high', rule: 'cred-read', label: 'Reads credential material' });
    if (r.category === 'WRITE' && isOutside(p, r.cwd)) hits.push({ level: 'medium', rule: 'write-outside', label: 'Writes outside the workspace' });
  }

  if (r.category === 'WRITE' && r.secretDetected) {
    hits.push({ level: 'medium', rule: 'secret-write', label: 'Writes a secret to disk' });
  }

  if ((canon === 'WebFetch' || r.category === 'NETWORK') && r.externalDomains?.length) {
    hits.push({ level: r.secretDetected ? 'critical' : 'low', rule: r.secretDetected ? 'secret-egress' : 'web-fetch', label: r.secretDetected ? 'Secret sent over the network' : 'Fetches external content' });
  }

  // User-defined rules from agent-monitor.rules.json
  const cr = rules().customCompiled;
  if (cr.length) {
    let any: string | null = null;
    for (const c of cr) {
      const target = c.target === 'path' ? p : c.target === 'any' ? (any ??= JSON.stringify(r.input ?? '')) : (r.category === 'EXEC' ? cmd : '');
      if (target && c.re.test(target)) hits.push({ level: c.level, rule: c.rule, label: c.label });
    }
  }

  // Apply level overrides ("off" removes the rule).
  const out: RiskHit[] = [];
  for (const h of hits) {
    const o = riskOverride(h.rule);
    if (o === 'off') continue;
    out.push(o ? { ...h, level: o } : h);
  }
  return out.sort((a, b) => RANK[b.level] - RANK[a.level]);
}

// Rules evaluated outside COMMAND_RULES, listed for the Rules view.
const DERIVED_RULES: { rule: string; label: string; level: RiskLevel; appliesTo: string }[] = [
  { rule: 'secret-egress', label: 'Secret sent over the network', level: 'critical', appliesTo: 'shell / web requests carrying a detected secret' },
  { rule: 'write-outside', label: 'Writes outside the workspace', level: 'medium', appliesTo: 'file writes' },
  { rule: 'secret-write', label: 'Writes a secret to disk', level: 'medium', appliesTo: 'file writes' },
  { rule: 'web-fetch', label: 'Fetches external content', level: 'low', appliesTo: 'web fetch tools' },
];

export interface RiskRuleInfo {
  rule: string;
  label: string;
  defaultLevel: RiskLevel | null;
  level: RiskLevel | 'off';
  source: 'built-in' | 'custom';
  appliesTo: string;
  pattern?: string;
}

/** Effective risk rules (built-in + custom) with overrides applied. */
export function listRiskRules(): RiskRuleInfo[] {
  const eff = (rule: string, level: RiskLevel) => riskOverride(rule) ?? level;
  const builtIn: RiskRuleInfo[] = [
    ...COMMAND_RULES.map(c => ({ rule: c.rule, label: c.label, defaultLevel: c.level, level: eff(c.rule, c.level), source: 'built-in' as const, appliesTo: c.rule === 'cred-read' ? 'shell commands and file paths' : 'shell commands' })),
    ...DERIVED_RULES.map(d => ({ rule: d.rule, label: d.label, defaultLevel: d.level, level: eff(d.rule, d.level), source: 'built-in' as const, appliesTo: d.appliesTo })),
  ];
  const custom: RiskRuleInfo[] = rules().customCompiled.map(c => ({
    rule: c.rule, label: c.label, defaultLevel: null, level: eff(c.rule, c.level), source: 'custom' as const,
    appliesTo: c.target === 'path' ? 'file paths' : c.target === 'any' ? 'any tool input' : 'shell commands', pattern: c.pattern,
  }));
  return [...builtIn, ...custom];
}
