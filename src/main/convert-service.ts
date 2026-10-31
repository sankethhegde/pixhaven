// v2.11 Video editor: converting videos to other formats (and phone photos to JPG / PNG), no upscaling; phase 2 adds
// edits of one video, joining several and saving frames.
// Runs through the job queue, one file at a time, with progress, speed and time left; Stop ends the running file and
// removes what it had written. Never overwrites: a taken name gets "(converted)". Originals are never changed; the
// new file keeps the original's date (and, for photos, its EXIF through ExifTool).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import sharp from 'sharp';
import type { ConvertCaps, ConvertFile, ConvertOptions, ConvertProgress, ConvertResult, ConvertTarget, EditSpec } from '@shared/types';
import { mediaKind } from '@shared/types';
import { run, tool, decodeStill } from './library/ffmpeg';
import { app } from 'electron';
import { keyframeAtOrBefore, probeMedia, type MediaProbe } from './library/player';
import { onlyCuts, outputsOf, planEdit, planJoin, type Run } from './convert/edit';
import { ENCODERS, TARGETS, outputName, pixFmt, planConvert, progressSeconds, type Codec } from './convert/plan';
import { exiftool } from './tags-service';
import { queue } from './queue';
import { log } from './logger';

const HEIF = /\.(heic|heif|hif|avif)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus|wma)$/i;

// ---------- what this computer can make ----------

let caps: Promise<Record<Codec, string | null>> | null = null;
/** The first encoder that works for each codec (a 2-frame test encode; once per run). */
function encoders(): Promise<Record<Codec, string | null>> {
  caps ??= (async () => {
    const out = {} as Record<Codec, string | null>;
    for (const codec of Object.keys(ENCODERS) as Codec[]) {
      out[codec] = null;
      for (const e of ENCODERS[codec]) {
        try {
          await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=320x240:rate=25', '-frames:v', '3', '-vf', `format=${pixFmt(e)}`, '-c:v', e, '-f', 'null', '-'], 20000);
          out[codec] = e;
          break;
        } catch { /* not here */ }
      }
    }
    log('info', `Converter encoders: ${JSON.stringify(out)}`);
    return out;
  })();
  return caps;
}

export async function capabilities(): Promise<ConvertCaps> {
  const enc = await encoders();
  const targets = {} as ConvertCaps['targets'];
  for (const [t, spec] of Object.entries(TARGETS) as [ConvertTarget, (typeof TARGETS)[ConvertTarget]][]) {
    const codec = spec.video && spec.video !== 'gif' ? spec.video : null;
    const e = codec ? enc[codec] : null;
    targets[t] = codec && !e
      ? { ok: false, encoder: null, why: 'Not available on this computer' }
      : { ok: true, encoder: e };
  }
  return { targets };
}

// ---------- the files ----------

export async function inspect(paths: string[]): Promise<ConvertFile[]> {
  const out: ConvertFile[] = [];
  for (const p of paths) {
    const st = await fs.promises.stat(p).catch(() => null);
    const base = { path: p, name: path.basename(p), size: st?.size ?? 0 };
    if (!st?.isFile()) { out.push({ ...base, kind: 'other', error: 'Not there any more' }); continue; }
    const k = mediaKind(p);
    if (k === 'image') {
      const m = HEIF.test(p) ? null : await sharp(p).metadata().catch(() => null);
      out.push({ ...base, kind: 'image', width: m?.width, height: m?.height, codec: path.extname(p).slice(1).toUpperCase() });
      continue;
    }
    if (k !== 'video' && !AUDIO.test(p)) { out.push({ ...base, kind: 'other', error: 'Not a video, sound or photo file' }); continue; }
    try {
      const m = await probeMedia(p);
      out.push({ ...base, kind: m.video ? 'video' : 'audio', duration: m.duration, width: m.video?.width, height: m.video?.height, codec: m.video?.codec, audio: m.audio[0]?.codec });
    } catch (e) { out.push({ ...base, kind: 'other', error: `Could not read it (${(e as Error).message})` }); }
  }
  return out;
}

// ---------- converting ----------

let stop: (() => void) | null = null;
export const cancel = () => stop?.();

