// Dry run (FACE-13): turns the face data into folders, moves and copies, following the sorting rules:
//   0 faces → stays (or "No faces")      1 person → original moves to that person's folder
//   2+ people → a copy in each person's folder (pass 1), then the original moves to "Group photos" (pass 2)
//   faces but none recognisable → stays, listed under "Couldn't recognise"
// No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { SortOp, SortPlan, SortSettings, SortTarget } from '../../shared/types';
import type { Db } from '../db';

export const GROUP_DIR = 'Group photos';
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

export const personLabel = (p: { name: string | null; num: number }) => p.name ?? `Person ${String(p.num).padStart(2, '0')}`;

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
    SELECT p.id, p.num, p.name, p.dir, COUNT(DISTINCT f.image_id) AS photos FROM people p
    LEFT JOIN faces f ON f.person_id = p.id AND f.removed = 0
    WHERE p.folder_id = ? GROUP BY p.id ORDER BY p.num`).all(fid) as { id: number; num: number; name: string | null; dir: string | null; photos: number }[];

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
  addTarget('group', GROUP_DIR, path.join(root, GROUP_DIR), null);
  addTarget('nofaces', NO_FACES_DIR, path.join(root, NO_FACES_DIR), null);

  // ---- images ----
  const images = db.prepare("SELECT id, path, size, status, error, faces FROM images WHERE folder_id = ? ORDER BY path").all(fid) as
    { id: number; path: string; size: number; status: string; error: string | null; faces: number }[];
  const facePeople = db.prepare('SELECT DISTINCT person_id FROM faces WHERE image_id = ? AND removed = 0 AND person_id IS NOT NULL');

  const ops: SortOp[] = [];
  const stays: SortPlan['stays'] = [];
  const taken = new Map<string, Set<string>>();
  const used = new Set<string>();
  let copyBytes = 0;

  for (const img of images) {
    if (sortDirs.some(d => inside(img.path, d))) continue;          // already sorted earlier
    if (!fs.existsSync(img.path)) continue;
    if (img.status === 'skipped' || img.status === 'error') { stays.push({ path: img.path, reason: img.error ?? 'Skipped' }); continue; }
    if (img.status !== 'done') { stays.push({ path: img.path, reason: 'Not scanned yet' }); continue; }
    let writable = true;
    try { writable = (fs.statSync(img.path).mode & 0o200) !== 0; } catch { /* checked again at Apply */ }

    const keys = [...new Set((facePeople.all(img.id) as { person_id: number }[]).map(r => personKey.get(r.person_id)).filter((k): k is string => !!k))];
    const base = path.basename(img.path);

    if (img.faces === 0) {
      if (s.noFacesFolder && writable) { ops.push({ kind: 'move', pass: 1, from: img.path, to: uniqueIn(targets.get('nofaces')!.dir, base, taken), imageId: img.id, personId: null }); used.add('nofaces'); }
      else stays.push({ path: img.path, reason: writable ? 'No faces' : 'Read-only file' });
      continue;
    }
    if (!keys.length) { stays.push({ path: img.path, reason: "Couldn't recognise" }); continue; }
    if (!writable) { stays.push({ path: img.path, reason: 'Read-only file' }); continue; }

    if (keys.length === 1) {
      const t = targets.get(keys[0])!;
      if (path.dirname(img.path).toLowerCase() === t.dir.toLowerCase()) continue; // already there
      ops.push({ kind: 'move', pass: 1, from: img.path, to: uniqueIn(t.dir, base, taken), imageId: img.id, personId: t.personId, bytes: img.size });
      used.add(keys[0]);
    } else {
      for (const k of keys) {
        const t = targets.get(k)!;
        ops.push({ kind: 'copy', pass: 1, from: img.path, to: uniqueIn(t.dir, base, taken), imageId: img.id, personId: t.personId, bytes: img.size });
        copyBytes += img.size;
        used.add(k);
      }
      ops.push({ kind: 'move', pass: 2, from: img.path, to: uniqueIn(targets.get('group')!.dir, base, taken), imageId: img.id, personId: null, bytes: img.size });
      used.add('group');
    }
  }

  const usedTargets = [...targets.values()].filter(t => used.has(t.key));
  const mkdirs: SortOp[] = usedTargets.filter(t => !t.exists).map(t => ({ kind: 'mkdir', pass: 0, to: t.dir, personId: t.personId }));
  let freeBytes: number | null = null;
  try { const st = fs.statfsSync(root); freeBytes = Number(st.bavail) * Number(st.bsize); } catch { /* unknown */ }

  return {
    folderId: fid, root, targets: usedTargets, ops: [...mkdirs, ...ops], stays,
    counts: {
      folders: mkdirs.length,
      moves: ops.filter(o => o.kind === 'move' && o.pass === 1).length,
      copies: ops.filter(o => o.kind === 'copy').length,
      groupMoves: ops.filter(o => o.pass === 2).length,
      stays: stays.length,
    },
    copyBytes, freeBytes,
  };
}
