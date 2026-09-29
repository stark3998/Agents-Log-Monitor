export type DiffOp = { type: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

/** Side-by-side row: left (old) and right (new) cells; either may be empty for pure adds/deletes. */
export interface DiffRow { left?: { n: number; text: string; changed: boolean }; right?: { n: number; text: string; changed: boolean } }

/** Line diff via longest-common-subsequence (O(n·m); lane YAML is small). */
export function diffLines(a: string, b: string): DiffOp[] {
  const A = a.replace(/\n$/, '').split('\n');
  const B = b.replace(/\n$/, '').split('\n');
  const n = A.length;
  const m = B.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ type: 'same', text: A[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ type: 'del', text: A[i], a: i + 1 }); i++; }
    else { ops.push({ type: 'add', text: B[j], b: j + 1 }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', text: A[i], a: i + 1 }); i++; }
  while (j < m) { ops.push({ type: 'add', text: B[j], b: j + 1 }); j++; }
  return ops;
}

/** Pair deletions with following additions so replaced lines sit on the same row. */
export function sideBySide(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let k = 0;
  while (k < ops.length) {
    const op = ops[k];
    if (op.type === 'same') {
      rows.push({ left: { n: op.a!, text: op.text, changed: false }, right: { n: op.b!, text: op.text, changed: false } });
      k++;
      continue;
    }
    const dels: DiffOp[] = [];
    const adds: DiffOp[] = [];
    while (k < ops.length && ops[k].type === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].type === 'add') adds.push(ops[k++]);
    const len = Math.max(dels.length, adds.length);
    for (let x = 0; x < len; x++) {
      rows.push({
        left: dels[x] ? { n: dels[x].a!, text: dels[x].text, changed: true } : undefined,
        right: adds[x] ? { n: adds[x].b!, text: adds[x].text, changed: true } : undefined,
      });
    }
  }
  return rows;
}
