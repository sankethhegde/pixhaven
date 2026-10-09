// Watched folders (v2.1, LIB-08): the folders listed in Settings are indexed in the background (one at a time, paused
// while a video plays), then kept current with Windows' own change notifications — one recursive watch per folder,
// which costs far less than watching thousands of subfolders one by one. Every change re-reads just the folder it
// happened in. New files that are a labelled file renamed or moved (also from one watched folder to another) take
// their labels and stars with them. Folders on a drive that is unplugged show as offline and are looked at again
// every 30 seconds; their index (and labels) are kept.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { MediaKind, TaggedMedia, WatchChange, WatchedFolder, WatchQuery, WatchResult } from '@shared/types';
import { getSettings, updateSettings } from './settings';
import { log } from './logger';
import { MediaIndex, isInside, type DirChange } from './library/media-index';
import * as tags from './tags-service';

const IS_WIN = process.platform === 'win32';
const key = (p: string) => (IS_WIN ? p.toLowerCase() : p);

let index: MediaIndex | null = null;
const watchers = new Map<string, fs.FSWatcher>();
const live = new Map<string, boolean>();
const progress = new Map<string, number>();
let running: string | null = null;
let abort: AbortController | null = null;
const pausedBy = new Set<string>();
let resume: (() => void) | null = null;
const dirty = new Set<string>();
let dirtyTimer: NodeJS.Timeout | null = null;
const fullScan = new Set<string>();     // folders to walk again (new, re-index, back online, no live watch)
let sendStatus: (s: WatchedFolder[]) => void = () => {};
let sendChange: (c: WatchChange) => void = () => {};
let statusTimer: NodeJS.Timeout | null = null;
let closing = false;

export const indexFile = () => path.join(app.getPath('userData'), 'library', 'index.db');
function idx(): MediaIndex { if (!index) index = new MediaIndex(indexFile()); return index; }
const folders = () => getSettings().library.watched ?? [];

export function init(status: (s: WatchedFolder[]) => void, change: (c: WatchChange) => void): void {
  sendStatus = status; sendChange = change;
  const ix = idx();
  // The settings list is the truth; the index follows it (it is only a cache).
  for (const r of ix.roots()) if (!folders().some(f => key(f) === key(r.path))) ix.removeRoot(r.path);
  for (const f of folders()) {
    ix.addRoot(f);
    fullScan.add(f);     // a quick check at every start finds what changed while PixHaven was closed (or resumes)
    startWatch(f);
  }
  // Start quietly a few seconds after the window opens.
  setTimeout(() => void pump(), app.isPackaged ? 8000 : 1500);
  setInterval(checkOffline, 30_000);
}

export function close(): void {
  closing = true;
  abort?.abort();
  for (const w of watchers.values()) w.close();
  watchers.clear();
  index?.close(); index = null;
}

// ---------- status ----------

export function status(): WatchedFolder[] {
  const ix = idx();
  return folders().map(f => {
    const r = ix.rootOf(f);
    const indexing = running !== null && key(running) === key(f);
    const state: WatchedFolder['state'] = r?.offline ? 'offline' : indexing ? (pausedBy.size ? 'paused' : 'indexing') : (fullScan.has(f) || r?.scanning || !r?.last_scan) ? 'waiting' : 'ready';
    return { path: f, files: r?.files ?? 0, state, scanned: progress.get(key(f)) ?? 0, lastScan: r?.last_scan ?? null, live: live.get(key(f)) ?? false };
  });
}
function pushStatus(): void {
  if (statusTimer) return;
  statusTimer = setTimeout(() => { statusTimer = null; sendStatus(status()); }, 400);
}

// ---------- adding and removing folders ----------

export function add(dir: string): WatchedFolder[] {
  const d = path.resolve(dir);
  if (!fs.statSync(d).isDirectory()) throw new Error('That is not a folder.');
  const parent = folders().find(f => isInside(d, f));
  if (parent) throw new Error(key(parent) === key(d) ? 'This folder is already watched.' : `This folder is already watched as part of ${parent}.`);
  // A parent of watched folders takes their place.
  const inner = folders().filter(f => isInside(f, d));
  for (const f of inner) remove(f);
  updateSettings({ library: { ...getSettings().library, watched: [...folders(), d] } });
  idx().addRoot(d);
  fullScan.add(d);
  startWatch(d);
  log('info', `Watching ${d}`);
  void pump();
  pushStatus();
  return status();
}

