// Worker thread for Sort by person. Tasks: scan (→ group), regroup, apply, finish, undo; v2.8: estimate (time a few
// photos), match and combine (people across sorted folders).
// Scan results are saved after every image, so a cancelled or crashed scan resumes where it stopped.
// Apply/undo hash every file, so they also run here to keep the window responsive.
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import type { CombineRequest, ScanProgress, SortPlan, SortSettings } from '../../shared/types';
import { openDb } from '../db';
import { FaceEngine } from './detect';
import { syncImages, scanImage, groupFolder, trialScan, type ListedFile } from './pipeline';
import { dot } from './cluster';
import { combineFolders, estimateCombine, matchPeople, peopleOf } from '../sorter/combine';
import { applyPlan, undoSort } from '../sorter/apply';
import { syncPhotoInfo, inspectRow } from '../tidy/inspect';

export interface WorkerInput {
  task: 'scan' | 'regroup' | 'apply' | 'finish' | 'undo' | 'inspect' | 'estimate' | 'match' | 'combine';
  sortId?: number;
  plan?: SortPlan;
  dbPath: string;
  folderId: number;
  root: string;
  files: ListedFile[];
  keepDirs: string[];
  modelsDir: string;
  thumbsDir: string;
  settings: SortSettings;
  preferGpu: boolean;
  exiftool?: string;
  folderIds?: number[];          // match
  combine?: CombineRequest;      // combine (dry: only the estimate)
  dry?: boolean;
  samples?: string[];            // estimate
}

const input = workerData as WorkerInput;
let paused = false;
let cancelled = false;
parentPort!.on('message', (m: string) => {
  if (m === 'pause') paused = true;
  if (m === 'resume') paused = false;
  if (m === 'cancel') { cancelled = true; paused = false; }
});

const post = (p: Partial<ScanProgress> & { phase: ScanProgress['phase'] }) =>
  parentPort!.postMessage({ type: 'progress', progress: { folder: input.root, done: 0, total: 0, faces: 0, people: 0, ...p } });

