/**
 * Minimal YAML emitter for lane objects (plain objects / arrays / strings / numbers / booleans).
 * Parsing is done server-side (POST /api/gov/lanes/validate returns the parsed lane), so the
 * dashboard needs no YAML dependency.
 */

const PLAIN = /^[A-Za-z_./$~][\w .,/@${}~*()'+-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  if (v === '' || !PLAIN.test(v) || RESERVED.test(v) || /^[\d.+-]/.test(v) || /:\s|\s#|\s$/.test(v) || v.startsWith('*')) return JSON.stringify(v);
  return v;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.values(v).every(x => x === undefined));

function block(v: string, indent: string): string {
  return `|\n${v.replace(/\n$/, '').split('\n').map(l => (l ? indent + l : '')).join('\n')}`;
}

function emit(value: unknown, indent: string, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isObj(item)) {
        const entries = Object.entries(item).filter(([, x]) => !isEmpty(x));
        if (!entries.length) { out.push(`${indent}- {}`); continue; }
        const sub: string[] = [];
        emitObject(Object.fromEntries(entries), `${indent}  `, sub);
        out.push(`${indent}- ${sub[0].trimStart()}`, ...sub.slice(1));
      } else if (Array.isArray(item)) {
        out.push(`${indent}-`);
        emit(item, `${indent}  `, out);
      } else if (typeof item === 'string' && item.includes('\n')) {
        out.push(`${indent}- ${block(item, `${indent}  `)}`);
      } else {
        out.push(`${indent}- ${scalar(item as string | number | boolean | null)}`);
      }
    }
    return;
  }
  if (isObj(value)) emitObject(value, indent, out);
}

function emitObject(obj: Record<string, unknown>, indent: string, out: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (isEmpty(v)) continue;
    const key = /^[\w.+-]+$/.test(k) ? k : JSON.stringify(k);
    if (Array.isArray(v)) {
      if (v.every(x => !isObj(x) && !Array.isArray(x) && !(typeof x === 'string' && x.includes('\n'))) && v.length <= 6 && JSON.stringify(v).length < 60) {
        out.push(`${indent}${key}: [${v.map(x => scalar(x as string)).join(', ')}]`);
      } else {
        out.push(`${indent}${key}:`);
        emit(v, `${indent}  `, out);
      }
    } else if (isObj(v)) {
      out.push(`${indent}${key}:`);
      emitObject(v, `${indent}  `, out);
    } else if (typeof v === 'string' && v.includes('\n')) {
      out.push(`${indent}${key}: ${block(v, `${indent}  `)}`);
    } else {
      out.push(`${indent}${key}: ${scalar(v as string | number | boolean | null)}`);
    }
  }
}

/** Serialise a JSON-compatible object to block-style YAML. */
export function toYaml(value: Record<string, unknown>): string {
  const out: string[] = [];
  emitObject(value, '', out);
  return `${out.join('\n')}\n`;
}
