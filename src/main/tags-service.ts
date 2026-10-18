// Labels and stars (v2.0 Phase C; photos too since v2.1): library.db location, daily backups, export/import, renaming
// or moving files inside the app (their labels follow), playlists (saved filters), re-linking files moved outside the
// app, and — when switched on — writing stars and labels into the files themselves (TAG-08). v2.2: what the files hold
// is read back too (from PixHaven on another computer, Explorer, Lightroom…), so labels travel with the files.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { app } from 'electron';
import type { BackupInfo, FileWriteStatus, ImportResult, LabelInfo, MediaTags, Playlist, TaggedMedia, TagFilter } from '@shared/types';
import { mediaKind } from '@shared/types';
import { getSettings, updateSettings } from './settings';
import { log } from './logger';
import { resourcesDir } from './engine';
import { TagStore, fromCsv, quickFingerprint, toCsv, type ExportData, type FileRef } from './library/tags';
import { writeTags, writeTarget } from './library/xmp';
import { TagReader } from './library/file-tags';
import { manifestRootOf, movedFile as manifestMoved, remapManifest } from './sorter/people-manifest';
import { syncGroupLinksFor } from './group-links';
import * as fileOps from './library/file-ops';

const KEEP_BACKUPS = 7;
let store: TagStore | null = null;

export const defaultDbPath = () => path.join(app.getPath('userData'), 'library.db');
export const dbPath = () => getSettings().library.dbPath ?? defaultDbPath();
const backupDir = () => path.join(app.getPath('userData'), 'backups');

export function tagStore(): TagStore {
  if (!store) {
    store = new TagStore(dbPath());
    migrateOldPlayback(store);
  }
  return store;
}

/** Phase B kept playback positions in the thumbnail cache's database; move them over once. */
function migrateOldPlayback(s: TagStore): void {
  const old = path.join(app.getPath('userData'), 'library', 'library.db');
  if (!fs.existsSync(old)) return;
  try {
    s.db.exec(`ATTACH DATABASE '${old.replace(/'/g, "''")}' AS old`);
    try { s.db.exec('INSERT OR IGNORE INTO playback SELECT path, position, duration, updated FROM old.playback'); } catch { /* none */ }
    s.db.exec('DETACH DATABASE old');
    for (const f of [old, old + '-wal', old + '-shm']) fs.rmSync(f, { force: true });
    log('info', 'Moved playback positions into library.db');
  } catch (e) { log('warn', 'Could not move old playback positions', e); }
}

/** Photos and videos (v2.1: TAG-09 — the same labels and stars for images). */
const media = (files: FileRef[]) => files.filter(f => mediaKind(f.path));
const result = (paths: string[]) => ({ tags: tagStore().tagsFor(paths), labels: tagStore().labels() });

export const labels = (): LabelInfo[] => tagStore().labels();

/** Tags for the files in view, after re-linking any that were renamed or moved outside the app. What the files
 * themselves hold is read in the background; changes arrive through the "from files" event. */
export async function forFiles(files: FileRef[]): Promise<{ tags: Record<string, MediaTags>; relinked: string[] }> {
  const m = media(files);
  const relinked = await tagStore().relink(m).catch(e => { log('warn', 'Re-linking failed', e); return [] as string[]; });
  void readFolders(m);
  return { tags: tagStore().tagsFor(m.map(f => f.path)), relinked };
}

// ---------- reading what the files hold (v2.2) ----------

let reader: TagReader | null = null;
const fileReader = () => (reader ??= new TagReader(exiftoolPath()));
let onFromFiles: (paths: string[]) => void = () => {};
export const setOnFromFiles = (fn: (paths: string[]) => void) => { onFromFiles = fn; };
const reading = new Set<string>();

