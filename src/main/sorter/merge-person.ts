// v2.9 Photos → "Merge into…": a person who is really someone else (or several people) goes where they belong.
// Suggest: every face of the person is compared with everyone else in the same sorted folder; a photo is matched to the
// person it clearly looks like (close to their nearest faces, and well ahead of the next best), never to someone who
// already has a face in that photo. Merge: each chosen photo's face goes to its new person, the file moves from the old
// person's folder into the new one's, the name inside the photo changes, and the group photo list and the sort log
// follow. Runs in the sort worker. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { MergePlan, MergeResult } from '../../shared/types';
import { type Db, tx, blobToEmb } from '../db';
import { FACE_MODEL } from '../faces/detect';
import { dot, nearestK, type FaceSet } from '../faces/cluster';
import { pasteItems } from '../library/file-ops';
import { writePeople } from '../library/xmp';
import { personLabel } from './plan';
import { readManifest, writeManifest } from './people-manifest';
import { mapper, remapLog } from './reconcile';

const win = process.platform === 'win32';
const key = (p: string) => (win ? path.resolve(p).toLowerCase() : path.resolve(p));
const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join('/');
const abs = (root: string, r: string) => path.join(root, ...r.split('/'));

const MEMBERS = 24;        // nearest faces kept per person
const BELOW = 0.04;        // a photo joins a person at threshold − this (its 3 nearest faces there)…
const LEAD = 0.05;         // …when that person is clearly closer than the next best

interface Person extends FaceSet { id: number; images: Set<number> }

/** Where each photo of this person belongs, by face. */
export function suggestMerge(db: Db, pid: number, threshold: number): MergePlan {
  const me = db.prepare('SELECT id, folder_id, num, dir FROM people WHERE id = ?').get(pid) as { id: number; folder_id: number; num: number; dir: string | null } | undefined;
  if (!me) throw new Error('This person is no longer there.');
  const mine = db.prepare(`SELECT f.image_id, f.emb, i.path, i.thumb FROM faces f JOIN images i ON i.id = f.image_id
    WHERE f.person_id = ? AND f.removed = 0 ORDER BY i.path`).all(pid) as { image_id: number; emb: Uint8Array | null; path: string; thumb: string | null }[];

  // Everyone else in this sorted folder: the sum of their fingerprints, their best faces, the photos they are in.
  const others = new Map<number, Person>();
  const rows = db.prepare(`SELECT f.person_id, f.image_id, f.emb, f.usable, f.model FROM faces f JOIN people p ON p.id = f.person_id
    WHERE p.folder_id = ? AND p.id <> ? AND f.removed = 0 ORDER BY f.person_id, COALESCE(f.quality, 1) DESC`).iterate(me.folder_id, pid) as Iterable<{ person_id: number; image_id: number; emb: Uint8Array | null; usable: number; model: number }>;
  for (const r of rows) {
    let g = others.get(r.person_id);
    if (!g) { g = { id: r.person_id, sum: new Float32Array(512), n: 0, members: [], images: new Set() }; others.set(r.person_id, g); }
    g.images.add(r.image_id);
    if (!r.emb || !r.usable || r.model !== FACE_MODEL) continue;
    const e = blobToEmb(r.emb);
    for (let i = 0; i < e.length; i++) g.sum[i] += e[i];
    g.n++;
    if (g.members.length < MEMBERS) g.members.push(e);
  }
  const people = [...others.values()].filter(g => g.n > 0);

  const byTarget = new Map<number, { imageId: number; path: string; thumb: string | null; score: number }[]>();
  const unmatched: { imageId: number; path: string; thumb: string | null }[] = [];
  const seen = new Set<number>();
  for (const f of mine) {
    if (seen.has(f.image_id)) continue;
    seen.add(f.image_id);
    if (!f.emb) { unmatched.push({ imageId: f.image_id, path: f.path, thumb: f.thumb }); continue; }
    const e = blobToEmb(f.emb);
    let best: Person | null = null, b1 = -1, b2 = -1;
    for (const g of people) {
      if (g.images.has(f.image_id)) continue;              // already in this photo: it is someone else
      if (dot(e, g.sum) / g.n < threshold - 0.25) continue;  // far apart: skip the closer look
      const s = nearestK(e, g, 3);
      if (s > b1) { b2 = b1; b1 = s; best = g; } else if (s > b2) b2 = s;
    }
    if (best && b1 >= threshold - BELOW && b1 - Math.max(b2, 0) >= LEAD) byTarget.set(best.id, [...(byTarget.get(best.id) ?? []), { imageId: f.image_id, path: f.path, thumb: f.thumb, score: b1 }]);
    else unmatched.push({ imageId: f.image_id, path: f.path, thumb: f.thumb });
  }
  const label = db.prepare('SELECT num, dir FROM people WHERE id = ?');
  return {
    personId: pid, label: personLabel(me), photos: seen.size,
    targets: [...byTarget].map(([id, photos]) => {
      const p = label.get(id) as { num: number; dir: string | null };
      return { personId: id, label: personLabel(p), photos: photos.map(({ score: _s, ...x }) => x), score: photos.reduce((s, x) => s + x.score, 0) / photos.length };
    }).sort((a, b) => b.photos.length - a.photos.length),
    unmatched,
  };
}

