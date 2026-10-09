// Labels, star ratings and playback positions (v2.0 Phase C; photos too since v2.1) in library.db, plus playlists
// (saved filters, v2.1). Nothing is written into the user's files unless TAG-08 is switched on (see xmp.ts); the
// "written" column remembers which labels were last written into a file, so only those are ever taken out again.
// Each tagged file keeps a quick fingerprint (size + first and last MB), so its labels follow it when it is renamed or
// moved outside the app, and survive export → import on another computer with different folders. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ImportResult, LabelInfo, MediaTags, Playlist, RecentVideo, TagFilter } from '../../shared/types';
import { LABEL_COLORS } from '../../shared/types';

const IS_WIN = process.platform === 'win32';
const CI = IS_WIN ? 'COLLATE NOCASE' : '';
const MB = 1024 * 1024;

export interface FileRef { path: string; size: number; mtime: number }
export interface MediaRow { id: number; path: string; name: string; size: number; mtime: number; stars: number; labels: number[] }

/** Exported file format (JSON). CSV carries the same media fields, labels joined with "; ". */
export interface ExportData {
  app: 'PixHaven' | 'ClearUp'; kind: 'labels'; version: 1; exported: string;   // files exported before the rename say ClearUp
  labels: { name: string; color: string | null }[];
  media: { path: string; name: string; size: number; fingerprint: string; stars: number; labels: string[] }[];
  playlists?: { name: string; labels: string[]; mode: 'all' | 'any'; minStars: number }[];   // v2.1
}

