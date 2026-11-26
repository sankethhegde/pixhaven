// Watched folders (v2.1, LIB-08): the folders listed in Settings are indexed in the background (one at a time, paused
// while a video plays), then kept current with Windows' own change notifications — one recursive watch per folder,
// which costs far less than watching thousands of subfolders one by one. Every change re-reads just the folder it
// happened in. New files that are a labelled file renamed or moved (also from one watched folder to another) take
// their labels and stars with them. Folders on a drive that is unplugged show as offline and are looked at again
// every 30 seconds; their index (and labels) are kept.
import fs from 'node:fs';
import path from 'node:path';
import { app, powerMonitor } from 'electron';
import type { MediaEntry, MediaKind, TaggedMedia, WatchChange, WatchedFolder, WatchQuery, WatchResult } from '@shared/types';
import { getSettings, updateSettings } from './settings';
import { log } from './logger';
import { MediaIndex, inSkipped, isInside, type DirChange } from './library/media-index';
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
let enabled = true;                        // 1.1.2: Light mode can switch watching off

export const indexFile = () => path.join(app.getPath('userData'), 'library', 'index.db');
function idx(): MediaIndex { if (!index) index = new MediaIndex(indexFile()); return index; }
const folders = () => getSettings().library.watched ?? [];

export function init(status: (s: WatchedFolder[]) => void, change: (c: WatchChange) => void): void {
  sendStatus = status; sendChange = change;
  const ix = idx();
  // The settings list is the truth; the index follows it (it is only a cache).
  for (const r of ix.roots()) if (!folders().some(f => key(f) === key(r.path))) ix.removeRoot(r.path);
  // 1.0.9: what change storms put into the index from skipped parts (AppData…) goes.
  try { const n = ix.purgeSkipped(getSettings().library.showSystem); if (n) log('info', `Removed ${n} file(s) indexed from system and app folders`); } catch (e) { log('warn', 'Cleaning the index failed', e); }
  // 1.0.14: TypeScript code indexed as ".ts video" by earlier versions goes (in the background: it reads each .ts).
  void ix.purgeTsCode().then(gone => {
    if (!gone.length) return;
    log('info', `Removed ${gone.length} TypeScript code file(s) that were listed as videos`);
    sendChange({ dirs: [...new Set(gone.map(p => path.dirname(p)))], added: 0, removed: gone.length, relinked: 0 });
  }).catch(e => log('warn', 'Cleaning code files from the index failed', e));
  for (const f of folders()) ix.addRoot(f);
  if (enabled) for (const f of folders()) {
    fullScan.add(f);     // a quick check at every start finds what changed while PixHaven was closed (or resumes)
    startWatch(f);
  }
  // Start quietly a few seconds after the window opens.
  setTimeout(() => void pump(), app.isPackaged ? 8000 : 1500);
  setInterval(checkOffline, 30_000);
  setInterval(dailyPass, 5 * 60_000).unref();
}

/**
 * 1.1.2 Light mode: watching switched off stops the watchers and any walk under way (the Videos list stays as it
 * was); switched on again, a quick check catches up.
 */
