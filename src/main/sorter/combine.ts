// v2.8 Combine people across sorted folders (Photos tab). Each sorted folder has its own people ("Person 1" in Trip and
// "Person 4" in Family can be the same person). Matching compares the people of several folders by their face
// fingerprints; after the user confirms, every person's folder moves into one destination folder, the same person's
// folders merged into one. Face data, the names written inside the photos, the group photo list (people.json) and the
// sort logs follow, so the destination opens like any sorted folder and the old sorts can still be undone.
// Runs in the sort worker. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { CombineGroup, CombineProgress, CombineRequest, CombineResult } from '../../shared/types';
import { type Db, tx, blobToEmb, folderId, nextPersonNum } from '../db';
import { FACE_MODEL } from '../faces/detect';
import { dot, linkage, type FaceSet } from '../faces/cluster';
import { pasteItems } from '../library/file-ops';
import { writePeople } from '../library/xmp';
import { personLabel, safeFolderName } from './plan';
import { readManifest, writeManifest, type PeopleManifest } from './people-manifest';
import { mapper, remapLog } from './reconcile';

const win = process.platform === 'win32';
const key = (p: string) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
const isInside = (p: string, dir: string) => key(p).startsWith(key(dir) + path.sep);
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const abs = (root: string, r: string) => path.join(root, ...r.split('/'));

/** Automatic names ("Person 3", "Person 3 (2)"): not a name the user gave. */
export const AUTO_NAME = /^Person \d+( \(\d+\))?$/i;
const MAX_FACES = 300;      // best faces per person in their average: enough to be sure, bounded cost
const NEAR_FACES = 24;      // of those, kept for the face-by-face check (memory stays small with thousands of people)
const NAME_BONUS = 0.08;    // the same name given in two folders counts towards a match
const ALL_PAIRS = 0.05;     // in a merged group every pair must be at least threshold − this (no chains of look-alikes)

export interface CombinePersonRow {
  id: number; folderId: number; root: string; num: number; dir: string; label: string; named: boolean; photos: number; set: FaceSet | null;
}

/** People of these folders that have their own folder on disk (a sort made it), with their best face fingerprints. */
export function peopleOf(db: Db, fids: number[], withFaces = true): CombinePersonRow[] {
  if (!fids.length) return [];
  const rows = db.prepare(`SELECT p.id, p.folder_id, p.num, p.dir, f.path AS root,
      (SELECT COUNT(DISTINCT x.image_id) FROM faces x WHERE x.person_id = p.id AND x.removed = 0) AS photos
    FROM people p JOIN folders f ON f.id = p.folder_id
    WHERE p.dir IS NOT NULL AND p.folder_id IN (${fids.map(() => '?').join(',')}) ORDER BY f.path, p.num`).all(...fids) as
    { id: number; folder_id: number; num: number; dir: string; root: string; photos: number }[];
  const faces = db.prepare(`SELECT emb FROM faces WHERE person_id = ? AND removed = 0 AND usable = 1 AND emb IS NOT NULL AND model = ?
    ORDER BY COALESCE(quality, 1) DESC, sharpness * h DESC LIMIT ${MAX_FACES}`);
  const out: CombinePersonRow[] = [];
  for (const r of rows) {
    if (!fs.existsSync(r.dir)) continue;
    const label = personLabel(r);
    let set: FaceSet | null = null;
    if (withFaces) {
      let sum: Float32Array | null = null, n = 0;
      const members: Float32Array[] = [];
      for (const f of faces.iterate(r.id, FACE_MODEL) as Iterable<{ emb: Uint8Array }>) {
        const e = blobToEmb(f.emb);
        sum ??= new Float32Array(e.length);
        for (let i = 0; i < e.length; i++) sum[i] += e[i];
        n++;
        if (members.length < NEAR_FACES) members.push(e);
      }
      if (sum) set = { sum, n, members };
    }
    out.push({ id: r.id, folderId: r.folder_id, root: r.root, num: r.num, dir: r.dir, label, named: !AUTO_NAME.test(label), photos: r.photos, set });
  }
  return out;
}

/**
 * Who is the same person in different folders. Two people of one folder are never merged (the sort already kept them
 * apart); a group only grows when every pair in it matches, so two look-alikes are not joined through a third.
 */