/** One FFmpeg run with progress; resolves when done. */
function ffmpeg(args: string[], duration: number, onTime: (t: number) => void, signal: { kill?: () => void }): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(tool('ffmpeg'), args, { windowsHide: true });
    signal.kill = () => p.kill();
    let err = '';
    p.stdout.on('data', d => { const t = progressSeconds(String(d)); if (t !== null) onTime(Math.min(duration || t, t)); });
    p.stderr.on('data', d => { if (err.length < 4000) err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).pop() || `FFmpeg stopped (${code})`))));
  });
}

async function keepPhotoFacts(from: string, to: string): Promise<void> {
  const et = exiftool();
  if (!fs.existsSync(et)) return;
  await new Promise<void>(r => execFile(et, ['-q', '-q', '-overwrite_original', '-TagsFromFile', from, '-all:all', '-unsafe', '-Orientation=', to], { windowsHide: true, timeout: 30000 }, () => r()));
}

export function start(files: string[], o: ConvertOptions, onProgress: (p: ConvertProgress) => void): { jobId: string; done: Promise<ConvertResult> } {
  const jobId = crypto.randomUUID();
  const t = TARGETS[o.target];
  const res: ConvertResult = { done: [], failed: [], skipped: [], cancelled: false };
  let cancelled = false;
  const signal: { kill?: () => void } = {};
  const label = `Video editor: ${files.length} file${files.length === 1 ? '' : 's'} to ${t.ext.toUpperCase()}`;
  const job = queue.add('convert', label, async () => {
    stop = () => { cancelled = true; signal.kill?.(); };
    const enc = await encoders();
    for (let i = 0; i < files.length && !cancelled; i++) {
      const file = files[i];
      const name = path.basename(file);
      const tell = (p: Partial<ConvertProgress> & Pick<ConvertProgress, 'state'>) => onProgress({ jobId, index: i, total: files.length, file: name, percent: 0, ...p });
      const kind = mediaKind(file) ?? (AUDIO.test(file) ? 'audio' : null);
      // Photos become photos; videos become videos, sound or GIFs; sound files only sound.
      const fits = t.kind === 'photo' ? kind === 'image' : t.kind === 'audio' ? kind === 'video' || kind === 'audio' : kind === 'video';
      if (!fits) {
        const reason = t.kind === 'photo' ? 'Not a photo' : kind === 'image' ? 'A photo: choose JPG or PNG for photos' : 'Not a video';
        res.skipped.push({ path: file, reason }); tell({ state: 'skipped', error: reason }); continue;
      }
      const dir = o.outDir ?? path.dirname(file);
      const out = outputName(file, t.ext, dir, fs.existsSync);
      const part = `${out}.part.${t.ext}`;
      const t0 = Date.now();
      tell({ state: 'running' });
      try {
        let note: string | undefined;
        if (t.kind === 'photo') {
          const input = HEIF.test(file) ? await decodeStill(file) : await fs.promises.readFile(file);
          const img = sharp(input).rotate().withMetadata();
          await (t.ext === 'png' ? img.png({ compressionLevel: 6 }) : img.jpeg({ quality: { small: 80, balanced: 90, best: 96 }[o.quality], mozjpeg: true })).toFile(part);
          if (HEIF.test(file)) await keepPhotoFacts(file, part);
        } else {
          const p: MediaProbe = await probeMedia(file);
          const codec = t.video && t.video !== 'gif' ? t.video : null;
          const plan = planConvert(file, part, p, o, codec ? enc[codec] : null);
          note = plan.note;
          let last = 0;
          await ffmpeg(plan.args, p.duration, s => {
            if (Date.now() - last < 300) return;
            last = Date.now();
            const el = (Date.now() - t0) / 1000;
            const pct = p.duration ? Math.min(99, (s / p.duration) * 100) : 0;
            tell({ state: 'running', percent: pct, speed: el > 0 ? s / el : undefined, etaSeconds: s > 0 && p.duration ? (el / s) * (p.duration - s) : null });
          }, signal);
        }
        if (cancelled) throw new Error('Stopped');
        fs.renameSync(part, out);
        const st = fs.statSync(file);
        await fs.promises.utimes(out, st.atime, st.mtime).catch(() => {});
        const size = fs.statSync(out).size;
        res.done.push({ from: file, to: out, size, note });
        tell({ state: 'done', percent: 100, out, outSize: size, note });
        log('info', `Converted ${file} → ${out} (${(size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s)${note ? `; ${note}` : ''}`);
      } catch (e) {
        fs.rmSync(part, { force: true });
        if (cancelled) { tell({ state: 'cancelled' }); break; }
        const reason = (e as Error).message;
        res.failed.push({ path: file, reason });
        tell({ state: 'failed', error: reason });
        log('warn', `Could not convert ${file}`, e);
      }
    }
    res.cancelled = cancelled;
    stop = null;
    onProgress({ jobId, index: files.length, total: files.length, file: '', percent: 100, state: 'finished' });
  }, () => { cancelled = true; signal.kill?.(); });
  return { jobId, done: job.done.then(() => res) };
}

