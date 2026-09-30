import type { EndpointInfo, EndpointInventory, PostureFindingDraft } from './types';
import { checkDef } from './checks/defs';
import { domainMatchesOrg, normalizeEmailDomain, semverCompare } from './utils';

export const PERSONAL_MAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'aol.com', 'zoho.com', 'fastmail.com', 'hey.com', 'mail.com', 'pm.me', 'yandex.com', 'yandex.ru', 'gmx.com', 'gmx.net', 'gmx.de'];

function isPersonal(domain: string, allow: string[]): boolean {
  const d = domain.toLowerCase();
  return allow.some(p => p.endsWith('.*') ? d === p.slice(0, -2) || d.startsWith(`${p.slice(0, -2)}.`) : d === p || d.endsWith(`.${p}`));
}

export function evaluateFleet(reports: { endpoint: EndpointInfo; inventory: EndpointInventory }[], opts: { orgDomains: string[]; personalMailDomains?: string[] }): (PostureFindingDraft & { endpointId: string })[] {
  const out: (PostureFindingDraft & { endpointId: string })[] = [];
  const personal = [...PERSONAL_MAIL_DOMAINS, ...(opts.personalMailDomains ?? [])];
  if (opts.orgDomains.length) {
    const def = checkDef('ai-agent-non-corporate-user');
    for (const r of reports) for (const acct of r.inventory.accounts) {
      const domain = normalizeEmailDomain(acct.account);
      if (!domain || domainMatchesOrg(domain, opts.orgDomains) || isPersonal(domain, personal)) continue;
      out.push({ checkId: def.id, severity: def.severity, category: def.category, title: def.title, subject: `${acct.agentId}:${domain}`, summary: `Agent ${acct.agentId} is signed in with a non-corporate account domain.`, evidence: { agentId: acct.agentId, domain }, fixable: false, endpointId: r.endpoint.endpointId });
    }
  }
  // One version per endpoint (the highest installed; IDEs keep old extension folders and browsers
  // install per profile), compared across endpoints only.
  const perEndpoint = new Map<string, Map<string, string>>();
  for (const r of reports) for (const a of r.inventory.agents) if (a.version) {
    const eps = perEndpoint.get(a.id) ?? new Map<string, string>();
    const cur = eps.get(r.endpoint.endpointId);
    if (!cur || semverCompare(a.version, cur) > 0) eps.set(r.endpoint.endpointId, a.version);
    perEndpoint.set(a.id, eps);
  }
  const versions = new Map<string, Map<string, { count: number; endpoints: string[] }>>();
  for (const [agentId, eps] of perEndpoint) {
    if (eps.size < 2) continue;
    const byVer = new Map<string, { count: number; endpoints: string[] }>();
    for (const [endpointId, v] of eps) {
      const rec = byVer.get(v) ?? { count: 0, endpoints: [] };
      rec.count++; rec.endpoints.push(endpointId); byVer.set(v, rec);
    }
    versions.set(agentId, byVer);
  }
  const def = checkDef('ai-agent-version-mismatch');
  for (const [agentId, byVer] of versions) {
    if (byVer.size < 2) continue;
    const standard = [...byVer.entries()].sort((a, b) => (b[1].count - a[1].count) || semverCompare(b[0], a[0]))[0][0];
    for (const [ver, rec] of byVer) if (ver !== standard) for (const endpointId of rec.endpoints) out.push({ checkId: def.id, severity: def.severity, category: def.category, title: def.title, subject: `${agentId}@${ver}`, summary: `${agentId} version ${ver} differs from fleet standard ${standard}.`, evidence: { agentId, version: ver, standardVersion: standard, versions: [...byVer.keys()] }, fixable: false, endpointId });
  }
  return out;
}
