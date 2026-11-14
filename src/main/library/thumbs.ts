// Thumbnails and facts (size, duration) for library files: made in the background, cached on disk.
// Cache: <dir>/thumbs/<ab>/<key>.jpg + <dir>/previews/<key>.jpg, facts in library.db. The key changes when the file does.
// No Electron imports: the cache folder is passed in (tests use a temp folder).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import sharp, { type Sharp } from 'sharp';
import { BROWSER_IMAGE_EXTENSIONS, RAW_EXTENSIONS, mediaKind, type MediaInfo } from '../../shared/types';
import { decodeBmp } from '../bmp';
import { decodeStill, probeVideo, videoFrame } from './ffmpeg';
import { rawPreview, rotatedPreview } from './raw';
import { dirSize } from '../dir-size';
export { setFfmpegDir } from './ffmpeg';

// libvips keeps recently read files open in its cache by default; on Windows that stops the user from deleting or
// renaming those photos in Explorer while PixHaven runs. Keep no files open (results are still cached in memory).
sharp.cache({ files: 0 });


export const THUMB_PX = 320;
const SLOT_TIMEOUT_MS = 60_000;
const PREVIEW_PX = 4096;
const HEIF = ['heic', 'heif', 'hif'];
const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

export interface FileRef { path: string; size: number; mtime: number }
interface Row { key: string; width: number | null; height: number | null; duration: number | null; codec: string | null; thumb: number; error: string | null }

