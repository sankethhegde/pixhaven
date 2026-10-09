// Upscale jobs: one image (result kept in temp until Save) or a whole folder (saved as it goes).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app } from 'electron';
import sharp from 'sharp';
import type { ImageInfo, JobItem, JobUpdate, Settings, UpscaleOptions } from '@shared/types';
import { openImage as open, isImageFile } from './image-io';
import { runEngine, EngineError } from './engine';
import { modelDir } from './models';
import { planScale, outputPath, uniquePath, isUpscaledName, type ScalePlan } from './plan';
import { log } from './logger';

sharp.cache(false); // don't hold large images in libvips' cache between jobs

// ---------- temp folder ----------
const tempRoot = () => path.join(app.getPath('temp'), 'clearup');
let sessionDir: string | null = null;
export function sessionTemp(): string {
  if (!sessionDir) {
    sessionDir = path.join(tempRoot(), `s-${process.pid}-${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}
/** Remove temp files from earlier runs (and, at quit, this one). */
export function cleanTemp(all = false): void {
  try {
    for (const d of fs.readdirSync(tempRoot())) {
      const p = path.join(tempRoot(), d);
      if (all || p !== sessionDir) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
}

export const fileUrl = (p: string) => `clearup://img/${encodeURIComponent(p)}?v=${safeMtime(p)}`;
const safeMtime = (p: string) => { try { return Math.round(fs.statSync(p).mtimeMs); } catch { return 0; } };

export { isImageFile };

// ---------- reading images ----------
interface Prepared { png: string; width: number; height: number; hasAlpha: boolean }
const prepared = new Map<string, Prepared>();

/** Upright (EXIF-rotated) PNG copy of the input: the engine's input and the "before" preview. */
async function prepare(file: string): Promise<Prepared> {
  const key = `${file}|${safeMtime(file)}`;
  const hit = prepared.get(key);
  if (hit && fs.existsSync(hit.png)) return hit;
  const png = path.join(sessionTemp(), `${crypto.randomUUID()}-in.png`);
  const info = await open(file).rotate().png({ compressionLevel: 1 }).toFile(png);
  const result = { png, width: info.width, height: info.height, hasAlpha: info.channels === 4 };
  prepared.set(key, result);
  return result;
}

export async function inspectImage(file: string): Promise<ImageInfo> {
  const p = await prepare(file);
  return {
    path: file, name: path.basename(file), width: p.width, height: p.height,
    bytes: fs.statSync(file).size, hasAlpha: p.hasAlpha, previewUrl: fileUrl(p.png),
  };
}

/** Image size without decoding the pixels (for folder scans and the >4000 px warning). */
export async function quickSize(file: string): Promise<{ width: number; height: number } | null> {
  try {
    if (/\.bmp$/i.test(file)) {
      const head = Buffer.alloc(26);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, head, 0, 26, 0); fs.closeSync(fd);
      return { width: head.readInt32LE(18), height: Math.abs(head.readInt32LE(22)) };
    }
    const m = await sharp(file).metadata();
    const swap = (m.orientation ?? 1) >= 5;
    return m.width && m.height ? { width: swap ? m.height : m.width, height: swap ? m.width : m.height } : null;
  } catch { return null; }
}

export interface FolderScan { files: { path: string; width: number; height: number }[]; skipped: number; unreadable: string[] }

export async function scanFolder(dir: string): Promise<FolderScan> {
  const files: FolderScan['files'] = [];
  const unreadable: string[] = [];
  let skipped = 0;
  for (const name of fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const p = path.join(dir, name);
    if (!isImageFile(p) || !fs.statSync(p).isFile()) continue;
    if (isUpscaledName(p)) { skipped++; continue; } // our own earlier outputs
    const size = await quickSize(p);
    if (size) files.push({ path: p, ...size }); else unreadable.push(name);
  }
  return { files, skipped, unreadable };
}

// ---------- upscaling one image ----------
async function writeFinal(file: string, aiPng: string, plan: ScalePlan, opts: UpscaleOptions, dest: string): Promise<void> {
  let ai = sharp(aiPng, { limitInputPixels: false });
  if (plan.needsResize) ai = ai.resize(plan.width, plan.height, { fit: 'fill', kernel: 'lanczos3' });
  if (opts.format === 'jpg') ai = ai.flatten({ background: '#ffffff' });
  const { data, info } = await ai.raw().toBuffer({ resolveWithObject: true });

  // Draw the AI pixels over the (rotated) original so its EXIF/ICC metadata carries over; the
  // Orientation tag is reset because the pixels are already upright.
  let out = open(file).rotate().resize(plan.width, plan.height, { fit: 'fill', kernel: 'nearest' });
  if (opts.format === 'jpg' || info.channels === 3) out = out.removeAlpha();
  out = out.composite([{ input: data, raw: { width: info.width, height: info.height, channels: info.channels }, blend: 'source' }]).keepMetadata();
  if (opts.format === 'jpg') out = out.jpeg({ quality: opts.jpgQuality, chromaSubsampling: opts.jpgQuality >= 90 ? '4:4:4' : '4:2:0' });
  else if (opts.format === 'webp') out = out.webp({ quality: opts.jpgQuality });
  else out = out.png({ compressionLevel: 6 });

  const tmp = dest + '.part';
  await out.toFile(tmp);
  fs.renameSync(tmp, dest);
}

async function upscaleOne(
  file: string, opts: UpscaleOptions, settings: Settings, destFor: (file: string) => string,
  signal: AbortSignal, onProgress: (f: number) => void,
): Promise<{ output: string; width: number; height: number; beforeUrl: string }> {
  const p = await prepare(file);
  const plan = planScale(p.width, p.height, opts.size, opts.model);
  if ('error' in plan) throw new EngineError(plan.error);
  const aiPng = path.join(sessionTemp(), `${crypto.randomUUID()}-ai.png`);
  const dir = modelDir(plan.model);
  if (!dir) throw new EngineError('This model is not downloaded yet. Choose it again to download it (45 MB, once).');

  // GEN-06: on out-of-memory, halve the tile size and try again (down to 32).
  let tile = settings.tileSize || 256;
  for (;;) {
    try {
      await runEngine({ input: p.png, output: aiPng, model: plan.model, scale: plan.engineScale, tileSize: tile,
        threads: settings.threads, gpuId: settings.gpuId, cpu: useCpu(settings), modelDir: dir, signal, onProgress: f => onProgress(f * 0.9) });
      break;
    } catch (e) {
      if (e instanceof EngineError && e.outOfMemory && tile > 32) {
        tile = Math.max(32, Math.floor(tile / 2));
        log('warn', `Out of memory, retrying ${path.basename(file)} with tile ${tile}`);
        continue;
      }
      throw e;
    }
  }
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const dest = destFor(file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await writeFinal(file, aiPng, plan, opts, dest);
  fs.rmSync(aiPng, { force: true });
  onProgress(1);
  return { output: dest, width: plan.width, height: plan.height, beforeUrl: fileUrl(p.png) };
}

/** CPU mode: chosen in Settings, or automatic when no Vulkan GPU works (GEN-03). */
let gpuWorks = true;
export function setGpuWorks(ok: boolean): void { gpuWorks = ok; }
export const useCpu = (s: Settings) => s.cpuOnly || !gpuWorks;

// ---------- jobs ----------
const MODEL_COST = { fast: 1, photo: 12, anime: 9 } as const; // relative speed, from the Phase 0 benchmark

export class UpscaleJob {
  readonly id = crypto.randomUUID();
  readonly items: JobItem[];
  private weights: number[];
  private abort = new AbortController();
  private started = 0;
  private lastEmit = 0;

  constructor(
    files: { path: string; width: number; height: number }[],
    private opts: UpscaleOptions,
    private settings: Settings,
    private mode: 'single' | 'folder',
    private emit: (u: JobUpdate) => void,
  ) {
    // Resume: in folder mode, images whose "_upscaled" result already exists are skipped (Settings → skip finished).
    const skip = (p: string) => mode === 'folder' && settings.skipExisting && fs.existsSync(outputPath(p, opts.format, settings.outputDir));
    this.items = files.map(f => ({ id: crypto.randomUUID(), input: f.path, name: path.basename(f.path), progress: 0,
      ...(skip(f.path) ? { state: 'skipped' as const, error: 'Already upscaled' } : { state: 'queued' as const }) }));
    this.weights = files.map(f => f.width * f.height * MODEL_COST[opts.model] + 2e5);
  }

  cancel(): void { this.abort.abort(); }

  /** Tell the UI the job exists (it may wait in the queue before running). */
  announce(): void { this.push(true); }

  private destFor = (file: string): string =>
    this.mode === 'single'
      ? path.join(sessionTemp(), `${crypto.randomUUID()}-result${path.extname(outputPath(file, this.opts.format, null))}`)
      : uniquePath(outputPath(file, this.opts.format, this.settings.outputDir));

  async run(): Promise<void> {
    this.started = Date.now();
    if (this.abort.signal.aborted) { for (const i of this.items) i.state = 'cancelled'; this.push(true, true); return; }
    log('info', `Job ${this.id} (${this.mode}): ${this.items.length} image(s)`, this.opts);
    for (const item of this.items) {
      if (item.state === 'skipped') continue;
      if (this.abort.signal.aborted) { item.state = 'cancelled'; continue; }
      item.state = 'running';
      this.push(true);
      const t = Date.now();
      try {
        const r = await upscaleOne(item.input, this.opts, this.settings, this.destFor, this.abort.signal, f => { item.progress = f; this.push(); });
        Object.assign(item, { state: 'done', progress: 1, output: r.output, outputUrl: fileUrl(r.output), beforeUrl: r.beforeUrl, outWidth: r.width, outHeight: r.height });
      } catch (e) {
        if ((e as Error).name === 'AbortError') item.state = 'cancelled';
        else {
          item.state = 'failed';
          item.error = friendlyError(e);
          log('error', `Failed: ${item.input}`, e);
        }
      }
      item.seconds = (Date.now() - t) / 1000;
      this.push(true);
    }
    this.push(true, true);
    log('info', `Job ${this.id} finished`, this.items.map(i => `${i.name}: ${i.state}`).join(', '));
  }

  private push(force = false, finished = false): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < 100) return;
    this.lastEmit = now;
    const total = this.weights.reduce((a, b) => a + b, 0);
    let doneW = 0;
    this.items.forEach((it, i) => { if (it.state !== 'queued') doneW += this.weights[i] * (it.state === 'running' ? it.progress : 1); });
    const skippedW = this.items.reduce((a, it, i) => a + (it.state === 'skipped' ? this.weights[i] : 0), 0);
    const elapsed = (now - this.started) / 1000;
    const workDone = doneW - skippedW;
    const eta = workDone > 0 && elapsed > 2 && !finished ? (elapsed / workDone) * (total - doneW) : null;
    this.emit({
      jobId: this.id, items: this.items.map(i => ({ ...i })), finished,
      done: this.items.filter(i => i.state !== 'queued' && i.state !== 'running').length,
      total: this.items.length, etaSeconds: eta,
    });
  }
}

export function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  if (e instanceof EngineError) return msg;
  if (/ENOSPC/.test(msg)) return 'The disk is full. Free up some space and try again.';
  if (/EACCES|EPERM/.test(msg)) return 'No permission to write there. Choose another output folder.';
  if (/EBUSY/.test(msg)) return 'The file is locked by another program.';
  if (/unsupported image format|Input file contains unsupported|corrupt|premature end|VipsJpeg|not a BMP|Not a BMP/i.test(msg)) return 'This file is damaged or not a supported image.';
  return msg;
}

/** Single mode: copy the temp result to its final place (default name, or a path the user picked). */
export function saveResult(item: JobItem, opts: UpscaleOptions, settings: Settings, chosen?: string): string {
  if (!item.output || !fs.existsSync(item.output)) throw new Error('The upscaled image is no longer available. Please upscale again.');
  const dest = chosen ?? uniquePath(outputPath(item.input, opts.format, settings.outputDir));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(item.output, dest);
  log('info', `Saved ${dest}`);
  return dest;
}
