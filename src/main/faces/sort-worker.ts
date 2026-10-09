// Worker thread for Sort by person. Tasks: scan (→ group → name), regroup, apply, finish, undo.
// Scan results are saved after every image, so a cancelled or crashed scan resumes where it stopped.
// Apply/undo hash every file, so they also run here to keep the window responsive.
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import type { ScanProgress, SortPlan, SortSettings } from '../../shared/types';
import { openDb } from '../db';
import { FaceEngine } from './detect';
import { NameReader } from './names-ocr';
import { syncImages, scanImage, groupFolder, nameFolder, type ListedFile } from './pipeline';
import { applyPlan, undoSort } from '../sorter/apply';
import { syncPhotoInfo, inspectRow } from '../tidy/inspect';

export interface WorkerInput {
  task: 'scan' | 'regroup' | 'apply' | 'finish' | 'undo' | 'inspect';
  sortId?: number;
  plan?: SortPlan;
  dbPath: string;
  folderId: number;
  root: string;
  files: ListedFile[];
  keepDirs: string[];
  modelsDir: string;
  ocrDir: string;
  cacheDir: string;
  thumbsDir: string;
  settings: SortSettings;
  preferGpu: boolean;
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
    const res = await applyPlan(db, input.sortId!, input.plan!, p => parentPort!.postMessage({ type: 'apply', progress: p }), input.task === 'finish');
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
  if (input.task === 'undo') {
    const res = undoSort(db, input.sortId!, input.root, p => parentPort!.postMessage({ type: 'apply', progress: p }));
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

  const reader = s.useOcr ? new NameReader(input.ocrDir, input.cacheDir) : null;
  try {
    await nameFolder(db, input.folderId, reader, (d, t) => {
      if (!cancelled) post({ phase: 'naming', done: d, total: t, faces, people });
    });
  } finally {
    await reader?.close();
  }
  post({ phase: 'done', done: input.files.length, total: input.files.length, faces, people });
  parentPort!.postMessage({ type: 'result', result: { people } });
  db.close();
}

main().catch(e => parentPort!.postMessage({ type: 'error', message: String((e as Error)?.stack ?? e) }));
