// Sort by person, main-process side: lists files, runs the worker through the job queue,
// and answers the review / dry-run / apply / undo calls from the UI.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import sharp from 'sharp';
import workerPath from './faces/sort-worker?modulePath';
import type {
  ApplyProgress, ApplyResult, CombineEstimate, CombineMatch, CombineProgress, CombineRequest, CombineResult, FolderStatus, KnownFolder, MediaEntry, MergePhoto, MergePlan, MergeResult,
  PersonSummary, PhotoRef, ReviewData, ScanEstimate, ScanProgress, SortHistory, SortPlan,
} from '@shared/types';
import { openDb, folderId, nextPersonNum, tx, type Db } from './db';
import { getSettings } from './settings';
import { resourcesDir } from './engine';
import { isImageFile } from './image-io';
import { buildPlan, personLabel } from './sorter/plan';
import { sortedFolders } from './sorter/people-manifest';
import { reconcileFolder, relocateFolder, renamePeople } from './sorter/reconcile';
import { syncGroupLinks } from './group-links';
import { exiftool, afterSort as tagsAfterSort } from './tags-service';
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
  combine: (p: CombineProgress) => void;
};

// ---------- listing files ----------
/** Cloud-only (OneDrive "online-only") files: reading them would start a download, so they are skipped. */
function cloudOnlyFiles(root: string, recurse: boolean): Promise<Set<string>> {
  if (process.platform !== 'win32') return Promise.resolve(new Set());
  return new Promise(resolve => {
    const cmd = `Get-ChildItem -LiteralPath $env:CLEARUP_ROOT -File -Force ${recurse ? '-Recurse' : ''} -ErrorAction SilentlyContinue | ` +
      `Where-Object { ([int]$_.Attributes -band 0x441000) -ne 0 } | ForEach-Object { $_.FullName }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 300000, maxBuffer: 256 << 20, env: { ...process.env, CLEARUP_ROOT: root } },
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

export function runWorker(input: Omit<WorkerInput, 'dbPath' | 'modelsDir' | 'thumbsDir' | 'settings' | 'preferGpu'> & Partial<WorkerInput>, ev: Partial<SortEvents>, track = true): Promise<any> {
  const s = getSettings();
  const full: WorkerInput = {
    dbPath: dbPath(), modelsDir: path.join(resourcesDir(), 'models'), thumbsDir: path.join(dataDir(), String(input.folderId)),
    settings: s.sort, preferGpu: !s.cpuOnly, exiftool: exiftool(), ...input,
  } as WorkerInput;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: full });
    // Quick lookups (track = false) run beside a scan and must not take over its pause / cancel.
    if (track) current = { worker, root: full.root };
    let result: unknown = null;
    worker.on('message', (m: any) => {
      if (m.type === 'progress') ev.scan?.(m.progress);
      else if (m.type === 'apply') ev.apply?.(m.progress);
      else if (m.type === 'combine') ev.combine?.(m.progress);
      else if (m.type === 'log') log('info', 'sort-worker', m.message);
      // The result is the last message: end the worker right away (ONNX threads could keep it alive).
      else if (m.type === 'result') { result = m.result; resolve(result); void worker.terminate(); }
      else if (m.type === 'error') { log('error', 'sort-worker', m.message); reject(new Error(m.message.split('\n')[0])); }
    });
    worker.on('error', e => { log('error', 'sort-worker crashed', e); reject(e); });
    worker.on('exit', code => { if (track && current?.worker === worker) current = null; if (result !== null || code === 0) resolve(result); else reject(new Error(`Worker stopped (${code})`)); });
  });
}

export function pauseScan(paused: boolean): void { current?.worker.postMessage(paused ? 'pause' : 'resume'); }
export function cancelScan(): void { current?.worker.postMessage('cancel'); }

// ---------- public API ----------
export const sortDirs = (fid: number) => (getDb().prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid) as { dir: string }[]).map(r => r.dir);

/**
 * v2.4: a folder sorted before is matched again even when it, its person folders or its photos were renamed or moved
 * in Explorer, so it opens as it was and a scan doesn't see those photos as new. Not while a sort job is running.
 * v2.9: the folder is listed without blocking the window; two requests for one folder share one run.
 */
const reconciling = new Map<string, Promise<FolderStatus['reconciled']>>();
function reconcile(root: string): Promise<FolderStatus['reconciled']> {
  const k = root.toLowerCase();
  const had = reconciling.get(k);
  if (had) return had;
  const run = reconcileNow(root).finally(() => reconciling.delete(k));
  reconciling.set(k, run);
  return run;
}
async function reconcileNow(root: string): Promise<FolderStatus['reconciled']> {
  if (current) return null;
  try {
    const d = getDb();
    const t = Date.now();
    const relocated = await relocateFolder(d, root);
    const movedFrom = relocated?.from ?? null;
    const fid = folderId(d, root, false);
    // Sorted on another computer (no face data here): its group photos still get their Explorer shortcuts.
    if (fid == null) { void syncGroupLinks(root); return null; }
    const { moved, ...r } = await reconcileFolder(d, fid, root);
    if (Date.now() - t > 1000) log('info', `Matched ${root} with earlier sorts in ${Date.now() - t} ms`);
    // Labels and stars follow the photos too.
    const all = [...(relocated?.moved ?? []), ...moved];
    if (all.length) tagsAfterSort(all, []).catch(e => log('warn', 'Labels did not follow moved photos', e));
    renamePeopleLater(fid, root);
    void syncGroupLinks(root);
    if (movedFrom || r.photos || r.folders.length) {
      log('info', `Found again in ${root}: ${movedFrom ? `folder moved from ${movedFrom}, ` : ''}${r.folders.length} person folder(s) renamed, ${r.photos} photo(s) moved`);
      return { movedFrom, ...r };
    }
  } catch (e) { log('warn', `Could not match ${root} with earlier sorts`, e); }
  return null;
}

/** Renamed person folders: the names inside the photos are changed in the background (one job at a time). */
let renaming = false;
function renamePeopleLater(fid: number, root: string): void {
  if (renaming || !getDb().prepare('SELECT 1 FROM name_changes WHERE folder_id = ?').get(fid)) return;
  renaming = true;
  let changed: string[] = [];
  queue.add('apply', `Sort by person: new names into the photos of ${path.basename(root)}`, async () => {
    changed = await renamePeople(getDb(), fid, root, exiftool());
  }, () => {}).done
    .then(() => { if (changed.length) { log('info', `Renamed people in ${changed.length} photo(s)`); return tagsAfterSort([], changed); } })
    .catch(e => log('warn', 'Could not rename people in the photos', e))
    .finally(() => { renaming = false; });
}

export async function folderStatus(root: string): Promise<FolderStatus> {
  const d = getDb();
  const reconciled = await reconcile(root);
  const fid = folderId(d, root, false);
  if (fid == null) return { folderId: null, scannedImages: 0, people: 0, lastScan: null, sorts: [], interrupted: null };
  const sorts = d.prepare("SELECT id, kind, created, state, summary FROM sorts WHERE folder_id = ? AND kind = 'people' ORDER BY id DESC LIMIT 10").all(fid) as unknown as SortHistory[];
  return {
    folderId: fid,
    scannedImages: (d.prepare("SELECT COUNT(*) AS n FROM images WHERE folder_id = ? AND status = 'done'").get(fid) as { n: number }).n,
    people: (d.prepare('SELECT COUNT(*) AS n FROM people WHERE folder_id = ?').get(fid) as { n: number }).n,
    lastScan: (d.prepare('SELECT last_scan FROM folders WHERE id = ?').get(fid) as { last_scan: number | null }).last_scan,
    sorts, interrupted: sorts.find(x => x.state === 'applying') ?? null, reconciled,
  };
}

/** Scan (or re-scan) a folder through the job queue. Resolves when grouping is done. */
export async function scanFolder(root: string, ev: Pick<SortEvents, 'scan'>): Promise<{ queueId: string; done: Promise<{ folderId: number; cancelled?: boolean }> }> {
  await reconcile(root);   // before the folder gets a new record: it may be a known one, renamed
  const fid = folderId(getDb(), root)!;
  let cancelled = false;
  const job = queue.add('scan', `Sort by person: scan ${path.basename(root)}`, async () => {
    if (cancelled) return;
    ev.scan({ folder: root, phase: 'listing', done: 0, total: 0, faces: 0, people: 0 });
    await reconcile(root);
    // Folders sorted before — on this computer, or (from the folder's own list) on another one — are left alone.
    const files = await listImages(root, getSettings().sort.includeSubfolders, [...sortDirs(fid), ...sortedFolders(root)]);
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
    SELECT p.id, p.num, p.dir, COUNT(DISTINCT f.image_id) AS photos
    FROM people p LEFT JOIN faces f ON f.person_id = p.id AND f.removed = 0
    WHERE p.folder_id = ? GROUP BY p.id ORDER BY p.num`).all(fid) as { id: number; num: number; dir: string | null; photos: number }[];
  // v2.9: everyone's 4 best face thumbnails in one query, without checking each file (2,500 people froze the app;
  // a thumbnail that is gone just does not show).
  const chips = new Map<number, string[]>();
  for (const c of d.prepare(`SELECT person_id, chip FROM (SELECT f.person_id, f.chip, ROW_NUMBER() OVER (PARTITION BY f.person_id ORDER BY f.sharpness * f.h DESC) AS k
      FROM faces f JOIN people p ON p.id = f.person_id WHERE p.folder_id = ? AND f.removed = 0 AND f.chip IS NOT NULL) WHERE k <= 4`).iterate(fid) as Iterable<{ person_id: number; chip: string }>) {
    chips.set(c.person_id, [...(chips.get(c.person_id) ?? []), fileUrl(c.chip)]);
  }
  const summaries: PersonSummary[] = people.filter(p => p.photos > 0 || (p.dir && fs.existsSync(p.dir))).map(p => ({
    id: p.id, num: p.num, label: personLabel(p), photos: p.photos, dir: p.dir,
    faceUrls: chips.get(p.id) ?? [],
    unsorted: p.photos < s.minPhotos && !p.dir,
  }));
  const ref = (r: { id: number; path: string; thumb: string | null }): PhotoRef => ({ imageId: r.id, name: path.basename(r.path), path: r.path, thumbUrl: r.thumb ? fileUrl(r.thumb) : '' });
  const cant = d.prepare(`SELECT id, path, thumb FROM images i WHERE folder_id = ? AND status = 'done' AND faces > 0
    AND NOT EXISTS (SELECT 1 FROM faces f WHERE f.image_id = i.id AND f.person_id IS NOT NULL AND f.removed = 0) ORDER BY path`).all(fid) as any[];
  const none = d.prepare("SELECT id, path, thumb FROM images WHERE folder_id = ? AND status = 'done' AND faces = 0 ORDER BY path").all(fid) as any[];
  const skipped = d.prepare("SELECT path, error FROM images WHERE folder_id = ? AND status IN ('skipped', 'error') ORDER BY path").all(fid) as { path: string; error: string | null }[];
  return {
    folderId: fid, folder: root, people: summaries,
    cantRecognise: cant.map(ref), noFaces: none.map(ref),
    skipped: skipped.map(x => ({ path: x.path, reason: x.error ?? 'Skipped' })),
    lowRes: !s.suggestUpscale ? [] : lowResPhotos(fid).map(r => ({ ...ref(r), width: r.orig_w, height: r.orig_h })),
    scanned: (d.prepare("SELECT COUNT(*) AS n FROM images WHERE folder_id = ? AND status = 'done'").get(fid) as { n: number }).n,
  };
}

// ---------- v2.3: low-resolution photos, upscaled in place (optional) ----------

/** Under 2 megapixels and under 1,600 px on the long side (WhatsApp, Instagram's 1080 px…), in a format that can be
 * written back as itself (JPG, PNG, WEBP). */
export const LOW_RES_PX = 2_000_000, LOW_RES_SIDE = 1600;
const REPLACEABLE = /\.(jpe?g|png|webp)$/i;
function lowResPhotos(fid: number): { id: number; path: string; thumb: string | null; orig_w: number; orig_h: number }[] {
  return (getDb().prepare(`SELECT id, path, thumb, orig_w, orig_h FROM images WHERE folder_id = ? AND status = 'done' AND orig_w IS NOT NULL
    AND orig_w * orig_h < ? AND MAX(orig_w, orig_h) < ? ORDER BY orig_w * orig_h`).all(fid, LOW_RES_PX, LOW_RES_SIDE) as { id: number; path: string; thumb: string | null; orig_w: number; orig_h: number }[])
    .filter(r => REPLACEABLE.test(r.path) && fs.existsSync(r.path));
}

/** After photos were upscaled in place: new size recorded, so they are not scanned again and leave the list. */
export async function afterUpscale(paths: string[]): Promise<void> {
  const d = getDb();
  const set = d.prepare('UPDATE images SET size = ?, mtime = ?, orig_w = ?, orig_h = ? WHERE path = ?');
  for (const p of paths) {
    try {
      const st = fs.statSync(p);
      const m = await sharp(p).metadata();
      const [w, h] = (m.orientation ?? 1) >= 5 ? [m.height, m.width] : [m.width, m.height];
      set.run(st.size, Math.round(st.mtimeMs), w ?? null, h ?? null, p);
    } catch (e) { log('warn', `Could not update ${p} after upscaling`, e); }
  }
}

export function personPhotos(pid: number): PhotoRef[] {
  const rows = getDb().prepare(`
    SELECT i.id AS imageId, i.path, i.thumb, f.id AS faceId, f.chip,
      (SELECT COUNT(DISTINCT f2.person_id) FROM faces f2 WHERE f2.image_id = i.id AND f2.person_id IS NOT NULL AND f2.removed = 0) AS people
    FROM faces f JOIN images i ON i.id = f.image_id WHERE f.person_id = ? AND f.removed = 0 ORDER BY i.path`).all(pid) as any[];
  return rows.map(r => ({ imageId: r.imageId, faceId: r.faceId, name: path.basename(r.path), path: r.path, thumbUrl: r.thumb ? fileUrl(r.thumb) : '', faceUrl: faceUrl(r.chip), people: r.people }));
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
  const sortId = Number(d.prepare("INSERT INTO sorts (folder_id, created, state, plan) VALUES (?, ?, 'applying', ?)").run(fid, Date.now(), JSON.stringify(plan)).lastInsertRowid);
  plans.delete(fid);
  let result: ApplyResult | null = null;
  return queue.add('apply', `Sort by person: apply ${path.basename(plan.root)}`, async () => {
    result = await runWorker({ task: 'apply', folderId: fid, root: plan.root, files: [], keepDirs: [], sortId, plan }, ev);
    await syncGroupLinks(plan.root);
  }, () => { /* apply can't be cancelled halfway: Undo afterwards instead */ }).done.then(() => result!);
}

/** Finish an Apply that was interrupted (crash, power loss). */
export function finishSort(sortId: number, ev: Pick<SortEvents, 'apply'>): Promise<ApplyResult> {
  const row = getDb().prepare('SELECT folder_id, plan FROM sorts WHERE id = ?').get(sortId) as { folder_id: number; plan: string };
  const plan = JSON.parse(row.plan) as SortPlan;
  let result: ApplyResult | null = null;
  return queue.add('apply', `Sort by person: finish ${path.basename(plan.root)}`, async () => {
    result = await runWorker({ task: 'finish', folderId: row.folder_id, root: plan.root, files: [], keepDirs: [], sortId, plan }, ev);
    await syncGroupLinks(plan.root);
  }, () => {}).done.then(() => result!);
}

export function undoSortJob(sortId: number, ev: Pick<SortEvents, 'apply'>): Promise<{ restored: number; kept: { path: string; reason: string }[] }> {
  const row = getDb().prepare('SELECT s.folder_id, f.path FROM sorts s JOIN folders f ON f.id = s.folder_id WHERE s.id = ?').get(sortId) as { folder_id: number; path: string };
  let result: any = null;
  return queue.add('undo', `Sort by person: undo ${path.basename(row.path)}`, async () => {
    await syncGroupLinks(row.path, true);    // shortcuts out first, so the folders a sort made can be removed
    result = await runWorker({ task: 'undo', folderId: row.folder_id, root: row.path, files: [], keepDirs: [], sortId }, ev);
    await syncGroupLinks(row.path);          // back for any other sort still in place
  }, () => {}).done.then(() => result);
}

// ---------- v2.5 Photos tab ----------

/** Folders scanned or sorted before that are still there (the Photos tab's list), most recent first. */
export function knownFolders(): KnownFolder[] {
  const rows = getDb().prepare(`SELECT f.id, f.path, f.last_scan,
      (SELECT COUNT(*) FROM people p WHERE p.folder_id = f.id AND (p.dir IS NOT NULL OR (SELECT COUNT(DISTINCT x.image_id) FROM faces x
        WHERE x.person_id = p.id AND x.removed = 0) >= ?)) AS people,
      (SELECT COUNT(*) FROM images i WHERE i.folder_id = f.id AND i.status = 'done') AS photos,
      (SELECT MAX(created) FROM sorts s WHERE s.folder_id = f.id AND s.state = 'done') AS sorted,
      (SELECT COUNT(*) FROM people p WHERE p.folder_id = f.id AND p.dir IS NOT NULL) AS dirs
    FROM folders f ORDER BY COALESCE(sorted, f.last_scan, 0) DESC`).all(getSettings().sort.minPhotos) as { id: number; path: string; last_scan: number | null; people: number; photos: number; sorted: number | null; dirs: number }[];
  return rows.filter(r => r.people > 0 && fs.existsSync(r.path))
    .map(r => ({ id: r.id, path: r.path, people: r.people, photos: r.photos, lastScan: r.last_scan, sorted: r.sorted, personFolders: r.dirs }));
}

/** One person's photos: their folder when it exists (the renderer lists it), else the photos where they are now. */
export function personItems(pid: number): { dir: string | null; items: MediaEntry[] } {
  const p = getDb().prepare('SELECT dir FROM people WHERE id = ?').get(pid) as { dir: string | null } | undefined;
  if (p?.dir && fs.existsSync(p.dir)) return { dir: p.dir, items: [] };
  const items: MediaEntry[] = [];
  for (const r of personPhotos(pid)) {
    try { const st = fs.statSync(r.path); items.push({ name: r.name, path: r.path, kind: 'image', size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ }
  }
  return { dir: null, items: [...new Map(items.map(i => [i.path, i])).values()] };
}

/** FACE-17: image paths of one person, for "Upscale all photos of this person". */
export function personImagePaths(pid: number): { path: string; width: number; height: number }[] {
  return (getDb().prepare(`SELECT DISTINCT i.path, i.width, i.height FROM faces f JOIN images i ON i.id = f.image_id
    WHERE f.person_id = ? AND f.removed = 0 ORDER BY i.path`).all(pid) as { path: string; width: number; height: number }[])
    .filter(r => fs.existsSync(r.path));
}

// ---------- v2.8: time estimate before a scan ----------

/**
 * How long a scan of this folder will take: the photos are counted (only new or changed ones are scanned), then a few
 * of them are put through face finding on this computer. Grouping is estimated from how fast it compares faces.
 */
export function estimateScan(root: string): Promise<ScanEstimate> {
  let result: ScanEstimate | null = null;
  return queue.add('scan', `Sort by person: time a scan of ${path.basename(root)}`, async () => {
    const d = getDb();
    const fid = folderId(d, root, false);
    const files = await listImages(root, getSettings().sort.includeSubfolders, [...(fid != null ? sortDirs(fid) : []), ...sortedFolders(root)]);
    const known = new Map((fid != null ? d.prepare('SELECT path, size, mtime, status FROM images WHERE folder_id = ?').all(fid) as { path: string; size: number; mtime: number; status: string }[] : [])
      .map(r => [r.path.toLowerCase(), r]));
    const todo = files.filter(f => {
      if (f.cloud) return false;
      const r = known.get(f.path.toLowerCase());
      return !r || r.size !== f.size || r.mtime !== f.mtime || r.status === 'pending' || r.status === 'skipped';
    });
    // Up to 9 photos spread over the folder (different subfolders, cameras and sizes).
    const pool = todo.length ? todo : files.filter(f => !f.cloud);
    const step = Math.max(1, Math.floor(pool.length / 9));
    const samples = pool.filter((_, i) => i % step === 0).slice(0, 9).map(f => f.path);
    const t: { provider: string; loadMs: number; sampled: number; msPerPhoto: number; facesPerPhoto: number; dotsPerSecond: number } =
      samples.length ? await runWorker({ task: 'estimate', folderId: fid ?? 0, root, files: [], keepDirs: [], samples }, {})
        : { provider: '', loadMs: 0, sampled: 0, msPerPhoto: 0, facesPerPhoto: 0, dotsPerSecond: 1e6 };
    const scanSeconds = todo.length ? (todo.length * t.msPerPhoto + t.loadMs) / 1000 : 0;
    // Grouping compares every face with the groups so far (about 1 group for every 8 faces in real folders), then
    // groups with each other and leftover faces with everyone.
    const before = fid != null ? (d.prepare('SELECT COUNT(*) AS n FROM faces f JOIN images i ON i.id = f.image_id WHERE i.folder_id = ? AND f.usable = 1').get(fid) as { n: number }).n : 0;
    const F = before + todo.length * t.facesPerPhoto;
    const G = Math.max(10, F / 8);
    const groupSeconds = F ? (F * G + (G * G) / 2 + 0.1 * F * F) / t.dotsPerSecond + F / 20_000 : 0;
    result = {
      files: files.length, toScan: todo.length, cloud: files.filter(f => f.cloud).length,
      sampled: t.sampled, msPerPhoto: t.msPerPhoto, facesPerPhoto: t.facesPerPhoto, provider: t.provider,
      scanSeconds, groupSeconds, seconds: scanSeconds + groupSeconds,
    };
    log('info', `Scan estimate for ${root}: ${JSON.stringify(result)}`);
  }, cancelScan).done.then(() => result!);
}

// ---------- v2.9: merge a person into the people they really are ----------

/** Where each photo of this person belongs, by face (worker: big folders load many fingerprints). */
export async function mergeSuggest(pid: number): Promise<MergePlan> {
  const plan = await runWorker({ task: 'mergeSuggest', folderId: 0, root: '', files: [], keepDirs: [], personId: pid }, {}, false) as MergePlan;
  const chip = getDb().prepare('SELECT chip FROM faces WHERE person_id = ? AND removed = 0 ORDER BY COALESCE(quality, 1) * sharpness * h DESC LIMIT 1');
  const url = (p: MergePhoto) => ({ ...p, thumbUrl: p.thumb && fs.existsSync(p.thumb) ? fileUrl(p.thumb) : '' });
  return {
    ...plan,
    targets: plan.targets.map(t => ({ ...t, photos: t.photos.map(url), faceUrl: faceUrl((chip.get(t.personId) as { chip: string | null } | undefined)?.chip ?? null) })),
    unmatched: plan.unmatched.map(url),
  };
}

/** Merge: chosen photos to their people, or every photo into one person. Shortcuts follow; an emptied folder goes. */
export function mergePerson(pid: number, moves: { imageId: number; to: number }[] | null, all: number | null):
  Promise<MergeResult & { moves: { from: string; to: string }[]; files: string[] }> {
  let result: any = null;
  return queue.add('apply', 'Photos: merge a person', async () => {
    result = await runWorker({ task: 'merge', folderId: 0, root: '', files: [], keepDirs: [], personId: pid, mergeMoves: moves ?? undefined, mergeAll: all ?? undefined }, {});
    await syncGroupLinks(result.root);
    if (result.removed && result.dir) {
      // Only shortcuts PixHaven made could be left; with those gone the folder is empty and goes too.
      try { fs.rmdirSync(result.dir); } catch { /* something else is in it: the folder stays */ }
    }
    log('info', `Merged ${result.merged} photo(s) of person ${pid}: ${result.moved} moved, ${result.renamed} renamed, ${result.left} left, ${result.skipped.length} skipped`);
  }, () => {}).done.then(() => result);
}

// ---------- v2.8: combine people across sorted folders ----------

/** Who is the same person in these sorted folders (by face). */
export function matchAcross(fids: number[], ev: Pick<SortEvents, 'combine'>): Promise<CombineMatch> {
  let result: CombineMatch | null = null;
  return queue.add('combine', `Combine people: compare ${fids.length} folders`, async () => {
    const r = await runWorker({ task: 'match', folderId: fids[0] ?? 0, root: '', files: [], keepDirs: [], folderIds: fids },
      { scan: p => ev.combine({ phase: 'matching', done: p.done, total: p.total }) }) as { people: (Omit<CombineMatch['people'][number], 'faceUrls' | 'folder'> & { root: string })[]; groups: CombineMatch['groups']; ms: number };
    const chips = getDb().prepare('SELECT chip FROM faces WHERE person_id = ? AND removed = 0 ORDER BY COALESCE(quality, 1) * sharpness * h DESC LIMIT 4');
    result = {
      people: r.people.map(({ root, ...p }) => ({ ...p, folder: root, faceUrls: (chips.all(p.id) as { chip: string | null }[]).map(c => faceUrl(c.chip)).filter(Boolean) })),
      groups: r.groups, ms: r.ms,
    };
    log('info', `Combine: ${r.people.length} people in ${fids.length} folders, ${r.groups.length} found in more than one (${r.ms} ms)`);
  }, cancelScan).done.then(() => result!);
}

export function combineEstimate(req: CombineRequest): Promise<CombineEstimate> {
  return runWorker({ task: 'combine', dry: true, folderId: 0, root: req.dest, files: [], keepDirs: [], combine: req }, {}, false);
}

/** Move the people into the destination. Labels and shortcuts follow afterwards (main process). */
export function combine(req: CombineRequest, ev: Pick<SortEvents, 'combine'>): Promise<CombineResult & { moves: { from: string; to: string }[]; files: string[]; roots: string[] }> {
  let result: any = null;
  return queue.add('combine', `Combine people into ${path.basename(req.dest)}`, async () => {
    result = await runWorker({ task: 'combine', folderId: 0, root: req.dest, files: [], keepDirs: [], combine: req }, ev);
    await syncGroupLinks(req.dest);
    for (const r of result.roots as string[]) await syncGroupLinks(r);
    log('info', `Combined ${result.people} people into ${req.dest}: ${result.moved} files moved, ${result.renamed} renamed, ${result.skipped.length} skipped`);
  }, () => { /* moving can't stop halfway safely */ }).done.then(() => result);
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
