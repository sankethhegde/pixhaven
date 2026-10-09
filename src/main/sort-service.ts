// Sort by person, main-process side: lists files, runs the worker through the job queue,
// and answers the review / dry-run / apply / undo calls from the UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import workerPath from './faces/sort-worker?modulePath';
import type {
  ApplyProgress, ApplyResult, FolderStatus, PersonSummary, PhotoRef, ReviewData, ScanProgress, SortHistory, SortPlan,
} from '@shared/types';
import { openDb, folderId, nextPersonNum, tx, type Db } from './db';
import { getSettings } from './settings';
import { resourcesDir } from './engine';
import { isImageFile } from './image-io';
import { buildPlan, personLabel, safeFolderName } from './sorter/plan';
import { appendLog, renamePathsUnder } from './sorter/apply';
import type { ListedFile } from './faces/pipeline';
import type { WorkerInput } from './faces/sort-worker';
import { fileUrl } from './upscale-job';
import { queue } from './queue';
import { log } from './logger';

export const dataDir = () => path.join(app.getPath('userData'), 'facedata');
const dbPath = () => path.join(dataDir(), 'faces.db');
let db: Db | null = null;
export const getDb = () => (db ??= openDb(dbPath()));

export type SortEvents = {
  scan: (p: ScanProgress) => void;
  apply: (p: ApplyProgress) => void;
};