export async function quickFingerprint(file: string, size: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const h = crypto.createHash('sha1').update(String(size));
    const head = Buffer.alloc(Math.min(MB, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > MB) {
      const tail = Buffer.alloc(Math.min(MB, size - MB));
      await fh.read(tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
    return h.digest('hex');
  } finally { await fh.close(); }
}

const exists = async (p: string) => { try { return (await fs.promises.stat(p)).isFile(); } catch { return false; } };

export class TagStore {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS media (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE ${CI}, dir TEXT NOT NULL ${CI}, name TEXT NOT NULL,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL, fingerprint TEXT NOT NULL,
        stars INTEGER NOT NULL DEFAULT 0, added INTEGER NOT NULL, updated INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_dir ON media(dir);
      CREATE INDEX IF NOT EXISTS media_size ON media(size);
      CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_labels (
        media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
        PRIMARY KEY (media_id, label_id)
      );
      CREATE INDEX IF NOT EXISTS media_labels_label ON media_labels(label_id);
      CREATE TABLE IF NOT EXISTS playback (
        path TEXT PRIMARY KEY ${CI}, position REAL NOT NULL, duration REAL NOT NULL, updated INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, filter TEXT NOT NULL, created INTEGER NOT NULL);`);
    // v2.1: labels last written into the file (TAG-08), as a JSON list of names; null = never written.
    const cols = (this.db.prepare('PRAGMA table_info(media)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('written')) this.db.exec('ALTER TABLE media ADD COLUMN written TEXT');
  }

  close(): void { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- labels (TAG-01, TAG-02) ----------

  labels(): LabelInfo[] {
    return this.db.prepare(`SELECT l.id, l.name, l.color, COUNT(ml.media_id) AS count FROM labels l
      LEFT JOIN media_labels ml ON ml.label_id = l.id GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).all() as unknown as LabelInfo[];
  }

  /** Id of the label with this name (any case), created if new. */
  labelId(name: string, color: string | null = null): number {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) throw new Error('A label needs a name.');
    const row = this.db.prepare('SELECT id FROM labels WHERE name = ?').get(clean) as { id: number } | undefined;
    if (row) return row.id;
    // New labels take the next colour of the palette, so chips are easy to tell apart.
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n;
    return Number(this.db.prepare('INSERT INTO labels (name, color, created) VALUES (?, ?, ?)').run(clean, color ?? LABEL_COLORS[n % LABEL_COLORS.length], Date.now()).lastInsertRowid);
  }

  /** Renaming onto an existing name merges the two labels. */
  renameLabel(id: number, name: string): { mergedInto: number | null } {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60);
    if (!clean) throw new Error('A label needs a name.');
    const other = this.db.prepare('SELECT id FROM labels WHERE name = ? AND id <> ?').get(clean, id) as { id: number } | undefined;
    if (!other) { this.db.prepare('UPDATE labels SET name = ? WHERE id = ?').run(clean, id); return { mergedInto: null }; }
    this.tx(() => {
      this.db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) SELECT media_id, ? FROM media_labels WHERE label_id = ?').run(other.id, id);
      this.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
      this.playlistLabel(id, other.id);
    });
    return { mergedInto: other.id };
  }

  setColor(id: number, color: string | null): void { this.db.prepare('UPDATE labels SET color = ? WHERE id = ?').run(color, id); }

  deleteLabel(id: number): void {
    this.tx(() => {
      const ids = (this.db.prepare('SELECT media_id FROM media_labels WHERE label_id = ?').all(id) as { media_id: number }[]).map(r => r.media_id);
      this.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
      this.playlistLabel(id, null);
      this.prune(ids);
    });
  }

  // ---------- files ----------

  private rowByPath(p: string) { return this.db.prepare('SELECT id, size FROM media WHERE path = ?').get(p) as { id: number; size: number } | undefined; }

  /** The media row for a file, created (with its fingerprint) the first time it gets a label or stars. */
  private async ensure(f: FileRef): Promise<number> {
    const row = this.rowByPath(f.path);
    if (row && row.size === f.size) return row.id;
    const fp = await quickFingerprint(f.path, f.size);
    const now = Date.now();
    if (row) {   // same path, file replaced: keep the tags, refresh the fingerprint
      this.db.prepare('UPDATE media SET size = ?, mtime = ?, fingerprint = ?, updated = ? WHERE id = ?').run(f.size, Math.floor(f.mtime), fp, now, row.id);
      return row.id;
    }
    return Number(this.db.prepare(`INSERT INTO media (path, dir, name, size, mtime, fingerprint, stars, added, updated)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(f.path, path.dirname(f.path), path.basename(f.path), f.size, Math.floor(f.mtime), fp, now, now).lastInsertRowid);
  }

  /** Rows with neither stars nor labels are dropped (their files are no longer "tagged"). */
  private prune(ids: number[]): void {
    const gone = this.db.prepare('SELECT path, written FROM media WHERE id = ? AND stars = 0 AND NOT EXISTS (SELECT 1 FROM media_labels WHERE media_id = ?)');
    const del = this.db.prepare('DELETE FROM media WHERE id = ?');
    for (const id of ids) {
      const r = gone.get(id, id) as { path: string; written: string | null } | undefined;
      if (!r) continue;
      if (r.written && r.written !== '[]') this.pendingClean.set(r.path, JSON.parse(r.written));
      del.run(id);
    }
  }

  tagsFor(paths: string[]): Record<string, MediaTags> {
    const out: Record<string, MediaTags> = {};
    const one = this.db.prepare('SELECT id, stars FROM media WHERE path = ?');
    const labs = this.db.prepare('SELECT label_id FROM media_labels WHERE media_id = ? ORDER BY label_id');
    for (const p of paths) {
      const r = one.get(p) as { id: number; stars: number } | undefined;
      if (r) out[p] = { stars: r.stars, labels: (labs.all(r.id) as { label_id: number }[]).map(x => x.label_id) };
    }
    return out;
  }

  /** TAG-03 / TAG-04: stars (0–5, 0 = not rated) for one or many files. */
  async setStars(files: FileRef[], stars: number): Promise<void> {
    const s = Math.max(0, Math.min(5, Math.round(stars)));
    const ids: number[] = [];
    for (const f of files) {
      if (s === 0 && !this.rowByPath(f.path)) continue;
      ids.push(await this.ensure(f));
    }
    this.tx(() => {
      const up = this.db.prepare('UPDATE media SET stars = ?, updated = ? WHERE id = ?');
      for (const id of ids) up.run(s, Date.now(), id);
      if (s === 0) this.prune(ids);
    });
  }

  async addLabel(files: FileRef[], name: string, color: string | null = null): Promise<number> {
    const label = this.labelId(name, color);
    const ids: number[] = [];
    for (const f of files) ids.push(await this.ensure(f));
    this.tx(() => {
      const add = this.db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) VALUES (?, ?)');
      for (const id of ids) add.run(id, label);
    });
    return label;
  }

  removeLabel(paths: string[], label: number): void {
    this.tx(() => {
      const ids: number[] = [];
      for (const p of paths) { const r = this.rowByPath(p); if (r) ids.push(r.id); }
      const del = this.db.prepare('DELETE FROM media_labels WHERE media_id = ? AND label_id = ?');
      for (const id of ids) del.run(id, label);
      this.prune(ids);
    });
  }

  /** TAG-05: tagged files matching the labels (all of / any of) and minimum stars, newest change first. */
  query(f: TagFilter, text = ''): MediaRow[] {
    const where = ['m.stars >= ?'];
    const args: (number | string)[] = [f.minStars];
    if (f.labels.length) {
      const marks = f.labels.map(() => '?').join(',');
      where.push(f.mode === 'any'
        ? `EXISTS (SELECT 1 FROM media_labels ml WHERE ml.media_id = m.id AND ml.label_id IN (${marks}))`
        : `(SELECT COUNT(*) FROM media_labels ml WHERE ml.media_id = m.id AND ml.label_id IN (${marks})) = ${f.labels.length}`);
      args.push(...f.labels);
    }
    for (const w of text.toLowerCase().split(/\s+/).filter(Boolean)) {
      // Name or any label name contains the word.
      where.push(`(m.name LIKE ? OR EXISTS (SELECT 1 FROM media_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.media_id = m.id AND l.name LIKE ?))`);
      args.push(`%${w}%`, `%${w}%`);
    }
    const rows = this.db.prepare(`SELECT m.id, m.path, m.name, m.size, m.mtime, m.stars FROM media m WHERE ${where.join(' AND ')} ORDER BY m.updated DESC`)
      .all(...args) as unknown as Omit<MediaRow, 'labels'>[];
    const labs = this.db.prepare('SELECT label_id FROM media_labels WHERE media_id = ? ORDER BY label_id');
    return rows.map(r => ({ ...r, labels: (labs.all(r.id) as { label_id: number }[]).map(x => x.label_id) }));
  }

  /** TAG-06: a file renamed or moved by the app keeps its labels, stars and playback position. */
  moved(from: string, to: string): void {
    this.tx(() => {
      this.db.prepare('UPDATE media SET path = ?, dir = ?, name = ?, updated = ? WHERE path = ?').run(to, path.dirname(to), path.basename(to), Date.now(), from);
      this.db.prepare('UPDATE OR REPLACE playback SET path = ? WHERE path = ?').run(to, from);
    });
  }

  /**
   * Renamed or moved outside the app (or imported from another computer): a file we have no row for, whose size and
   * fingerprint match a row whose own path no longer exists, takes over that row. Returns the files re-linked.
   */
  async relink(files: FileRef[]): Promise<string[]> {
    const done: string[] = [];
    const bySize = this.db.prepare('SELECT id, path, fingerprint FROM media WHERE size = ?');
    for (const f of files) {
      if (this.rowByPath(f.path)) continue;
      const cands = bySize.all(f.size) as { id: number; path: string; fingerprint: string }[];
      if (!cands.length) continue;
      let fp: string | null = null;
      for (const c of cands) {
        if (await exists(c.path)) continue;                 // still there: a copy, not a move
        fp ??= await quickFingerprint(f.path, f.size).catch(() => '');
        if (fp && fp === c.fingerprint) { this.moved(c.path, f.path); done.push(f.path); break; }
      }
    }
    return done;
  }

  /** Rows whose files are missing right now (unplugged drive, moved away, or imported and not found yet). */
  missingCount(): number {
    let n = 0;
    for (const r of this.db.prepare('SELECT path FROM media').all() as { path: string }[]) if (!fs.existsSync(r.path)) n++;
    return n;
  }

  /** Tagged rows whose file is not at its path now (moved, renamed, imported and not found yet). */
  missingRows(): { path: string; size: number; fingerprint: string }[] {
    return (this.db.prepare('SELECT path, size, fingerprint FROM media').all() as { path: string; size: number; fingerprint: string }[])
      .filter(r => r.path.startsWith('missing:') || !fs.existsSync(r.path));
  }

  /** Has this file got a row (labels or stars)? */
  isTagged(p: string): boolean { return !!this.rowByPath(p); }
  allPaths(): string[] { return (this.db.prepare('SELECT path FROM media').all() as { path: string }[]).map(r => r.path).filter(p => !p.startsWith('missing:')); }
  pathsWithLabel(id: number): string[] {
    return (this.db.prepare('SELECT m.path FROM media m JOIN media_labels ml ON ml.media_id = m.id WHERE ml.label_id = ?').all(id) as { path: string }[]).map(r => r.path);
  }

  // ---------- writing into files (TAG-08) ----------

  /** What should be in the file now, and which labels were written into it last time. */
  writeState(p: string): { stars: number; labels: string[]; previous: string[] } {
    const r = this.db.prepare('SELECT id, stars, written FROM media WHERE path = ?').get(p) as { id: number; stars: number; written: string | null } | undefined;
    const labels = r ? (this.db.prepare('SELECT l.name FROM media_labels ml JOIN labels l ON l.id = ml.label_id WHERE ml.media_id = ? ORDER BY l.name').all(r.id) as { name: string }[]).map(x => x.name) : [];
    const previous = r?.written ? JSON.parse(r.written) as string[] : (this.pendingClean.get(p) ?? []);
    return { stars: r?.stars ?? 0, labels, previous };
  }
  /** Labels written into a file whose row was dropped (all labels and stars taken off): the file still gets cleaned. */
  private pendingClean = new Map<string, string[]>();

  /** After ExifTool changed the file: new size and fingerprint (so it is still recognised), and what it now holds. */
  async written(p: string, labels: string[]): Promise<void> {
    this.pendingClean.delete(p);
    const row = this.rowByPath(p);
    if (!row) return;
    const st = await fs.promises.stat(p).catch(() => null);
    const fp = st ? await quickFingerprint(p, st.size).catch(() => null) : null;
    if (st && fp) this.db.prepare('UPDATE media SET size = ?, mtime = ?, fingerprint = ?, written = ? WHERE id = ?').run(st.size, Math.floor(st.mtimeMs), fp, JSON.stringify(labels), row.id);
    else this.db.prepare('UPDATE media SET written = ? WHERE id = ?').run(JSON.stringify(labels), row.id);
  }

  // ---------- playlists: saved filters (PLAY-08) ----------

  playlists(): Playlist[] {
    return (this.db.prepare('SELECT id, name, filter, created FROM playlists ORDER BY name COLLATE NOCASE').all() as { id: number; name: string; filter: string; created: number }[])
      .map(r => ({ id: r.id, name: r.name, created: r.created, filter: JSON.parse(r.filter) as TagFilter }));
  }
  savePlaylist(name: string, filter: TagFilter, id?: number): number {
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!clean) throw new Error('A playlist needs a name.');
    const f = JSON.stringify({ labels: filter.labels, mode: filter.mode, minStars: filter.minStars });
    const other = this.db.prepare('SELECT id FROM playlists WHERE name = ?').get(clean) as { id: number } | undefined;
    if (id !== undefined) {
      if (other && other.id !== id) throw new Error(`There is already a playlist called "${clean}".`);
      this.db.prepare('UPDATE playlists SET name = ?, filter = ? WHERE id = ?').run(clean, f, id);
      return id;
    }
    if (other) { this.db.prepare('UPDATE playlists SET filter = ? WHERE id = ?').run(f, other.id); return other.id; }
    return Number(this.db.prepare('INSERT INTO playlists (name, filter, created) VALUES (?, ?, ?)').run(clean, f, Date.now()).lastInsertRowid);
  }
  /** A label merged into another (or deleted): playlists follow. */
  private playlistLabel(from: number, to: number | null): void {
    for (const p of this.playlists()) {
      if (!p.filter.labels.includes(from)) continue;
      const labels = [...new Set(p.filter.labels.map(l => (l === from ? to : l)).filter((l): l is number => l !== null))];
      this.db.prepare('UPDATE playlists SET filter = ? WHERE id = ?').run(JSON.stringify({ ...p.filter, labels }), p.id);
    }
  }
  deletePlaylist(id: number): void { this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id); }

  // ---------- playback positions (PLAY-05) ----------

  position(p: string): number | null {
    return (this.db.prepare('SELECT position FROM playback WHERE path = ?').get(p) as { position: number } | undefined)?.position ?? null;
  }
  savePosition(p: string, position: number, duration: number): void {
    this.db.prepare('INSERT OR REPLACE INTO playback (path, position, duration, updated) VALUES (?, ?, ?, ?)').run(p, position, duration, Date.now());
  }
  recent(limit: number): Omit<RecentVideo, 'size' | 'mtime'>[] {
    return this.db.prepare('SELECT path, position, duration, updated FROM playback ORDER BY updated DESC LIMIT ?').all(limit) as unknown as RecentVideo[];
  }

  // ---------- export / import (TAG-07) and backups ----------

  exportData(): ExportData {
    const labels = this.db.prepare('SELECT id, name, color FROM labels ORDER BY name').all() as { id: number; name: string; color: string | null }[];
    const names = new Map(labels.map(l => [l.id, l.name]));
    const rows = this.db.prepare('SELECT id, path, name, size, fingerprint, stars FROM media ORDER BY path').all() as { id: number; path: string; name: string; size: number; fingerprint: string; stars: number }[];
    const labs = this.db.prepare('SELECT label_id FROM media_labels WHERE media_id = ?');
    return {
      app: 'PixHaven', kind: 'labels', version: 1, exported: new Date().toISOString(),
      labels: labels.map(l => ({ name: l.name, color: l.color })),
      playlists: this.playlists().map(p => ({ name: p.name, mode: p.filter.mode, minStars: p.filter.minStars, labels: p.filter.labels.map(id => names.get(id)!).filter(Boolean) })),
      media: rows.map(r => ({ path: r.path, name: r.name, size: r.size, fingerprint: r.fingerprint, stars: r.stars,
        labels: (labs.all(r.id) as { label_id: number }[]).map(x => names.get(x.label_id)!).filter(Boolean) })),
    };
  }

  /**
   * Merges an export into this library. Each file is matched by fingerprint (a file this library already has, wherever
   * it is now), else by its old path if that file is here and identical; otherwise it is kept and linked as soon as a
   * matching file turns up while browsing (relink). Labels are added; imported stars win when set.
   */
  async importData(data: ExportData): Promise<ImportResult> {
    if ((data?.app !== 'PixHaven' && data?.app !== 'ClearUp') || data.kind !== 'labels' || !Array.isArray(data.media)) throw new Error('This is not a PixHaven labels file.');
    const res: ImportResult = { labels: 0, applied: 0, waiting: 0, skipped: 0 };
    const before = (this.db.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n;
    for (const l of data.labels ?? []) { const id = this.labelId(l.name, l.color ?? null); if (l.color) this.db.prepare('UPDATE labels SET color = COALESCE(color, ?) WHERE id = ?').run(l.color, id); }
    for (const m of data.media) {
      if (!m || typeof m.path !== 'string' || !m.fingerprint || !(m.size >= 0)) { res.skipped++; continue; }
      let id = (this.db.prepare('SELECT id, path FROM media WHERE fingerprint = ? AND size = ?').all(m.fingerprint, m.size) as { id: number; path: string }[])
        .sort((a, b) => Number(path.basename(b.path) === m.name) - Number(path.basename(a.path) === m.name))[0]?.id;
      let here = id !== undefined;
      if (id === undefined) {
        const st = await fs.promises.stat(m.path).catch(() => null);
        const same = st?.isFile() && st.size === m.size && (await quickFingerprint(m.path, m.size).catch(() => '')) === m.fingerprint;
        // A different file sits at the old path here: park the entry under a path that can't exist, so only the
        // real file (same fingerprint) picks it up later.
        const at = same || !st ? m.path : `missing:${m.fingerprint}/${m.name || path.basename(m.path)}`;
        if (this.rowByPath(at)) { res.skipped++; continue; }
        const now = Date.now();
        id = Number(this.db.prepare(`INSERT INTO media (path, dir, name, size, mtime, fingerprint, stars, added, updated) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`)
          .run(at, path.dirname(at), m.name || path.basename(m.path), m.size, Math.floor(st?.mtimeMs ?? 0), m.fingerprint, now, now).lastInsertRowid);
        here = !!same;
      } else here = await exists((this.db.prepare('SELECT path FROM media WHERE id = ?').get(id) as { path: string }).path);
      if (m.stars > 0) this.db.prepare('UPDATE media SET stars = ?, updated = ? WHERE id = ?').run(Math.min(5, Math.round(m.stars)), Date.now(), id);
      for (const name of m.labels ?? []) if (name?.trim()) this.db.prepare('INSERT OR IGNORE INTO media_labels (media_id, label_id) VALUES (?, ?)').run(id, this.labelId(name));
      this.prune([id]);
      if (here) res.applied++; else res.waiting++;
    }
    for (const p of data.playlists ?? []) {
      if (!p?.name) continue;
      try { this.savePlaylist(p.name, { labels: (p.labels ?? []).filter(Boolean).map(n => this.labelId(n)), mode: p.mode === 'any' ? 'any' : 'all', minStars: Number(p.minStars) || 0 }); } catch { /* bad entry */ }
    }
    res.labels = (this.db.prepare('SELECT COUNT(*) AS n FROM labels').get() as { n: number }).n - before;
    return res;
  }

  /** A consistent copy of the whole database (safe while it is in use). */
  backupTo(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }
}

// ---------- CSV ----------

const csvCell = (v: string | number) => { const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function toCsv(d: ExportData): string {
  const lines = [['path', 'name', 'size', 'fingerprint', 'stars', 'labels'].join(',')];
  for (const m of d.media) lines.push([m.path, m.name, m.size, m.fingerprint, m.stars, m.labels.join('; ')].map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';    // BOM: Excel opens UTF-8 names correctly
}

export function fromCsv(text: string): ExportData {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift()?.map(h => h.trim().toLowerCase()) ?? [];
  const col = (n: string) => head.indexOf(n);
  if (col('path') < 0 || col('fingerprint') < 0) throw new Error('This CSV file has no "path" and "fingerprint" columns.');
  const media = rows.filter(r => r.length > 1 && r[col('path')]).map(r => ({
    path: r[col('path')], name: r[col('name')] ?? path.basename(r[col('path')]), size: Number(r[col('size')] ?? 0),
    fingerprint: r[col('fingerprint')], stars: Number(r[col('stars')] ?? 0) || 0,
    labels: (r[col('labels')] ?? '').split(';').map(x => x.trim()).filter(Boolean),
  }));
  const names = [...new Set(media.flatMap(m => m.labels))];
  return { app: 'PixHaven', kind: 'labels', version: 1, exported: '', labels: names.map(name => ({ name, color: null })), media };
}
