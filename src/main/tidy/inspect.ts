// Photo facts for the tidy tools: exact hash, perceptual hash, blur score, date taken, GPS position.
// No Electron imports (runs in the worker thread).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { type Db, tx } from '../db';
import { openImage } from '../image-io';
import { sha1 } from '../sorter/apply';
import type { ListedFile } from '../faces/pipeline';

export interface PhotoFacts {
  sha1: string;
  dhash: string;            // 64-bit difference hash, hex
  blur: number;             // sharpness: higher = sharper (see blurScore)
  width: number;
  height: number;
  taken: number | null;     // ms since epoch, local wall-clock time
  takenSrc: 'exif' | 'file' | null;
  lat: number | null;
  lon: number | null;
}

const WORK = 512;

/** 64-bit dHash: is each pixel brighter than its right neighbour, on a 9×8 grey thumbnail. */
export async function dHash(gray: Buffer, w: number, h: number): Promise<string> {
  const px = await sharp(gray, { raw: { width: w, height: h, channels: 1 } }).resize(9, 8, { fit: 'fill' }).extractChannel(0).raw().toBuffer();
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Sharpness = variance of the Laplacian, measured on a 4×4 grid; the score is the sharpest tile, so a photo with
 *  a sharp subject and a soft background (bokeh) is not called blurry. */
export function blurScore(gray: Buffer, w: number, h: number): number {
  let best = 0;
  const tw = Math.floor(w / 4), th = Math.floor(h / 4);
  for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) {
    let sum = 0, sq = 0, n = 0;
    for (let y = Math.max(1, ty * th); y < Math.min(h - 1, (ty + 1) * th); y++) {
      for (let x = Math.max(1, tx * tw); x < Math.min(w - 1, (tx + 1) * tw); x++) {
        const i = y * w + x;
        const l = gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w] - 4 * gray[i];
        sum += l; sq += l * l; n++;
      }
    }
    if (n) best = Math.max(best, sq / n - (sum / n) ** 2);
  }
  return Math.round(best * 10) / 10;
}

/** Camera date (EXIF DateTimeOriginal/CreateDate) as local wall-clock ms, and GPS position. */
export async function readExif(file: string): Promise<{ taken: number | null; lat: number | null; lon: number | null }> {
  if (/\.bmp$/i.test(file)) return { taken: null, lat: null, lon: null };
  try {
    const e = await exifr.parse(file, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false, reviveValues: false });
    if (!e) return { taken: null, lat: null, lon: null };
    // "2024:05:12 18:30:55" → kept as the wall-clock time the camera showed (no time-zone shift).
    const raw: unknown = e.DateTimeOriginal ?? e.CreateDate ?? e.DateTimeDigitized;
    let taken: number | null = null;
    const m = typeof raw === 'string' ? raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/) : null;
    if (m && +m[1] > 1900) taken = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const lat = typeof e.latitude === 'number' && isFinite(e.latitude) ? e.latitude : null;
    const lon = typeof e.longitude === 'number' && isFinite(e.longitude) ? e.longitude : null;
    return { taken, lat: lat === 0 && lon === 0 ? null : lat, lon: lat === 0 && lon === 0 ? null : lon };
  } catch {
    return { taken: null, lat: null, lon: null };
  }
}

export async function inspectPhoto(file: string, thumb: string): Promise<PhotoFacts> {
  const meta = await openImage(file).metadata();
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0, height = (swap ? meta.width : meta.height) ?? 0;
  const { data, info } = await openImage(file).rotate().resize(WORK, WORK, { fit: 'inside', withoutEnlargement: true })
    .grayscale().raw().toBuffer({ resolveWithObject: true });
  const gray = info.channels === 1 ? data : Buffer.from(data.filter((_, i) => i % info.channels === 0));
  await openImage(file).rotate().resize(320, 320, { fit: 'inside' }).jpeg({ quality: 78 }).toFile(thumb);
  const exif = await readExif(file);
  const st = fs.statSync(file);
  return {
    sha1: sha1(file), dhash: await dHash(gray, info.width, info.height), blur: blurScore(gray, info.width, info.height),
    width, height,
    taken: exif.taken ?? localMs(st.mtime), takenSrc: exif.taken ? 'exif' : 'file',
    lat: exif.lat, lon: exif.lon,
  };
}

/** A Date as "wall-clock" ms in UTC fields, matching how EXIF dates are stored above. */
const localMs = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());

/** Keep photo_info in step with the files on disk; returns ids still to inspect. */
export function syncPhotoInfo(db: Db, fid: number, files: ListedFile[]): number[] {
  return tx(db, () => {
    db.prepare('UPDATE photo_info SET seen = 0 WHERE folder_id = ?').run(fid);
    const get = db.prepare('SELECT id, size, mtime, status FROM photo_info WHERE folder_id = ? AND path = ?');
    const ins = db.prepare('INSERT INTO photo_info (folder_id, path, size, mtime, status) VALUES (?, ?, ?, ?, ?)');
    const reset = db.prepare("UPDATE photo_info SET size = ?, mtime = ?, status = ?, error = NULL, seen = 1 WHERE id = ?");
    const seen = db.prepare('UPDATE photo_info SET seen = 1 WHERE id = ?');
    const todo: number[] = [];
    for (const f of files) {
      const row = get.get(fid, f.path) as { id: number; size: number; mtime: number; status: string } | undefined;
      const status = f.cloud ? 'skipped' : 'pending';
      if (!row) { const id = Number(ins.run(fid, f.path, f.size, f.mtime, status).lastInsertRowid); if (!f.cloud) todo.push(id); }
      else if (row.size !== f.size || row.mtime !== f.mtime || row.status === 'pending') { reset.run(f.size, f.mtime, status, row.id); if (!f.cloud) todo.push(row.id); }
      else seen.run(row.id);
    }
    db.prepare('DELETE FROM photo_info WHERE folder_id = ? AND seen = 0').run(fid);
    db.prepare("UPDATE photo_info SET error = 'Online-only file (not downloaded)' WHERE folder_id = ? AND status = 'skipped' AND error IS NULL").run(fid);
    return todo;
  });
}

export async function inspectRow(db: Db, id: number, thumbsDir: string): Promise<void> {
  const row = db.prepare('SELECT path FROM photo_info WHERE id = ?').get(id) as { path: string };
  fs.mkdirSync(thumbsDir, { recursive: true });
  const thumb = path.join(thumbsDir, `tidy-${id}.jpg`);
  try {
    const f = await inspectPhoto(row.path, thumb);
    db.prepare(`UPDATE photo_info SET status = 'done', sha1 = ?, dhash = ?, blur = ?, width = ?, height = ?, taken = ?, taken_src = ?, lat = ?, lon = ?, thumb = ? WHERE id = ?`)
      .run(f.sha1, f.dhash, f.blur, f.width, f.height, f.taken, f.takenSrc, f.lat, f.lon, thumb, id);
  } catch (e) {
    const msg = /EBUSY|EPERM|EACCES/.test(String(e)) ? 'Locked or no permission' : 'Unreadable or damaged image';
    db.prepare("UPDATE photo_info SET status = 'error', error = ? WHERE id = ?").run(msg, id);
  }
}
