// Size of folders on disk, counted without blocking the window (1.0.3: Settings froze on a big thumbnail cache).
import fs from 'node:fs';
import path from 'node:path';

/** Total bytes of every file below the given folders; missing folders count as 0. */
export async function dirSize(dirs: string[]): Promise<number> {
  let total = 0;
  const pending = [...dirs];
  while (pending.length) {
    const listed = await Promise.all(pending.splice(0, 16).map(d => fs.promises.readdir(d, { withFileTypes: true }).then(e => ({ d, e })).catch(() => null)));
    const files: string[] = [];
    for (const l of listed) {
      if (!l) continue;
      for (const e of l.e) (e.isDirectory() ? pending : files).push(path.join(l.d, e.name));
    }
    for (let i = 0; i < files.length; i += 256) {
      const sizes = await Promise.all(files.slice(i, i + 256).map(f => fs.promises.stat(f).then(s => s.size, () => 0)));
      for (const s of sizes) total += s;
    }
  }
  return total;
}