async function main(): Promise<void> {
  const db = openDb(input.dbPath);
  const s = input.settings;

  if (input.task === 'apply' || input.task === 'finish') {
    const res = await applyPlan(db, input.sortId!, input.plan!, p => parentPort!.postMessage({ type: 'apply', progress: p }), input.task === 'finish', input.exiftool);
    parentPort!.postMessage({ type: 'result', result: res });
    db.close();
    return;
  }
  if (input.task === 'inspect') {
    // Tidy tools: hashes, blur, date and GPS for every photo (cached; only new or changed files are read).
    const todo = syncPhotoInfo(db, input.folderId, input.files);
    const already = input.files.length - todo.length;
    const t0 = Date.now();
    for (let k = 0; k < todo.length; k++) {
      while (paused) { post({ phase: 'scanning', done: already + k, total: input.files.length, paused: true }); await new Promise(r => setTimeout(r, 300)); }
      if (cancelled) { post({ phase: 'cancelled', done: already + k, total: input.files.length }); parentPort!.postMessage({ type: 'result', result: { cancelled: true } }); return; }
      await inspectRow(db, todo[k], input.thumbsDir);
      const elapsed = (Date.now() - t0) / 1000;
      post({ phase: 'scanning', done: already + k + 1, total: input.files.length,
        current: path.basename((db.prepare('SELECT path FROM photo_info WHERE id = ?').get(todo[k]) as { path: string }).path),
        etaSeconds: k >= 2 ? (elapsed / (k + 1)) * (todo.length - k - 1) : null });
    }
    post({ phase: 'done', done: input.files.length, total: input.files.length });
    parentPort!.postMessage({ type: 'result', result: { inspected: todo.length } });
    db.close();
    return;
  }
  if (input.task === 'estimate') {
    // Model load, then a few of the folder's photos timed (the first one warms up the engine and is not counted).
    let t = Date.now();
    const engine = await FaceEngine.create(path.join(input.modelsDir, 'face'), input.preferGpu);
    const loadMs = Date.now() - t;
    const times: number[] = [];
    let faces = 0, read = 0;
    for (const [k, f] of (input.samples ?? []).entries()) {
      if (cancelled) break;
      t = Date.now();
      const n = await trialScan(engine, f, s);
      if (n < 0) continue;
      if (k > 0 || (input.samples ?? []).length === 1) times.push(Date.now() - t);
      faces += n; read++;
      post({ phase: 'scanning', done: k + 1, total: input.samples!.length, faces });
    }
    // How fast this computer compares face fingerprints (for the grouping step).
    const a = new Float32Array(512).map(() => Math.random()), b = new Float32Array(512).map(() => Math.random());
    t = performance.now();
    let x = 0;
    for (let i = 0; i < 200_000; i++) x += dot(a, b);
    const dotsPerSecond = 200_000 / Math.max(1e-3, (performance.now() - t) / 1000);
    if (!Number.isFinite(x)) post({ phase: 'scanning', done: 0, total: 0 });   // keeps the timed loop from being optimised away
    times.sort((p, q) => p - q);
    parentPort!.postMessage({ type: 'result', result: {
      provider: engine.provider, loadMs, sampled: read, msPerPhoto: times.length ? times[Math.floor(times.length / 2)] : 0,
      facesPerPhoto: read ? faces / read : 0, dotsPerSecond,
    } });
    db.close();
    return;
  }
  if (input.task === 'match') {
    const people = peopleOf(db, input.folderIds ?? []);
    const t = Date.now();
    const groups = matchPeople(people, s.strictness, (done, total) => post({ phase: 'grouping', done, total }));
    parentPort!.postMessage({ type: 'result', result: {
      people: people.map(({ set, ...p }) => ({ ...p, matchable: !!set })), groups, ms: Date.now() - t,
    } });
    db.close();
    return;
  }
  if (input.task === 'combine') {
    if (input.dry) { parentPort!.postMessage({ type: 'result', result: estimateCombine(db, input.combine!) }); db.close(); return; }
    const res = await combineFolders(db, input.combine!, p => parentPort!.postMessage({ type: 'combine', progress: p }), input.exiftool);
    parentPort!.postMessage({ type: 'result', result: res });
    db.close();
    return;
  }
  if (input.task === 'undo') {
    const res = await undoSort(db, input.sortId!, input.root, p => parentPort!.postMessage({ type: 'apply', progress: p }), input.exiftool);
    parentPort!.postMessage({ type: 'result', result: res });
    db.close();
    return;
  }
  let faces = 0;

  if (input.task === 'scan') {
    const todo = syncImages(db, input.folderId, input.files, input.keepDirs);
    const already = input.files.length - todo.length;
    const engine = await FaceEngine.create(path.join(input.modelsDir, 'face'), input.preferGpu);
    parentPort!.postMessage({ type: 'log', message: `face engine: ${engine.provider}, ${todo.length} to scan, ${already} already scanned` });
    faces = (db.prepare('SELECT COUNT(*) AS n FROM faces f JOIN images i ON i.id = f.image_id WHERE i.folder_id = ?').get(input.folderId) as { n: number }).n;

    // Rough live "people so far": greedy grouping of the new fingerprints only (the real grouping runs after).
    const live: { sum: Float32Array; n: number }[] = [];
    const t0 = Date.now();
    for (let k = 0; k < todo.length; k++) {
      while (paused) { post({ phase: 'scanning', done: already + k, total: input.files.length, faces, people: live.length, paused: true }); await new Promise(r => setTimeout(r, 300)); }
      if (cancelled) { post({ phase: 'cancelled', done: already + k, total: input.files.length, faces, people: live.length }); parentPort!.postMessage({ type: 'result', result: { cancelled: true } }); return; }
      const r = await scanImage(db, engine, todo[k], input.thumbsDir, s);
      faces += r.faces;
      for (const e of r.embs) {
        let best = -1, bi = -1;
        live.forEach((g, i) => { let d = 0; for (let j = 0; j < e.length; j++) d += e[j] * g.sum[j]; d /= g.n; if (d > best) { best = d; bi = i; } });
        if (best >= s.strictness) { const g = live[bi]; for (let j = 0; j < e.length; j++) g.sum[j] += e[j]; g.n++; }
        else live.push({ sum: Float32Array.from(e), n: 1 });
      }
      const elapsed = (Date.now() - t0) / 1000;
      post({
        phase: 'scanning', done: already + k + 1, total: input.files.length, faces, people: live.length,
        current: path.basename((db.prepare('SELECT path FROM images WHERE id = ?').get(todo[k]) as { path: string }).path),
        etaSeconds: k >= 2 ? (elapsed / (k + 1)) * (todo.length - k - 1) : null,
      });
    }
    db.prepare('UPDATE folders SET last_scan = ? WHERE id = ?').run(Date.now(), input.folderId);
  }

  post({ phase: 'grouping', done: input.files.length, total: input.files.length, faces });
  const people = groupFolder(db, input.folderId, s.strictness);

  post({ phase: 'done', done: input.files.length, total: input.files.length, faces, people });
  parentPort!.postMessage({ type: 'result', result: { people } });
  db.close();
}

main().catch(e => parentPort!.postMessage({ type: 'error', message: String((e as Error)?.stack ?? e) }));
