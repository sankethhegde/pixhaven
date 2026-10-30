// v2.5: group photos in File Explorer. A group photo is kept in one person's folder; every other person's folder gets
// a Windows shortcut to it (about 1 KB, opens the original), so Explorer shows it there too without a copy.
// The shortcuts follow people.json: made for every entry, retargeted when photos move, removed when entries go (Undo).
// Only shortcuts PixHaven made (recognised by their description) are ever changed. No Electron imports: the
// shortcut reader/writer is passed in (Electron's shell in the app, a fake in tests).
// v2.9: big folders (2,500 people, 6,000 shortcuts) froze the app for minutes: every shortcut was read through Windows
// on each open and matched against every other. Now the folder is listed without blocking, what each shortcut points
// at is remembered in .clearup/shortcuts.json (read again only when the file changed), matching uses a lookup table,
// and the work gives way to the window every few dozen shortcuts.
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
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const cachePath = (root: string) => path.join(root, '.clearup', 'shortcuts.json');
/** Let the window breathe during long runs: after every ~40 ms of work (one Windows shortcut takes ~25 ms). */
export const breathe = () => new Promise<void>(r => setImmediate(r));
function slicer(): () => Promise<void> {
  let since = performance.now();
  return async () => { if (performance.now() - since > 40) { await breathe(); since = performance.now(); } };
}

interface Cached { t: string | null; s: number; m: number }    // target (null: not one of ours), size, modified

/** Everything below root, listed without blocking: files and folders (keys), and the .lnk files with size and date. */
async function listTree(root: string, lnkDepth = 4): Promise<{ files: Set<string>; dirs: Set<string>; lnks: { path: string; size: number; mtime: number }[] }> {
  const files = new Set<string>(), dirs = new Set<string>([key(root)]);
  const lnks: { path: string; size: number; mtime: number }[] = [];
  const pending: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (pending.length) {
    const batch = pending.splice(0, 32);
    const listed = await Promise.all(batch.map(b => fs.promises.readdir(b.dir, { withFileTypes: true }).then(e => ({ ...b, e })).catch(() => null)));
    const stats: Promise<void>[] = [];
    for (const l of listed) {
      if (!l) continue;
      for (const e of l.e) {
        const p = path.join(l.dir, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.')) { dirs.add(key(p)); pending.push({ dir: p, depth: l.depth + 1 }); } }
        else if (e.isFile()) {
          files.add(key(p));
          if (l.depth <= lnkDepth && e.name.toLowerCase().endsWith('.lnk')) {
            stats.push(fs.promises.stat(p).then(st => { lnks.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs) }); }).catch(() => {}));
          }
        }
      }
    }
    await Promise.all(stats);
  }
  return { files, dirs, lnks };
}

function readCache(root: string): Record<string, Cached> {
  try { return JSON.parse(fs.readFileSync(cachePath(root), 'utf8')) as Record<string, Cached>; } catch { return {}; }
}

/** Make the shortcuts match people.json. `removeAll` takes every one of ours out (before an Undo moves files back). */
export async function syncShortcuts(root: string, links: LinkApi, removeAll = false): Promise<{ made: number; removed: number }> {
  const tree = await listTree(root);
  const cache = readCache(root);
  const next: Record<string, Cached> = {};

  // Ours: from the remembered list while the file is unchanged, else read through Windows (and remembered).
  const have = new Map<string, string[]>();                // "folder|target" → shortcuts
  const slice = slicer();
  for (const l of tree.lnks) {
    const r = rel(root, l.path);
    let c = cache[r];
    if (!c || c.s !== l.size || c.m !== l.mtime) {
      const got = links.read(l.path);
      c = { t: got && got.description === LINK_MARK ? got.target : null, s: l.size, m: l.mtime };
      await slice();
    }
    next[r] = c;
    if (c.t) { const k = `${key(path.dirname(l.path))}|${key(c.t)}`; have.set(k, [...(have.get(k) ?? []), l.path]); }
  }

  const want: { dir: string; target: string }[] = [];
  if (!removeAll) {
    for (const [k, list] of Object.entries(readManifest(root).folders)) {
      const dir = abs(root, k);
      if (!tree.dirs.has(key(dir))) continue;
      for (const e of list) {
        const target = abs(root, e.file);
        if (tree.files.has(key(target)) && key(path.dirname(target)) !== key(dir)) want.push({ dir, target });
      }
    }
  }
  const keep = new Set<string>();
  let made = 0, removed = 0;
  for (const w of want) {
    const list = have.get(`${key(w.dir)}|${key(w.target)}`);
    const hit = list?.find(l => !keep.has(l));
    if (hit) { keep.add(hit); continue; }
    const lnk = linkName(w.dir, w.target, tree.files);
    if (links.write(lnk, w.target, LINK_MARK)) {
      keep.add(lnk); made++;
      tree.files.add(key(lnk));
      try { const st = fs.statSync(lnk); next[rel(root, lnk)] = { t: w.target, s: st.size, m: Math.round(st.mtimeMs) }; } catch { /* read next time */ }
    }
    await slice();
  }
  for (const list of have.values()) for (const l of list) {
    if (keep.has(l)) continue;
    try { fs.rmSync(l, { force: true }); removed++; delete next[rel(root, l)]; } catch { /* in use: next time */ }
    await slice();
  }
  try {
    if (Object.keys(next).length || fs.existsSync(cachePath(root))) {
      fs.mkdirSync(path.dirname(cachePath(root)), { recursive: true });
      fs.writeFileSync(cachePath(root), JSON.stringify(next));
    }
  } catch { /* remembered next time */ }
  return { made, removed };
}

/** A free shortcut name for `target` in `dir`: "beach.jpg.lnk" (Explorer shows "beach.jpg"), else "beach (2).jpg.lnk". */
function linkName(dir: string, target: string, files: Set<string>): string {
  const base = path.basename(target), ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${stem} (${i})${ext}`;
    const lnk = path.join(dir, `${name}.lnk`);
    if (!files.has(key(lnk)) && !files.has(key(path.join(dir, name)))) return lnk;
  }
}
