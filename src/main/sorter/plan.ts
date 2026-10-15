// Dry run (FACE-13): turns the face data into folders and moves, following the sorting rules:
//   0 faces → stays (or "No faces")      1 person → moves to that person's folder ("Person 1", "Person 2"…)
//   2+ people (v2.2) → no copies: the photo moves once, to the folder of the person whose face is biggest in it, and
//     every person in it is written into the photo as a tag; the other people's folders show it from there
//   faces but none recognisable → stays, listed under "Couldn't recognise"
// No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { SortOp, SortPlan, SortSettings, SortTarget } from '../../shared/types';
import type { Db } from '../db';

export const NO_FACES_DIR = 'No faces';
export const UNSORTED_DIR = 'Unsorted';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** A safe Windows folder name for a person. */
export function safeFolderName(name: string): string {
  let n = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  if (n.length > 80) n = n.slice(0, 80).trim();
  if (!n) n = 'Person';
  if (RESERVED.test(n)) n += '_';
  return n;
}

/** v2.2: people are "Person 1", "Person 2"… — or the name of the folder an earlier sort already gave them. */
export const personLabel = (p: { num: number; dir?: string | null }) => (p.dir ? path.basename(p.dir) : `Person ${p.num}`);

const inside = (file: string, dir: string) => file.toLowerCase().startsWith(dir.toLowerCase() + path.sep);

/** Picks "name.jpg", "name (2).jpg", … not on disk and not already planned. */
export function uniqueIn(dir: string, base: string, taken: Map<string, Set<string>>): string {
  let set = taken.get(dir.toLowerCase());
  if (!set) {
    set = new Set();
    try { for (const f of fs.readdirSync(dir)) set.add(f.toLowerCase()); } catch { /* new folder */ }
    taken.set(dir.toLowerCase(), set);
  }
  const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
  let name = base;
  for (let i = 2; set.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
  set.add(name.toLowerCase());
  return path.join(dir, name);
}

export function buildPlan(db: Db, fid: number, root: string, s: SortSettings): SortPlan {
  const sortDirs = (db.prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[]).map(r => r.dir);
  const people = db.prepare(`
    SELECT p.id, p.num, p.dir, COUNT(DISTINCT f.image_id) AS photos FROM people p
    LEFT JOIN faces f ON f.person_id = p.id AND f.removed = 0
    WHERE p.folder_id = ? GROUP BY p.id ORDER BY p.num`).all(fid) as { id: number; num: number; dir: string | null; photos: number }[];

  // ---- targets ----
  const targets = new Map<string, SortTarget>();
  const byDirName = new Map<string, string>(); // lower-case dir → key, to keep folder names unique
  const addTarget = (key: string, label: string, dir: string, personId: number | null) => {
    let d = dir, i = 2;
    while (byDirName.has(d.toLowerCase()) && byDirName.get(d.toLowerCase()) !== key) d = `${dir} (${i++})`;
    byDirName.set(d.toLowerCase(), key);
    targets.set(key, { key, label, dir: d, exists: fs.existsSync(d), personId });
  };
  const personKey = new Map<number, string>();
  for (const p of people) {
    if (p.photos < s.minPhotos && !p.dir) { personKey.set(p.id, 'unsorted'); continue; }
    const key = `p${p.id}`;
    personKey.set(p.id, key);
    addTarget(key, personLabel(p), p.dir ?? path.join(root, safeFolderName(personLabel(p))), p.id);
  }
  addTarget('unsorted', UNSORTED_DIR, path.join(root, UNSORTED_DIR), null);
  addTarget('nofaces', NO_FACES_DIR, path.join(root, NO_FACES_DIR), null);

  // ---- images ----
  const images = db.prepare("SELECT id, path, size, status, error, faces FROM images WHERE folder_id = ? ORDER BY path").all(fid) as
    { id: number; path: string; size: number; status: string; error: string | null; faces: number }[];
  // Biggest face first: that person is who the photo is "of", so it lives in their folder.
  const facePeople = db.prepare('SELECT person_id, MAX(w * h) AS area FROM faces WHERE image_id = ? AND removed = 0 AND person_id IS NOT NULL GROUP BY person_id');
  const photosOf = new Map(people.map(p => [p.id, p.photos]));

  const ops: SortOp[] = [];
  const stays: SortPlan['stays'] = [];
  const taken = new Map<string, Set<string>>();
  const used = new Set<string>();

  for (const img of images) {
    if (sortDirs.some(d => inside(img.path, d))) continue;          // already sorted earlier
    if (!fs.existsSync(img.path)) continue;
    if (img.status === 'skipped' || img.status === 'error') { stays.push({ path: img.path, reason: img.error ?? 'Skipped' }); continue; }
    if (img.status !== 'done') { stays.push({ path: img.path, reason: 'Not scanned yet' }); continue; }
    let writable = true;
    try { writable = (fs.statSync(img.path).mode & 0o200) !== 0; } catch { /* checked again at Apply */ }

    const found = (facePeople.all(img.id) as { person_id: number; area: number }[])
      .sort((a, b) => b.area - a.area || (photosOf.get(b.person_id) ?? 0) - (photosOf.get(a.person_id) ?? 0));
    const keys = [...new Set(found.map(r => personKey.get(r.person_id)).filter((k): k is string => !!k))];
    const base = path.basename(img.path);

    if (img.faces === 0) {
      if (s.noFacesFolder && writable) { ops.push({ kind: 'move', pass: 1, from: img.path, to: uniqueIn(targets.get('nofaces')!.dir, base, taken), imageId: img.id, personId: null }); used.add('nofaces'); }
      else stays.push({ path: img.path, reason: writable ? 'No faces' : 'Read-only file' });
      continue;
    }
    if (!keys.length) { stays.push({ path: img.path, reason: "Couldn't recognise" }); continue; }
    if (!writable) { stays.push({ path: img.path, reason: 'Read-only file' }); continue; }

    // People with their own folder, biggest face first; "Unsorted" only when nobody in the photo has a folder.
    const real = keys.filter(k => k !== 'unsorted');
    const home = targets.get(real[0] ?? 'unsorted')!;
    const people = real.map(k => targets.get(k)!.label);
    const alsoIn = real.slice(1).map(k => ({ label: targets.get(k)!.label, dir: targets.get(k)!.dir }));
    for (const k of real.slice(1)) used.add(k);
    used.add(home.key);
    if (path.dirname(img.path).toLowerCase() === home.dir.toLowerCase()) {
      if (people.length) ops.push({ kind: 'tag', pass: 1, from: img.path, to: img.path, imageId: img.id, personId: home.personId, people, alsoIn });
      continue;                                                       // already there
    }
    ops.push({ kind: 'move', pass: 1, from: img.path, to: uniqueIn(home.dir, base, taken), imageId: img.id, personId: home.personId, bytes: img.size, people, alsoIn });
  }

  const usedTargets = [...targets.values()].filter(t => used.has(t.key));
  const mkdirs: SortOp[] = usedTargets.filter(t => !t.exists).map(t => ({ kind: 'mkdir', pass: 0, to: t.dir, personId: t.personId }));
  let freeBytes: number | null = null;
  try { const st = fs.statfsSync(root); freeBytes = Number(st.bavail) * Number(st.bsize); } catch { /* unknown */ }

  return {
    folderId: fid, root, targets: usedTargets, ops: [...mkdirs, ...ops], stays,
    counts: {
      folders: mkdirs.length,
      moves: ops.filter(o => o.kind === 'move').length,
      tagged: ops.filter(o => o.alsoIn?.length).length,
      stays: stays.length,
    },
    freeBytes,
  };
}
