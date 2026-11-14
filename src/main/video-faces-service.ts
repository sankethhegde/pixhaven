// 1.0.8: people in a video (the watch page, under the video in Theatre). Looks for the faces of every sorted folder
// PixHaven knows (on drives that are connected) in frames of the video, in a worker; the answer is kept per video
// (and worked out again when the sorted folders changed), with each person's name, folder and a few photos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import workerPath from './faces/video-worker?modulePath';
import type { VideoFaces, VideoPerson } from '@shared/types';
import { LIB_IMAGE_EXTENSIONS } from '@shared/types';
import type { VideoWorkerInput } from './faces/video-worker';
import { frameSize, frameStep, sureness } from './faces/video-faces';
import { getSettings } from './settings';
import { resourcesDir } from './engine';
import { log } from './logger';
import { getDb, knownFolders, personPhotos } from './sort-service';
import { personLabel } from './sorter/plan';
import { fileUrl } from './upscale-job';
import { inputArgs, probeVideo, tool } from './library/ffmpeg';

const cacheDir = () => path.join(app.getPath('userData'), 'video-faces');
let onUpdate: (v: VideoFaces) => void = () => {};
export const setOnUpdate = (fn: (v: VideoFaces) => void) => { onUpdate = fn; };
let running: { path: string; worker: Worker } | null = null;
const states = new Map<string, VideoFaces>();

/** Stricter than sorting photos: video frames blur, turn and are small. */
const threshold = () => getSettings().sort.strictness + 0.06;
/** What the people of the sorted folders look like now (a new sort or a merge makes old answers stale). */
function peopleStamp(ids: number[]): string {
  if (!ids.length) return 'none';
  const r = getDb().prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(f.id), 0) AS m FROM faces f JOIN people p ON p.id = f.person_id WHERE p.folder_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number; m: number };
  return `${ids.join(',')}|${r.n}|${r.m}|${threshold().toFixed(3)}`;
}
const keyOf = (p: string, size: number, mtime: number) => crypto.createHash('sha1').update(`${p}|${size}|${Math.floor(mtime)}`).digest('hex');
const cacheFile = (k: string) => path.join(cacheDir(), `${k}.json`);

/** A person's details for the page: name, folder, best face and a few photos. */
function personInfo(id: number, hit: { frames: number; mean: number; times: number[] }): VideoPerson | null {
  const d = getDb();
  const p = d.prepare('SELECT p.id, p.num, p.dir, f.path AS root FROM people p JOIN folders f ON f.id = p.folder_id WHERE p.id = ?').get(id) as { id: number; num: number; dir: string | null; root: string } | undefined;
  if (!p) return null;
  const chip = (d.prepare('SELECT chip FROM faces WHERE person_id = ? AND removed = 0 AND chip IS NOT NULL ORDER BY sharpness * h DESC LIMIT 1').get(id) as { chip: string } | undefined)?.chip ?? null;
  let photos: string[];
  if (p.dir && fs.existsSync(p.dir)) {
    photos = fs.readdirSync(p.dir).filter(n => LIB_IMAGE_EXTENSIONS.includes(path.extname(n).slice(1).toLowerCase())).slice(0, 8).map(n => path.join(p.dir!, n));
  } else photos = personPhotos(id).map(r => r.path).filter(x => fs.existsSync(x)).slice(0, 8);
  return {
    id, name: personLabel(p), sure: sureness(hit.mean, threshold()), frames: hit.frames, times: hit.times.slice(0, 12),
    folder: p.dir && fs.existsSync(p.dir) ? p.dir : null, root: p.root,
    face: chip && fs.existsSync(chip) ? fileUrl(chip) : null,
    photos: photos.map(x => ({ path: x, url: fileUrl(x) })),
  };
}

function update(v: VideoFaces) { states.set(v.path, v); onUpdate(v); }

