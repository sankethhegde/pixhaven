// 1.0.8: worker thread for "people in this video" (the face engine runs here, so the window never waits).
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { openDb } from '../db';
import { FaceEngine } from './detect';
import { MIN_SHARPNESS } from './pipeline';
import { peopleOf } from '../sorter/combine';
import { findPeople, videoFrames } from './video-faces';

export interface VideoWorkerInput {
  dbPath: string; modelsDir: string; preferGpu: boolean; ffmpeg: string;
  input: string[];               // FFmpeg input arguments (a local file, or an Attic URL with its cookie)
  folderIds: number[];           // the sorted folders to look in
  step: number; W: number; H: number; total: number;
  threshold: number; minFace: number;
}

const input = workerData as VideoWorkerInput;
let cancelled = false;
parentPort!.on('message', (m: string) => { if (m === 'cancel') cancelled = true; });

async function main() {
  const db = openDb(input.dbPath);
  const people = peopleOf(db, input.folderIds).filter(p => p.set).map(p => ({ id: p.id, set: p.set! }));
  db.close();
  parentPort!.postMessage({ type: 'progress', done: 0, total: input.total, people: people.length });
  if (!people.length) { parentPort!.postMessage({ type: 'result', result: { frames: 0, faces: 0, unknown: 0, people: [] } }); return; }
  const engine = await FaceEngine.create(path.join(input.modelsDir, 'face'), input.preferGpu);
  let last = 0;
  const result = await findPeople(videoFrames(input.ffmpeg, input.input, input.step, input.W, input.H, () => cancelled), engine, people, {
    threshold: input.threshold, minFace: input.minFace, minSharpness: MIN_SHARPNESS,
    onFrame: done => { if (Date.now() - last > 300) { last = Date.now(); parentPort!.postMessage({ type: 'progress', done, total: input.total }); } },
  });
  parentPort!.postMessage({ type: 'result', result: cancelled ? null : result });
}

main().catch(e => parentPort!.postMessage({ type: 'error', message: String(e?.stack ?? e) }));
