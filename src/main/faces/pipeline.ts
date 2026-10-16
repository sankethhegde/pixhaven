// Sort-by-person pipeline steps that touch the database: scan images, group faces into people.
// No Electron imports — runs in the scan worker thread (and in tests).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SortSettings } from '../../shared/types';
import { type Db, tx, embToBlob, blobToEmb, nextPersonNum } from '../db';
import { openImage } from '../image-io';
import { FaceEngine, FACE_MODEL } from './detect';
import { cluster } from './cluster';

export interface ListedFile { path: string; size: number; mtime: number; cloud: boolean }
export const MIN_SHARPNESS = 20; // variance of Laplacian on the 112-px chip; below = too blurry to recognise
const WORK = 1280;               // doc: photos resized to ~1280 px before face detection

/** Sync the image list with what is on disk. Returns ids still to scan. */
export function syncImages(db: Db, fid: number, files: ListedFile[], keepDirs: string[]): number[] {
  return tx(db, () => {
    db.prepare('UPDATE images SET seen = 0 WHERE folder_id = ?').run(fid);
    const get = db.prepare('SELECT id, size, mtime, status FROM images WHERE folder_id = ? AND path = ?');
    const ins = db.prepare('INSERT INTO images (folder_id, path, size, mtime, status) VALUES (?, ?, ?, ?, ?)');
    const reset = db.prepare("UPDATE images SET size = ?, mtime = ?, status = ?, error = NULL, faces = 0, seen = 1 WHERE id = ?");
    const seen = db.prepare('UPDATE images SET seen = 1 WHERE id = ?');
    const delFaces = db.prepare('DELETE FROM faces WHERE image_id = ?');
    const todo: number[] = [];
    for (const f of files) {
      const row = get.get(fid, f.path) as { id: number; size: number; mtime: number; status: string } | undefined;
      const status = f.cloud ? 'skipped' : 'pending';
      if (!row) {
        const id = Number(ins.run(fid, f.path, f.size, f.mtime, status).lastInsertRowid);
        if (!f.cloud) todo.push(id);
      } else if (row.size !== f.size || row.mtime !== f.mtime || row.status === 'pending' || (row.status === 'skipped' && !f.cloud)) {
        delFaces.run(row.id); reset.run(f.size, f.mtime, status, row.id);
        if (!f.cloud) todo.push(row.id);
      } else seen.run(row.id);
    }
    // Forget images that vanished — except those living in folders a sort created (they are not listed).
    const gone = db.prepare('SELECT id, path FROM images WHERE folder_id = ? AND seen = 0').all(fid) as { id: number; path: string }[];
    const del = db.prepare('DELETE FROM images WHERE id = ?');
    for (const g of gone) {
      const inKept = keepDirs.some(d => g.path.toLowerCase().startsWith(d.toLowerCase() + path.sep));
      if (!inKept || !fs.existsSync(g.path)) del.run(g.id);
    }
    // v2.2: fingerprints from an older face model are made again — sorted photos too, so the people already in
    // folders keep recognising new photos (who is who is kept: see scanImage).
    const stale = db.prepare(`SELECT DISTINCT i.id FROM images i JOIN faces f ON f.image_id = i.id
      WHERE i.folder_id = ? AND i.status = 'done' AND f.usable = 1 AND f.model <> ?`).all(fid, FACE_MODEL) as { id: number }[];
    const queued = new Set(todo);
    for (const s of stale) if (!queued.has(s.id)) todo.push(s.id);
    db.prepare("UPDATE images SET error = 'Online-only file (not downloaded)' WHERE folder_id = ? AND status = 'skipped' AND error IS NULL").run(fid);
    return todo;
  });
}

