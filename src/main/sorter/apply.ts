// Apply a sort plan safely, and undo it (FACE-05/06/13/14). No Electron imports.
//  • never overwrites (names were made unique in the plan; re-checked here)
//  • every copy is verified (size + SHA-1) before the job continues
//  • group originals move to "Group photos" only after all their copies are verified (pass 2)
//  • every action is appended to <root>/.clearup/sort-log.jsonl, which Undo replays backwards
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ApplyProgress, ApplyResult, SortOp, SortPlan } from '../../shared/types';
import { type Db, tx } from '../db';

export interface LogEntry { sort: number; op: 'mkdir' | 'move' | 'copy' | 'rename-dir'; from?: string; to: string; hash?: string; size?: number; t: number }

export const logPath = (root: string) => path.join(root, '.clearup', 'sort-log.jsonl');

export function appendLog(root: string, e: LogEntry): void {
  fs.mkdirSync(path.dirname(logPath(root)), { recursive: true });
  const fd = fs.openSync(logPath(root), 'a');
  try { fs.writeSync(fd, JSON.stringify(e) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function readLog(root: string, sortId: number): LogEntry[] {
  try {
    return fs.readFileSync(logPath(root), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as LogEntry).filter(e => e.sort === sortId);
  } catch { return []; }
}

export function sha1(file: string): string {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** Can we move this file? Locked (open in another program), read-only or online-only files are skipped. */
function movable(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o200) === 0) return 'Read-only file';
    fs.closeSync(fs.openSync(file, 'r+'));
    return null;
  } catch (e) {
    const c = (e as NodeJS.ErrnoException).code;
    if (c === 'EBUSY') return 'Locked by another program';
    if (c === 'EPERM' || c === 'EACCES') return 'No permission';
    if (c === 'ENOENT') return 'File no longer exists';
    return `Cannot open (${c ?? e})`;
  }
}

/** If the planned name was taken meanwhile, pick "name (n).ext". */
function freeName(p: string): string {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p), stem = p.slice(0, -ext.length || undefined);
  for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}

function moveFile(from: string, to: string): void {
  try { fs.renameSync(from, to); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (fs.statSync(to).size !== fs.statSync(from).size) { fs.rmSync(to); throw new Error('Copy check failed'); }
    fs.rmSync(from);
  }
}

/** Is a planned op already done? (used when finishing an interrupted Apply) */
function alreadyDone(op: SortOp): boolean {
  if (op.kind === 'mkdir') return fs.existsSync(op.to);
  if (op.kind === 'move') return fs.existsSync(op.to) && !fs.existsSync(op.from!);
  return false; // copies are re-verified below
}

