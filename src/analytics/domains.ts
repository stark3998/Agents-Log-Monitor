import { isDomainIgnored } from './rules';

const URL_RE = /\bhttps?:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(?::\d+)?/gi;
const SSH_GIT_RE = /\bgit@([a-z0-9.-]+\.[a-z]{2,}):/gi;

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (!ip) return false;
  const a = Number(ip[1]); const b = Number(ip[2]);
  return a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** External hostnames referenced in a tool call's input (not its output). */
export function extractDomains(input: unknown): string[] {
  if (input == null) return [];
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const out = new Set<string>();
  for (const re of [URL_RE, SSH_GIT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const host = m[1].toLowerCase().replace(/\.$/, '');
      if (!isPrivateHost(host) && !isDomainIgnored(host) && /[a-z]/.test(host.split('.').pop() ?? '')) out.add(host);
      if (out.size >= 20) break;
    }
  }
  return [...out];
}
