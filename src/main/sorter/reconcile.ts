// v2.4: a sorted folder opens again as it was — even after it, or the person folders inside it, were renamed or moved
// in Explorer. Photos are found again by name and size, the stored paths follow (face data, person folders, the
// "also shown in" list and the undo log), so a later scan does not see them as new photos. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { type Db, tx } from '../db';
import { isImageFile } from '../image-io';
import { logPath } from './apply';
import { remapManifest } from './people-manifest';
import { TagReader } from '../library/file-tags';
import { writePeople } from '../library/xmp';

export interface Reconciled {
  movedFrom: string | null;                     // the sorted folder itself was renamed or moved from here
  folders: { from: string; to: string }[];      // person folders found under a new name
  photos: number;                               // photos found at a new place
}
export type Moved = { from: string; to: string }[];

const win = process.platform === 'win32';
const key = (p: string) => (win ? p.toLowerCase() : p);
const under = (p: string, dir: string) => key(p).startsWith(key(dir) + path.sep);

/** Image files below root (folders starting with "." skipped), with their sizes. */
function listFiles(root: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(p); }
      else if (e.isFile() && isImageFile(p)) { try { out.push({ path: p, size: fs.statSync(p).size }); } catch { /* vanished */ } }
    }
  };
  walk(root);
  return out;
}

/** A path rewriter: exact files first, then folder prefixes (longest first). */
function mapper(files: Map<string, string>, dirs: { from: string; to: string }[]): (p: string) => string {
  const sorted = [...dirs].sort((a, b) => b.from.length - a.from.length);
  return p => {
    const f = files.get(key(p));
    if (f) return f;
    for (const d of sorted) {
      if (key(p) === key(d.from)) return d.to;
      if (under(p, d.from)) return d.to + p.slice(d.from.length);
    }
    return p;
  };
}

/** Every stored path of one folder goes through `map` (only the ones that change are written). Returns the photos moved. */
function rewrite(db: Db, fid: number, root: string, map: (p: string) => string): Moved {
  const moved: Moved = [];
  tx(db, () => {
    for (const t of ['images', 'photo_info']) {
      const set = db.prepare(`UPDATE ${t} SET path = ? WHERE id = ?`);
      for (const r of db.prepare(`SELECT id, path FROM ${t} WHERE folder_id = ?`).all(fid) as { id: number; path: string }[]) {
        const n = map(r.path);
        if (n === r.path) continue;
        set.run(n, r.id);
        if (t === 'images') moved.push({ from: r.path, to: n });
      }
    }
    const dirs = db.prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[];
    db.prepare('DELETE FROM sort_dirs WHERE folder_id = ?').run(fid);
    const addDir = db.prepare('INSERT OR IGNORE INTO sort_dirs (folder_id, dir) VALUES (?, ?)');
    for (const d of dirs) addDir.run(fid, map(d.dir));
    const setP = db.prepare('UPDATE people SET dir = ? WHERE id = ?');
    for (const p of db.prepare('SELECT id, dir FROM people WHERE folder_id = ? AND dir IS NOT NULL').all(fid) as { id: number; dir: string }[]) {
      const n = map(p.dir);
      if (n !== p.dir) setP.run(n, p.id);
    }
    // The plan of a sort is kept for "finish an interrupted sort".
    const setPlan = db.prepare('UPDATE sorts SET plan = ? WHERE id = ?');
    for (const s of db.prepare('SELECT id, plan FROM sorts WHERE folder_id = ? AND plan IS NOT NULL').all(fid) as { id: number; plan: string }[]) {
      const deep = (v: unknown): unknown => typeof v === 'string' ? (path.isAbsolute(v) ? map(v) : v)
        : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v;
      try { const n = JSON.stringify(deep(JSON.parse(s.plan))); if (n !== s.plan) setPlan.run(n, s.id); } catch { /* unreadable: left */ }
    }
  });
  // The undo log (absolute paths) and the "also shown in" list (relative to root) follow too.
  try {
    const file = logPath(root);
    if (fs.existsSync(file)) {
      const old = fs.readFileSync(file, 'utf8');
      const next = old.split('\n').map(l => {
        if (!l) return l;
        try {
          const e = JSON.parse(l);
          if (e.to) e.to = map(e.to);
          if (e.from) e.from = map(e.from);
          return JSON.stringify(e);
        } catch { return l; }
      }).join('\n');
      if (next !== old) { fs.writeFileSync(`${file}.tmp`, next); fs.renameSync(`${file}.tmp`, file); }
    }
  } catch { /* log unreadable: Undo reports what it cannot find */ }
  try { remapManifest(root, map); } catch { /* list unreadable */ }
  return moved;
}