/** A folder's files are read when its listing changed since last time; tagged files also when they changed. */
async function readFolders(files: FileRef[]): Promise<void> {
  const byDir = new Map<string, FileRef[]>();
  for (const f of files) { const d = path.dirname(f.path); byDir.set(d, [...(byDir.get(d) ?? []), f]); }
  for (const [dir, list] of byDir) {
    const k = dir.toLowerCase();
    if (reading.has(k)) continue;
    reading.add(k);
    try {
      const sig = crypto.createHash('sha1').update(list.map(f => `${f.path}|${f.size}|${Math.floor(f.mtime)}`).sort().join('|')).digest('hex');
      const s = tagStore();
      const todo = s.dirRead(dir) === sig ? list.filter(f => s.isTagged(f.path) && s.needsRead([f]).length) : s.needsRead(list);
      await syncFromFiles(todo);
      s.setDirRead(dir, sig);
    } catch (e) { log('warn', `Could not read labels from files in ${dir}`, e); }
    finally { reading.delete(k); }
  }
}

/** Reads and merges a batch of files (also used by watched folders). Returns the files whose labels or stars changed. */
export async function syncFromFiles(files: FileRef[]): Promise<string[]> {
  const changed: string[] = [];
  const behind: string[] = [];
  for (let i = 0; i < files.length; i += 200) {
    const part = files.slice(i, i + 200).filter(f => !f.path.startsWith('missing:'));
    if (!part.length) continue;
    const got = await fileReader().read(part.map(f => f.path));
    for (const f of part) {
      const ft = got.get(f.path);
      if (!ft) continue;
      const r = await tagStore().mergeFromFile(f, ft).catch(e => { log('warn', `Could not merge labels of ${f.path}`, e); return null; });
      if (r?.changed) changed.push(f.path);
      if (r?.behind) behind.push(f.path);
    }
  }
  if (changed.length) { log('info', `Took labels or stars from ${changed.length} file(s)`); onFromFiles(changed); }
  if (behind.length) queueWrite(behind);     // the file catches up with labels added in the app
  return changed;
}

/** People named inside a photo (PixHaven's Sort by person, Lightroom, digiKam, Windows Photo Gallery…). */
export async function peopleIn(file: string): Promise<string[]> {
  return (await fileReader().read([file]).catch(() => new Map())).get(file)?.people ?? [];
}

export async function setStars(files: FileRef[], stars: number) {
  await tagStore().setStars(media(files), stars);
  queueWrite(files.map(f => f.path));
  return result(files.map(f => f.path));
}
export async function addLabel(files: FileRef[], name: string, color: string | null) {
  await tagStore().addLabel(media(files), name, color);
  queueWrite(files.map(f => f.path));
  return result(files.map(f => f.path));
}
export function removeLabel(paths: string[], label: number) {
  tagStore().removeLabel(paths, label);
  queueWrite(paths);
  return result(paths);
}
export function renameLabel(id: number, name: string) {
  const affected = tagStore().pathsWithLabel(id);
  const r = tagStore().renameLabel(id, name);
  queueWrite(affected);
  return { ...r, labels: labels() };
}
export function setColor(id: number, color: string | null) { tagStore().setColor(id, color); return labels(); }
export function deleteLabel(id: number) {
  const affected = tagStore().pathsWithLabel(id);
  tagStore().deleteLabel(id);
  queueWrite(affected);
  return labels();
}

/** TAG-05 across the whole library. Files on a drive that is not connected come back as offline. */
export async function query(filter: TagFilter, text: string): Promise<TaggedMedia[]> {
  const rows = tagStore().query(filter, text).filter(r => !r.path.startsWith('missing:'));
  const out: TaggedMedia[] = [];
  for (let i = 0; i < rows.length; i += 64) {
    const part = rows.slice(i, i + 64);
    const st = await Promise.all(part.map(r => Promise.race([
      fs.promises.stat(r.path).then(s => s.isFile() ? s : null, () => null),
      new Promise<null>(res => setTimeout(() => res(null), 1500)),    // unreachable network drive
    ])));
    part.forEach((r, j) => out.push({
      name: r.name, path: r.path, kind: mediaKind(r.path) ?? 'video', size: st[j]?.size ?? r.size, mtime: st[j]?.mtimeMs ?? r.mtime,
      stars: r.stars, labels: r.labels, offline: !st[j],
    }));
  }
  return out;
}

// ---------- playlists: saved filters (PLAY-08) ----------

