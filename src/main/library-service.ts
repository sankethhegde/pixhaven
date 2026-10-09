// Media library (v2.0 Phase A): drives, folders, thumbnails, viewer previews and name search.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { MediaEntry, MediaInfo, SearchUpdate } from '@shared/types';
import { mediaKind } from '@shared/types';
import { getSettings } from './settings';
import { log } from './logger';
import { folderHasMedia, listDrives, listFolder, searchNames } from './library/browse';
import { ThumbCache, ThumbQueue, type FileRef } from './library/thumbs';
import { setFfmpegDir } from './library/ffmpeg';
import { resourcesDir } from './engine';

const CACHE_LIMIT = 2 * 1024 ** 3;   // doc: roughly 1–2 GB of thumbnails per 100,000 files

let cache: ThumbCache | null = null;
let queue: ThumbQueue | null = null;
let notify: (info: MediaInfo) => void = () => {};

export const cacheDir = () => path.join(app.getPath('userData'), 'library');

function getCache(): ThumbCache {
  if (!cache) {
    cache = new ThumbCache(cacheDir());
    // Low-spec: two at a time (doc); otherwise three, leaving the rest of the machine responsive.
    queue = new ThumbQueue(cache, getSettings().lowSpec ? 2 : 3, info => notify(info));
    setTimeout(() => { try { cache?.trim(CACHE_LIMIT); } catch (e) { log('warn', 'Thumbnail cache trim failed', e); } }, 30_000);
  }
  return cache;
}

export function init(onThumb: (info: MediaInfo) => void): void {
  notify = onThumb;
  setFfmpegDir(process.platform === 'win32' ? path.join(resourcesDir(), 'bin', 'win', 'ffmpeg') : path.join(resourcesDir(), 'bin', 'linux', 'ffmpeg', 'bin'));
}

const places = () => {
  const p = (name: string, key: Parameters<typeof app.getPath>[0]) => { try { return { name, path: app.getPath(key) }; } catch { return null; } };
  return [p('Pictures', 'pictures'), p('Videos', 'videos'), p('Desktop', 'desktop'), p('Downloads', 'downloads'), p('Home', 'home')]
    .filter((x): x is { name: string; path: string } => !!x);
};

export const drives = () => listDrives(places());
export const list = (dir: string) => listFolder(dir, getSettings().library.showSystem);

export async function hasMedia(dirs: string[]): Promise<Record<string, boolean | null>> {
  const show = getSettings().library.showSystem;
  const out: Record<string, boolean | null> = {};
  // A few at a time: each check reads up to a few thousand directory entries.
  for (let i = 0; i < dirs.length; i += 6) {
    const part = dirs.slice(i, i + 6);
    const r = await Promise.all(part.map(d => folderHasMedia(d, show)));
    part.forEach((d, j) => { out[d] = r[j]; });
  }
  return out;
}

export function thumbs(files: FileRef[]): MediaInfo[] {
  getCache();
  if (queue) queue.concurrency = getSettings().lowSpec ? 2 : 3;
  return queue!.request(files.filter(f => mediaKind(f.path)));
}
export const pauseThumbs = (p: boolean) => { getCache(); queue!.pause(p); };

export async function preview(p: string) {
  const s = await fs.promises.stat(p);
  return getCache().preview({ path: p, size: s.size, mtime: s.mtimeMs });
}

/** Serves clearup://thumb/<ab>/<key>.jpg and clearup://preview/<key>.jpg from the cache folder. */
export function cacheFile(host: 'thumb' | 'preview', rel: string): string | null {
  if (!/^([0-9a-f]{2}\/)?[0-9a-f]{40}\.jpg$/.test(rel)) return null;
  return path.join(cacheDir(), host === 'thumb' ? 'thumbs' : 'previews', rel);
}

export const cacheSize = () => getCache().sizeOnDisk();
export const clearCache = () => getCache().clear();

let searchId = 0;
let searchAbort: AbortController | null = null;
export function search(root: string, query: string, send: (u: SearchUpdate) => void,
  fromIndex?: (root: string, q: string) => { items: MediaEntry[]; total: number } | null): number {
  searchAbort?.abort();
  const id = ++searchId;
  // v2.1: inside a watched folder that is fully indexed, the answer comes from the index at once.
  const hit = fromIndex?.(root, query);
  if (hit) {
    setTimeout(() => send({ id, items: hit.items, scanned: hit.total, done: true, truncated: hit.total > hit.items.length, indexed: true }), 0);
    return id;
  }
  const abort = (searchAbort = new AbortController());
  searchNames(root, query, getSettings().library.showSystem, abort.signal, (items, scanned) => send({ id, items, scanned, done: false }))
    .then(r => send({ id, items: [], scanned: r.scanned, done: true, truncated: r.truncated }))
    .catch(e => { log('error', 'Search failed', e); send({ id, items: [], scanned: 0, done: true }); });
  return id;
}
export const cancelSearch = () => searchAbort?.abort();