/** Every photo of this person (for "Merge all into…"). */
export function allPhotos(db: Db, pid: number): number[] {
  return (db.prepare('SELECT DISTINCT image_id FROM faces WHERE person_id = ? AND removed = 0').all(pid) as { image_id: number }[]).map(r => r.image_id);
}

/**
 * Move photos of `pid` to other people of the same sorted folder: `moves` = image → person. Returns the files moved and
 * changed, for labels and shortcuts (main process).
 */
export async function mergePerson(db: Db, pid: number, moves: { imageId: number; to: number }[], exiftool?: string, onProgress?: (done: number, total: number) => void):
  Promise<MergeResult & { root: string; dir: string | null; moves: { from: string; to: string }[]; files: string[] }> {
  const me = db.prepare('SELECT p.id, p.folder_id, p.num, p.dir, f.path AS root FROM people p JOIN folders f ON f.id = p.folder_id WHERE p.id = ?').get(pid) as
    { id: number; folder_id: number; num: number; dir: string | null; root: string } | undefined;
  if (!me) throw new Error('This person is no longer there.');
  const from = personLabel(me);
  const targets = new Map<number, { label: string; dir: string | null }>();
  for (const id of new Set(moves.map(m => m.to))) {
    const t = db.prepare('SELECT folder_id, num, dir FROM people WHERE id = ?').get(id) as { folder_id: number; num: number; dir: string | null } | undefined;
    if (!t || t.folder_id !== me.folder_id || id === pid) throw new Error('People can only be merged within one sorted folder.');
    targets.set(id, { label: personLabel(t), dir: t.dir && fs.existsSync(t.dir) ? t.dir : null });
  }
  const res = { root: me.root, dir: me.dir, merged: 0, moved: 0, renamed: 0, left: 0, skipped: [] as { path: string; reason: string }[], moves: [] as { from: string; to: string }[], files: [] as string[], removed: false };
  const logFile = path.join(me.root, '.clearup', 'merge-log.jsonl');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const pathOf = db.prepare('SELECT path FROM images WHERE id = ?');
  const setImg = db.prepare('UPDATE images SET path = ? WHERE id = ?');
  const setInfo = db.prepare('UPDATE photo_info SET path = ? WHERE folder_id = ? AND path = ?');
  const setFace = db.prepare('UPDATE faces SET person_id = ? WHERE image_id = ? AND person_id = ?');
  const toOf = new Map<string, number>();          // photo (where it is now) → the person its face went to
  const files = new Map<string, string>();
  const names: { file: string; to: string }[] = [];
  let done = 0;
  for (const m of moves) {
    onProgress?.(done++, moves.length);
    const t = targets.get(m.to)!;
    const file = (pathOf.get(m.imageId) as { path: string } | undefined)?.path;
    if (!file || !fs.existsSync(file)) { res.skipped.push({ path: file ?? String(m.imageId), reason: 'File no longer exists' }); continue; }
    let now = file;
    // Kept in this person's folder: it moves into the new person's folder. A group photo kept in someone else's folder stays.
    if (me.dir && t.dir && key(path.dirname(file)) === key(me.dir)) {
      const r = await pasteItems([file], t.dir, 'move', () => {});
      if (r.failed.length) { res.skipped.push({ path: file, reason: r.failed[0].reason }); continue; }
      now = r.done[0].to;
      files.set(key(file), now);
      res.moves.push({ from: file, to: now });
      res.moved++;
      fs.appendFileSync(logFile, JSON.stringify({ merge: pid, into: m.to, from: file, to: now, t: Date.now() }) + '\n');
    }
    tx(db, () => {
      if (now !== file) { setImg.run(now, m.imageId); setInfo.run(now, me.folder_id, file); }
      setFace.run(m.to, m.imageId, pid);
      db.prepare('UPDATE people SET keep = 1 WHERE id = ?').run(m.to);
    });
    toOf.set(key(now), m.to);
    names.push({ file: now, to: t.label });
    res.merged++;
  }

  // The group photo list: photos shown in this person's folder are shown in their new person's folder instead; paths
  // of moved photos follow everywhere.
  const map = mapper(files, []);
  try {
    const m = readManifest(me.root);
    const mineKey = me.dir ? rel(me.root, me.dir).toLowerCase() : null;
    const out: typeof m.folders = {};
    for (const [k, list] of Object.entries(m.folders)) {
      for (const e of list) {
        const f = map(abs(me.root, e.file));
        let dir = abs(me.root, k);
        if (k.toLowerCase() === mineKey) {
          // Shown in this person's folder: now in the folder of whoever this face went to (if it went anywhere).
          const toId = toOf.get(key(f));
          const td = toId != null ? targets.get(toId)?.dir : null;
          if (td) dir = td;
        }
        if (key(path.dirname(f)) === key(dir)) continue;     // kept right there: nothing to show from elsewhere
        const nk = rel(me.root, dir);
        const l = (out[nk] ??= []);
        const nf = rel(me.root, f);
        if (!l.some(x => x.file.toLowerCase() === nf.toLowerCase())) l.push({ ...e, file: nf });
      }
    }
    writeManifest(me.root, { ...m, folders: out });
  } catch (e) { res.skipped.push({ path: me.root, reason: `Group photo list not updated: ${(e as Error).message}` }); }
  remapLog(me.root, map);

  // Names inside the photos: the old person's name comes out, the new person's goes in.
  if (exiftool && names.length) {
    const setSize = db.prepare('UPDATE images SET size = ?, mtime = ? WHERE path = ?');
    for (let i = 0; i < names.length; i += 100) {
      const part = names.slice(i, i + 100);
      const out = await writePeople(exiftool, part.map(n => ({ file: n.file, add: [n.to], remove: [from] }))).catch(e => part.map(() => ({ ok: false, error: String(e) })));
      out.forEach((o, k) => {
        if (!o.ok) { res.skipped.push({ path: part[k].file, reason: `Name not changed inside the file: ${o.error ?? 'unknown error'}` }); return; }
        res.files.push(part[k].file); res.renamed++;
        try { const st = fs.statSync(part[k].file); setSize.run(st.size, Math.round(st.mtimeMs), part[k].file); } catch { /* gone */ }
      });
    }
  }

  // Nobody left: the person goes (their emptied folder is removed by the main process, after the shortcuts).
  res.left = (db.prepare('SELECT COUNT(DISTINCT image_id) AS n FROM faces WHERE person_id = ? AND removed = 0').get(pid) as { n: number }).n;
  if (!res.left) {
    tx(db, () => {
      if (me.dir) db.prepare('DELETE FROM sort_dirs WHERE folder_id = ? AND dir = ?').run(me.folder_id, me.dir);
      db.prepare('DELETE FROM people WHERE id = ?').run(pid);
    });
    res.removed = true;
  }
  onProgress?.(moves.length, moves.length);
  return res;
}