export const playlists = (): Playlist[] => tagStore().playlists();
export function savePlaylist(name: string, filter: TagFilter, id?: number): Playlist[] { tagStore().savePlaylist(name, filter, id); return playlists(); }
export function deletePlaylist(id: number): Playlist[] { tagStore().deletePlaylist(id); return playlists(); }

// ---------- rename and move inside the app (TAG-06: labels follow) ----------

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.+$|[. ]$/;
let onMoved: (from: string, to: string) => void = () => {};
export const setOnMoved = (fn: (from: string, to: string) => void) => { onMoved = fn; };

/** An .xmp sidecar (TAG-08, or from another photo app) travels with its file. */
async function moveSidecar(from: string, to: string): Promise<void> {
  const a = writeTarget(from), b = writeTarget(to);
  if (!a.sidecar || !fs.existsSync(a.target) || fs.existsSync(b.target)) return;
  await fs.promises.rename(a.target, b.target).catch(async e => {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fs.promises.copyFile(a.target, b.target); await fs.promises.rm(a.target);
  }).catch(e => log('warn', `Could not move ${a.target}`, e));
}

export async function renameFile(from: string, newName: string): Promise<string> {
  const name = newName.trim();
  if (!name || BAD_NAME.test(name)) throw new Error('That name has characters Windows does not allow (< > : " / \\ | ? *).');
  if (path.extname(name).toLowerCase() !== path.extname(from).toLowerCase()) throw new Error(`Keep the file type: the name must end in ${path.extname(from)}.`);
  const to = path.join(path.dirname(from), name);
  if (to === from) return to;
  if (to.toLowerCase() !== from.toLowerCase() && fs.existsSync(to)) throw new Error(`There is already a file called "${name}" here.`);
  await fs.promises.rename(from, to);
  tagStore().moved(from, to);
  await moveSidecar(from, to);
  onMoved(from, to);
  try { manifestMoved(from, to); } catch (e) { log('warn', 'Could not update the people list', e); }
  syncGroupLinksFor([from, to]);
  log('info', `Renamed ${from} → ${name}`);
  return to;
}

