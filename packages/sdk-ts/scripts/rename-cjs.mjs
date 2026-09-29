import { readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p);
    else if (entry.name.endsWith('.js')) {
      const cjs = p.slice(0, -3) + '.cjs';
      let text = await readFile(p, 'utf8');
      text = text.replace(/require\("\.\/(.*?)\.js"\)/g, 'require("./$1.cjs")');
      await writeFile(p, text);
      await rename(p, cjs);
    }
  }
}

await walk(fileURLToPath(new URL('../dist/cjs', import.meta.url)));
