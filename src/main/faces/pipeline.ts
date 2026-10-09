// Sort-by-person pipeline steps that touch the database: scan images, group faces, name people.
// No Electron imports — runs in the scan worker thread (and in tests).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { SortSettings } from '../../shared/types';
import { type Db, tx, embToBlob, blobToEmb, nextPersonNum } from '../db';
import { openImage, readImageBuffer } from '../image-io';
import { FaceEngine } from './detect';
import { cluster } from './cluster';
import { bestFileName } from './names-file';
import type { NameReader } from './names-ocr';

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

  fs.mkdirSync(thumbsDir, { recursive: true });
  const raw = { raw: { width: W, height: H, channels: 3 as const } };
  const thumb = path.join(thumbsDir, `img-${imageId}.jpg`);
  await sharp(data, raw).resize(320, 320, { fit: 'inside' }).jpeg({ quality: 78 }).toFile(thumb);

  const ins = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const setChip = db.prepare('UPDATE faces SET chip = ? WHERE id = ?');
  const ids: number[] = [];
  tx(db, () => {
    db.prepare('DELETE FROM faces WHERE image_id = ?').run(imageId);
    for (const f of faces) {
      ids.push(Number(ins.run(imageId, f.x, f.y, f.w, f.h, f.score, f.sharpness, f.usable ? 1 : 0, f.emb ? embToBlob(f.emb) : null).lastInsertRowid));
    }
    db.prepare("UPDATE images SET status = 'done', error = NULL, faces = ?, width = ?, height = ?, thumb = ?, seen = 1 WHERE id = ?")
      .run(faces.length, W, H, thumb, imageId);
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

/** Group all usable faces of a folder into people (FACE-03). People the user kept stay as they are. */
export function groupFolder(db: Db, fid: number, strictness: number): number {
  const rows = db.prepare(`
    SELECT f.id, f.image_id, f.emb, p.id AS pid, p.keep FROM faces f
    JOIN images i ON i.id = f.image_id LEFT JOIN people p ON p.id = f.person_id
    WHERE i.folder_id = ? AND f.usable = 1 AND f.removed = 0 AND f.emb IS NOT NULL`).all(fid) as
    { id: number; image_id: number; emb: Uint8Array; pid: number | null; keep: number | null }[];
  const result = cluster(rows.map(r => ({ id: r.id, imageId: r.image_id, emb: blobToEmb(r.emb), anchor: r.keep ? r.pid : null })), strictness);

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

/** Photos where this person is the only recognised person (names are only taken from these). */
export function singlePersonPhotos(db: Db, pid: number): { id: number; path: string; faceH: number }[] {
  return db.prepare(`
    SELECT i.id, i.path, MAX(f.h) AS faceH FROM images i JOIN faces f ON f.image_id = i.id
    WHERE f.person_id = ? AND f.removed = 0 AND i.status = 'done'
      AND (SELECT COUNT(DISTINCT f2.person_id) FROM faces f2 WHERE f2.image_id = i.id AND f2.person_id IS NOT NULL AND f2.removed = 0) = 1
    GROUP BY i.id ORDER BY faceH DESC`).all(pid) as { id: number; path: string; faceH: number }[];
}

/** FACE-10/11: give unnamed people a name from file names, then (optionally) from text in their photos. */
export async function nameFolder(db: Db, fid: number, reader: NameReader | null, onPerson?: (done: number, total: number) => void): Promise<void> {
  const people = db.prepare("SELECT id FROM people WHERE folder_id = ? AND (name_source IS NULL OR name_source != 'typed') ORDER BY num").all(fid) as { id: number }[];
  const set = db.prepare('UPDATE people SET name = ?, name_source = ?, name_detail = ? WHERE id = ?');
  let done = 0;
  for (const p of people) {
    const photos = singlePersonPhotos(db, p.id);
    const byFile = bestFileName(photos.map(ph => ph.path));
    if (byFile) {
      set.run(byFile.name, 'file', path.basename(byFile.from), p.id);
    } else {
      let found: { name: string; from: string } | null = null;
      if (reader) {
        // Stop at the first good name; look at a few of the clearest single-person photos only.
        for (const ph of photos.slice(0, 4)) {
          try {
            const n = await reader.read(ph.path, readImageBuffer);
            if (n) { found = { name: n, from: ph.path }; break; }
          } catch { /* unreadable: try the next photo */ }
        }
      }
      if (found) set.run(found.name, 'ocr', path.basename(found.from), p.id);
      else set.run(null, null, null, p.id);
    }
    onPerson?.(++done, people.length);
  }
}
