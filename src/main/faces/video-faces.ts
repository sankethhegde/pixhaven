// 1.0.8: who is in a video. FFmpeg hands over one frame every few seconds (raw RGB, at most 1280 px wide); the face
// engine finds the faces and their fingerprints, the same as when sorting photos; each face is compared with the
// people of every sorted folder (their best faces, as Combine does). A person counts when they are matched in at
// least two frames, or once very clearly. No Electron imports (runs in a worker; tests run it directly).
import { spawn } from 'node:child_process';
import { dot, nearestK, type FaceSet } from './cluster';

export interface VideoFrame { t: number; rgb: Buffer; W: number; H: number }
export interface PersonHit { personId: number; frames: number; best: number; mean: number; times: number[] }
export interface VideoFacesResult { frames: number; faces: number; unknown: number; people: PersonHit[] }
export interface Analyser { analyse(rgb: Buffer, W: number, H: number, minFace: number, minSharpness: number): Promise<{ usable: boolean; emb?: Float32Array }[]> }

/** How often to look: every 2 s, spread wider on long videos so at most `max` frames are read. */
export function frameStep(duration: number, max = 600): number {
  return Math.max(2, Math.ceil(duration / max));
}
/** The size frames are read at: at most 1280 px wide, even numbers (what the face engine works on). */
export function frameSize(width: number, height: number): { W: number; H: number } {
  const W = Math.max(2, Math.min(1280, width) & ~1);
  return { W, H: Math.max(2, Math.round((W * height) / width / 2) * 2) };
}

/** Frames from FFmpeg, one every `step` seconds, as raw RGB. `input` are FFmpeg's input arguments (a local file, or an
 * Attic URL with its cookie). Stops early when `stop()` says so. */
export async function* videoFrames(ffmpeg: string, input: string[], step: number, W: number, H: number, stop: () => boolean = () => false): AsyncGenerator<VideoFrame> {
  const proc = spawn(ffmpeg, ['-v', 'error', '-nostdin', ...input, '-an', '-sn', '-vf', `fps=1/${step},scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const size = W * H * 3;
  let buf: Buffer = Buffer.alloc(0), n = 0, err = '';
  proc.stderr.on('data', d => { if (err.length < 2000) err += d; });
  try {
    for await (const chunk of proc.stdout) {
      buf = buf.length ? Buffer.concat([buf, chunk as Buffer]) : (chunk as Buffer);
      while (buf.length >= size) {
        const rgb = Buffer.from(buf.subarray(0, size));
        buf = buf.subarray(size);
        yield { t: n++ * step, rgb, W, H };
        if (stop()) return;
      }
    }
    const code: number | null = proc.exitCode ?? await new Promise(r => proc.on('close', r));
    if (code && !n) throw new Error(err.trim().split(/\r?\n/).pop() || `FFmpeg could not read the video (${code}).`);
  } finally { if (proc.exitCode === null) proc.kill(); }
}

/** One face against everyone: the closest person and how close (average, or nearest faces for a clear match). */
export function bestMatch(e: Float32Array, people: { id: number; set: FaceSet }[], threshold: number): { id: number; score: number } | null {
  let best: { id: number; score: number } | null = null;
  for (const p of people) {
    const avg = dot(e, p.set.sum) / p.set.n;
    if (avg < threshold - 0.15) continue;                       // far away: skip the closer look
    const s = Math.max(avg, nearestK(e, p.set, 5) - 0.05);
    if (s >= threshold && (!best || s > best.score)) best = { id: p.id, score: s };
  }
  return best;
}

/** Looks at every frame and tallies who was seen. `threshold` is stricter than for photos (videos blur and turn). */
export async function findPeople(frames: AsyncIterable<VideoFrame>, engine: Analyser, people: { id: number; set: FaceSet }[], o: {
  threshold: number; minFace: number; minSharpness: number; onFrame?: (done: number) => void;
}): Promise<VideoFacesResult> {
  const hits = new Map<number, { frames: Set<number>; scores: number[]; times: number[] }>();
  let nFrames = 0, faces = 0, unknown = 0;
  for await (const f of frames) {
    const found = await engine.analyse(f.rgb, f.W, f.H, o.minFace, o.minSharpness);
    for (const face of found) {
      if (!face.usable || !face.emb) continue;
      faces++;
      const m = bestMatch(face.emb, people, o.threshold);
      if (!m) { unknown++; continue; }
      const h = hits.get(m.id) ?? { frames: new Set(), scores: [], times: [] };
      if (!h.frames.has(nFrames)) h.times.push(f.t);
      h.frames.add(nFrames); h.scores.push(m.score);
      hits.set(m.id, h);
    }
    o.onFrame?.(++nFrames);
  }
  const out: PersonHit[] = [];
  for (const [id, h] of hits) {
    const best = Math.max(...h.scores), mean = h.scores.reduce((a, b) => a + b, 0) / h.scores.length;
    if (h.frames.size < 2 && best < o.threshold + 0.1) continue;   // one blurry glimpse: not sure enough
    out.push({ personId: id, frames: h.frames.size, best, mean, times: h.times });
  }
  out.sort((a, b) => b.frames * b.mean - a.frames * a.mean);
  return { frames: nFrames, faces, unknown, people: out };
}

/** How sure, for people: 50 % at the threshold, rising to 99 % for a very clear match. */
export const sureness = (mean: number, threshold: number) => Math.round(Math.max(50, Math.min(99, 50 + ((mean - threshold) / (0.72 - threshold)) * 49)));