/** Detect + fingerprint one image, save faces and thumbnails. Returns the number of faces found. */
export async function scanImage(db: Db, engine: FaceEngine, imageId: number, thumbsDir: string, s: SortSettings): Promise<{ faces: number; embs: Float32Array[] }> {
  const row = db.prepare('SELECT path FROM images WHERE id = ?').get(imageId) as { path: string };
  let data: Buffer, W: number, H: number;
  try {
    const r = await openImage(row.path).rotate().resize(WORK, WORK, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
    data = r.data; W = r.info.width; H = r.info.height;
  } catch (e) {
    const msg = /EBUSY|EPERM|EACCES/.test(String(e)) ? 'Locked or no permission' : 'Unreadable or damaged image';
    db.prepare("UPDATE images SET status = 'error', error = ?, seen = 1 WHERE id = ?").run(msg, imageId);
    return { faces: 0, embs: [] };
  }
  const faces = await engine.analyse(data, W, H, s.minFaceSize, MIN_SHARPNESS);
  // The photo's own size, upright (EXIF orientations 5–8 swap width and height).
  const meta = await openImage(row.path).metadata().catch(() => null);
  const [ow, oh] = meta?.width ? ((meta.orientation ?? 1) >= 5 ? [meta.height!, meta.width] : [meta.width, meta.height!]) : [null, null];

  fs.mkdirSync(thumbsDir, { recursive: true });
  const raw = { raw: { width: W, height: H, channels: 3 as const } };
  const thumb = path.join(thumbsDir, `img-${imageId}.jpg`);
  await sharp(data, raw).resize(320, 320, { fit: 'inside' }).jpeg({ quality: 78 }).toFile(thumb);

  const ins = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id, removed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const setChip = db.prepare('UPDATE faces SET chip = ? WHERE id = ?');
  const ids: number[] = [];
  // A photo scanned again (new face model, or edited) keeps who is who for faces the user or an earlier sort settled.
  const old = db.prepare(`SELECT f.x, f.y, f.w, f.h, f.person_id, f.removed, p.keep FROM faces f LEFT JOIN people p ON p.id = f.person_id
    WHERE f.image_id = ?`).all(imageId) as { x: number; y: number; w: number; h: number; person_id: number | null; removed: number; keep: number | null }[];
  const before = (f: { x: number; y: number; w: number; h: number }) => old.find(o => (o.keep || o.removed) && overlap(o, f) > 0.5);
  tx(db, () => {
    db.prepare('DELETE FROM faces WHERE image_id = ?').run(imageId);
    for (const f of faces) {
      const was = before(f);
      ids.push(Number(ins.run(imageId, f.x, f.y, f.w, f.h, f.score, f.sharpness, f.usable ? 1 : 0, f.emb ? embToBlob(f.emb) : null, FACE_MODEL, f.quality,
        was && !was.removed ? was.person_id : null, was?.removed ?? 0).lastInsertRowid));
    }
    db.prepare("UPDATE images SET status = 'done', error = NULL, faces = ?, width = ?, height = ?, thumb = ?, seen = 1, orig_w = ?, orig_h = ? WHERE id = ?")
      .run(faces.length, W, H, thumb, ow, oh, imageId);
  });
  // Face thumbnails: a loose square crop around each face.
  for (let i = 0; i < faces.length; i++) {
    const f = faces[i];
    const side = Math.min(Math.max(f.w, f.h) * 1.7, W, H);
    const left = Math.round(Math.min(Math.max(0, f.x + f.w / 2 - side / 2), W - side));
    const top = Math.round(Math.min(Math.max(0, f.y + f.h / 2 - side / 2), H - side));
    const chip = path.join(thumbsDir, `face-${ids[i]}.jpg`);
    await sharp(data, raw).extract({ left, top, width: Math.round(side), height: Math.round(side) }).resize(128, 128).jpeg({ quality: 82 }).toFile(chip);
    setChip.run(chip, ids[i]);
  }
  return { faces: faces.length, embs: faces.filter(f => f.emb).map(f => f.emb!) };
}

/** Overlap of two boxes (intersection over union). */
function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/** Group all usable faces of a folder into people (FACE-03). People the user kept stay as they are. */
export function groupFolder(db: Db, fid: number, strictness: number): number {
  // People from an earlier sort whose folder is gone (deleted or moved away) are no longer kept as they were.
  tx(db, () => {
    for (const p of db.prepare('SELECT id, dir FROM people WHERE folder_id = ? AND dir IS NOT NULL').all(fid) as { id: number; dir: string }[]) {
      if (fs.existsSync(p.dir)) continue;
      db.prepare('UPDATE people SET dir = NULL, keep = 0 WHERE id = ?').run(p.id);
      db.prepare('DELETE FROM sort_dirs WHERE folder_id = ? AND dir = ?').run(fid, p.dir);
    }
  });
  const rows = db.prepare(`
    SELECT f.id, f.image_id, f.emb, f.quality, p.id AS pid, p.keep FROM faces f
    JOIN images i ON i.id = f.image_id LEFT JOIN people p ON p.id = f.person_id
    WHERE i.folder_id = ? AND f.usable = 1 AND f.removed = 0 AND f.emb IS NOT NULL AND f.model = ?`).all(fid, FACE_MODEL) as
    { id: number; image_id: number; emb: Uint8Array; quality: number | null; pid: number | null; keep: number | null }[];
  const result = cluster(rows.map(r => ({ id: r.id, imageId: r.image_id, emb: blobToEmb(r.emb), anchor: r.keep ? r.pid : null, quality: r.quality ?? 1 })), strictness);

  return tx(db, () => {
    // Drop automatic people; their faces are re-assigned below.
    db.prepare(`UPDATE faces SET person_id = NULL WHERE person_id IN (SELECT id FROM people WHERE folder_id = ? AND keep = 0)`).run(fid);
    db.prepare('DELETE FROM people WHERE folder_id = ? AND keep = 0').run(fid);
    let num = nextPersonNum(db, fid);
    const insP = db.prepare('INSERT INTO people (folder_id, num) VALUES (?, ?)');
    const setF = db.prepare('UPDATE faces SET person_id = ? WHERE id = ?');
    const groups = [...result.groups].sort((a, b) => b.faceIds.length - a.faceIds.length);
    for (const g of groups) {
      const pid = g.anchor ?? Number(insP.run(fid, num++).lastInsertRowid);
      for (const id of g.faceIds) setF.run(pid, id);
    }
    // Kept people that lost every face (e.g. all removed) disappear unless they own a folder on disk.
    db.prepare(`DELETE FROM people WHERE folder_id = ? AND dir IS NULL AND id NOT IN (SELECT DISTINCT person_id FROM faces WHERE person_id IS NOT NULL)`).run(fid);
    return (db.prepare('SELECT COUNT(*) AS n FROM people WHERE folder_id = ?').get(fid) as { n: number }).n;
  });
}