export async function moveFiles(paths: string[], dest: string): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; reason: string }[] }> {
  const moved: { from: string; to: string }[] = [];
  const failed: { path: string; reason: string }[] = [];
  for (const from of paths) {
    const to = path.join(dest, path.basename(from));
    try {
      if (path.dirname(from).toLowerCase() === dest.toLowerCase()) continue;
      if (fs.existsSync(to)) throw new Error('A file with that name is already there');
      try {
        await fs.promises.rename(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        // Another drive: copy, check, then remove the original.
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        if ((await fs.promises.stat(to)).size !== (await fs.promises.stat(from)).size) { await fs.promises.rm(to, { force: true }); throw new Error('The copy did not match'); }
        await fs.promises.rm(from);
      }
      tagStore().moved(from, to);
      await moveSidecar(from, to);
      onMoved(from, to);
      try { manifestMoved(from, to); } catch (e) { log('warn', 'Could not update the people list', e); }
      moved.push({ from, to });
    } catch (e) { failed.push({ path: from, reason: (e as Error).message }); }
  }
  log('info', `Moved ${moved.length} file(s) to ${dest}, ${failed.length} failed`);
  syncGroupLinksFor([...moved.map(m => m.from), ...moved.map(m => m.to)]);
  return { moved, failed };
}

// ---------- v2.5 Photos tab: copy / cut / paste, new folder, rename folders ----------

const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Files (and maybe a whole folder) moved by the app: labels, the watched-folder index, the people list and the
 * Explorer shortcuts of group photos follow. Face data follows the next time the sorted folder is opened. */
async function followMoves(pairs: { from: string; to: string }[], dir?: { from: string; to: string }): Promise<void> {
  const s = tagStore();
  for (const m of pairs) { try { s.moved(m.from, m.to); } catch { /* not labelled */ } onMoved(m.from, m.to); }
  const files = new Map(pairs.map(m => [lower(m.from), m.to]));
  const map = (p: string) => {
    const f = files.get(lower(p));
    if (f) return f;
    if (dir && (lower(p) === lower(dir.from) || lower(p).startsWith(lower(dir.from) + path.sep))) return dir.to + p.slice(dir.from.length);
    return p;
  };
  const ends = [...pairs.flatMap(m => [m.from, m.to]), ...(dir ? [path.join(dir.from, 'x'), path.join(dir.to, 'x')] : [])];
  const roots = new Map<string, string>();
  for (const p of ends) { const r = manifestRootOf(p); if (r) roots.set(lower(r), r); }
  for (const r of roots.values()) { try { remapManifest(r, map); } catch (e) { log('warn', 'Could not update the people list', e); } }
  syncGroupLinksFor(ends);
}

export async function pasteItems(paths: string[], dest: string, mode: 'copy' | 'move'): Promise<fileOps.OpResult> {
  const r = await fileOps.pasteItems(paths, dest, mode, followMoves);
  log('info', `${mode === 'copy' ? 'Copied' : 'Moved'} ${r.done.length} item(s) to ${dest}, ${r.failed.length} failed`);
  return r;
}

export function newFolder(parent: string, name: string): string { return fileOps.newFolder(parent, name); }

/** Rename a file (keeps its type) or a folder. */
export async function renameItem(from: string, name: string): Promise<string> {
  if (fs.statSync(from).isDirectory()) return fileOps.renameFolder(from, name, followMoves);
  return renameFile(from, name);
}

/** After Sort by person: labels follow the moved photos, and photos the people were written into stay recognised. */
export async function afterSort(moves: { from: string; to: string }[], changed: string[]): Promise<void> {
  const s = tagStore();
  for (const m of moves) { s.moved(m.from, m.to); onMoved(m.from, m.to); }
  for (const p of changed) await s.refresh(p);
}

// ---------- re-linking files moved outside the app ----------

/** New files seen in a watched folder: any that are a labelled file moved or renamed take over its labels. */
export async function relinkAdded(files: FileRef[]): Promise<string[]> {
  const m = media(files);
  if (!m.length) return [];
  return tagStore().relink(m).catch(e => { log('warn', 'Re-linking failed', e); return [] as string[]; });
}

/**
 * Labelled files that are not where PixHaven last saw them, looked up in the watched-folder index by size and then
 * fingerprint (also picks up imports from another computer without browsing to their folders).
 */
export async function relinkFromIndex(bySize: (size: number) => FileRef[]): Promise<number> {
  const s = tagStore();
  let n = 0;
  for (const row of s.missingRows()) {
    for (const c of bySize(row.size)) {
      if (s.isTagged(c.path)) continue;
      const fp = await quickFingerprint(c.path, c.size).catch(() => '');
      if (fp === row.fingerprint) { s.moved(row.path, c.path); n++; break; }
    }
  }
  if (n) log('info', `Re-linked ${n} labelled file(s) found in watched folders`);
  return n;
}

// ---------- export / import (TAG-07) ----------

export function exportTo(file: string): number {
  const data = tagStore().exportData();
  fs.writeFileSync(file, file.toLowerCase().endsWith('.csv') ? toCsv(data) : JSON.stringify(data, null, 1));
  return data.media.length;
}

let afterImport: () => void = () => {};
export const setAfterImport = (fn: () => void) => { afterImport = fn; };

export async function importFrom(file: string): Promise<ImportResult> {
  const text = fs.readFileSync(file, 'utf8');
  let data: ExportData;
  if (file.toLowerCase().endsWith('.csv')) data = fromCsv(text);
  else { try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('This file is not a PixHaven labels export.'); } }
  backupNow('before-import');
  const r = await tagStore().importData(data);
  log('info', `Imported labels from ${file}`, r);
  afterImport();
  queueWrite(tagStore().allPaths());
  return r;
}

