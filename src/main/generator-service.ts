// v2.6 Image Generator, main-process side: model download, the worker (loaded on demand, ended after 5 idle minutes to
// give its ~5 GB of memory back), requests through the job queue (one GPU job at a time), saving the images with their
// prompt inside, and the history the tab shows.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { app } from 'electron';
import sharp from 'sharp';
import workerPath from './generator/worker?modulePath';
import type { GenWorkerIn, GenWorkerOut, GenWorkerInput } from './generator/worker';
import type { GenImage, GenProgress, GenRequest, GenStatus, GenStyle, GenSize } from '@shared/types';
import { downloadGenerator, generatorDir, generatorInstalled, MODEL_BYTES, MODEL_LICENCE, MODEL_NAME, MODEL_SOURCE, removeGenerator } from './generator/model';
import { getSettings } from './settings';
import { queue } from './queue';
import { fileUrl } from './upscale-job';
import { log } from './logger';

/**
 * v2.6.1: the style goes first (the model weighs the start of a description most) and each style also says what it is
 * not; the avoid list below goes with every picture (bad anatomy, borders, text and signatures). Tested on the user's
 * own pictures: styles now show clearly, bodies and hands come out better, fewer fake signatures.
 */
export const STYLES: Record<GenStyle, { pre: string; post: string; avoid: string }> = {
  none: { pre: '', post: ', best quality, highly detailed', avoid: '' },
  photo: { pre: 'RAW photo, professional photograph of ', post: ', natural skin texture, sharp focus, 50mm lens, soft natural light, highly detailed', avoid: 'painting, drawing, illustration, cartoon, anime, 3d render, cgi' },
  illustration: { pre: 'digital illustration of ', post: ', clean lines, flat shading, vibrant colors, artstation', avoid: 'photo, realistic, 3d render' },
  anime: { pre: 'anime artwork, key visual of ', post: ', anime style, cel shading, clean line art, vibrant colors', avoid: 'photo, realistic, 3d render' },
  painting: { pre: 'oil painting of ', post: ', visible brush strokes, canvas texture, rich colors, fine art', avoid: 'photo, realistic, 3d render, anime' },
  '3d': { pre: '3d render of ', post: ', octane render, soft studio lighting, subsurface scattering, highly detailed', avoid: 'photo, painting, drawing, anime, flat' },
};
export const AVOID = 'deformed, bad anatomy, extra limbs, fused legs, malformed hands, blurry, lowres, border, frame, white border, poster, cropped, text, signature, watermark, logo';
const STEER = 1.5;
const SAFETY_RETRIES = 2;   // a picture stopped by the safety filter is tried again with new seeds this many times   // strength of the avoid list (2.0 left more stray text in tests)
export const SIZES: Record<GenSize, [number, number]> = { square: [512, 512], portrait: [512, 768], landscape: [768, 512] };
const IDLE_MS = 5 * 60_000;

export const outputDir = () => getSettings().generator.outputDir ?? path.join(app.getPath('pictures'), 'PixHaven');
const historyFile = () => path.join(app.getPath('userData'), 'generator-history.json');

// ---------- worker ----------
let worker: Worker | null = null;
let device: 'dml' | 'cpu' | null = null;
let idle: NodeJS.Timeout | null = null;
const listeners = new Set<(m: GenWorkerOut) => void>();

function startWorker(): Worker {
  if (worker) return worker;
  const data: GenWorkerInput = { modelDir: generatorDir(), preferGpu: !getSettings().cpuOnly };
  const w = new Worker(workerPath, { workerData: data });
  w.on('message', (m: GenWorkerOut) => {
    if (m.type === 'ready') { device = m.device; log('info', `Image Generator loaded on ${m.device} in ${m.ms} ms`); }
    for (const l of listeners) l(m);
  });
  w.on('error', e => { log('error', 'Image Generator worker crashed', e); for (const l of listeners) l({ type: 'error', message: friendly(e.message) }); });
  w.on('exit', () => { if (worker === w) { worker = null; device = null; } });
  worker = w;
  return w;
}
function keepAlive(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { void worker?.terminate(); worker = null; device = null; log('info', 'Image Generator unloaded (idle)'); }, IDLE_MS);
}
const send = (m: GenWorkerIn) => startWorker().postMessage(m);