export function matchPeople(people: CombinePersonRow[], threshold: number, onProgress?: (done: number, total: number) => void): CombineGroup[] {
  const P = people.length;
  const nameKey = people.map(p => (p.named ? p.label.trim().toLowerCase() : ''));
  const sims = new Map<number, number>();                 // i * P + j (i < j) → similarity, only pairs worth keeping
  const edges: [number, number, number][] = [];
  let last = Date.now();
  for (let i = 0; i < P; i++) {
    const a = people[i].set;
    if (a) {
      for (let j = i + 1; j < P; j++) {
        const b = people[j].set;
        if (!b || people[j].folderId === people[i].folderId) continue;
        const avg = dot(a.sum, b.sum) / (a.n * b.n);
        const bonus = nameKey[i] && nameKey[i] === nameKey[j] ? NAME_BONUS : 0;
        if (avg + bonus < threshold - 0.15) continue;       // far apart: skip the face-by-face check
        const s = Math.max(avg, linkage(a, b, threshold)) + bonus;
        if (s < threshold - ALL_PAIRS) continue;
        sims.set(i * P + j, s);
        if (s >= threshold) edges.push([s, i, j]);
      }
    }
    if (onProgress && Date.now() - last > 250) { last = Date.now(); onProgress(i + 1, P); }
  }
  onProgress?.(P, P);
  const sim = (i: number, j: number) => sims.get(Math.min(i, j) * P + Math.max(i, j));

  // Closest pairs first; groups join only when no folder is in both and every pair across them is close enough.
  edges.sort((x, y) => y[0] - x[0]);
  const groupOf = people.map((_, i) => [i]);
  for (const [, i, j] of edges) {
    const A = groupOf[i], B = groupOf[j];
    if (A === B) continue;
    const folders = new Set(A.map(k => people[k].folderId));
    if (B.some(k => folders.has(people[k].folderId))) continue;
    if (!A.every(a => B.every(b => sim(a, b) !== undefined))) continue;
    const into = [...A, ...B];
    for (const k of into) groupOf[k] = into;
  }
  const seen = new Set<number[]>();
  const groups: CombineGroup[] = [];
  for (const g of groupOf) {
    if (g.length < 2 || seen.has(g)) continue;
    seen.add(g);
    let t = 0, n = 0;
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) { t += sim(g[x], g[y])!; n++; }
    const names = new Set(g.map(k => nameKey[k]).filter(Boolean));
    groups.push({
      members: [...g].sort((x, y) => people[y].photos - people[x].photos).map(k => people[k].id),
      score: t / n, sameName: names.size === 1 && g.every(k => nameKey[k]),
    });
  }
  return groups.sort((x, y) => y.score - x.score);
}

// ---------- the move ----------

interface Target { name: string; dir: string; members: CombinePersonRow[]; keep: CombinePersonRow | null }

/**
 * Where each group goes: Dest\<name>. Names the user gave are kept; an automatic one is kept while free, else numbered
 * again (two folders both have a "Person 1"). A person already in the destination stays put.
 */