/**
 * A folder chosen for the first time may be a sorted folder that was renamed or moved: it is matched with a known
 * folder that no longer exists by the photos inside (name and size). Returns the old path when it was one.
 */
export function relocateFolder(db: Db, root: string): { from: string; moved: Moved } | null {
  if (db.prepare('SELECT 1 FROM folders WHERE path = ?').get(root)) return null;
  if (!fs.existsSync(path.join(root, '.clearup'))) return null;   // only folders PixHaven sorted
  const gone = (db.prepare('SELECT id, path FROM folders').all() as { id: number; path: string }[]).filter(f => !fs.existsSync(f.path));
  if (!gone.length) return null;
  const here = new Set(listFiles(root).map(f => `${key(path.basename(f.path))}|${f.size}`));
  let best: { id: number; path: string; score: number } | null = null;
  for (const f of gone) {
    const sample = db.prepare("SELECT path, size FROM images WHERE folder_id = ? AND status = 'done' ORDER BY RANDOM() LIMIT 200").all(f.id) as { path: string; size: number }[];
    if (sample.length < 3) continue;
    const score = sample.filter(s => here.has(`${key(path.basename(s.path))}|${s.size}`)).length / sample.length;
    if (score >= 0.6 && (!best || score > best.score)) best = { ...f, score };
  }
  if (!best) return null;
  db.prepare('UPDATE folders SET path = ? WHERE id = ?').run(root, best.id);
  const moved = rewrite(db, best.id, root, mapper(new Map(), [{ from: best.path, to: root }]));
  return { from: best.path, moved };
}

/** Photos and person folders of a known folder renamed or moved inside it: found again, every stored path follows. */
export function reconcileFolder(db: Db, fid: number, root: string): Omit<Reconciled, 'movedFrom'> & { moved: Moved } {
  const rows = db.prepare('SELECT id, path, size FROM images WHERE folder_id = ?').all(fid) as { id: number; path: string; size: number | null }[];
  const missing = rows.filter(r => !fs.existsSync(r.path));
  if (!missing.length) return { folders: [], photos: 0, moved: [] };
  const known = new Set(rows.map(r => key(r.path)));
  const bySize = new Map<string, string[]>(), byName = new Map<string, string[]>();
  for (const f of listFiles(root)) {
    if (known.has(key(f.path))) continue;
    const n = key(path.basename(f.path));
    bySize.set(`${n}|${f.size}`, [...(bySize.get(`${n}|${f.size}`) ?? []), f.path]);
    byName.set(n, [...(byName.get(n) ?? []), f.path]);
  }
  const claimed = new Set<string>();
  const files = new Map<string, string>();
  const take = (list: string[] | undefined, unique: boolean) => {
    const free = (list ?? []).filter(p => !claimed.has(key(p)));
    return unique ? (free.length === 1 ? free[0] : undefined) : free[0];
  };
  for (const m of missing) {
    const n = key(path.basename(m.path));
    // Same name and size; or, when the file was changed (people or labels written), the only free file with that name.
    const to = take(bySize.get(`${n}|${m.size}`), false) ?? take(byName.get(n), true);
    if (!to) continue;
    claimed.add(key(to));
    files.set(key(m.path), to);
  }

  // A person folder that is gone went where most of its photos went.
  const lost = [
    ...(db.prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[]).map(r => r.dir),
    ...(db.prepare('SELECT dir FROM people WHERE folder_id = ? AND dir IS NOT NULL').all(fid) as { dir: string }[]).map(r => r.dir),
  ].filter((d, i, a) => !fs.existsSync(d) && a.findIndex(x => key(x) === key(d)) === i);
  const folders: { from: string; to: string }[] = [];
  for (const d of lost) {
    const votes = new Map<string, { dir: string; n: number }>();
    let total = 0;
    for (const m of missing) {
      if (key(path.dirname(m.path)) !== key(d)) continue;
      total++;
      const to = files.get(key(m.path));
      if (!to) continue;
      const nd = path.dirname(to);
      const v = votes.get(key(nd)) ?? { dir: nd, n: 0 };
      v.n++; votes.set(key(nd), v);
    }
    const top = [...votes.values()].sort((a, b) => b.n - a.n)[0];
    if (top && top.n * 2 >= total && !folders.some(f => key(f.to) === key(top.dir))) folders.push({ from: d, to: top.dir });
  }
  if (!files.size && !folders.length) return { folders: [], photos: 0, moved: [] };
  const moved = rewrite(db, fid, root, mapper(files, folders));
  // A person is named after their folder: the name written inside their photos follows (see renamePeople).
  const note = db.prepare('INSERT INTO name_changes (folder_id, old, new) VALUES (?, ?, ?)');
  for (const f of folders) if (path.basename(f.from) !== path.basename(f.to)) note.run(fid, path.basename(f.from), path.basename(f.to));
  return { folders, photos: files.size, moved };
}