/** The graphics card went away under the generator (DXGI device removed / suspended). */
const deviceLost = (msg: string) => /887A0005|887A0006|887A0007|887A0020|device instance has been suspended|DEVICE_REMOVED|device removed/i.test(msg);

function friendly(msg: string): string {
  if (deviceLost(msg)) return 'The graphics card stopped responding (this can happen on battery power or after sleep). Plug the laptop in and try again; PixHaven restarts the generator by itself.';
  if (/DmlExecutionProvider|D3D12|DXGI|dml/i.test(msg)) return 'The graphics card could not run the Image Generator. Update the graphics driver, or turn off "Use the processor only" in Settings.';
  if (/memory|bad_alloc|ENOMEM/i.test(msg)) return 'Not enough memory to make the image. Close other programs, or choose a smaller size.';
  return msg;
}

// ---------- history ----------
function readHistory(): GenImage[] {
  try { return JSON.parse(fs.readFileSync(historyFile(), 'utf8')) as GenImage[]; } catch { return []; }
}
function writeHistory(list: GenImage[]): void {
  fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
  fs.writeFileSync(historyFile(), JSON.stringify(list.slice(0, 300), null, 1));
}
/** Images made before that are still there, newest first (with fresh URLs). */
export function history(): GenImage[] {
  return readHistory().filter(h => h.path && fs.existsSync(h.path)).map(h => ({ ...h, url: fileUrl(h.path!) }));
}
export function forget(id: string): void { writeHistory(readHistory().filter(h => h.id !== id)); }

// ---------- status / download ----------
let dl: GenStatus['download'] = { state: 'idle', got: 0, total: MODEL_BYTES };
let dlAbort: AbortController | null = null;

export function status(): GenStatus {
  return {
    installed: generatorInstalled(), bytes: MODEL_BYTES, device, loaded: !!worker, outputDir: outputDir(), download: dl,
    modelName: MODEL_NAME, source: MODEL_SOURCE, licence: MODEL_LICENCE,
  };
}

export async function download(onUpdate: (s: GenStatus) => void): Promise<void> {
  if (dl.state === 'downloading') return;
  dlAbort = new AbortController();
  dl = { state: 'downloading', got: 0, total: MODEL_BYTES };
  onUpdate(status());
  let last = 0;
  try {
    await downloadGenerator((got, total) => {
      dl = { state: 'downloading', got, total };
      if (Date.now() - last > 250) { last = Date.now(); onUpdate(status()); }
    }, dlAbort.signal);
    dl = { state: 'idle', got: MODEL_BYTES, total: MODEL_BYTES };
  } catch (e) {
    dl = { state: 'error', got: dl.got, total: MODEL_BYTES, error: (e as Error).message };
    log('warn', 'Image Generator download failed', e);
  } finally { dlAbort = null; onUpdate(status()); }
}
export function cancelDownload(): void { dlAbort?.abort(); }

export async function remove(): Promise<void> {
  await worker?.terminate(); worker = null; device = null;
  removeGenerator();
}

