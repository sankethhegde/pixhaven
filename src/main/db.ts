// Local face database (node:sqlite, built into Electron's Node): images, faces, people, sorts.
// Used by the main process and the scan worker (WAL mode lets both open it). No Electron imports here.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE COLLATE NOCASE, created INTEGER, last_scan INTEGER
);
CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL COLLATE NOCASE, size INTEGER, mtime INTEGER, width INTEGER, height INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | done | error | skipped
  error TEXT, faces INTEGER NOT NULL DEFAULT 0, thumb TEXT, seen INTEGER NOT NULL DEFAULT 1,
  UNIQUE (folder_id, path)
);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  num INTEGER NOT NULL, name TEXT, name_source TEXT, name_detail TEXT,
  keep INTEGER NOT NULL DEFAULT 0,                 -- 1 = user-edited or applied: survives re-grouping
  dir TEXT                                         -- folder on disk once a sort created/used it
);
CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY, image_id INTEGER NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  x REAL, y REAL, w REAL, h REAL, score REAL, sharpness REAL,
  usable INTEGER NOT NULL, emb BLOB, chip TEXT,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  removed INTEGER NOT NULL DEFAULT 0               -- user removed this face from its person (FACE-09)
);
CREATE TABLE IF NOT EXISTS sorts (
  id INTEGER PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  created INTEGER, state TEXT NOT NULL, plan TEXT, summary TEXT
);
CREATE TABLE IF NOT EXISTS sort_dirs (           -- folders a sort created or filled: excluded from later scans
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE, dir TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (folder_id, dir)
);
CREATE TABLE IF NOT EXISTS photo_info (         -- tidy tools: duplicates, blur, date, place
  id INTEGER PRIMARY KEY, folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL COLLATE NOCASE, size INTEGER, mtime INTEGER,
  status TEXT NOT NULL DEFAULT 'pending', error TEXT,
  sha1 TEXT, dhash TEXT, blur REAL, width INTEGER, height INTEGER,
  taken INTEGER, taken_src TEXT, lat REAL, lon REAL, thumb TEXT, seen INTEGER NOT NULL DEFAULT 1,
  UNIQUE (folder_id, path)
);
CREATE INDEX IF NOT EXISTS photo_info_folder ON photo_info(folder_id);
CREATE INDEX IF NOT EXISTS faces_image ON faces(image_id);
CREATE INDEX IF NOT EXISTS faces_person ON faces(person_id);
CREATE INDEX IF NOT EXISTS images_folder ON images(folder_id);
CREATE INDEX IF NOT EXISTS people_folder ON people(folder_id);
`;

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Added in Phase 5: which tool a sort record belongs to.
  try { db.exec("ALTER TABLE sorts ADD COLUMN kind TEXT NOT NULL DEFAULT 'people'"); } catch { /* already there */ }
  return db;
}

export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function folderId(db: Db, root: string, create = true): number | null {
  const row = db.prepare('SELECT id FROM folders WHERE path = ?').get(root) as { id: number } | undefined;
  if (row) return row.id;
  if (!create) return null;
  return Number(db.prepare('INSERT INTO folders (path, created) VALUES (?, ?)').run(root, Date.now()).lastInsertRowid);
}

export const embToBlob = (e: Float32Array) => new Uint8Array(e.buffer, e.byteOffset, e.byteLength);
export const blobToEmb = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

export function nextPersonNum(db: Db, fid: number): number {
  const r = db.prepare('SELECT MAX(num) AS m FROM people WHERE folder_id = ?').get(fid) as { m: number | null };
  return (r.m ?? 0) + 1;
}
