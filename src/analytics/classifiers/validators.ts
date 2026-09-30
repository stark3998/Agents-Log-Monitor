function digits(value: string): string {
  return value.replace(/\D/g, '');
}

export function luhn(value: string): boolean {
  const s = digits(value);
  if (s.length < 2) return false;
  let sum = 0;
  let dbl = false;
  for (let i = s.length - 1; i >= 0; i--) {
    let n = Number(s[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function ibanMod97(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of moved) {
    const n = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of n) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

export function abaChecksum(value: string): boolean {
  const s = digits(value);
  if (!/^\d{9}$/.test(s)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = [...s].reduce((n, d, i) => n + Number(d) * w[i], 0);
  return sum !== 0 && sum % 10 === 0;
}

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function verhoeff(value: string): boolean {
  const s = digits(value);
  if (!/^\d+$/.test(s)) return false;
  let c = 0;
  for (let i = 0; i < s.length; i++) c = D[c][P[i % 8][Number(s[s.length - 1 - i])]];
  return c === 0;
}

const VIN_TRANSLIT: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export function vinCheckDigit(value: string): boolean {
  const vin = value.toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return false;
  let sum = 0;
  for (let i = 0; i < vin.length; i++) {
    const ch = vin[i];
    const n = /\d/.test(ch) ? Number(ch) : VIN_TRANSLIT[ch];
    if (n == null) return false;
    sum += n * VIN_WEIGHTS[i];
  }
  const check = sum % 11;
  return vin[8] === (check === 10 ? 'X' : String(check));
}

export function deaChecksum(value: string): boolean {
  const s = value.toUpperCase().replace(/\s+/g, '');
  const m = /^([A-Z]{2})(\d{7})$/.exec(s);
  if (!m) return false;
  const d = m[2];
  const sum = Number(d[0]) + Number(d[2]) + Number(d[4]) + 2 * (Number(d[1]) + Number(d[3]) + Number(d[5]));
  return sum % 10 === Number(d[6]);
}

export function tfnChecksum(value: string): boolean {
  const s = digits(value);
  if (!/^\d{8,9}$/.test(s)) return false;
  const padded = s.length === 8 ? '0' + s : s;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  const sum = [...padded].reduce((n, d, i) => n + Number(d) * weights[i], 0);
  return sum % 11 === 0;
}

export function cusipCheck(value: string): boolean {
  const s = value.toUpperCase();
  if (!/^[0-9A-Z*@#]{9}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const ch = s[i];
    let n = /\d/.test(ch) ? Number(ch) : ch >= 'A' && ch <= 'Z' ? ch.charCodeAt(0) - 55 : ch === '*' ? 36 : ch === '@' ? 37 : 38;
    if (i % 2 === 1) n *= 2;
    sum += Math.floor(n / 10) + (n % 10);
  }
  return (10 - (sum % 10)) % 10 === Number(s[8]);
}

export function isinCheck(value: string): boolean {
  const isin = value.toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  let expanded = '';
  for (const ch of isin) expanded += ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
  return luhn(expanded);
}

export function ssnValid(value: string): boolean {
  const s = digits(value);
  if (!/^\d{9}$/.test(s)) return false;
  const area = Number(s.slice(0, 3));
  const group = Number(s.slice(3, 5));
  const serial = Number(s.slice(5));
  return area !== 0 && area !== 666 && area < 900 && group !== 0 && serial !== 0;
}

const INVALID_EIN_PREFIXES = new Set(['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89']);
export function einPrefixValid(value: string): boolean {
  const s = digits(value);
  return /^\d{9}$/.test(s) && !INVALID_EIN_PREFIXES.has(s.slice(0, 2));
}