export function remove(dir: string): WatchedFolder[] {
  const f = folders().find(x => key(x) === key(dir));
  if (!f) return status();
  if (running && key(running) === key(f)) abort?.abort();
  watchers.get(key(f))?.close();
  watchers.delete(key(f));
  fullScan.delete(f);
  updateSettings({ library: { ...getSettings().library, watched: folders().filter(x => key(x) !== key(f)) } });
  idx().removeRoot(f);
  log('info', `Stopped watching ${f}`);
  pushStatus();
  return status();
}

/** "Index again": a fresh pass over the whole folder. */
export function reindex(dir: string): WatchedFolder[] {
  const f = folders().find(x => key(x) === key(dir));
  if (!f) return status();
  if (running && key(running) === key(f)) abort?.abort();
  const r = idx().rootOf(f);
  if (r) idx().restart(r.id);
  fullScan.add(f);
  void pump();
  pushStatus();
  return status();
}

/** Low-spec: no indexing while a video plays (and while the user pauses it). */
export function pause(reason: string, on: boolean): void {
  if (on) pausedBy.add(reason); else pausedBy.delete(reason);
  if (!pausedBy.size && resume) { const r = resume; resume = null; r(); }
  pushStatus();
}
const gate = () => (pausedBy.size ? new Promise<void>(r => { resume = r; abort?.signal.addEventListener('abort', () => r(), { once: true }); pushStatus(); }) : Promise.resolve());

// ---------- indexing passes ----------