// ---------- v2.11 phase 2: edit one video, join several, save frames ----------

/** A free name like "clip (edited).mp4", "clip (edited 2).mp4" in `dir` (never overwrites). */
function freeName(dir: string, stem: string, ext: string): string {
  for (let i = 1; ; i++) {
    const s = i === 1 ? stem : stem.endsWith(')') ? `${stem.slice(0, -1)} ${i})` : `${stem} (${i})`;
    const p = path.join(dir, ext ? `${s}.${ext}` : s);
    if (!fs.existsSync(p)) return p;
  }
}
const FONTS = process.platform === 'win32'
  ? ['C:\\Windows\\Fonts\\segoeuib.ttf', 'C:\\Windows\\Fonts\\segoeui.ttf', 'C:\\Windows\\Fonts\\arialbd.ttf', 'C:\\Windows\\Fonts\\arial.ttf']
  : ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'];

/** Runs FFmpeg jobs one after another through the queue, with progress per output. */
function runOutputs(label: string, prepare: () => Promise<{ runs: Run[]; source: string; note?: string; cleanup?: () => void }>, onProgress: (p: ConvertProgress) => void): { jobId: string; done: Promise<ConvertResult> } {
  const jobId = crypto.randomUUID();
  const res: ConvertResult = { done: [], failed: [], skipped: [], cancelled: false };
  let cancelled = false;
  const signal: { kill?: () => void } = {};
  const job = queue.add('convert', label, async () => {
    stop = () => { cancelled = true; signal.kill?.(); };
    let prep: Awaited<ReturnType<typeof prepare>> | null = null;
    try {
      prep = await prepare();
      const { runs, source, note } = prep;
      for (let i = 0; i < runs.length && !cancelled; i++) {
        const r = runs[i];
        const name = path.basename(r.out);
        const part = `${r.out}.part${path.extname(r.out)}`;
        const args = [...r.args.slice(0, -1), part];
        const t0 = Date.now();
        const tell = (p: Partial<ConvertProgress> & Pick<ConvertProgress, 'state'>) => onProgress({ jobId, index: i, total: runs.length, file: name, percent: 0, ...p });
        tell({ state: 'running', note });
        try {
          let last = 0;
          await ffmpeg(args, r.duration, s => {
            if (Date.now() - last < 300) return;
            last = Date.now();
            const el = (Date.now() - t0) / 1000;
            tell({ state: 'running', percent: r.duration ? Math.min(99, (s / r.duration) * 100) : 0, speed: el > 0 ? s / el : undefined, etaSeconds: s > 0 ? (el / s) * (r.duration - s) : null, note });
          }, signal);
          if (cancelled) throw new Error('Stopped');
          fs.renameSync(part, r.out);
          const st = fs.statSync(source);
          await fs.promises.utimes(r.out, st.atime, st.mtime).catch(() => {});
          const size = fs.statSync(r.out).size;
          res.done.push({ from: source, to: r.out, size, note });
          tell({ state: 'done', percent: 100, out: r.out, outSize: size, note });
          log('info', `${label}: ${r.out} (${(size / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
        } catch (e) {
          fs.rmSync(part, { force: true });
          if (cancelled) { tell({ state: 'cancelled' }); break; }
          res.failed.push({ path: r.out, reason: (e as Error).message });
          tell({ state: 'failed', error: (e as Error).message });
          log('warn', `${label} failed`, e);
        }
      }
    } catch (e) {
      res.failed.push({ path: label, reason: (e as Error).message });
      onProgress({ jobId, index: 0, total: 1, file: label, percent: 0, state: 'failed', error: (e as Error).message });
    } finally { prep?.cleanup?.(); }
    res.cancelled = cancelled;
    stop = null;
    onProgress({ jobId, index: 0, total: 0, file: '', percent: 100, state: 'finished' });
  }, () => { cancelled = true; signal.kill?.(); });
  return { jobId, done: job.done.then(() => res) };
}

/** Edit one video into one file (or one per split piece). */
export function startEdit(file: string, spec: EditSpec, onProgress: (p: ConvertProgress) => void): { jobId: string; done: Promise<ConvertResult> } {
  return runOutputs(`Video editor: edit ${path.basename(file)}`, async () => {
    const p = await probeMedia(file);
    const enc = await encoders();
    const t = TARGETS[spec.output.target];
    const codec = t.video as Codec;
    let e = spec;
    let note: string | undefined;
    if (onlyCuts(e)) {
      // A cut without converting starts on a keyframe: when that is more than a second early, cut exactly instead.
      for (const g of outputsOf(e, p.duration)) {
        const kf = await keyframeAtOrBefore(file, p, g[0].start).catch(() => g[0].start);
        if (g[0].start - kf > 1) { e = { ...e, exact: true }; note = 'Cut exactly (this video has few keyframes), so it is converted'; break; }
      }
      if (!e.exact) note = 'Cut without converting (no quality lost)';
    }
    const n = outputsOf(e, p.duration).length;
    const dir = e.outDir ?? path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    const ext = onlyCuts(e) ? (path.extname(file).slice(1).toLowerCase() || t.ext) : t.ext;
    const outs: string[] = [];
    for (let i = 0; i < n; i++) {
      const o = freeName(dir, n > 1 ? `${stem} (part ${i + 1})` : `${stem} (edited)`, ext);
      outs.push(o);
      fs.writeFileSync(o, '');           // held until written, so the next name is different
    }
    for (const o of outs) fs.rmSync(o, { force: true });
    let textFile: string | undefined, cleanup: (() => void) | undefined;
    if (e.text?.value.trim()) {
      textFile = path.join(app.getPath('temp'), `pixhaven-title-${crypto.randomUUID()}.txt`);
      fs.writeFileSync(textFile, e.text.value.trim());
      cleanup = () => fs.rmSync(textFile!, { force: true });
    }
    const font = FONTS.find(f => fs.existsSync(f));
    if (e.text?.value.trim() && !font) throw new Error('No font found for the text.');
    return { runs: planEdit(file, outs, p, e, enc[codec], { textFile, font }), source: file, note, cleanup };
  }, onProgress);
}

/** Clips one after another into one file, named after the first. */
export function startJoin(files: string[], o: Pick<EditSpec, 'output' | 'outDir'>, onProgress: (p: ConvertProgress) => void): { jobId: string; done: Promise<ConvertResult> } {
  return runOutputs(`Video editor: join ${files.length} videos`, async () => {
    const enc = await encoders();
    const codec = TARGETS[o.output.target].video as Codec;
    if (!enc[codec]) throw new Error('No encoder for this format on this computer.');
    const probes = await Promise.all(files.map(async f => ({ path: f, probe: await probeMedia(f) })));
    const stem = path.basename(files[0], path.extname(files[0]));
    const out = freeName(o.outDir ?? path.dirname(files[0]), `${stem} (joined)`, TARGETS[o.output.target].ext);
    return { runs: [planJoin(probes, out, o.output, enc[codec]!)], source: files[0] };
  }, onProgress);
}

const fmtTime = (t: number) => `${Math.floor(t / 60)}m${String(Math.floor(t % 60)).padStart(2, '0')}s`;
/** Save the frame at `at` as a JPG / PNG next to the video; or one every `every` seconds into a "<name> frames" folder. */
export async function saveFrames(file: string, at: number | null, every: number | null, format: 'jpg' | 'png'): Promise<{ files: string[]; dir: string }> {
  const stem = path.basename(file, path.extname(file));
  const q = format === 'jpg' ? ['-q:v', '2'] : [];
  if (at !== null) {
    const out = freeName(path.dirname(file), `${stem} at ${fmtTime(at)}`, format);
    await run('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', ...q, out], 60000);
    return { files: [out], dir: path.dirname(file) };
  }
  const dir = freeName(path.dirname(file), `${stem} frames`, '');
  fs.mkdirSync(dir, { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vf', `fps=1/${Math.max(0.1, every ?? 1)}`, ...q, path.join(dir, `${stem} %04d.${format}`)], 600000);
  return { files: fs.readdirSync(dir).map(f => path.join(dir, f)), dir };
}
