// v2.2: a group photo lives in one person's folder only (no copies); the other people's folders show it from there.
// Which photos each folder shows lives next to the sort log, in <root>/.clearup/people.json, with paths relative to
// the sorted folder — so it travels with the folder to another drive or computer and works there without any setup.
// The people are also written into each photo (PersonInImage), so other apps see them too. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';

export interface ManifestEntry { file: string; sort: number }
export interface PeopleManifest { app: 'PixHaven'; version: 1; folders: Record<string, ManifestEntry[]> }

export const manifestPath = (root: string) => path.join(root, '.clearup', 'people.json');
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const abs = (root: string, r: string) => path.join(root, ...r.split('/'));
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export function readManifest(root: string): PeopleManifest {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8')) as PeopleManifest;
    if (m && typeof m.folders === 'object') return m;
  } catch { /* none yet, or unreadable */ }
  return { app: 'PixHaven', version: 1, folders: {} };
}

function writeManifest(root: string, m: PeopleManifest): void {
  for (const k of Object.keys(m.folders)) if (!m.folders[k].length) delete m.folders[k];
  const file = manifestPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!Object.keys(m.folders).length) { fs.rmSync(file, { force: true }); return; }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, file);
}

/** After an Apply: photo `file` is shown in folder `dir` too. */
export function addShown(root: string, sort: number, items: { dir: string; file: string }[]): void {
  if (!items.length) return;
  const m = readManifest(root);
  for (const it of items) {
    const key = rel(root, it.dir), f = rel(root, it.file);
    const list = (m.folders[key] ??= []);
    if (!list.some(e => same(e.file, f))) list.push({ file: f, sort });
  }
  writeManifest(root, m);
}

/** Undo of a sort: its entries go. */
export function removeSort(root: string, sort: number): void {
  if (!fs.existsSync(manifestPath(root))) return;
  const m = readManifest(root);
  for (const k of Object.keys(m.folders)) m.folders[k] = m.folders[k].filter(e => e.sort !== sort);
  writeManifest(root, m);
}

/** The sorted folder (with its manifest) that `dir` belongs to, looking a couple of levels up. */
function rootOf(p: string): string | null {
  let d = path.dirname(p);
  for (let i = 0; i < 3; i++) {
    if (fs.existsSync(manifestPath(d))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

/** Photos kept in other folders that this folder shows (only those still there). */
export function shownIn(dir: string): string[] {
  const root = fs.existsSync(manifestPath(path.dirname(dir))) ? path.dirname(dir) : rootOf(dir);
  if (!root) return [];
  const m = readManifest(root);
  const key = rel(root, dir);
  const list = Object.entries(m.folders).find(([k]) => same(k, key))?.[1] ?? [];
  return list.map(e => abs(root, e.file)).filter(f => fs.existsSync(f));
}

/** A photo renamed or moved inside the app: entries pointing at it follow. */
export function movedFile(from: string, to: string): void {
  const root = rootOf(from);
  if (!root || !fs.existsSync(manifestPath(root))) return;
  const m = readManifest(root);
  const a = rel(root, from);
  const inside = !path.relative(root, to).startsWith('..');
  let hit = false;
  for (const k of Object.keys(m.folders)) for (const e of m.folders[k]) if (same(e.file, a)) { hit = true; e.file = inside ? rel(root, to) : ''; }
  if (!hit) return;
  for (const k of Object.keys(m.folders)) m.folders[k] = m.folders[k].filter(e => e.file);
  writeManifest(root, m);
}

/** Folders or photos renamed outside the app (found again by reconcile.ts): `map` takes and gives absolute paths. */
export function remapManifest(root: string, map: (p: string) => string): void {
  if (!fs.existsSync(manifestPath(root))) return;
  const m = readManifest(root);
  const folders: Record<string, ManifestEntry[]> = {};
  let changed = false;
  for (const [k, list] of Object.entries(m.folders)) {
    const nk = rel(root, map(abs(root, k)));
    if (nk !== k) changed = true;
    const out = (folders[nk] ??= []);
    for (const e of list) {
      const f = rel(root, map(abs(root, e.file)));
      if (f !== e.file) changed = true;
      if (!out.some(x => same(x.file, f))) out.push({ ...e, file: f });
    }
  }
  if (!changed) return;
  m.folders = folders;
  writeManifest(root, m);
}

/** Folders a scan should treat as already sorted (when the face data is not on this computer). */
export function sortedFolders(root: string): string[] {
  const m = readManifest(root);
  const dirs = new Set<string>();
  for (const [k, list] of Object.entries(m.folders)) {
    dirs.add(abs(root, k));
    for (const e of list) dirs.add(path.dirname(abs(root, e.file)));
  }
  return [...dirs].filter(d => !same(d, root));
}