/** "Find moved files": looks through a folder (and below) for photos and videos whose labels are waiting for them. */
export async function findMoved(dir: string, onProgress?: (n: number) => void): Promise<number> {
  let found = 0, seen = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let list: fs.Dirent[];
    try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
    const refs: FileRef[] = [];
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('$')) stack.push(p);
      else if (e.isFile() && mediaKind(e.name)) {
        const s = await fs.promises.stat(p).catch(() => null);
        if (s) refs.push({ path: p, size: s.size, mtime: s.mtimeMs });
      }
    }
    found += (await tagStore().relink(refs)).length;
    seen += refs.length;
    onProgress?.(seen);
  }
  return found;
}
export const missingCount = () => tagStore().missingCount();

// ---------- writing into the files (TAG-08, optional) ----------

const exiftoolPath = () => process.platform === 'win32'
  ? path.join(resourcesDir(), 'bin', 'win', 'exiftool', 'exiftool.exe')
  : path.join(resourcesDir(), 'bin', 'linux', 'exiftool', 'exiftool');
export const exiftool = exiftoolPath;

const toWrite = new Set<string>();
let writeTimer: NodeJS.Timeout | null = null;
let writing = false;
let writeStats: FileWriteStatus = { pending: 0, written: 0, failed: [] };
let isBusy: (p: string) => boolean = () => false;
let onWriteStatus: (s: FileWriteStatus) => void = () => {};
export function setWriteHooks(busy: (p: string) => boolean, status: (s: FileWriteStatus) => void): void { isBusy = busy; onWriteStatus = status; }
/** Waiting files, and the ones being written right now (they have left the queue but are not in the files yet). */
let inFlight = 0;
export const writeStatus = (): FileWriteStatus => ({ ...writeStats, pending: toWrite.size + inFlight });

/** Changes are collected for a moment (stars clicked a few times in a row become one write). */
export function queueWrite(paths: string[], force = false): void {
  if (!getSettings().library.writeToFiles && !force) return;
  for (const p of paths) if (mediaKind(p) && !p.startsWith('missing:')) toWrite.add(p);
  if (!toWrite.size) return;
  onWriteStatus(writeStatus());
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => void flushWrites(), 1500);
}

async function flushWrites(): Promise<void> {
  if (writing) { writeTimer = setTimeout(() => void flushWrites(), 1000); return; }
  writing = true;
  writeTimer = null;
  try {
    const now = [...toWrite].filter(p => !isBusy(p)).slice(0, 200);    // a file open in the player waits until it closes
    inFlight = now.length;
    for (const p of now) toWrite.delete(p);
    const s = tagStore();
    // Anything another app put into these files since they were last read is merged first, so nothing is lost.
    const refs = now.map(p => { try { const st = fs.statSync(p); return { path: p, size: st.size, mtime: st.mtimeMs }; } catch { return null; } }).filter((r): r is FileRef => !!r);
    const unread = s.needsRead(refs);
    if (unread.length) {
      const got = await fileReader().read(unread.map(f => f.path)).catch(() => new Map());
      const changed: string[] = [];
      for (const f of unread) { const ft = got.get(f.path); if (ft && (await s.mergeFromFile(f, ft)).changed) changed.push(f.path); }
      if (changed.length) onFromFiles(changed);
    }
    const jobs = refs.map(r => r.path).map(p => ({ file: p, ...s.writeState(p) }));
    if (jobs.length) {
      const res = await writeTags(exiftoolPath(), jobs);
      for (const r of res) {
        const j = jobs.find(x => x.file === r.file)!;
        if (r.ok) { await s.written(r.file, j.labels); writeStats.written++; writeStats.failed = writeStats.failed.filter(f => f.path !== r.file); }
        else { writeStats.failed = [{ path: r.file, reason: r.error ?? 'Could not write' }, ...writeStats.failed.filter(f => f.path !== r.file)].slice(0, 20); log('warn', `Could not write labels into ${r.file}: ${r.error}`); }
      }
      log('info', `Wrote stars and labels into ${res.filter(r => r.ok).length} of ${res.length} file(s)`);
    }
  } catch (e) { log('error', 'Writing labels into files failed', e); }
  finally {
    writing = false;
    inFlight = 0;
    if (toWrite.size && !writeTimer) writeTimer = setTimeout(() => void flushWrites(), [...toWrite].every(p => isBusy(p)) ? 10_000 : 500);
    onWriteStatus(writeStatus());
  }
}

