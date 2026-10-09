// Watched folders (v2.1, LIB-08): a background index of the photos and videos under the folders the user chose, so
// search and filters work without browsing first. index.db is a rebuildable cache (not backed up, not exported).
// A pass walks the folder tree with a queue kept in the database, so a cancelled or interrupted pass resumes where
// it stopped; each pass stamps what it saw with a new generation number, and files left with an older one when the
// pass ends were deleted while PixHaven was not looking. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MediaEntry, MediaKind } from '../../shared/types';
import { mediaKind } from '../../shared/types';
import { skipDir } from './browse';

const IS_WIN = process.platform === 'win32';
const CI = IS_WIN ? 'COLLATE NOCASE' : '';
const same = (a: string, b: string) => (IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

export interface FileRef { path: string; size: number; mtime: number }
export interface RootRow { id: number; path: string; gen: number; scanning: number; last_scan: number | null; offline: number; files: number; pending: number }
export interface DirChange { added: FileRef[]; removed: string[] }
export interface ScanControl {
  signal?: AbortSignal;
  showSystem?: boolean;
  /** Resolves when indexing may go on (it waits here while a video plays). */
  gate?: () => Promise<void>;
  onProgress?: (scanned: number) => void;
  onChange?: (dir: string, c: DirChange) => void | Promise<void>;
}

/** Is `p` the folder `dir` or inside it? */
export function isInside(p: string, dir: string): boolean {
  const d = dir.replace(/[\\/]+$/, '');
  if (same(p, d)) return true;
  const pre = d + path.sep;
  return IS_WIN ? p.toLowerCase().startsWith(pre.toLowerCase()) : p.startsWith(pre);
}

export class MediaIndex {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS roots (
        id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE ${CI}, gen INTEGER NOT NULL DEFAULT 0,
        scanning INTEGER NOT NULL DEFAULT 0, last_scan INTEGER, offline INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY ${CI}, root INTEGER NOT NULL, dir TEXT NOT NULL ${CI}, name TEXT NOT NULL, kind TEXT NOT NULL,
        size INTEGER NOT NULL, mtime INTEGER NOT NULL, gen INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS files_dir ON files(dir);
      CREATE INDEX IF NOT EXISTS files_root ON files(root, gen);
      CREATE INDEX IF NOT EXISTS files_size ON files(size);
      CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY ${CI}, root INTEGER NOT NULL, parent TEXT NOT NULL ${CI}, gen INTEGER NOT NULL) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS dirs_parent ON dirs(parent);
      CREATE TABLE IF NOT EXISTS pending (root INTEGER NOT NULL, dir TEXT NOT NULL ${CI}, PRIMARY KEY (root, dir)) WITHOUT ROWID;`);
  }

  close(): void { this.db.close(); }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  // ---------- roots ----------

  roots(): RootRow[] {
    return this.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM files f WHERE f.root = r.id) AS files,
      (SELECT COUNT(*) FROM pending p WHERE p.root = r.id) AS pending FROM roots r ORDER BY r.path`).all() as unknown as RootRow[];
  }
  root(id: number): RootRow | undefined { return this.roots().find(r => r.id === id); }
  rootOf(p: string): RootRow | undefined { return this.roots().find(r => isInside(p, r.path)); }

  addRoot(dir: string): number {
    const row = this.db.prepare('SELECT id FROM roots WHERE path = ?').get(dir) as { id: number } | undefined;
    if (row) return row.id;
    return Number(this.db.prepare('INSERT INTO roots (path) VALUES (?)').run(dir).lastInsertRowid);
  }

  removeRoot(dir: string): void {
    const row = this.db.prepare('SELECT id FROM roots WHERE path = ?').get(dir) as { id: number } | undefined;
    if (!row) return;
    this.tx(() => {
      for (const t of ['files', 'dirs', 'pending']) this.db.prepare(`DELETE FROM ${t} WHERE root = ?`).run(row.id);
      this.db.prepare('DELETE FROM roots WHERE id = ?').run(row.id);
    });
  }

  /** The next pass starts over (a fresh generation) instead of resuming. */
  restart(id: number): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM pending WHERE root = ?').run(id);
      this.db.prepare('UPDATE roots SET scanning = 0 WHERE id = ?').run(id);
    });
  }

  setOffline(id: number, offline: boolean): void { this.db.prepare('UPDATE roots SET offline = ? WHERE id = ?').run(offline ? 1 : 0, id); }

  // ---------- indexing ----------

  /**
   * One indexing pass over a watched folder (resumes an interrupted one). Returns 'done', 'stopped' (aborted; the
   * next call carries on) or 'offline' (the folder can't be reached now; what was indexed is kept).
   */
  async scan(id: number, ctl: ScanControl = {}): Promise<'done' | 'stopped' | 'offline'> {
    const r = this.db.prepare('SELECT * FROM roots WHERE id = ?').get(id) as unknown as RootRow | undefined;
    if (!r) return 'stopped';
    const st = await fs.promises.stat(r.path).catch(() => null);
    if (!st?.isDirectory()) { this.setOffline(id, true); return 'offline'; }
    this.setOffline(id, false);
    let gen = r.gen;
    if (!r.scanning) {
      gen = r.gen + 1;
      this.tx(() => {
        this.db.prepare('UPDATE roots SET gen = ?, scanning = 1 WHERE id = ?').run(gen, id);
        this.db.prepare('INSERT OR IGNORE INTO pending (root, dir) VALUES (?, ?)').run(id, r.path);
      });
    }
    const next = this.db.prepare('SELECT dir FROM pending WHERE root = ? LIMIT 1');
    let scanned = 0;
    for (;;) {
      if (ctl.signal?.aborted) return 'stopped';
      await ctl.gate?.();
      if (ctl.signal?.aborted) return 'stopped';
      const row = next.get(id) as { dir: string } | undefined;
      if (!row) break;
      const res = await this.readDir(row.dir, ctl.showSystem ?? false);
      this.tx(() => {
        this.db.prepare('DELETE FROM pending WHERE root = ? AND dir = ?').run(id, row.dir);
        if (res) {
          this.apply(id, gen, row.dir, res, false);
          const add = this.db.prepare('INSERT OR IGNORE INTO pending (root, dir) VALUES (?, ?)');
          for (const d of res.subdirs) add.run(id, d);
        }
      });
      if (res) {
        scanned += res.files.length;
        ctl.onProgress?.(scanned);
        if (res.added.length) await ctl.onChange?.(row.dir, { added: res.added, removed: [] });
      }
    }
    // Anything with an older generation was not seen in this pass: deleted while nobody was watching.
    const gone = (this.db.prepare('SELECT path FROM files WHERE root = ? AND gen < ?').all(id, gen) as { path: string }[]).map(x => x.path);
    this.tx(() => {
      this.db.prepare('DELETE FROM files WHERE root = ? AND gen < ?').run(id, gen);
      this.db.prepare('DELETE FROM dirs WHERE root = ? AND gen < ?').run(id, gen);
      this.db.prepare('UPDATE roots SET scanning = 0, last_scan = ? WHERE id = ?').run(Date.now(), id);
    });
    if (gone.length) await ctl.onChange?.(r.path, { added: [], removed: gone });
    return 'done';
  }

  /** Reads one folder: its photos and videos (with size and date) and the subfolders to look into. */
  private async readDir(dir: string, showSystem: boolean) {
    let list: fs.Dirent[];
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return null; }
    const subdirs: string[] = [];
    const media: fs.Dirent[] = [];
    for (const d of list) {
      if (d.isDirectory()) { if (!skipDir(d.name, showSystem)) subdirs.push(path.join(dir, d.name)); }
      else if (d.isFile() && mediaKind(d.name)) media.push(d);
    }
    const files: (FileRef & { name: string; kind: MediaKind })[] = [];
    for (let i = 0; i < media.length; i += 64) {
      const part = media.slice(i, i + 64);
      const st = await Promise.all(part.map(d => fs.promises.stat(path.join(dir, d.name)).catch(() => null)));
      part.forEach((d, j) => { const s = st[j]; if (s) files.push({ path: path.join(dir, d.name), name: d.name, kind: mediaKind(d.name)!, size: s.size, mtime: Math.floor(s.mtimeMs) }); });
    }
    const known = new Map((this.db.prepare('SELECT path, size, mtime FROM files WHERE dir = ?').all(dir) as { path: string; size: number; mtime: number }[])
      .map(r => [IS_WIN ? r.path.toLowerCase() : r.path, r]));
    const k = (p: string) => (IS_WIN ? p.toLowerCase() : p);
    const added = files.filter(f => { const o = known.get(k(f.path)); return !o || o.size !== f.size; }).map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
    const here = new Set(files.map(f => k(f.path)));
    const removed = [...known.values()].filter(r => !here.has(k(r.path))).map(r => r.path);
    return { files, subdirs, added, removed };
  }

  /** Writes what readDir found (inside a transaction). */
  private apply(root: number, gen: number, dir: string, res: NonNullable<Awaited<ReturnType<MediaIndex['readDir']>>>, removeMissing: boolean): void {
    const up = this.db.prepare(`INSERT INTO files (path, root, dir, name, kind, size, mtime, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET root = excluded.root, dir = excluded.dir, name = excluded.name, kind = excluded.kind,
      size = excluded.size, mtime = excluded.mtime, gen = excluded.gen`);
    for (const f of res.files) up.run(f.path, root, dir, f.name, f.kind, f.size, f.mtime, gen);
    if (removeMissing) { const del = this.db.prepare('DELETE FROM files WHERE path = ?'); for (const p of res.removed) del.run(p); }
    this.db.prepare(`INSERT INTO dirs (path, root, parent, gen) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET root = excluded.root, gen = excluded.gen`)
      .run(dir, root, path.dirname(dir), gen);
  }

  /**
   * A folder changed (the watcher saw something): re-read it, index any new subfolders in full, and drop subfolders
   * that are gone. Returns what was added and removed.
   */
  async rescanDir(dir: string, showSystem = false): Promise<DirChange> {
    const r = this.rootOf(dir);
    const out: DirChange = { added: [], removed: [] };
    if (!r) return out;
    const res = await this.readDir(dir, showSystem);
    if (!res) {
      // The folder itself is gone (deleted or moved away): forget it and everything below.
      if (!fs.existsSync(dir)) out.removed.push(...this.forgetTree(dir));
      return out;
    }
    const gen = Math.max(1, r.gen);
    const knownSubs = (this.db.prepare('SELECT path FROM dirs WHERE parent = ?').all(dir) as { path: string }[]).map(x => x.path);
    const isNew = (d: string) => !knownSubs.some(k => same(k, d));
    const fresh = res.subdirs.filter(isNew);
    const vanished = knownSubs.filter(k => !res.subdirs.some(d => same(d, k)));
    this.tx(() => this.apply(r.id, gen, dir, res, true));
    out.added.push(...res.added);
    out.removed.push(...res.removed);
    for (const v of vanished) out.removed.push(...this.forgetTree(v));
    // New subfolders (made, copied or moved in): index them now, all the way down.
    const stack = [...fresh];
    while (stack.length) {
      const d = stack.pop()!;
      const sub = await this.readDir(d, showSystem);
      if (!sub) continue;
      this.tx(() => this.apply(r.id, gen, d, sub, true));
      out.added.push(...sub.added);
      stack.push(...sub.subdirs);
    }
    return out;
  }

  /** Removes a folder and everything below it from the index; returns the files removed. */
  private forgetTree(dir: string): string[] {
    const pre = dir.replace(/[\\/]+$/, '') + path.sep;
    const n = pre.length;
    const cmp = IS_WIN ? 'COLLATE NOCASE' : '';
    const gone = (this.db.prepare(`SELECT path FROM files WHERE dir = ? OR substr(dir, 1, ?) = ? ${cmp}`).all(dir, n, pre) as { path: string }[]).map(x => x.path);
    this.tx(() => {
      this.db.prepare(`DELETE FROM files WHERE dir = ? OR substr(dir, 1, ?) = ? ${cmp}`).run(dir, n, pre);
      this.db.prepare(`DELETE FROM dirs WHERE path = ? OR substr(path, 1, ?) = ? ${cmp}`).run(dir, n, pre);
    });
    return gone;
  }

  // ---------- questions ----------

  /** LIB-07 across watched folders: name words (all must match), type, optional folder; newest first. */
  query(o: { text?: string; kind?: MediaKind | 'all'; under?: string | null; limit?: number; paths?: Set<string> | null }): { items: MediaEntry[]; total: number } {
    const where: string[] = [];
    const args: (string | number)[] = [];
    for (const w of (o.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
      where.push(`name LIKE ? ESCAPE '\\'`);
      args.push(`%${w.replace(/[\\%_]/g, m => '\\' + m)}%`);
    }
    if (o.kind && o.kind !== 'all') { where.push('kind = ?'); args.push(o.kind); }
    if (o.under) {
      const pre = o.under.replace(/[\\/]+$/, '') + path.sep;
      where.push(`(dir = ? OR substr(dir, 1, ?) = ? ${CI})`);
      args.push(o.under.replace(/[\\/]+$/, ''), pre.length, pre);
    }
    const sql = `FROM files ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    let rows = this.db.prepare(`SELECT path, name, kind, size, mtime ${sql} ORDER BY mtime DESC`).all(...args) as unknown as MediaEntry[];
    if (o.paths) rows = rows.filter(r => o.paths!.has(IS_WIN ? r.path.toLowerCase() : r.path));
    const total = rows.length;
    return { items: o.limit ? rows.slice(0, o.limit) : rows, total };
  }

  /** Indexed files of this size (to find where a labelled file went). */
  bySize(size: number): FileRef[] {
    return this.db.prepare('SELECT path, size, mtime FROM files WHERE size = ?').all(size) as unknown as FileRef[];
  }

  has(p: string): boolean { return !!this.db.prepare('SELECT 1 FROM files WHERE path = ?').get(p); }

  /** The app renamed or moved a file inside watched folders: keep the index in step without waiting for the watcher. */
  moved(from: string, to: string, size: number, mtime: number): void {
    const r = this.rootOf(to);
    this.tx(() => {
      this.db.prepare('DELETE FROM files WHERE path = ?').run(from);
      const k = mediaKind(to);
      if (r && k) this.db.prepare(`INSERT OR REPLACE INTO files (path, root, dir, name, kind, size, mtime, gen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(to, r.id, path.dirname(to), path.basename(to), k, size, Math.floor(mtime), Math.max(1, r.gen));
    });
  }
}
