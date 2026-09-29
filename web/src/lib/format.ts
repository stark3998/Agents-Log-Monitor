const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : nf.format(n));
export const fmtCompact = (n: number) => (n >= 10_000 ? cf.format(n) : nf.format(n));

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Math.max(0, now - Date.parse(iso));
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function fmtGap(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min later`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr later`;
  return `${Math.round(h / 24)} days later`;
}

/** Percentage change label, capped like ">999%". */
export function fmtDelta(cur: number, prev: number): { label: string; dir: 'up' | 'down' | 'flat' } {
  if (prev === 0 && cur === 0) return { label: '0%', dir: 'flat' };
  if (prev === 0) return { label: 'New', dir: 'up' };
  const pct = ((cur - prev) / prev) * 100;
  const dir = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
  const abs = Math.abs(pct);
  return { label: abs > 999 ? '>999%' : `${abs < 10 ? abs.toFixed(abs % 1 ? 1 : 0) : Math.round(abs)}%`, dir };
}

export const shortId = (id: string) => id.slice(0, 8);

/** Strip markdown noise (headings, emphasis, code ticks) from a prompt used as a title. */
export function cleanTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.replace(/[#*`_>~]+/g, '').replace(/\s+/g, ' ').trim();
  return t || null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)} ${n === 1 ? one : many}`;
}