/**
 * Person folders renamed in Explorer ("Person 3" → "Mom"): the name written inside that person's photos — group photos
 * kept in other folders too — changes with it, and so does the undo log (Undo then takes "Mom" out). Pending renames
 * are kept in the database until done, so an interrupted run carries on next time. Returns the files changed.
 */
export async function renamePeople(db: Db, fid: number, root: string, exiftool: string): Promise<string[]> {
  const todo = db.prepare('SELECT id, old, new FROM name_changes WHERE folder_id = ? ORDER BY id').all(fid) as { id: number; old: string; new: string }[];
  if (!todo.length || !fs.existsSync(exiftool)) return [];
  const changed = new Set<string>();
  const reader = new TagReader(exiftool);
  try {
    for (const r of todo) {
      // That person's photos, wherever they are kept.
      const files = (db.prepare(`SELECT DISTINCT i.id, i.path FROM people p JOIN faces f ON f.person_id = p.id AND f.removed = 0
        JOIN images i ON i.id = f.image_id WHERE p.folder_id = ? AND p.dir IS NOT NULL`).all(fid) as { id: number; path: string }[])
        .filter(x => fs.existsSync(x.path));
      const named: { id: number; path: string }[] = [];
      for (let i = 0; i < files.length; i += 200) {
        const part = files.slice(i, i + 200);
        const tags = await reader.read(part.map(x => x.path));
        for (const x of part) if (tags.get(x.path)?.people.includes(r.old)) named.push(x);
      }
      const setSize = db.prepare('UPDATE images SET size = ?, mtime = ? WHERE id = ?');
      for (let i = 0; i < named.length; i += 100) {
        const part = named.slice(i, i + 100);
        const out = await writePeople(exiftool, part.map(x => ({ file: x.path, add: [r.new], remove: [r.old] })));
        out.forEach((o, k) => {
          if (!o.ok) return;
          changed.add(part[k].path);
          try { const st = fs.statSync(part[k].path); setSize.run(st.size, Math.round(st.mtimeMs), part[k].id); } catch { /* gone */ }
        });
      }
      renameInLog(root, r.old, r.new);
      db.prepare('DELETE FROM name_changes WHERE id = ?').run(r.id);
    }
  } finally { reader.stop(); }
  return [...changed];
}

function renameInLog(root: string, from: string, to: string): void {
  const file = logPath(root);
  if (!fs.existsSync(file)) return;
  const old = fs.readFileSync(file, 'utf8');
  const next = old.split('\n').map(l => {
    if (!l) return l;
    try {
      const e = JSON.parse(l);
      if (!Array.isArray(e.people) || !e.people.includes(from)) return l;
      e.people = e.people.map((n: string) => (n === from ? to : n));
      return JSON.stringify(e);
    } catch { return l; }
  }).join('\n');
  if (next !== old) { fs.writeFileSync(`${file}.tmp`, next); fs.renameSync(`${file}.tmp`, file); }
}
