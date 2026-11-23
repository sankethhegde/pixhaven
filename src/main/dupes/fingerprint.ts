// 1.1.0 Duplicate videos: a video's fingerprint, read with FFmpeg in one pass: a 9×8 grey picture every STEP
// seconds (only the frames needed are decoded in full), hashed. Plus a whole-file hash for exact copies.
// No Electron imports.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { probeVideo, tool } from '../library/ffmpeg';
export { setFfmpegDir } from '../library/ffmpeg';   // for tests: the bundled copy of the module
import { STEP, align, hashFrames, type Fingerprint } from './video-match';

/** Reads the fingerprint of a local video. `signal.kill` stops it. */
export async function fingerprint(file: string, signal: { kill?: () => void } = {}): Promise<Fingerprint> {
  const st = await fs.promises.stat(file);
  const v = await probeVideo(file);
  if (!v.hasVideo) throw new Error('No picture in this video');
  // Decoding shortcuts first; a decoder that does not take them is asked again without.
  const raw = await frames(file, v.duration, signal, true).catch(e => ((e as { decoderOptions?: boolean }).decoderOptions ? frames(file, v.duration, signal, false) : Promise.reject(e)));
  const { hashes, blank } = hashFrames(raw);
  return { path: file, size: st.size, mtime: Math.floor(st.mtimeMs), duration: v.duration, width: v.width, height: v.height, hashes, blank };
}

function frames(file: string, duration: number, signal: { kill?: () => void }, skip: boolean): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Skipping frames nothing refers to and the deblocking filter: ~0.7 s per minute of 480p video instead of ~1.5 s
    // (a 9×8 picture does not change).
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-nostdin', ...(skip ? ['-skip_frame', 'noref', '-skip_loop_filter', 'all'] : []), '-i', file, '-map', '0:V:0', '-an', '-sn', '-dn',
      '-vf', `fps=1/${STEP},scale=9:8:flags=area,format=gray`, '-f', 'rawvideo', '-'], { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const limit = setTimeout(() => { p.kill(); reject(new Error('Reading the video took too long')); }, Math.max(120, duration * 2) * 1000);
    signal.kill = () => { p.kill(); };
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { if (err.length < 2000) err += d; });
    p.on('error', e => { clearTimeout(limit); reject(e); });
    p.on('close', code => {
      clearTimeout(limit);
      signal.kill = undefined;
      const buf = Buffer.concat(out);
      if (code === 0 || buf.length >= 72 * 3) resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
      else reject(Object.assign(new Error(err.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`), { decoderOptions: skip && /decoder options|skip_frame|skip_loop_filter/i.test(err) }));
    });
  });
}

/** SHA-1 of the whole file (only asked for files of the same size). */
export function fileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file, { highWaterMark: 1 << 20 }).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Hashes of `seconds` of a video from `from`, at `rate` pictures a second. */
async function hashesAt(file: string, from: number, seconds: number, rate: number): Promise<Fingerprint> {
  const raw = await new Promise<Uint8Array>((resolve, reject) => {
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', Math.max(0, from).toFixed(3), '-t', seconds.toFixed(3), '-i', file, '-map', '0:V:0', '-an', '-sn', '-dn',
      '-vf', `fps=${rate},scale=9:8:flags=area,format=gray`, '-f', 'rawvideo', '-'], { windowsHide: true });
    const out: Buffer[] = [];
    p.stdout.on('data', d => out.push(d));
    p.on('error', reject);
    p.on('close', () => { const b = Buffer.concat(out); resolve(new Uint8Array(b.buffer, b.byteOffset, b.length)); });
  });
  const { hashes, blank } = hashFrames(raw);
  return { path: file, size: 0, mtime: 0, duration: seconds, width: 0, height: 0, hashes, blank };
}

/**
 * Where exactly the second part goes on from (to a quarter of a second), near the rough `cut` found every 2 s:
 * the last 12 s of the first part are lined up with the second part around `cut`.
 */
export async function refineCut(first: string, firstDuration: number, second: string, cut: number): Promise<number> {
  const RATE = 4, TAIL = 12, AROUND = 6;
  const a = await hashesAt(first, firstDuration - TAIL, TAIL, RATE);
  const bFrom = Math.max(0, cut - TAIL - AROUND);
  const b = await hashesAt(second, bFrom, TAIL + 2 * AROUND, RATE);
  if (a.blank.length < 8 || b.blank.length < 8) return cut;
  let best = { score: -1, shift: 0 };
  for (let shift = -(a.blank.length - 4); shift < b.blank.length - 4; shift++) {
    const al = align(a, b, shift);
    const score = al.compared >= 8 ? al.matched / al.compared - Math.abs(al.compared - a.blank.length) * 0.002 : -1;
    if (score > best.score) best = { score, shift };
  }
  if (best.score < 0.6) return cut;
  // a's last picture (TAIL s after its start) sits at b's sample (len(a) + shift): the second part goes on from there.
  const end = bFrom + (a.blank.length + best.shift) / RATE;
  return Math.abs(end - cut) <= AROUND + 2 ? Math.max(0, end) : cut;
}
