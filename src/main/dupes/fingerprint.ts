// 1.1.0 Duplicate videos: a video's fingerprint, read with FFmpeg in one pass: a small grey picture every STEP
// seconds, hashed as it is, zoomed into its middle and mirrored. Plus a whole-file hash for exact copies. Attic videos
// (attic://…) are read over the home network like the player does.
// No Electron imports.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { inputArgs, probeVideo, tool } from '../library/ffmpeg';
export { setFfmpegDir } from '../library/ffmpeg';   // for tests: the bundled copy of the module
import { GRID_H, GRID_W, STEP, hashFrames, type Fingerprint } from './video-match';

/** Reads the fingerprint of a video (local, or on Attic: then its size and date are given). `signal.kill` stops it. */
export async function fingerprint(file: string, signal: { kill?: () => void } = {}, known?: { size: number; mtime: number }): Promise<Fingerprint> {
  const st = known ? { size: known.size, mtimeMs: known.mtime } : await fs.promises.stat(file);
  const v = await probeVideo(file);
  if (!v.hasVideo) throw new Error('No picture in this video');
  // Decoding shortcuts first; a decoder that does not take them is asked again without.
  const raw = await frames(file, v.duration, signal, true).catch(e => ((e as { decoderOptions?: boolean }).decoderOptions ? frames(file, v.duration, signal, false) : Promise.reject(e)));
  return { path: file, size: st.size, mtime: Math.floor(st.mtimeMs), duration: v.duration, width: v.width, height: v.height, ...hashFrames(raw) };
}

function frames(file: string, duration: number, signal: { kill?: () => void }, skip: boolean): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Skipping frames nothing refers to and the deblocking filter: ~0.7 s per minute of 480p video instead of ~1.5 s
    // (a 9×8 picture does not change).
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-nostdin', ...(skip ? ['-skip_frame', 'noref', '-skip_loop_filter', 'all'] : []), ...inputArgs(file), '-map', '0:V:0', '-an', '-sn', '-dn',
      '-vf', `fps=1/${STEP},scale=${GRID_W}:${GRID_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { windowsHide: true });
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
      if (code === 0 || buf.length >= GRID_W * GRID_H * 3) resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.length));
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

/** The mean distance between a's and b's pictures when a's sample i is b's sample i + shift. */
function meanDistance(a: Fingerprint, b: Fingerprint, shift: number): { mean: number; compared: number } {
  let sum = 0, compared = 0;
  for (let i = 0; i < a.blank.length; i++) {
    const j = i + shift;
    if (j < 0 || j >= b.blank.length || a.blank[i] || b.blank[j]) continue;
    sum += popcount((a.hashes[i * 2] ^ b.hashes[j * 2]) >>> 0) + popcount((a.hashes[i * 2 + 1] ^ b.hashes[j * 2 + 1]) >>> 0);
    compared++;
  }
  return { mean: compared ? sum / compared : 64, compared };
}
const popcount = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };

/** Hashes of `seconds` of a video from `from`, at `rate` pictures a second. */
async function hashesAt(file: string, from: number, seconds: number, rate: number): Promise<Fingerprint> {
  const raw = await new Promise<Uint8Array>((resolve, reject) => {
    const p = spawn(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-ss', Math.max(0, from).toFixed(3), '-t', seconds.toFixed(3), ...inputArgs(file), '-map', '0:V:0', '-an', '-sn', '-dn',
      '-vf', `fps=${rate},scale=${GRID_W}:${GRID_H}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { windowsHide: true });
    const out: Buffer[] = [];
    p.stdout.on('data', d => out.push(d));
    p.on('error', reject);
    p.on('close', () => { const b = Buffer.concat(out); resolve(new Uint8Array(b.buffer, b.byteOffset, b.length)); });
  });
  return { path: file, size: 0, mtime: 0, duration: seconds, width: 0, height: 0, ...hashFrames(raw) };
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
    // Exact picture against picture here (no slack either side): the closest-looking position wins.
    const d = meanDistance(a, b, shift);
    const score = d.compared >= Math.min(8, a.blank.length - 2) ? 1 - d.mean / 64 - (a.blank.length - d.compared) * 0.002 : -1;
    if (score > best.score) best = { score, shift };
  }
  if (best.score < 0.8) return cut;
  // a's last picture (TAIL s after its start) sits at b's sample (len(a) + shift): the second part goes on from there.
  const end = bFrom + (a.blank.length + best.shift) / RATE;
  return Math.abs(end - cut) <= AROUND + 2 ? Math.max(0, end) : cut;
}