export class ThumbCache {
  readonly db: DatabaseSync;
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(path.join(dir, 'thumbs.db'));
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS media_cache (
        key TEXT PRIMARY KEY, path TEXT NOT NULL, width INTEGER, height INTEGER, duration REAL, codec TEXT,
        thumb INTEGER NOT NULL DEFAULT 0, error TEXT, used INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_cache_used ON media_cache(used);`);
  }

  static key(f: FileRef): string {
    const p = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
    return crypto.createHash('sha1').update(`${p}|${f.size}|${Math.floor(f.mtime)}`).digest('hex');
  }
  thumbFile(key: string) { return path.join(this.dir, 'thumbs', key.slice(0, 2), `${key}.jpg`); }
  previewFile(key: string) { return path.join(this.dir, 'previews', `${key}.jpg`); }
  static thumbUrl(key: string) { return `clearup://thumb/${key.slice(0, 2)}/${key}.jpg`; }

  get(f: FileRef): MediaInfo | null {
    const r = this.db.prepare('SELECT * FROM media_cache WHERE key = ?').get(ThumbCache.key(f)) as Row | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE media_cache SET used = ? WHERE key = ?').run(Date.now(), r.key);
    return toInfo(f.path, r);
  }

  /** Makes (or re-reads) the thumbnail and facts for one file. Failures are cached too, so they are not retried each time. */
  async make(f: FileRef): Promise<MediaInfo> {
    const key = ThumbCache.key(f);
    const row: Row = { key, width: null, height: null, duration: null, codec: null, thumb: 0, error: null };
    const out = this.thumbFile(key);
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const kind = mediaKind(f.path);
      if (kind === 'video') {
        const v = await probeVideo(f.path);
        Object.assign(row, { width: v.width || null, height: v.height || null, duration: v.duration || null, codec: v.codec || null });
        if (!v.hasVideo) throw new Error('No picture in this video');
        const at = v.duration > 0 ? Math.min(v.duration * 0.1, 30) : 0;   // skip black intros, stay quick on long films
        await fs.promises.writeFile(out, await videoFrame(f.path, at, THUMB_PX));
      } else {
        const { img, width, height } = await openStill(f.path);
        Object.assign(row, { width, height });
        await img.resize(THUMB_PX, THUMB_PX, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' })
          .jpeg({ quality: 80 }).toFile(out);
      }
      row.thumb = 1;
    } catch (e) {
      row.error = String((e as Error).message ?? e).slice(0, 300);
      // 1.0.7: Attic off or signed out is not the file's fault: tried again next time instead of remembered.
      if (f.path.startsWith('attic://') && /answer|connect|refused|timed out|timeout|forbidden|unauthori[sz]ed|server returned|fetch failed|403|401|5\d\d/i.test(row.error)) return toInfo(f.path, row);
    }
    this.db.prepare(`INSERT OR REPLACE INTO media_cache (key, path, width, height, duration, codec, thumb, error, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(key, f.path, row.width, row.height, row.duration, row.codec, row.thumb, row.error, Date.now());
    return toInfo(f.path, row);
  }

  /** Full-size picture for the viewer: the file itself when Chromium can show it, else a converted JPEG (cached). */
  async preview(f: FileRef): Promise<{ url: string; width: number; height: number; converted: boolean }> {
    const e = ext(f.path);
    if (BROWSER_IMAGE_EXTENSIONS.includes(e)) {
      const info = this.get(f) ?? await this.make(f);
      return { url: `clearup://img/${encodeURIComponent(f.path)}`, width: info.width ?? 0, height: info.height ?? 0, converted: false };
    }
    const key = ThumbCache.key(f);
    const file = this.previewFile(key);
    if (!fs.existsSync(file)) {
      const { img } = await openStill(f.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await img.resize(PREVIEW_PX, PREVIEW_PX, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' })
        .jpeg({ quality: 88 }).toFile(file + '.part');
      fs.renameSync(file + '.part', file);
    }
    const m = await sharp(file).metadata();
    return { url: `clearup://preview/${key}.jpg`, width: m.width ?? 0, height: m.height ?? 0, converted: true };
  }

  sizeOnDisk(): Promise<number> {
    return dirSize(['thumbs', 'previews'].map(d => path.join(this.dir, d)));
  }

  clear(): void {
    for (const d of ['thumbs', 'previews']) fs.rmSync(path.join(this.dir, d), { recursive: true, force: true });
    this.db.exec('DELETE FROM media_cache');
  }

  /** Keeps the cache under `maxBytes` by dropping the least recently used thumbnails; previews are capped at a quarter. */
  // 1.0.3: file sizes are read in the background (on 80,000 thumbnails the old one-by-one check held the window).
  async trim(maxBytes: number): Promise<void> {
    const prev = path.join(this.dir, 'previews');
    const names = await fs.promises.readdir(prev).catch(() => [] as string[]);
    const files = (await Promise.all(names.map(n => { const p = path.join(prev, n); return fs.promises.stat(p).then(s => ({ p, size: s.size, t: s.atimeMs }), () => null); })))
      .filter((f): f is { p: string; size: number; t: number } => !!f).sort((a, b) => b.t - a.t);
    let psum = 0;
    for (const f of files) { psum += f.size; if (psum > maxBytes / 4) await fs.promises.rm(f.p, { force: true }); }
    const rows = this.db.prepare('SELECT key FROM media_cache WHERE thumb = 1 ORDER BY used DESC').all() as { key: string }[];
    let sum = 0;
    const drop: string[] = [];
    for (let i = 0; i < rows.length; i += 256) {
      const part = rows.slice(i, i + 256);
      const sizes = await Promise.all(part.map(r => fs.promises.stat(this.thumbFile(r.key)).then(s => s.size, () => -1)));
      part.forEach((r, j) => { if (sizes[j] < 0) { drop.push(r.key); return; } sum += sizes[j]; if (sum > maxBytes * 0.75) drop.push(r.key); });
    }
    const del = this.db.prepare('DELETE FROM media_cache WHERE key = ?');
    for (let i = 0; i < drop.length; i += 256) {
      const part = drop.slice(i, i + 256);
      await Promise.all(part.map(k => fs.promises.rm(this.thumbFile(k), { force: true })));
      for (const k of part) del.run(k);
    }
  }
}

const inKey = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const inside = (p: string, k: string) => { const x = inKey(p); return x === k || x.startsWith(k + path.sep); };

function toInfo(p: string, r: Row): MediaInfo {
  return {
    path: p, thumb: r.thumb ? ThumbCache.thumbUrl(r.key) : null,
    width: r.width ?? undefined, height: r.height ?? undefined, duration: r.duration ?? undefined, codec: r.codec ?? undefined,
    error: r.error ?? undefined,
  };
}

// 1.0.7: photos on Attic are read over the network (the Attic module registers how); null = a local file.
let remoteBytes: (file: string) => Promise<Buffer> | null = () => null;
export function setRemoteReader(fn: (file: string) => Promise<Buffer> | null): void { remoteBytes = fn; }

/** Any library photo as an upright sharp pipeline, with its displayed size. */
export async function openStill(file: string): Promise<{ img: Sharp; width: number; height: number }> {
  const e = ext(file);
  const remote = remoteBytes(file);
  if (remote) {
    // HEIC and camera RAW: FFmpeg reads them from Attic itself (RAW previews need ExifTool on a local file).
    if (HEIF.includes(e) || RAW_EXTENSIONS.includes(e)) return fromBuffer(await decodeStill(file));
    const buf = await remote;
    if (e === 'bmp') { const b = decodeBmp(buf); return { img: sharp(b.data, { raw: { width: b.width, height: b.height, channels: 4 } }), width: b.width, height: b.height }; }
    const img = sharp(buf, { failOn: 'none', limitInputPixels: false });
    const m = await img.metadata();
    if (!m.width || !m.height) return fromBuffer(await decodeStill(file));
    const swap = (m.orientation ?? 1) >= 5;
    return { img: img.rotate(), width: swap ? m.height : m.width, height: swap ? m.width : m.height };
  }
  if (RAW_EXTENSIONS.includes(e)) {
    const p = await rawPreview(file);
    return { img: rotatedPreview(p), width: p.width, height: p.height };
  }
  if (HEIF.includes(e)) return fromBuffer(await decodeStill(file));
  if (e === 'bmp') {
    const b = decodeBmp(await fs.promises.readFile(file));
    return { img: sharp(b.data, { raw: { width: b.width, height: b.height, channels: 4 } }), width: b.width, height: b.height };
  }
  try {
    // Read by Node, not by libvips: libvips keeps the file open (Windows then won't let the user delete or rename
    // the photo while PixHaven runs). Only very large files are opened directly.
    const size = (await fs.promises.stat(file)).size;
    const input = size <= 256 * 1024 * 1024 ? await fs.promises.readFile(file) : file;
    const img = sharp(input, { failOn: 'none', limitInputPixels: false });   // first frame of GIFs and multi-page TIFFs
    const m = await img.metadata();
    if (!m.width || !m.height) throw new Error('No size');
    const swap = (m.orientation ?? 1) >= 5;
    return { img: img.rotate(), width: swap ? m.height : m.width, height: swap ? m.width : m.height };
  } catch {
    return fromBuffer(await decodeStill(file));                             // FFmpeg reads many odd variants
  }
}

async function fromBuffer(png: Buffer) {
  const img = sharp(png, { limitInputPixels: false });
  const m = await img.metadata();
  return { img, width: m.width ?? 0, height: m.height ?? 0 };
}

/**
 * Background work list. The UI sends what is on screen first, then the rest of the folder; each new request
 * replaces the old list, so scrolling away drops work nobody is looking at. `pause` holds it (e.g. during playback).
 */
export class ThumbQueue {
  private pending: FileRef[] = [];
  private running = new Set<string>();
  private paused = false;
  private held: string[] = [];       // folders being renamed: nothing in them is opened meanwhile
  constructor(private cache: ThumbCache, public concurrency: number, private onDone: (info: MediaInfo) => void) {}

  /** Returns what is already cached; queues the rest. */
  request(files: FileRef[]): MediaInfo[] {
    const ready: MediaInfo[] = [];
    const todo: FileRef[] = [];
    const seen = new Set<string>();
    // One transaction for the whole list (up to 3,000 files each time the grid scrolls), not one write per file.
    this.cache.db.exec('BEGIN');
    try {
      for (const f of files) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        const hit = this.cache.get(f);
        if (hit) ready.push(hit); else if (!this.running.has(f.path)) todo.push(f);
      }
      this.cache.db.exec('COMMIT');
    } catch (e) { this.cache.db.exec('ROLLBACK'); throw e; }
    this.pending = todo;
    this.pump();
    return ready;
  }
  pause(p: boolean) { this.paused = p; if (!p) this.pump(); }

  /** 1.0.3: runs `fn` with no thumbnail open inside `dir` (Windows will not rename a folder with an open file in it). */
  async hold<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const k = inKey(dir);
    this.held.push(k);
    try {
      for (let i = 0; i < 100 && [...this.running].some(p => inside(p, k)); i++) await new Promise(r => setTimeout(r, 50));
      return await fn();
    } finally {
      this.held.splice(this.held.indexOf(k), 1);
      this.pump();
    }
  }
  get busy() { return this.running.size + this.pending.length; }

  private pump(): void {
    if (this.held.length) this.pending = this.pending.filter(f => !this.held.some(k => inside(f.path, k)));
    while (!this.paused && this.running.size < this.concurrency && this.pending.length) {
      const f = this.pending.shift()!;
      this.running.add(f.path);
      // 1.0.3: a file that never answers (a drive gone to sleep, a stuck network share) frees its place after a minute.
      let freed = false;
      const free = () => { if (freed) return; freed = true; this.running.delete(f.path); this.pump(); };
      const timer = setTimeout(free, SLOT_TIMEOUT_MS);
      this.cache.make(f).then(this.onDone, () => {}).finally(() => { clearTimeout(timer); free(); });
    }
  }
}