/** Before quitting: writes still waiting go into the files now (up to 15 s; the rest is picked up at next start). */
export async function flushNow(): Promise<void> {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const end = Date.now() + 15_000;
  while ((toWrite.size || writing) && Date.now() < end) {
    if (writing) { await new Promise(r => setTimeout(r, 100)); continue; }
    if ([...toWrite].every(p => isBusy(p))) break;
    await flushWrites();
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  }
}
export const hasPendingWrites = () => toWrite.size > 0 || writing;

/** At start: changes the files never got (PixHaven closed before the write ran) are written now. */
export function writeUnwritten(): number {
  if (!getSettings().library.writeToFiles) return 0;
  const paths = tagStore().unwritten().filter(p => fs.existsSync(p));
  queueWrite(paths);
  return paths.length;
}

/** Settings switch. Turning it on writes what is already labelled; turning it off leaves the files as they are. */
export function setWriteToFiles(on: boolean): number {
  updateSettings({ library: { ...getSettings().library, writeToFiles: on } });
  if (!on) { toWrite.clear(); onWriteStatus(writeStatus()); return 0; }
  const all = tagStore().allPaths();
  queueWrite(all);
  return all.length;
}

// ---------- backups (daily, last 7) and location ----------

export function backups(): BackupInfo[] {
  try {
    return fs.readdirSync(backupDir()).filter(f => /^library-.*\.db$/.test(f)).sort().reverse().map(f => {
      const p = path.join(backupDir(), f);
      return { file: p, date: fs.statSync(p).mtime.toISOString(), size: fs.statSync(p).size };
    });
  } catch { return []; }
}

export function backupNow(tag?: string): BackupInfo {
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(backupDir(), `library-${day}${tag ? `-${tag}` : ''}.db`);
  tagStore().backupTo(file);
  // Keep the last 7 daily copies (and the last few "before-…" safety copies).
  const all = backups();
  const daily = all.filter(b => /library-\d{4}-\d{2}-\d{2}\.db$/.test(b.file));
  const safety = all.filter(b => !daily.includes(b));
  for (const b of [...daily.slice(KEEP_BACKUPS), ...safety.slice(3)]) fs.rmSync(b.file, { force: true });
  return { file, date: new Date().toISOString(), size: fs.statSync(file).size };
}

/** Called at start and every few hours: one copy per day. */
export function dailyBackup(): void {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (!fs.existsSync(path.join(backupDir(), `library-${day}.db`)) && tagStore().labels().length + tagStore().query({ labels: [], mode: 'any', minStars: 0 }).length > 0) {
      backupNow();
      log('info', 'Daily backup of library.db made');
    }
  } catch (e) { log('warn', 'Daily backup failed', e); }
}

function reopen(): void { store?.close(); store = null; tagStore(); }

export function restore(file: string): void {
  if (!backups().some(b => b.file === file)) throw new Error('Unknown backup');
  backupNow('before-restore');
  const db = dbPath();
  store?.close(); store = null;
  for (const f of [db + '-wal', db + '-shm']) fs.rmSync(f, { force: true });
  fs.copyFileSync(file, db);
  tagStore();
  log('info', `Restored library.db from ${file}`);
}

/** Settings → "Change location": copy the library there ("move"), or open the one already there ("use"). */
export function setLocation(dir: string, mode: 'move' | 'use'): string {
  const target = path.join(dir, 'library.db');
  if (target.toLowerCase() === dbPath().toLowerCase()) return target;
  if (mode === 'move') {
    if (fs.existsSync(target)) backupNow('before-move');
    tagStore().backupTo(target);
  } else if (!fs.existsSync(target)) throw new Error('There is no PixHaven library in that folder.');
  updateSettings({ library: { ...getSettings().library, dbPath: target === defaultDbPath() ? null : target } });
  reopen();
  log('info', `library.db is now at ${target} (${mode})`);
  return target;
}
export const locationTaken = (dir: string) => fs.existsSync(path.join(dir, 'library.db'));

export function close(): void { store?.close(); store = null; reader?.stop(); reader = null; }
