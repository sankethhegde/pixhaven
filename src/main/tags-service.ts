// Labels and stars (v2.0 Phase C; photos too since v2.1): library.db location, daily backups, export/import, renaming
// or moving files inside the app (their labels follow), playlists (saved filters), re-linking files moved outside the
// app, and — when switched on — writing stars and labels into the files themselves (TAG-08).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { BackupInfo, FileWriteStatus, ImportResult, LabelInfo, MediaTags, Playlist, TaggedMedia, TagFilter } from '@shared/types';
import { mediaKind } from '@shared/types';
import { getSettings, updateSettings } from './settings';
import { log } from './logger';
import { resourcesDir } from './engine';
import { TagStore, fromCsv, quickFingerprint, toCsv, type ExportData, type FileRef } from './library/tags';
import { writeTags, writeTarget } from './library/xmp';

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

/** Tags for the files in view, after re-linking any that were renamed or moved outside the app. */
export async function forFiles(files: FileRef[]): Promise<{ tags: Record<string, MediaTags>; relinked: string[] }> {
  const m = media(files);
  const relinked = await tagStore().relink(m).catch(e => { log('warn', 'Re-linking failed', e); return [] as string[]; });
  return { tags: tagStore().tagsFor(m.map(f => f.path)), relinked };
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
      moved.push({ from, to });
    } catch (e) { failed.push({ path: from, reason: (e as Error).message }); }
  }
  log('info', `Moved ${moved.length} file(s) to ${dest}, ${failed.length} failed`);
  return { moved, failed };
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
export const writeStatus = (): FileWriteStatus => ({ ...writeStats, pending: toWrite.size });

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
    for (const p of now) toWrite.delete(p);
    const s = tagStore();
    const jobs = now.filter(p => fs.existsSync(p)).map(p => ({ file: p, ...s.writeState(p) }));
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
    if (toWrite.size && !writeTimer) writeTimer = setTimeout(() => void flushWrites(), [...toWrite].every(p => isBusy(p)) ? 10_000 : 500);
    onWriteStatus(writeStatus());
  }
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

export function close(): void { store?.close(); store = null; }