async function pump(): Promise<void> {
  if (running || closing) return;
  for (;;) {
    const f = folders().find(x => fullScan.has(x));
    if (!f || closing) break;
    const r = idx().rootOf(f);
    if (!r) { fullScan.delete(f); continue; }
    running = f;
    abort = new AbortController();
    progress.set(key(f), 0);
    pushStatus();
    const t0 = Date.now();
    let result: 'done' | 'stopped' | 'offline' = 'stopped';
    try {
      result = await idx().scan(r.id, {
        signal: abort.signal, gate, showSystem: getSettings().library.showSystem,
        onProgress: n => { progress.set(key(f), n); pushStatus(); },
        onChange: (dir, c) => changed([dir], c),
      });
    } catch (e) { log('error', `Indexing ${f} failed`, e); fullScan.delete(f); }
    running = null;
    // "stopped" = aborted by remove() (no longer listed), re-index (listed again: starts over) or quitting.
    if (result !== 'stopped') fullScan.delete(f);
    if (result === 'done') {
      log('info', `Indexed ${f}: ${idx().rootOf(f)?.files ?? 0} photos and videos in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      // Labelled files that went missing may be somewhere in here now.
      const n = await tags.relinkFromIndex(sz => idx().bySize(sz)).catch(() => 0);
      if (n) sendChange({ dirs: [], added: 0, removed: 0, relinked: n });
      if (!watchers.has(key(f))) startWatch(f);
    }
    pushStatus();
  }
  pushStatus();
}

async function changed(dirs: string[], c: DirChange): Promise<void> {
  let relinked = 0;
  if (c.added.length) relinked = (await tags.relinkAdded(c.added)).length;
  if (c.added.length || c.removed.length || relinked) sendChange({ dirs, added: c.added.length, removed: c.removed.length, relinked });
}

// ---------- live changes ----------

function startWatch(f: string): void {
  if (watchers.has(key(f))) return;
  try {
    const w = fs.watch(f, { recursive: true }, (_ev, name) => {
      if (!name) { fullScan.add(f); void pump(); return; }       // too many changes at once: walk again
      const n = name.toString();
      // The watched folder itself was renamed or deleted (Windows then reports its full path).
      if (path.isAbsolute(n) || n.startsWith('\\\\?\\')) { setTimeout(checkOffline, 500); return; }
      dirty.add(path.dirname(path.join(f, n)));
      if (dirtyTimer) clearTimeout(dirtyTimer);
      dirtyTimer = setTimeout(() => void flushDirty(), 1200);
    });
    w.on('error', e => {
      log('warn', `Stopped watching ${f}`, e);
      w.close(); watchers.delete(key(f)); live.set(key(f), false);
      const r = idx().rootOf(f);
      if (r && !fs.existsSync(f)) idx().setOffline(r.id, true);
      pushStatus();
    });
    watchers.set(key(f), w);
    live.set(key(f), true);
  } catch (e) {
    // Some network drives can't be watched: they are walked again every 15 minutes instead.
    live.set(key(f), false);
    log('warn', `Can't watch ${f} for changes`, e);
  }
}

async function flushDirty(): Promise<void> {
  dirtyTimer = null;
  const list = [...dirty];
  dirty.clear();
  // Re-read each changed folder once; a folder whose parent is also listed is covered by the parent's re-read only
  // when it is new or gone, so each one is read on its own.
  const all: DirChange = { added: [], removed: [] };
  const seen = new Set<string>();
  for (const d of list) {
    if (seen.has(key(d))) continue;
    seen.add(key(d));
    if (!folders().some(f => isInside(d, f))) continue;
    try {
      const c = await idx().rescanDir(d, getSettings().library.showSystem);
      all.added.push(...c.added); all.removed.push(...c.removed);
    } catch (e) { log('warn', `Re-reading ${d} failed`, e); }
  }
  await changed(list, all);
  pushStatus();
}

function checkOffline(): void {
  const ix = idx();
  for (const f of folders()) {
    const r = ix.rootOf(f);
    if (!r) continue;
    const there = fs.existsSync(f);
    if (r.offline && there) {             // drive plugged back in
      ix.setOffline(r.id, false);
      fullScan.add(f);
      startWatch(f);
      void pump();
    } else if (!r.offline && !there) {
      ix.setOffline(r.id, true);
      watchers.get(key(f))?.close(); watchers.delete(key(f));
    } else if (!live.get(key(f)) && there && r.last_scan && Date.now() - r.last_scan > 15 * 60_000) {
      fullScan.add(f); void pump();
    }
  }
  pushStatus();
}

export const bySize = (size: number) => idx().bySize(size);

/** The app itself renamed or moved a file: the index follows at once. */
export function moved(from: string, to: string): void {
  try {
    if (!index) return;
    const st = fs.statSync(to);
    if (idx().has(from) || folders().some(f => isInside(to, f))) idx().moved(from, to, st.size, st.mtimeMs);
  } catch { /* not indexed */ }
}

// ---------- questions from the Library ----------

/** Is this folder inside a watched folder whose index is complete? Then search can answer from the index at once. */
export function indexedFor(dir: string): boolean {
  const r = idx().rootOf(dir);
  return !!r && !r.scanning && !!r.last_scan && !r.offline;
}

export function searchIndex(root: string, text: string, limit: number): { items: TaggedMedia[]; total: number } {
  const r = idx().query({ text, under: root, limit });
  return { items: r.items.map(e => ({ ...e, stars: 0, labels: [], offline: false })), total: r.total };
}

/** "All watched folders" view: type, name words, labels and stars, without browsing first. */
export function query(q: WatchQuery): WatchResult {
  const s = tags.tagStore();
  const tagged = q.filter.labels.length || q.filter.minStars ? new Set(s.query(q.filter, '').map(r => key(r.path))) : null;
  const limit = q.limit ?? 20000;
  const r = idx().query({ text: q.text, kind: q.type as MediaKind | 'all', under: q.root, paths: tagged, limit });
  const t = s.tagsFor(r.items.map(e => e.path));
  return {
    items: r.items.map(e => ({ ...e, stars: t[e.path]?.stars ?? 0, labels: t[e.path]?.labels ?? [], offline: false })),
    total: r.total, truncated: r.total > limit, tags: t,
  };
}
