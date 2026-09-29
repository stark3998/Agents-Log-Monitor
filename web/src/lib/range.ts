import { useSearchParams } from 'react-router-dom';

export interface RangeOption { key: string; label: string; short: string; ms: number }

export const RANGES: RangeOption[] = [
  { key: '24h', label: 'Last 24 hours', short: '24h', ms: 86_400_000 },
  { key: '7d', label: 'Last 7 days', short: '7d', ms: 7 * 86_400_000 },
  { key: '30d', label: 'Last 30 days', short: '30d', ms: 30 * 86_400_000 },
  { key: '90d', label: 'Last 90 days', short: '90d', ms: 90 * 86_400_000 },
];

export const DEFAULT_RANGE = '7d';

export function rangeOption(key: string | null | undefined): RangeOption {
  return RANGES.find(r => r.key === key) ?? RANGES.find(r => r.key === DEFAULT_RANGE)!;
}

/** Resolve a range key into concrete ISO bounds at call time (so refetches use a fresh "now"). */
export function rangeBounds(key: string): { from: string; to: string } {
  const r = rangeOption(key);
  const to = Date.now();
  return { from: new Date(to - r.ms).toISOString(), to: new Date(to).toISOString() };
}

export function useRangeKey(): [string, (k: string) => void] {
  const [params, setParams] = useSearchParams();
  const key = rangeOption(params.get('range')).key;
  const set = (k: string) => {
    setParams(p => {
      const n = new URLSearchParams(p);
      if (k === DEFAULT_RANGE) n.delete('range'); else n.set('range', k);
      return n;
    }, { replace: true });
  };
  return [key, set];
}