// ---------- generating ----------
export function tokens(prompt: string): Promise<number> {
  if (!generatorInstalled()) return Promise.resolve(0);
  const id = crypto.randomUUID();
  return new Promise(resolve => {
    const l = (m: GenWorkerOut) => { if ((m.type === 'tokens' || m.type === 'error') && m.id === id) { listeners.delete(l); resolve(m.type === 'tokens' ? m.count : 0); } };
    listeners.add(l);
    send({ type: 'tokens', id, prompt });
    keepAlive();
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6).join(' ') || 'image';
function fileName(dir: string, prompt: string, seed: number, ext: string): string {
  const d = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())} ${slug(prompt)} (seed ${seed})`;
  let p = path.join(dir, `${base}.${ext}`);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i}).${ext}`);
  return p;
}
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The prompt and settings go inside the PNG (XMP description), so the picture remembers how it was made. */
function xmp(img: Omit<GenImage, 'url' | 'path' | 'id'>): string {
  const desc = `${img.prompt} | style ${img.style}, seed ${img.seed}, ${img.steps} steps, ${img.width}x${img.height} | ${MODEL_NAME}`;
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(desc)}</rdf:li></rdf:Alt></dc:description>
<xmp:CreatorTool>PixHaven Image Generator</xmp:CreatorTool>
</rdf:Description></rdf:RDF></x:xmpmeta>`;
}

/** Queue a request. Progress (and each finished image) arrives through `onProgress`. Returns the queue job id. */
export function generate(req: GenRequest, onProgress: (p: GenProgress) => void): string {
  if (!generatorInstalled()) throw new Error('Download the Image Generator model first.');
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error('Describe the picture you want first.');
  const [width, height] = SIZES[req.size];
  const steps = req.quality === 'better' ? 8 : 4;
  const count = Math.min(4, Math.max(1, Math.round(req.count)));
  const seed0 = req.seed ?? Math.floor(Math.random() * 2 ** 31);
  const st = STYLES[req.style];
  const full = st.pre + prompt + st.post;
  const negative = [st.avoid, AVOID].filter(Boolean).join(', ');
  const format = req.format ?? 'jpg';
  let id = crypto.randomUUID();
  let cancel = false;
  // Which of the request's images the worker is making now (all of them; after a recovery, the ones still missing).
  let batch = Array.from({ length: count }, (_, i) => i);
  const made = new Set<number>();
  let retried = false;
  // v2.7.1: a picture stopped by the safety filter is made again with a fresh seed (up to SAFETY_RETRIES times).
  const seedOf = new Map<number, number>();
  const tries = new Map<number, number>();
  let nextSeed = seed0 + count;
  let redo: number[] = [];
  const seedFor = (i: number) => seedOf.get(i) ?? seed0 + i;
  const images = (idx: number[]) => idx.map(i => ({ prompt: full, negative, cfg: STEER, seed: seedFor(i), steps, width, height }));
  // The queue may start this at once (before queue.add returns): wait a tick so the job id is known.
  const job = queue.add('generate', `Image Generator: ${count} image${count === 1 ? '' : 's'}`, async () => { await new Promise(r => setImmediate(r)); return run(); }, () => { cancel = true; if (worker) send({ type: 'cancel' }); });
  const run = () => new Promise<void>((resolve) => {
    if (idle) clearTimeout(idle);
    const dir = outputDir();
    fs.mkdirSync(dir, { recursive: true });
    onProgress({ jobId: job.id, index: 0, count, step: 0, steps: steps + 1, phase: worker && device ? 'working' : 'loading' });
    const handle = async (m: GenWorkerOut) => {
      if (m.type === 'ready') onProgress({ jobId: job.id, index: 0, count, step: 0, steps: steps + 1, phase: 'working' });
      if (!('id' in m) || m.id !== id) { if (m.type === 'error' && !('id' in m && m.id)) { listeners.delete(l); onProgress({ jobId: job.id, index: 0, count, step: 0, steps: steps + 1, phase: 'error', error: m.message }); keepAlive(); resolve(); } return; }
      if (m.type === 'step') onProgress({ jobId: job.id, index: batch[m.index], count, step: m.done, steps: m.total, phase: 'working' });
      else if (m.type === 'image') {
        const index = batch[m.index];
        if (m.nsfw && (tries.get(index) ?? 0) < SAFETY_RETRIES && !cancel) {
          // Not shown, not saved: tried again (after this round) with the next unused seed.
          tries.set(index, (tries.get(index) ?? 0) + 1);
          seedOf.set(index, nextSeed++);
          redo.push(index);
          log('info', `Image Generator: picture ${index + 1} stopped by the safety filter; trying seed ${seedFor(index)}`);
          return;
        }
        made.add(index);
        const seed = seedFor(index);
        const base = { prompt, style: req.style, seed, width: m.width, height: m.height, steps, created: Date.now() };
        let image: GenImage;
        if (m.nsfw) {
          // Stopped by the safety filter: not saved, shown only as a heavily blurred tile.
          const blurred = await sharp(Buffer.from(m.rgb), { raw: { width: m.width, height: m.height, channels: 3 } }).resize(64).blur(8).jpeg().toBuffer();
          image = { ...base, id: crypto.randomUUID(), path: null, url: `data:image/jpeg;base64,${blurred.toString('base64')}`, hidden: true };
        } else {
          const file = fileName(dir, prompt, seed, format);
          const img = sharp(Buffer.from(m.rgb), { raw: { width: m.width, height: m.height, channels: 3 } }).withXmp(xmp(base));
          await (format === 'jpg' ? img.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }) : format === 'webp' ? img.webp({ quality: 92 }) : img.png()).toFile(file);
          image = { ...base, id: crypto.randomUUID(), path: file, url: fileUrl(file) };
          writeHistory([image, ...readHistory()]);
        }
        onProgress({ jobId: job.id, index, count, step: steps + 1, steps: steps + 1, phase: 'working', image });
      } else if (m.type === 'error' && deviceLost(m.message) && !retried && !cancel && made.size < count) {
        // Windows suspended the graphics card (driver reset, power saving): start the generator again, once, and
        // make the pictures still missing.
        retried = true;
        log('warn', `Image Generator: graphics device lost (${m.message.slice(0, 120)}); restarting and retrying ${count - made.size} image(s)`);
        await worker?.terminate(); worker = null; device = null;
        batch = Array.from({ length: count }, (_, i) => i).filter(i => !made.has(i)); redo = [];
        id = crypto.randomUUID();
        onProgress({ jobId: job.id, index: batch[0], count, step: 0, steps: steps + 1, phase: 'loading' });
        send({ type: 'generate', id, images: images(batch) });
      } else if (m.type === 'done' && !m.cancelled && !cancel && redo.length) {
        // Another round for the pictures the safety filter stopped.
        batch = redo; redo = [];
        id = crypto.randomUUID();
        send({ type: 'generate', id, images: images(batch) });
      } else if (m.type === 'done' || m.type === 'error') {
        listeners.delete(l);
        if (m.type === 'error' && deviceLost(m.message)) { await worker?.terminate(); worker = null; device = null; }   // next request starts fresh
        onProgress({ jobId: job.id, index: count - 1, count, step: steps + 1, steps: steps + 1,
          phase: m.type === 'error' ? 'error' : m.cancelled ? 'cancelled' : 'done', error: m.type === 'error' ? friendly(m.message) : undefined });
        keepAlive();
        resolve();
      }
    };
    // Messages one after another: an image is saved before the next one (or the end) is handled.
    let chain = Promise.resolve();
    const l = (m: GenWorkerOut) => {
      chain = chain.then(() => handle(m)).catch(e => {
        listeners.delete(l);
        send({ type: 'cancel' });
        log('error', 'Image Generator: could not save an image', e);
        onProgress({ jobId: job.id, index: 0, count, step: 0, steps: steps + 1, phase: 'error', error: `The image could not be saved: ${friendly(String((e as Error)?.message ?? e))}` });
        keepAlive();
        resolve();
      });
    };
    listeners.add(l);
    if (cancel) { send({ type: 'cancel' }); }
    send({ type: 'generate', id, images: images(batch) });
  }).catch(e => {
    // Anything unexpected still ends the request in the window.
    log('error', 'Image Generator request failed', e);
    onProgress({ jobId: job.id, index: 0, count, step: 0, steps: steps + 1, phase: 'error', error: friendly(String((e as Error)?.message ?? e)) });
  });
  log('info', `Image Generator: ${count} × ${width}×${height}, ${steps} steps, seed ${seed0}, style ${req.style}`);
  return job.id;
}

export function close(): void { void worker?.terminate(); }