// ---------- listing files ----------
/** Cloud-only (OneDrive "online-only") files: reading them would start a download, so they are skipped. */
function cloudOnlyFiles(root: string, recurse: boolean): Promise<Set<string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  return new Promise(resolve => {
    const cmd = `Get-ChildItem -LiteralPath $env:CLEARUP_ROOT -File -Force ${recurse ? '-Recurse' : ''} -ErrorAction SilentlyContinue | ` +
      `Where-Object { ([int]$_.Attributes -band 0x441000) -ne 0 } | ForEach-Object { $_.FullName }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 60000, maxBuffer: 64 << 20, env: { ...process.env, CLEARUP_ROOT: root } },
      (err, out) => resolve(new Set(err ? [] : out.split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(Boolean))));
  });
}

export async function listImages(root: string, recurse: boolean, excludeDirs: string[]): Promise<ListedFile[]> {
  const cloud = await cloudOnlyFiles(root, recurse);
  const excluded = new Set(excludeDirs.map(d => d.toLowerCase()));
  const out: ListedFile[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recurse && !e.name.startsWith('.') && !excluded.has(p.toLowerCase())) walk(p);
      } else if (e.isFile() && isImageFile(p)) {
        try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtime: Math.round(st.mtimeMs), cloud: cloud.has(p.toLowerCase()) }); } catch { /* vanished */ }
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

// ---------- worker plumbing ----------
let current: { worker: Worker; root: string } | null = null;

export function runWorker(input: Omit<WorkerInput, 'dbPath' | 'modelsDir' | 'ocrDir' | 'cacheDir' | 'thumbsDir' | 'settings' | 'preferGpu'> & Partial<WorkerInput>, ev: Partial<SortEvents>): Promise<any> {
  const s = getSettings();
  const full: WorkerInput = {
    dbPath: dbPath(), modelsDir: path.join(resourcesDir(), 'models'), ocrDir: path.join(resourcesDir(), 'ocr'),
    cacheDir: path.join(dataDir(), 'ocr-cache'), thumbsDir: path.join(dataDir(), String(input.folderId)),
    settings: s.sort, preferGpu: !s.cpuOnly, ...input,
  } as WorkerInput;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: full });
    current = { worker, root: full.root };
    let result: unknown = null;
    worker.on('message', (m: any) => {
      if (m.type === 'progress') ev.scan?.(m.progress);
      else if (m.type === 'apply') ev.apply?.(m.progress);
      else if (m.type === 'log') log('info', 'sort-worker', m.message);
      // The result is the last message: end the worker right away (OCR/ONNX threads could keep it alive).
      else if (m.type === 'result') { result = m.result; resolve(result); void worker.terminate(); }
      else if (m.type === 'error') { log('error', 'sort-worker', m.message); reject(new Error(m.message.split('\n')[0])); }
    });
    worker.on('error', e => { log('error', 'sort-worker crashed', e); reject(e); });
    worker.on('exit', code => { current = null; if (result !== null || code === 0) resolve(result); else reject(new Error(`Worker stopped (${code})`)); });
  });
}

export function pauseScan(paused: boolean): void { current?.worker.postMessage(paused ? 'pause' : 'resume'); }
export function cancelScan(): void { current?.worker.postMessage('cancel'); }

// ---------- public API ----------
export const sortDirs = (fid: number) => (getDb().prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[]).map(r => r.dir);

export function folderStatus(root: string): FolderStatus {
  const d = getDb();
  const fid = folderId(d, root, false);
  if (fid == null) return { folderId: null, scannedImages: 0, people: 0, lastScan: null, sorts: [], interrupted: null };
  const sorts = d.prepare("SELECT id, kind, created, state, summary FROM sorts WHERE folder_id = ? AND kind = 'people' ORDER BY id DESC LIMIT 10").all(fid) as unknown as SortHistory[];
  return {
    folderId: fid,
    scannedImages: (d.prepare("SELECT COUNT(*) AS n FROM images WHERE folder_id = ? AND status = 'done'").get(fid) as { n: number }).n,
    people: (d.prepare('SELECT COUNT(*) AS n FROM people WHERE folder_id = ?').get(fid) as { n: number }).n,
    lastScan: (d.prepare('SELECT last_scan FROM folders WHERE id = ?').get(fid) as { last_scan: number | null }).last_scan,
    sorts, interrupted: sorts.find(x => x.state === 'applying') ?? null,
  };
}

/** Scan (or re-scan) a folder through the job queue. Resolves when grouping and naming are done. */
export function scanFolder(root: string, ev: Pick<SortEvents, 'scan'>): { queueId: string; done: Promise<{ folderId: number; cancelled?: boolean }> } {
  const fid = folderId(getDb(), root)!;
  let cancelled = false;
  const job = queue.add('scan', `Sort by person: scan ${path.basename(root)}`, async () => {
    if (cancelled) return;
    ev.scan({ folder: root, phase: 'listing', done: 0, total: 0, faces: 0, people: 0 });
    const files = await listImages(root, getSettings().sort.includeSubfolders, sortDirs(fid));
    log('info', `Scan ${root}: ${files.length} images (${files.filter(f => f.cloud).length} online-only)`);
    const r = await runWorker({ task: 'scan', folderId: fid, root, files, keepDirs: sortDirs(fid) }, ev);
    cancelled = !!r?.cancelled;
  }, () => { cancelled = true; cancelScan(); });
  return { queueId: job.id, done: job.done.then(() => ({ folderId: fid, cancelled })) };
}

/** Re-group without re-scanning (after changing face-match strictness). */
export function regroup(fid: number, ev: Pick<SortEvents, 'scan'>): Promise<void> {
  const root = (getDb().prepare('SELECT path FROM folders WHERE id = ?').get(fid) as { path: string }).path;
  return queue.add('regroup', `Sort by person: regroup ${path.basename(root)}`,
    () => runWorker({ task: 'regroup', folderId: fid, root, files: [], keepDirs: [] }, ev), cancelScan).done;
}

const faceUrl = (chip: string | null) => (chip && fs.existsSync(chip) ? fileUrl(chip) : '');

export function review(fid: number): ReviewData {
  const d = getDb();
  const s = getSettings().sort;
  const root = (d.prepare('SELECT path FROM folders WHERE id = ?').get(fid) as { path: string }).path;
  const people = d.prepare(`
    SELECT p.id, p.num, p.name, p.name_source, p.name_detail, p.dir, COUNT(DISTINCT f.image_id) AS photos
    FROM people p LEFT JOIN faces f ON f.person_id = p.id AND f.removed = 0
    WHERE p.folder_id = ? GROUP BY p.id ORDER BY photos DESC, p.num`).all(fid) as
    { id: number; num: number; name: string | null; name_source: string | null; name_detail: string | null; dir: string | null; photos: number }[];
  const chips = d.prepare('SELECT chip FROM faces WHERE person_id = ? AND removed = 0 ORDER BY sharpness * h DESC LIMIT 4');
  const summaries: PersonSummary[] = people.filter(p => p.photos > 0 || p.dir).map(p => ({
    id: p.id, num: p.num, name: p.name, label: personLabel(p),
    source: p.name_source as PersonSummary['source'], photos: p.photos, dir: p.dir,
    sourceDetail: p.name_source === 'typed' ? 'typed by you' : p.name_source === 'file' ? `from file name: ${p.name_detail}` : p.name_source === 'ocr' ? `read from text in ${p.name_detail}` : null,
    faceUrls: (chips.all(p.id) as { chip: string | null }[]).map(c => faceUrl(c.chip)).filter(Boolean),
    unsorted: p.photos < s.minPhotos && !p.dir,
  }));
  const ref = (r: { id: number; path: string; thumb: string | null }): PhotoRef => ({ imageId: r.id, name: path.basename(r.path), path: r.path, thumbUrl: r.thumb ? fileUrl(r.thumb) : '' });
  const cant = d.prepare(`SELECT id, path, thumb FROM images i WHERE folder_id = ? AND status = 'done' AND faces > 0
    AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.image_id = i.id AND f.person_id IS NOT NULL AND f.removed = 0) ORDER BY path`).all(fid) as any[];
  const none = d.prepare("SELECT id, path, thumb FROM images WHERE folder_id = ? AND status = 'done' AND faces = 0 ORDER BY path").all(fid) as any[];
  const skipped = d.prepare("SELECT path, error FROM images WHERE folder_id = ? AND status IN ('skipped', 'error') ORDER BY path").all(fid) as { path: string; error: string | null }[];
  const clashes = new Map<string, number[]>();
  for (const p of summaries) if (p.name) { const k = p.name.toLowerCase(); clashes.set(k, [...(clashes.get(k) ?? []), p.id]); }
  return {
    folderId: fid, folder: root, people: summaries,
    cantRecognise: cant.map(ref), noFaces: none.map(ref),
    skipped: skipped.map(x => ({ path: x.path, reason: x.error ?? 'Skipped' })),
    nameClashes: [...clashes.entries()].filter(([, ids]) => ids.length > 1).map(([, ids]) => ({ name: summaries.find(p => p.id === ids[0])!.name!, ids })),
    scanned: (d.prepare("SELECT COUNT(*) AS n FROM images WHERE folder_id = ? AND status = 'done'").get(fid) as { n: number }).n,
  };
}

export function personPhotos(pid: number): PhotoRef[] {
  const rows = getDb().prepare(`
    SELECT i.id AS imageId, i.path, i.thumb, f.id AS faceId, f.chip,
      (SELECT COUNT(DISTINCT f2.person_id) FROM faces f2 WHERE f2.image_id = i.id AND f2.person_id IS NOT NULL AND f2.removed = 0) AS people
    FROM faces f JOIN images i ON i.id = f.image_id WHERE f.person_id = ? AND f.removed = 0 ORDER BY i.path`).all(pid) as any[];
  return rows.map(r => ({ imageId: r.imageId, faceId: r.faceId, name: path.basename(r.path), path: r.path, thumbUrl: r.thumb ? fileUrl(r.thumb) : '', faceUrl: faceUrl(r.chip), people: r.people }));
}

/** FACE-12: typed name wins; a person who already has a folder gets it renamed. Returns a clash instead of saving. */
export function renamePerson(pid: number, rawName: string, allowClash = false): { ok: boolean; clashWith?: { id: number; label: string } } {
  const d = getDb();
  const name = rawName.replace(/\s+/g, ' ').trim() || null;
  const p = d.prepare('SELECT id, folder_id, num, dir FROM people WHERE id = ?').get(pid) as { id: number; folder_id: number; num: number; dir: string | null };
  if (name && !allowClash) {
    const other = d.prepare('SELECT id, num, name FROM people WHERE folder_id = ? AND id != ? AND lower(name) = lower(?)').get(p.folder_id, pid, name) as { id: number; num: number; name: string } | undefined;
    if (other) return { ok: false, clashWith: { id: other.id, label: personLabel(other) } };
  }
  if (p.dir && fs.existsSync(p.dir)) {
    const target = path.join(path.dirname(p.dir), safeFolderName(name ?? personLabel({ name: null, num: p.num })));
    if (target.toLowerCase() !== p.dir.toLowerCase()) {
      if (fs.existsSync(target)) throw new Error(`A folder named "${path.basename(target)}" already exists there.`);
      fs.renameSync(p.dir, target);
      const root = (d.prepare('SELECT path FROM folders WHERE id = ?').get(p.folder_id) as { path: string }).path;
      const sort = d.prepare("SELECT id FROM sorts WHERE folder_id = ? AND state = 'done' ORDER BY id DESC").get(p.folder_id) as { id: number } | undefined;
      if (sort) appendLog(root, { sort: sort.id, op: 'rename-dir', from: p.dir, to: target, t: Date.now() });
      renamePathsUnder(d, p.folder_id, p.dir, target);
    } else if (target !== p.dir) {
      fs.renameSync(p.dir, target); // only the letter case changed
      renamePathsUnder(d, p.folder_id, p.dir, target);
    }
  }
  d.prepare('UPDATE people SET name = ?, name_source = ?, name_detail = NULL, keep = 1 WHERE id = ?').run(name, name ? 'typed' : null, pid);
  return { ok: true };
}

/** FACE-09 merge: all of `from`'s faces go to `into`. */
export function mergePeople(fromId: number, intoId: number): void {
  const d = getDb();
  const from = d.prepare('SELECT * FROM people WHERE id = ?').get(fromId) as any;
  const into = d.prepare('SELECT * FROM people WHERE id = ?').get(intoId) as any;
  if (!from || !into || fromId === intoId) return;
  if (from.dir && fs.existsSync(from.dir)) throw new Error(`${personLabel(from)} already has a folder from an earlier sort. Merge the other way round, or move those files by hand.`);
  tx(d, () => {
    d.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(intoId, fromId);
    if (!into.name && from.name) d.prepare('UPDATE people SET name = ?, name_source = ?, name_detail = ? WHERE id = ?').run(from.name, from.name_source, from.name_detail, intoId);
    d.prepare('UPDATE people SET keep = 1 WHERE id = ?').run(intoId);
    d.prepare('DELETE FROM people WHERE id = ?').run(fromId);
  });
}

/** FACE-09 remove: this photo no longer counts for that person. */
export function removeFace(faceId: number): void {
  const d = getDb();
  const f = d.prepare('SELECT person_id FROM faces WHERE id = ?').get(faceId) as { person_id: number | null } | undefined;
  if (!f) return;
  tx(d, () => {
    d.prepare('UPDATE faces SET removed = 1, person_id = NULL WHERE id = ?').run(faceId);
    if (f.person_id) d.prepare('UPDATE people SET keep = 1 WHERE id = ?').run(f.person_id);
  });
}

/** FACE-09 split: chosen photos become a new person. */
export function splitPerson(pid: number, faceIds: number[]): number {
  const d = getDb();
  const p = d.prepare('SELECT folder_id FROM people WHERE id = ?').get(pid) as { folder_id: number };
  return tx(d, () => {
    const id = Number(d.prepare('INSERT INTO people (folder_id, num, keep) VALUES (?, ?, 1)').run(p.folder_id, nextPersonNum(d, p.folder_id)).lastInsertRowid);
    const set = d.prepare('UPDATE faces SET person_id = ? WHERE id = ? AND person_id = ?');
    for (const f of faceIds) set.run(id, f, pid);
    d.prepare('UPDATE people SET keep = 1 WHERE id = ?').run(pid);
    return id;
  });
}

const plans = new Map<number, SortPlan>();
export function makePlan(fid: number): SortPlan {
  const root = (getDb().prepare('SELECT path FROM folders WHERE id = ?').get(fid) as { path: string }).path;
  const plan = buildPlan(getDb(), fid, root, getSettings().sort);
  plans.set(fid, plan);
  return plan;
}

/** Apply the plan shown in the dry run. */
export function applySort(fid: number, ev: Pick<SortEvents, 'apply'>): Promise<ApplyResult> {
  const plan = plans.get(fid) ?? makePlan(fid);
  const d = getDb();
  if (d.prepare("SELECT 1 FROM sorts WHERE folder_id = ? AND state = 'applying'").get(fid)) throw new Error('An earlier sort of this folder did not finish. Finish or undo it first.');
  if (plan.freeBytes != null && plan.copyBytes > plan.freeBytes - 50e6) throw new Error('Not enough free disk space for the copies of group photos.');
  const sortId = Number(d.prepare("INSERT INTO sorts (folder_id, created, state, plan) VALUES (?, ?, 'applying', ?)").run(fid, Date.now(), JSON.stringify(plan)).lastInsertRowid);
  plans.delete(fid);
  let result: ApplyResult | null = null;
  return queue.add('apply', `Sort by person: apply ${path.basename(plan.root)}`, async () => {
    result = await runWorker({ task: 'apply', folderId: fid, root: plan.root, files: [], keepDirs: [], sortId, plan }, ev);
  }, () => { /* apply can't be cancelled halfway: Undo afterwards instead */ }).done.then(() => result!);
}

/** Finish an Apply that was interrupted (crash, power loss). */
export function finishSort(sortId: number, ev: Pick<SortEvents, 'apply'>): Promise<ApplyResult> {
  const row = getDb().prepare('SELECT folder_id, plan FROM sorts WHERE id = ?').get(sortId) as { folder_id: number; plan: string };
  const plan = JSON.parse(row.plan) as SortPlan;
  let result: ApplyResult | null = null;
  return queue.add('apply', `Sort by person: finish ${path.basename(plan.root)}`, async () => {
    result = await runWorker({ task: 'finish', folderId: row.folder_id, root: plan.root, files: [], keepDirs: [], sortId, plan }, ev);
  }, () => {}).done.then(() => result!);
}

export function undoSortJob(sortId: number, ev: Pick<SortEvents, 'apply'>): Promise<{ restored: number; kept: { path: string; reason: string }[] }> {
  const row = getDb().prepare('SELECT s.folder_id, f.path FROM sorts s JOIN folders f ON f.id = s.folder_id WHERE s.id = ?').get(sortId) as { folder_id: number; path: string };
  let result: any = null;
  return queue.add('undo', `Sort by person: undo ${path.basename(row.path)}`, async () => {
    result = await runWorker({ task: 'undo', folderId: row.folder_id, root: row.path, files: [], keepDirs: [], sortId }, ev);
  }, () => {}).done.then(() => result);
}

/** FACE-17: image paths of one person, for "Upscale all photos of this person". */
export function personImagePaths(pid: number): { path: string; width: number; height: number }[] {
  return (getDb().prepare(`SELECT DISTINCT i.path, i.width, i.height FROM faces f JOIN images i ON i.id = f.image_id
    WHERE f.person_id = ? AND f.removed = 0 ORDER BY i.path`).all(pid) as { path: string; width: number; height: number }[])
    .filter(r => fs.existsSync(r.path));
}

/** Privacy: delete every saved face fingerprint and thumbnail. Files on disk are not touched. */
export function deleteFaceData(): void {
  if (current) throw new Error('Wait for the running sort job to finish first.');
  db?.close(); db = null;
  fs.rmSync(dataDir(), { recursive: true, force: true });
  log('info', 'Face data deleted');
}

export function faceDataSize(): number {
  let n = 0;
  const walk = (d: string) => { try { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else n += fs.statSync(p).size; } } catch { /* none */ } };
  walk(dataDir());
  return n;
}