export function setEnabled(on: boolean): void {
  if (on === enabled) return;
  enabled = on;
  if (!index) return;
  if (!on) {
    abort?.abort();
    for (const w of watchers.values()) w.close();
    watchers.clear();
    fullScan.clear();
    dirty.clear();
    log('info', 'Light mode: watched folders are not kept up to date');
  } else {
    for (const f of folders()) { fullScan.add(f); startWatch(f); }
    void pump();
    log('info', 'Watched folders are kept up to date again');
  }
  pushStatus();
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
/** 1.1.2: why indexing waits ("battery", "user", a job…), for the background note. */
export const pausedReasons = (): string[] => [...pausedBy];
export function pause(reason: string, on: boolean): void {
  if (on) pausedBy.add(reason); else pausedBy.delete(reason);
  if (!pausedBy.size && resume) { const r = resume; resume = null; r(); }
  pushStatus();
}
const gate = () => (pausedBy.size ? new Promise<void>(r => { resume = r; abort?.signal.addEventListener('abort', () => r(), { once: true }); pushStatus(); }) : Promise.resolve());

// ---------- indexing passes ----------

async function pump(): Promise<void> {
  if (running || closing || !enabled) return;
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
  void readFileTags();
}

/**
 * v2.2: stars and labels inside the indexed files (written by PixHaven on another computer, Explorer, Lightroom…) are
 * read in the background after indexing, a batch at a time, so "Tagged" shows them without opening each folder.
 */
let tagReading = false;
async function readFileTags(): Promise<void> {
  if (tagReading || closing) return;
  tagReading = true;
  try {
    for (;;) {
      if (running || closing) break;                  // indexing first; this starts again when it's done
      await gate();
      if (closing) break;
      const batch = idx().tagsTodo(200);
      if (!batch.length) break;
      const changed = await tags.syncFromFiles(batch).catch(e => { log('warn', 'Reading labels from files failed', e); return null; });
      if (changed === null) break;
      idx().tagsDone(batch);
      if (changed.length) sendChange({ dirs: [...new Set(changed.map(p => path.dirname(p)))], added: 0, removed: 0, relinked: 0 });
    }
  } finally { tagReading = false; }
}

async function changed(dirs: string[], c: DirChange): Promise<void> {
  let relinked = 0;
  if (c.added.length) relinked = (await tags.relinkAdded(c.added)).length;
  if (c.added.length || c.removed.length || relinked) sendChange({ dirs, added: c.added.length, removed: c.removed.length, relinked });
  if (c.added.length) void readFileTags();
}

// ---------- live changes ----------

function startWatch(f: string): void {
  if (watchers.has(key(f)) || !enabled) return;
  try {
    const w = fs.watch(f, { recursive: true }, (_ev, name) => {
      if (!name) { overflow(f); return; }                         // too many changes at once: walk again (now and then)
      const n = name.toString();
      // The watched folder itself was renamed or deleted (Windows then reports its full path).
      if (path.isAbsolute(n) || n.startsWith('\\\\?\\')) { setTimeout(checkOffline, 500); return; }
      const d = path.dirname(path.join(f, n));
      // 1.0.9: a change in a part never indexed (AppData, Program Files, .git…) is not ours to read. With a whole drive
      // watched, a browser's cache and Temp change all the time: reading them kept PixHaven busy and "Not Responding".
      if (inSkipped(d, f, getSettings().library.showSystem)) return;
      dirty.add(d);
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

/**
 * Windows lost track (too many changes at once). 1.1.2: a whole system drive does this all the time, and walking all
 * of it again took up to 10 minutes of disk and CPU every 15 minutes (the fans ran while PixHaven was open). Now only
 * the folders that hold photos or videos are read again (seconds), at most every 2 minutes; a full walk, for new
 * folders Windows' report missed, waits for the daily pass (plugged in, and nobody using the laptop).
 */
const lastOverflow = new Map<string, number>();
const needsFull = new Set<string>();
function overflow(f: string): void {
  needsFull.add(key(f));
  const t = lastOverflow.get(key(f)) ?? 0;
  if (Date.now() - t < 2 * 60_000) return;
  lastOverflow.set(key(f), Date.now());
  const dirs = idx().mediaDirs(f);
  log('info', `Many changes at once in ${f}: checking the ${dirs.length} folder(s) with photos and videos again`);
  for (const d of dirs) dirty.add(d);
  dirty.add(f);
  if (dirtyTimer) clearTimeout(dirtyTimer);
  dirtyTimer = setTimeout(() => void flushDirty(), 5000);
}
const lastFull = new Map<string, number>();
/** Once a day, when plugged in and the laptop has not been used for 5 minutes: a full walk of what lost track. */
function dailyPass(): void {
  if (!enabled || closing || running || !needsFull.size) return;
  try { if (powerMonitor.isOnBatteryPower() || powerMonitor.getSystemIdleTime() < 300) return; } catch { return; }
  for (const f of folders()) {
    if (!needsFull.has(key(f)) || Date.now() - (lastFull.get(key(f)) ?? 0) < 24 * 3600_000) continue;
    needsFull.delete(key(f)); lastFull.set(key(f), Date.now());
    log('info', `Daily check of ${f} (idle and plugged in)`);
    fullScan.add(f);
  }
  void pump();
}

async function flushDirty(): Promise<void> {
  dirtyTimer = null;
  if (!enabled) { dirty.clear(); return; }
  const list = [...dirty];
  dirty.clear();
  // Re-read each changed folder once; a folder whose parent is also listed is covered by the parent's re-read only
  // when it is new or gone, so each one is read on its own.
  const all: DirChange = { added: [], removed: [] };
  const seen = new Set<string>();
  for (const d of list) {
    if (closing) return;                                  // quitting: the index is being closed
    if (seen.has(key(d))) continue;
    seen.add(key(d));
    const root = folders().find(f => isInside(d, f));
    if (!root || inSkipped(d, root, getSettings().library.showSystem)) continue;
    try {
      const c = await idx().rescanDir(d, getSettings().library.showSystem);
      for (const a of c.added) all.added.push(a);          // (not push(...): a huge list overflows the call stack)
      for (const p of c.removed) all.removed.push(p);
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
    if (!enabled) continue;
    if (r.offline && there) {             // drive plugged back in
      ix.setOffline(r.id, false);
      fullScan.add(f);
      startWatch(f);
      void pump();
    } else if (!r.offline && !there) {
      ix.setOffline(r.id, true);
      watchers.get(key(f))?.close(); watchers.delete(key(f));
    } else if (enabled && !live.get(key(f)) && there && r.last_scan && Date.now() - r.last_scan > 15 * 60_000) {
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

/** 1.1.0 Duplicate videos: every video in the watched folders. */
export const allVideos = (): MediaEntry[] => idx().query({ kind: 'video' }).items;
