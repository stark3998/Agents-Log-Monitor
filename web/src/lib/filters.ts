import { useSearchParams } from 'react-router-dom';
import type { Conversation } from '../api/types';

export type FilterField = 'agent' | 'severity' | 'autonomy' | 'data' | 'channel' | 'enforcement' | 'connect';

export const FILTER_FIELDS: FilterField[] = ['agent', 'severity', 'autonomy', 'data', 'channel', 'enforcement', 'connect'];

export const FILTER_LABELS: Record<FilterField, string> = {
  agent: 'Agent',
  severity: 'Severity',
  autonomy: 'Autonomy',
  data: 'Data',
  channel: 'Channel',
  enforcement: 'Enforcement',
  connect: 'Connects to',
};

export type Filters = Partial<Record<FilterField, string[]>> & { q?: string };

export function readFilters(p: URLSearchParams): Filters {
  const f: Filters = {};
  for (const k of FILTER_FIELDS) {
    const v = p.get(k);
    if (v) f[k] = v.split(',').filter(Boolean);
  }
  const q = p.get('q');
  if (q) f.q = q;
  return f;
}

export function useFilters(): [Filters, (field: FilterField | 'q', values: string[] | string | null) => void] {
  const [params, setParams] = useSearchParams();
  const filters = readFilters(params);
  const set = (field: FilterField | 'q', values: string[] | string | null) => {
    setParams(prev => {
      const n = new URLSearchParams(prev);
      const v = Array.isArray(values) ? values.join(',') : values;
      if (v) n.set(field, v); else n.delete(field);
      return n;
    }, { replace: true });
  };
  return [filters, set];
}

/** Values selectable for a field, derived from the loaded conversations. */
export function filterOptions(field: FilterField, rows: Conversation[]): { value: string; label: string }[] {
  const uniq = new Map<string, string>();
  for (const r of rows) {
    switch (field) {
      case 'agent': uniq.set(r.agentKey, r.agentName); break;
      case 'severity': break;
      case 'autonomy': if (r.autonomyLevel) uniq.set(String(r.autonomyLevel), `${r.autonomyLevel} · ${r.autonomyLabel}`); break;
      case 'data': for (const d of r.detectors) uniq.set(d.key, d.label); break;
      case 'channel': for (const c of r.channels) uniq.set(c, c); break;
      case 'enforcement': break;
      case 'connect': for (const k of [...r.mcpKeys, ...r.domainKeys]) uniq.set(k, k); break;
    }
  }
  if (field === 'severity') return ['critical', 'high', 'medium', 'low', 'info'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));
  if (field === 'enforcement') return [
    { value: 'denied', label: 'Denied' }, { value: 'blocked', label: 'Blocked' },
    { value: 'warned', label: 'Warned' }, { value: 'prompted', label: 'Permission prompt' },
  ];
  if (field === 'data') uniq.set('any', 'Any sensitive data');
  return [...uniq.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => (a.value === 'any' ? -1 : b.value === 'any' ? 1 : a.label.localeCompare(b.label)));
}

export function applyFilters(rows: Conversation[], f: Filters): Conversation[] {
  const q = f.q?.trim().toLowerCase();
  return rows.filter(r => {
    if (f.agent?.length && !f.agent.includes(r.agentKey)) return false;
    if (f.severity?.length && !f.severity.includes(r.severity)) return false;
    if (f.autonomy?.length && !f.autonomy.includes(String(r.autonomyLevel ?? ''))) return false;
    if (f.data?.length) {
      const keys = r.detectors.map(d => d.key);
      if (!f.data.some(v => (v === 'any' ? keys.length > 0 : keys.includes(v)))) return false;
    }
    if (f.channel?.length && !f.channel.some(c => r.channels.includes(c as never))) return false;
    if (f.enforcement?.length && !f.enforcement.some(k => (r.enforcement as Record<string, number>)[k] > 0)) return false;
    if (f.connect?.length && !f.connect.some(k => r.mcpKeys.includes(k) || r.domainKeys.includes(k))) return false;
    if (q) {
      const hay = `${r.title ?? ''} ${r.id} ${r.projectPath ?? ''} ${r.user ?? ''} ${r.endpoint ?? ''} ${r.agentName} ${r.model ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
