// v2.5: group photos in File Explorer. A group photo is kept in one person's folder; every other person's folder gets
// a Windows shortcut to it (about 1 KB, opens the original), so Explorer shows it there too without a copy.
// The shortcuts follow people.json: made for every entry, retargeted when photos move, removed when entries go (Undo).
// Only shortcuts PixHaven made (recognised by their description) are ever changed. No Electron imports: the
// shortcut reader/writer is passed in (Electron's shell in the app, a fake in tests).
import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './people-manifest';

export const LINK_MARK = 'PixHaven group photo';

export interface LinkApi {
  write(lnk: string, target: string, description: string): boolean;
  read(lnk: string): { target: string; description: string } | null;
}

const key = (p: string) => (process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p));
const abs = (root: string, r: string) => path.join(root, ...r.split('/'));

/** Our shortcuts below root (a few levels down, folders starting with "." skipped). */
function ours(root: string, links: LinkApi): { lnk: string; target: string }[] {
  const out: { lnk: string; target: string }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4 && !e.name.startsWith('.')) walk(p, depth + 1); }
      else if (e.isFile() && e.name.toLowerCase().endsWith('.lnk')) {
        const r = links.read(p);
        if (r && r.description === LINK_MARK) out.push({ lnk: p, target: r.target });
      }
    }
  };
  walk(root, 0);
  return out;
}

/** A free shortcut name for `target` in `dir`: "beach.jpg.lnk" (Explorer shows "beach.jpg"), else "beach (2).jpg.lnk". */
function linkName(dir: string, target: string): string {
  const base = path.basename(target), ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${stem} (${i})${ext}`;
    const lnk = path.join(dir, `${name}.lnk`);
    if (!fs.existsSync(lnk) && !fs.existsSync(path.join(dir, name))) return lnk;
  }
}

/** Make the shortcuts match people.json. `removeAll` takes every one of ours out (before an Undo moves files back). */
export function syncShortcuts(root: string, links: LinkApi, removeAll = false): { made: number; removed: number } {
  const have = ours(root, links);
  const want: { dir: string; target: string }[] = [];
  if (!removeAll) {
    for (const [k, list] of Object.entries(readManifest(root).folders)) {
      const dir = abs(root, k);
      if (!fs.existsSync(dir)) continue;
      for (const e of list) {
        const target = abs(root, e.file);
        if (fs.existsSync(target) && key(path.dirname(target)) !== key(dir)) want.push({ dir, target });
      }
    }
  }
  const keep = new Set<string>();
  let made = 0, removed = 0;
  for (const w of want) {
    const hit = have.find(h => !keep.has(h.lnk) && key(path.dirname(h.lnk)) === key(w.dir) && key(h.target) === key(w.target));
    if (hit) { keep.add(hit.lnk); continue; }
    const lnk = linkName(w.dir, w.target);
    if (links.write(lnk, w.target, LINK_MARK)) { keep.add(lnk); made++; }
  }
  for (const h of have) {
    if (keep.has(h.lnk)) continue;
    try { fs.rmSync(h.lnk, { force: true }); removed++; } catch { /* in use: next time */ }
  }
  return { made, removed };
}