export function planTargets(db: Db, req: CombineRequest): { dest: string; destFid: number | null; targets: Target[] } {
  const dest = path.resolve(req.dest);
  const destFid = (db.prepare('SELECT id FROM folders WHERE path = ?').get(dest) as { id: number } | undefined)?.id ?? null;
  const ids = req.groups.flatMap(g => g.people);
  const fids = [...new Set((ids.length ? db.prepare(`SELECT DISTINCT folder_id FROM people WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { folder_id: number }[] : []).map(r => r.folder_id))];
  const byId = new Map(peopleOf(db, fids, false).map(p => [p.id, p]));
  const taken = new Set<string>();
  try { for (const e of fs.readdirSync(dest)) taken.add(e.toLowerCase()); } catch { /* new folder */ }
  const targets: Target[] = [];
  const pending: { members: CombinePersonRow[]; name: string; keep: CombinePersonRow | null }[] = [];
  for (const g of req.groups) {
    const members = g.people.map(id => byId.get(id)).filter((p): p is CombinePersonRow => !!p);
    if (!members.length) continue;
    // Already in the destination (combining into one of the sorted folders): that folder is where the rest go.
    const keep = members.find(m => m.folderId === destFid) ?? null;
    if (keep) { taken.add(path.basename(keep.dir).toLowerCase()); targets.push({ name: path.basename(keep.dir), dir: keep.dir, members, keep }); continue; }
    pending.push({ members, name: g.name.trim(), keep: null });
  }
  for (const p of pending) {
    if (!p.name || AUTO_NAME.test(p.name)) continue;
    let name = safeFolderName(p.name);
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${safeFolderName(p.name)} (${i})`;
    taken.add(name.toLowerCase());
    targets.push({ name, dir: path.join(dest, name), members: p.members, keep: null });
  }
  // Automatic names: a person keeps the one they have (the member with most photos first) while it is free, so fewer
  // photos need their name rewritten; the rest get the next free number.
  const auto = pending.filter(p => !p.name || AUTO_NAME.test(p.name));
  const later: typeof pending = [];
  for (const p of auto) {
    const own = [...p.members].sort((a, b) => b.photos - a.photos).map(m => m.label).find(l => AUTO_NAME.test(l) && !taken.has(l.toLowerCase()));
    if (!own) { later.push(p); continue; }
    taken.add(own.toLowerCase());
    targets.push({ name: own, dir: path.join(dest, own), members: p.members, keep: null });
  }
  let num = 1;
  for (const p of later) {
    while (taken.has(`person ${num}`)) num++;
    const name = `Person ${num}`;
    taken.add(name.toLowerCase());
    targets.push({ name, dir: path.join(dest, name), members: p.members, keep: null });
  }
  return { dest, destFid, targets };
}

/** Everything below a folder: files (relative paths) and their total size. */
export function folderSize(dir: string): { files: string[]; bytes: number } {
  const files: string[] = [];
  let bytes = 0;
  const walk = (d: string, r: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, path.join(r, e.name));
      else { files.push(path.join(r, e.name)); try { bytes += fs.statSync(p).size; } catch { /* gone */ } }
    }
  };
  walk(dir, '');
  return { files, bytes };
}

/** The drive (volume) a path is on, also for a folder that does not exist yet. */
function deviceOf(p: string): number | null {
  for (let d = path.resolve(p); ; d = path.dirname(d)) {
    try { return fs.statSync(d).dev; } catch { /* look one up */ }
    if (path.dirname(d) === d) return null;
  }
}

/** Checks before anything moves. */
export function checkRequest(db: Db, req: CombineRequest): void {
  const dest = path.resolve(req.dest);
  const { targets } = planTargets(db, req);
  for (const t of targets) for (const m of t.members) {
    if (key(dest) === key(m.dir) || isInside(dest, m.dir)) throw new Error(`The destination is inside “${m.label}”, which is one of the folders being moved. Choose another destination.`);
  }
  const roots = [...new Set(targets.flatMap(t => t.members.map(m => m.root)))];
  for (const r of roots) if (isInside(dest, r)) throw new Error(`The destination is inside the sorted folder “${path.basename(r)}”. Choose that folder itself, or a folder outside it.`);
}

/** Rough time for the move: files counted on disk, the drive checked, names to rewrite counted. */
export function estimateCombine(db: Db, req: CombineRequest): { files: number; bytes: number; people: number; sameDrive: boolean; wholeFolders: number; renamed: number; seconds: number } {
  const { dest, targets } = planTargets(db, req);
  const destDev = deviceOf(dest);
  let files = 0, bytes = 0, wholeFolders = 0, perFile = 0, crossBytes = 0, renamed = 0;
  let sameDrive = true;
  const photosOf = db.prepare('SELECT COUNT(DISTINCT image_id) AS n FROM faces WHERE person_id = ? AND removed = 0');
  for (const t of targets) {
    let first = !t.keep && !fs.existsSync(t.dir);
    for (const m of t.members) {
      if (m === t.keep) continue;
      const s = folderSize(m.dir);
      files += s.files.length; bytes += s.bytes;
      const same = deviceOf(m.dir) === destDev;
      if (!same) { sameDrive = false; crossBytes += s.bytes; perFile += s.files.length; }
      else if (first) wholeFolders++;
      else perFile += s.files.length;
      first = false;
      if (m.label !== t.name) renamed += (photosOf.get(m.id) as { n: number }).n;
    }
  }
  // Same drive: a folder is renamed in one go, a file moved in a few ms. Another drive: copied (≈60 MB/s, checked).
  // ExifTool rewrites ≈25 photos a second.
  const seconds = wholeFolders * 0.05 + perFile * (sameDrive ? 0.004 : 0.01) + crossBytes / 60e6 + renamed / 25 + 2;
  return { files, bytes, people: targets.length, sameDrive, wholeFolders, renamed, seconds };
}

export async function combineFolders(db: Db, req: CombineRequest, onProgress: (p: CombineProgress) => void, exiftool?: string): Promise<CombineResult & { moves: { from: string; to: string }[]; files: string[]; roots: string[] }> {
  checkRequest(db, req);
  const { dest, targets } = planTargets(db, req);
  fs.mkdirSync(path.join(dest, '.clearup'), { recursive: true });
  const destFid = folderId(db, dest)!;
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state, plan, kind) VALUES (?, ?, 'applying', ?, 'combine')").run(destFid, Date.now(), JSON.stringify(req)).lastInsertRowid);
  const logFile = path.join(dest, '.clearup', 'combine-log.jsonl');
  const note = (e: object) => fs.appendFileSync(logFile, JSON.stringify({ combine: sortId, t: Date.now(), ...e }) + '\n');

  const res = { dest, people: 0, moved: 0, renamed: 0, skipped: [] as { path: string; reason: string }[], moves: [] as { from: string; to: string }[], files: [] as string[], roots: [] as string[] };
  const roots = [...new Set(targets.flatMap(t => t.members.map(m => m.root)))];
  res.roots = roots;
  const total = targets.reduce((n, t) => n + t.members.filter(m => m !== t.keep).length, 0);
  let done = 0;

  // Photos of each source folder, by the person folder they are in (looked up once: 80,000 photos stay quick).
  const memberDirs = new Map<number, { dir: string; pid: number }[]>();
  for (const t of targets) for (const m of t.members) if (m !== t.keep) memberDirs.set(m.folderId, [...(memberDirs.get(m.folderId) ?? []), { dir: m.dir, pid: m.id }]);
  const rowsIn = (table: 'images' | 'photo_info') => {
    const out = new Map<number, { id: number; path: string }[]>();
    for (const [fid, dirs] of memberDirs) {
      const sorted = [...dirs].sort((a, b) => b.dir.length - a.dir.length);
      for (const r of db.prepare(`SELECT id, path FROM ${table} WHERE folder_id = ?`).all(fid) as { id: number; path: string }[]) {
        const hit = sorted.find(d => isInside(r.path, d.dir));
        if (hit) out.set(hit.pid, [...(out.get(hit.pid) ?? []), r]);
      }
    }
    return out;
  };
  const images = rowsIn('images'), infos = rowsIn('photo_info');
  const allFiles = new Map<string, string>();
  const allDirs: { from: string; to: string }[] = [];
  const rename: { imageIds: number[]; from: string; to: string }[] = [];

  for (const t of targets) {
    const files = new Map<string, string>();
    const dirs: { from: string; to: string }[] = [];
    for (const m of t.members) {
      if (m === t.keep) continue;
      onProgress({ phase: 'moving', done, total, current: `${m.label} (${path.basename(m.root)})` });
      try {
        let whole = false;
        if (!fs.existsSync(t.dir)) {
          // Nothing there yet: the whole folder is renamed in one go (same drive), else it is made and filled.
          const inside = folderSize(m.dir).files;
          try {
            fs.renameSync(m.dir, t.dir);
            whole = true;
            dirs.push({ from: m.dir, to: t.dir });
            for (const f of inside) res.moves.push({ from: path.join(m.dir, f), to: path.join(t.dir, f) });
            res.moved += inside.length;
            note({ op: 'rename-dir', from: m.dir, to: t.dir });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
            fs.mkdirSync(t.dir, { recursive: true });
          }
        }
        if (!whole) {
          const entries = fs.readdirSync(m.dir).map(n => path.join(m.dir, n));
          const r = await pasteItems(entries, t.dir, 'move', (pairs, dir) => {
            for (const p of pairs) { files.set(key(p.from), p.to); res.moves.push(p); res.moved++; }
            if (dir) dirs.push(dir);
          });
          for (const d of r.done) note({ op: 'move', from: d.from, to: d.to });
          res.skipped.push(...r.failed);
          try { fs.rmdirSync(m.dir); } catch { /* something could not move: the folder stays */ }
        }
      } catch (e) {
        res.skipped.push({ path: m.dir, reason: (e as Error).message });
      }
      done++;
    }

    // Face data: one person in the destination, with every member's faces and photos.
    const map = mapper(files, dirs);
    for (const [k, v] of files) allFiles.set(k, v);
    allDirs.push(...dirs);
    tx(db, () => {
      let pid = t.keep?.id ?? null;
      if (pid == null) pid = Number(db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)').run(destFid, nextPersonNum(db, destFid), t.dir).lastInsertRowid);
      const setImg = db.prepare('UPDATE images SET path = ?, folder_id = ? WHERE id = ?');
      const setInfo = db.prepare('UPDATE photo_info SET path = ?, folder_id = ? WHERE id = ?');
      for (const m of t.members) {
        if (m === t.keep) continue;
        for (const r of images.get(m.id) ?? []) { const n = map(r.path); if (n !== r.path) setImg.run(n, destFid, r.id); }
        for (const r of infos.get(m.id) ?? []) { const n = map(r.path); if (n !== r.path) setInfo.run(n, destFid, r.id); }
        if (m.label !== t.name) {
          const ids = (db.prepare('SELECT DISTINCT image_id FROM faces WHERE person_id = ? AND removed = 0').all(m.id) as { image_id: number }[]).map(r => r.image_id);
          rename.push({ imageIds: ids, from: m.label, to: t.name });
        }
        db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(pid, m.id);
        db.prepare('DELETE FROM sort_dirs WHERE folder_id = ? AND dir = ?').run(m.folderId, m.dir);
        db.prepare('DELETE FROM people WHERE id = ?').run(m.id);
      }
      db.prepare('INSERT OR IGNORE INTO sort_dirs (folder_id, dir) VALUES (?, ?)').run(destFid, t.dir);
    });
    res.people++;
  }

  // The names written inside the photos follow (Person 3 → Mom, or the new number).
  const gmap = mapper(allFiles, allDirs);
  if (rename.length && exiftool) {
    const pathOf = db.prepare('SELECT path FROM images WHERE id = ?');
    const jobs = rename.flatMap(r => r.imageIds.map(id => ({ file: (pathOf.get(id) as { path: string } | undefined)?.path ?? '', add: [r.to], remove: [r.from] })))
      .filter(j => j.file && fs.existsSync(j.file));
    const setSize = db.prepare('UPDATE images SET size = ?, mtime = ? WHERE path = ?');
    for (let i = 0; i < jobs.length; i += 100) {
      const part = jobs.slice(i, i + 100);
      onProgress({ phase: 'naming', done: i, total: jobs.length, current: path.basename(part[0].file) });
      const out = await writePeople(exiftool, part).catch(e => part.map(() => ({ ok: false, error: String(e) })));
      out.forEach((o, k) => {
        if (!o.ok) { res.skipped.push({ path: part[k].file, reason: `Name not changed inside the file: ${o.error ?? 'unknown error'}` }); return; }
        res.files.push(part[k].file); res.renamed++;
        try { const st = fs.statSync(part[k].file); setSize.run(st.size, Math.round(st.mtimeMs), part[k].file); } catch { /* gone */ }
      });
    }
  }

  // Group photos shown in other people's folders (people.json, relative paths) move to the destination's list; the
  // sort logs of the old folders follow the files, so those sorts can still be undone.
  onProgress({ phase: 'finishing', done: total, total });
  const destM: PeopleManifest = readManifest(dest);
  const add = (dir: string, file: string) => {
    const k = rel(dest, dir), f = rel(dest, file);
    const list = (destM.folders[k] ??= []);
    if (!list.some(e => e.file.toLowerCase() === f.toLowerCase())) list.push({ file: f, sort: sortId });
  };
  for (const root of roots) {
    if (key(root) === key(dest)) continue;
    const m = readManifest(root);
    const keepHere: PeopleManifest['folders'] = {};
    for (const [k, list] of Object.entries(m.folders)) {
      const dir = abs(root, k), nd = gmap(dir);
      for (const e of list) {
        const file = abs(root, e.file), nf = gmap(file);
        const moved = nd !== dir || nf !== file;
        if (!moved) (keepHere[k] ??= []).push(e);
        else if (isInside(nd, dest) && isInside(nf, dest)) add(nd, nf);
        // else: one end left this folder and the other did not; the shortcut cannot follow
      }
    }
    try { writeManifest(root, { ...m, folders: keepHere }); } catch (e) { res.skipped.push({ path: root, reason: `Group photo list not updated: ${(e as Error).message}` }); }
    remapLog(root, gmap);
  }
  writeManifest(dest, destM);

  tx(db, () => {
    db.prepare('UPDATE folders SET last_scan = COALESCE(last_scan, ?) WHERE id = ?').run(Date.now(), destFid);
    db.prepare("UPDATE sorts SET state = 'done', summary = ? WHERE id = ?").run(JSON.stringify({ people: res.people, moved: res.moved, renamed: res.renamed, skipped: res.skipped.length }), sortId);
  });
  onProgress({ phase: 'done', done: total, total });
  return res;
}