export async function applyPlan(db: Db, sortId: number, plan: SortPlan, onProgress: (p: ApplyProgress) => void, resume = false): Promise<ApplyResult> {
  const root = plan.root;
  const res: ApplyResult = { sortId, ok: true, moved: 0, copied: 0, groupMoved: 0, skipped: [] };
  const total = plan.ops.length;
  let done = 0;
  const tick = (phase: ApplyProgress['phase'], current?: string) => onProgress({ sortId, done, total, phase, current });
  // Ops from face sorting carry an image id; ops from the tidy tools (duplicates, date, place) are keyed by path.
  const setImage = db.prepare('UPDATE images SET path = ? WHERE id = ?');
  const setInfo = db.prepare('UPDATE photo_info SET path = ? WHERE folder_id = ? AND path = ?');
  const setPath = (to: string, op: SortOp) => { if (op.imageId != null) setImage.run(to, op.imageId); setInfo.run(to, plan.folderId, op.from!); };
  const keyOf = (op: SortOp): number | string => op.imageId ?? op.from!;
  const hashes = new Map<string, string>();
  const hashOf = (f: string) => { let h = hashes.get(f); if (!h) { h = sha1(f); hashes.set(f, h); } return h; };
  const failedImages = new Set<number | string>();
  const blocked = new Map<number | string, string>(); // image → reason it can't be moved
  const groupIds = new Set(plan.ops.filter(o => o.pass === 2).map(keyOf));
  const checked = new Map<number | string, string | null>();
  const canMove = (id: number | string, file: string) => { if (!checked.has(id)) checked.set(id, movable(file)); return checked.get(id)!; };

  // ---- folders ----
  for (const op of plan.ops.filter(o => o.kind === 'mkdir')) {
    // Log every level created (e.g. "India" and "India\Bengaluru"), so Undo removes all of them.
    const missing: string[] = [];
    for (let d = op.to; !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d)) missing.unshift(d);
    for (const d of missing) { fs.mkdirSync(d); appendLog(root, { sort: sortId, op: 'mkdir', to: d, t: Date.now() }); }
    done++;
  }

  // ---- pass 1: single-person moves and group copies ----
  for (const op of plan.ops.filter(o => o.pass === 1)) {
    tick('pass1', path.basename(op.to));
    const id = keyOf(op);
    try {
      if (resume && alreadyDone(op)) { if (op.kind === 'move') setPath(op.to, op); done++; continue; }
      if (blocked.has(id)) { done++; continue; }
      // Group photos: if the original can't be moved at the end, don't make copies either (no duplicates).
      const why = op.kind === 'move' || groupIds.has(id) ? canMove(id, op.from!) : (fs.existsSync(op.from!) ? null : 'File no longer exists');
      if (why) { blocked.set(id, why); res.skipped.push({ path: op.from!, reason: why }); done++; continue; }

      if (op.kind === 'move') {
        const to = freeName(op.to);
        moveFile(op.from!, to);
        appendLog(root, { sort: sortId, op: 'move', from: op.from, to, t: Date.now() });
        setPath(to, op);
        res.moved++;
      } else {
        let to = op.to;
        const srcHash = hashOf(op.from!);
        if (resume && fs.existsSync(to) && sha1(to) === srcHash) { done++; continue; }
        to = freeName(to);
        fs.copyFileSync(op.from!, to, fs.constants.COPYFILE_EXCL);
        const size = fs.statSync(op.from!).size;
        if (fs.statSync(to).size !== size || sha1(to) !== srcHash) {
          fs.rmSync(to, { force: true });
          failedImages.add(id);
          res.skipped.push({ path: op.from!, reason: 'Copy check failed (disk error?)' });
        } else {
          appendLog(root, { sort: sortId, op: 'copy', from: op.from, to, hash: srcHash, size, t: Date.now() });
          res.copied++;
        }
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const reason = code === 'ENOSPC' ? 'Disk full' : code === 'EBUSY' ? 'Locked by another program' : code === 'EPERM' || code === 'EACCES' ? 'No permission' : String((e as Error).message ?? e);
      failedImages.add(id);
      res.skipped.push({ path: op.from ?? op.to, reason });
      if (code === 'ENOSPC') { res.ok = false; tick('error'); break; }
    }
    done++;
  }

  // ---- pass 2: group originals → "Group photos", only when every copy of that photo is verified ----
  if (res.ok) {
    for (const op of plan.ops.filter(o => o.pass === 2)) {
      tick('pass2', path.basename(op.to));
      const id = keyOf(op);
      done++;
      if (resume && alreadyDone(op)) { setPath(op.to, op); continue; }
      if (failedImages.has(id)) { res.skipped.push({ path: op.from!, reason: 'Original kept in place: a copy failed' }); continue; }
      if (blocked.has(id)) continue; // already reported in pass 1
      const why = movable(op.from!);
      if (why) { res.skipped.push({ path: op.from!, reason: why }); continue; }
      try {
        const to = freeName(op.to);
        moveFile(op.from!, to);
        appendLog(root, { sort: sortId, op: 'move', from: op.from, to, t: Date.now() });
        setPath(to, op);
        res.groupMoved++;
      } catch (e) {
        res.skipped.push({ path: op.from!, reason: String((e as Error).message ?? e) });
      }
    }
  }

  // ---- remember what this sort created, so later scans skip it and re-runs reuse the folders ----
  tx(db, () => {
    const addDir = db.prepare('INSERT OR IGNORE INTO sort_dirs (folder_id, dir) VALUES (?, ?)');
    const setDir = db.prepare('UPDATE people SET dir = ?, keep = 1 WHERE id = ?');
    for (const t of plan.targets) {
      if (!fs.existsSync(t.dir)) continue;
      addDir.run(plan.folderId, t.dir);
      if (t.personId != null) setDir.run(t.dir, t.personId);
    }
    db.prepare('UPDATE sorts SET state = ?, summary = ? WHERE id = ?')
      .run(res.ok ? 'done' : 'failed', JSON.stringify({ moved: res.moved, copied: res.copied, groupMoved: res.groupMoved, skipped: res.skipped.length }), sortId);
  });
  done = total;
  tick(res.ok ? 'done' : 'error');
  return res;
}