/** The answer for this video if worked out already (and still current), else where the search is. */
export async function get(p: string, size: number, mtime: number): Promise<VideoFaces> {
  const live = states.get(p);
  if (live && running?.path === p) return live;
  const ids = knownFolders().map(k => k.id).filter((x): x is number => typeof x === "number");
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(keyOf(p, size, mtime)), 'utf8'));
    if (c.stamp === peopleStamp(ids)) return c.result as VideoFaces;
  } catch { /* not worked out yet */ }
  return { path: p, state: ids.length ? 'none' : 'no-people', done: 0, total: 0, folders: ids.length, people: [] };
}

/** Starts looking (one video at a time: a new one stops the last). Progress and the answer arrive through onUpdate. */
export async function start(p: string, size: number, mtime: number): Promise<VideoFaces> {
  if (running?.path === p) return states.get(p)!;
  cancel();
  const ids = knownFolders().map(k => k.id).filter((x): x is number => typeof x === "number");
  if (!ids.length) {
    const none: VideoFaces = { path: p, state: 'no-people', done: 0, total: 0, folders: 0, people: [] };
    update(none);
    return none;
  }
  const v = await probeVideo(p);
  if (!v.hasVideo || !v.width) throw new Error('No picture in this video.');
  const step = frameStep(v.duration);
  const { W, H } = frameSize(v.width, v.height);
  const total = Math.max(1, Math.floor(v.duration / step) + 1);
  const s = getSettings();
  const input: VideoWorkerInput = {
    dbPath: path.join(app.getPath('userData'), 'facedata', 'faces.db'), modelsDir: path.join(resourcesDir(), 'models'), preferGpu: !s.cpuOnly,
    ffmpeg: tool('ffmpeg'), input: inputArgs(p), folderIds: ids, step, W, H, total, threshold: threshold(), minFace: s.sort.minFaceSize,
  };
  const t0 = Date.now();
  const stamp = peopleStamp(ids);
  update({ path: p, state: 'searching', done: 0, total, folders: ids.length, people: [] });
  const worker = new Worker(workerPath, { workerData: input });
  running = { path: p, worker };
  worker.on('message', (m: any) => {
    if (running?.worker !== worker && m.type !== 'result') return;
    if (m.type === 'progress') update({ path: p, state: 'searching', done: m.done, total, folders: ids.length, people: [] });
    else if (m.type === 'result') {
      void worker.terminate();
      if (running?.worker === worker) running = null;
      if (!m.result) { states.delete(p); return; }   // cancelled
      const people = (m.result.people as { personId: number; frames: number; mean: number; times: number[] }[])
        .map(h => personInfo(h.personId, h)).filter((x): x is VideoPerson => !!x);
      const result: VideoFaces = { path: p, state: 'done', done: total, total, folders: ids.length, frames: m.result.frames, faces: m.result.faces, unknown: m.result.unknown, people, at: Date.now() };
      log('info', `People in ${path.basename(p)}: ${people.length} found in ${m.result.frames} frame(s), ${m.result.faces} face(s), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      try { fs.mkdirSync(cacheDir(), { recursive: true }); fs.writeFileSync(cacheFile(keyOf(p, size, mtime)), JSON.stringify({ stamp, result })); } catch { /* not kept */ }
      update(result);
    } else if (m.type === 'error') {
      log('error', 'video faces', m.message);
      if (running?.worker === worker) running = null;
      update({ path: p, state: 'error', done: 0, total, folders: ids.length, people: [], error: String(m.message).split('\n')[0] });
    }
  });
  worker.on('error', e => { log('error', 'video faces worker', e); update({ path: p, state: 'error', done: 0, total, folders: ids.length, people: [], error: e.message }); });
  worker.on('exit', () => { if (running?.worker === worker) running = null; });
  return states.get(p)!;
}

/** Stops the search under way (another video opened, or the page closed). */
export function cancel(): void {
  if (!running) return;
  running.worker.postMessage('cancel');
  const w = running.worker;
  setTimeout(() => void w.terminate(), 3000);
  states.delete(running.path);
  running = null;
}