/** FACE-14: restore the folder to how it was before this sort (backwards through the log). */
export function undoSort(db: Db, sortId: number, root: string, onProgress?: (p: ApplyProgress) => void): { restored: number; kept: { path: string; reason: string }[] } {
  const entries = readLog(root, sortId).reverse();
  const kept: { path: string; reason: string }[] = [];
  let restored = 0, done = 0;
  const fid = (db.prepare('SELECT folder_id FROM sorts WHERE id = ?').get(sortId) as { folder_id: number }).folder_id;
  const setPath = {
    run: (to: string, f: number, from: string) => {
      db.prepare('UPDATE images SET path = ? WHERE folder_id = ? AND path = ?').run(to, f, from);
      db.prepare('UPDATE photo_info SET path = ? WHERE folder_id = ? AND path = ?').run(to, f, from);
    },
  };

  for (const e of entries) {
    onProgress?.({ sortId, done: done++, total: entries.length, phase: 'undo', current: path.basename(e.to) });
    try {
      if (e.op === 'copy') {
        if (!fs.existsSync(e.to)) continue;
        if (sha1(e.to) === e.hash) { fs.rmSync(e.to); restored++; }
        else kept.push({ path: e.to, reason: 'Copy was changed after sorting, so it was kept' });
      } else if (e.op === 'move') {
        if (!fs.existsSync(e.to)) { kept.push({ path: e.to, reason: 'File is no longer there' }); continue; }
        fs.mkdirSync(path.dirname(e.from!), { recursive: true });
        const back = freeName(e.from!);
        moveFile(e.to, back);
        setPath.run(back, fid, e.to);
        restored++;
      } else if (e.op === 'rename-dir') {
        if (fs.existsSync(e.to) && !fs.existsSync(e.from!)) {
          fs.renameSync(e.to, e.from!);
          renamePathsUnder(db, fid, e.to, e.from!);
        }
      } else if (e.op === 'mkdir') {
        try { fs.rmdirSync(e.to); } catch { kept.push({ path: e.to, reason: 'Folder not empty, so it was kept' }); }
      }
    } catch (err) {
      kept.push({ path: e.to, reason: String((err as Error).message ?? err) });
    }
  }
  tx(db, () => {
    for (const d of db.prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[]) {
      if (!fs.existsSync(d.dir)) {
        db.prepare('DELETE FROM sort_dirs WHERE folder_id = ? AND dir = ?').run(fid, d.dir);
        db.prepare('UPDATE people SET dir = NULL WHERE folder_id = ? AND dir = ?').run(fid, d.dir);
      }
    }
    db.prepare("UPDATE sorts SET state = 'undone' WHERE id = ?").run(sortId);
  });
  onProgress?.({ sortId, done: entries.length, total: entries.length, phase: 'done' });
  return { restored, kept };
}

/** After a folder rename, update every stored path inside it. */
export function renamePathsUnder(db: Db, fid: number, oldDir: string, newDir: string): void {
  const rows = db.prepare('SELECT id, path FROM images WHERE folder_id = ?').all(fid) as { id: number; path: string }[];
  const set = db.prepare('UPDATE images SET path = ? WHERE id = ?');
  for (const r of rows) if (r.path.toLowerCase().startsWith(oldDir.toLowerCase() + path.sep)) set.run(newDir + r.path.slice(oldDir.length), r.id);
  const info = db.prepare('SELECT id, path FROM photo_info WHERE folder_id = ?').all(fid) as { id: number; path: string }[];
  const setI = db.prepare('UPDATE photo_info SET path = ? WHERE id = ?');
  for (const r of info) if (r.path.toLowerCase().startsWith(oldDir.toLowerCase() + path.sep)) setI.run(newDir + r.path.slice(oldDir.length), r.id);
  db.prepare('UPDATE sort_dirs SET dir = ? WHERE folder_id = ? AND dir = ?').run(newDir, fid, oldDir);
  db.prepare('UPDATE people SET dir = ? WHERE folder_id = ? AND dir = ?').run(newDir, fid, oldDir);
}
