// v2.11 Video editor, phase 2: quick edits. Turns an edit (what to keep, split points, rotate / flip, crop, speed,
// sound and music, look, stabilise, text, fades) into FFmpeg runs — one per output file. A plain trim or split with
// nothing else changed is cut without converting (instant, lossless; cuts land on the nearest keyframe). Join puts
// clips one after another (sizes evened out). The bundled FFmpeg is an LGPL build without "eq": brightness and
// saturation use hue, contrast uses curves. No Electron imports.
import path from 'node:path';
import type { ConvertOptions, EditSpec } from '../../shared/types';
import { cropBox, outputsOf } from '../../shared/edit-math';
export { cropBox, outputsOf };
import type { MediaProbe } from '../library/player';
import { TARGETS, outSize, pixFmt, qualityArgs } from './plan';

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** Nothing but trimming / cutting at split points: the video can be cut without converting. */
export function onlyCuts(e: EditSpec): boolean {
  return !e.exact && e.cuts.length === 0 && !e.rotate && !e.flipH && !e.flipV && !e.crop && e.speed === 1 && e.volume === 1 && !e.music
    && !e.brightness && !e.contrast && e.saturation === 1 && !e.stabilize && !e.text?.value.trim() && !e.fadeIn && !e.fadeOut && e.resolution === 'keep';
}

/** atempo only takes 0.5–2: longer changes are chained. */
export function atempo(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${r3(s)}`);
  return out;
}

/** Path inside a filter graph: forward slashes, the drive colon escaped ("C\:/Windows/…"). */
const filterPath = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");

export interface Run { args: string[]; out: string; duration: number }

/**
 * FFmpeg runs for an edit of `file` (`outs[i]` is where output i goes). `textFile` holds the title (drawtext reads it
 * from a file, so no characters need escaping); `font` is a .ttf on this computer.
 */
export function planEdit(file: string, outs: string[], p: MediaProbe, e: EditSpec, enc: string | null, extra: { textFile?: string; font?: string } = {}): Run[] {
  const v = p.video;
  if (!v) throw new Error('This file has no video picture.');
  const groups = outputsOf(e, p.duration);
  if (!groups.length) throw new Error('Nothing is left to save: the whole video was cut out.');
  const t = TARGETS[e.output.target];
  const hasAudio = p.audio.length > 0 && e.volume > 0;
  const progress = ['-progress', 'pipe:1', '-nostats'];

  if (onlyCuts(e)) {
    // Cut without converting: -ss before -i jumps to the keyframe at or before the start.
    return groups.map((g, i) => ({
      out: outs[i], duration: g[0].end - g[0].start,
      args: ['-hide_banner', '-v', 'error', '-y', '-ss', String(r3(g[0].start)), '-to', String(r3(g[0].end)), '-i', file, '-map', '0:V:0', ...(p.audio.length ? ['-map', '0:a:0'] : []),
        '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-map_metadata', '0', ...progress, ...(t.ext === 'mp4' || t.ext === 'mov' ? ['-movflags', '+faststart'] : []), outs[i]],
    }));
  }
  if (!enc) throw new Error('No encoder for this format on this computer.');

  return groups.map((g, i) => {
    const inputs = ['-i', file];
    if (e.music) inputs.push('-stream_loop', '-1', '-i', e.music.path);
    const kept = g.reduce((n, s) => n + s.end - s.start, 0);
    const D = kept / e.speed;                                         // length of this output
    const fc: string[] = [];
    // 1. The kept parts, joined.
    g.forEach((s, k) => {
      fc.push(`[0:V:0]trim=start=${r3(s.start)}:end=${r3(s.end)},setpts=PTS-STARTPTS[v${k}]`);
      if (hasAudio) fc.push(`[0:a:0]atrim=start=${r3(s.start)}:end=${r3(s.end)},asetpts=PTS-STARTPTS[a${k}]`);
    });
    if (g.length > 1) fc.push(`${g.map((_, k) => `[v${k}]${hasAudio ? `[a${k}]` : ''}`).join('')}concat=n=${g.length}:v=1:a=${hasAudio ? 1 : 0}[vj]${hasAudio ? '[aj]' : ''}`);
    let vl = g.length > 1 ? 'vj' : 'v0', al = g.length > 1 ? 'aj' : 'a0';
    // 2. The picture.
    const vf: string[] = [];
    if (e.rotate === 90) vf.push('transpose=1'); else if (e.rotate === 270) vf.push('transpose=2'); else if (e.rotate === 180) vf.push('hflip', 'vflip');
    if (e.flipH) vf.push('hflip');
    if (e.flipV) vf.push('vflip');
    const box = cropBox(v.width, v.height, e);
    if (e.crop) vf.push(`crop=${box.w}:${box.h}:${box.x}:${box.y}`);
    if (e.stabilize) vf.push('deshake');
    if (e.brightness || e.saturation !== 1) vf.push(`hue=s=${r3(e.saturation)}:b=${r3(e.brightness * 5)}`);
    if (e.contrast) { const k = r3(e.contrast * 0.2); vf.push(`curves=all='0/0 0.25/${r3(0.25 - k)} 0.75/${r3(0.75 + k)} 1/1'`); }
    if (e.speed !== 1) vf.push(`setpts=PTS/${r3(e.speed)}`);
    const size = outSize(box.w, box.h, e.resolution);
    if (size.w !== box.w || size.h !== box.h) vf.push(`scale=${size.w}:${size.h}:flags=lanczos`);
    if (e.text?.value.trim() && extra.textFile && extra.font) {
      const fs = { s: 22, m: 14, l: 9 }[e.text.size];
      const y = { top: 'h/12', center: '(h-text_h)/2', bottom: 'h-text_h-h/12' }[e.text.position];
      vf.push(`drawtext=fontfile='${filterPath(extra.font)}':textfile='${filterPath(extra.textFile)}':expansion=none:fontsize=h/${fs}:fontcolor=white:borderw=3:bordercolor=black@0.55:x=(w-text_w)/2:y=${y}`);
    }
    if (e.fadeIn) vf.push(`fade=t=in:st=0:d=${r3(e.fadeIn)}`);
    if (e.fadeOut) vf.push(`fade=t=out:st=${r3(Math.max(0, D - e.fadeOut))}:d=${r3(e.fadeOut)}`);
    vf.push(`format=${pixFmt(enc)}`);
    fc.push(`[${vl}]${vf.join(',')}[vout]`);
    vl = 'vout';
    // 3. The sound: speed, volume, fades; music in place of it or mixed in.
    let audioOut: string | null = null;
    if (hasAudio) {
      const af = [...atempo(e.speed), ...(e.volume !== 1 ? [`volume=${r3(e.volume)}`] : []),
        ...(e.fadeIn ? [`afade=t=in:st=0:d=${r3(e.fadeIn)}`] : []), ...(e.fadeOut ? [`afade=t=out:st=${r3(Math.max(0, D - e.fadeOut))}:d=${r3(e.fadeOut)}`] : [])];
      fc.push(`[${al}]${af.length ? af.join(',') : 'anull'}[aout]`);
      audioOut = 'aout';
    }
    if (e.music) {
      const mf = [`atrim=0:${r3(D)}`, 'asetpts=PTS-STARTPTS', `volume=${r3(e.music.volume)}`,
        ...(e.fadeOut || D > 3 ? [`afade=t=out:st=${r3(Math.max(0, D - (e.fadeOut || 2)))}:d=${r3(e.fadeOut || 2)}`] : [])];
      fc.push(`[1:a:0]${mf.join(',')}[music]`);
      if (audioOut && e.music.mix) { fc.push(`[aout][music]amix=inputs=2:duration=first:normalize=0[amixed]`); audioOut = 'amixed'; }
      else audioOut = 'music';
    }
    const q = ['small', 'balanced', 'best'].indexOf(e.output.quality) as 0 | 1 | 2;
    const args = ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', fc.join(';'), '-map', `[${vl}]`, ...(audioOut ? ['-map', `[${audioOut}]`] : ['-an']),
      '-c:v', enc, ...qualityArgs(enc, q, size.w, size.h, (v.fps || 25)),
      ...(audioOut ? (t.audio === 'opus' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '160k']) : []),
      ...(t.video === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-map_metadata', '0', '-t', String(r3(D)), ...progress,
      ...(t.ext === 'mp4' || t.ext === 'mov' ? ['-movflags', '+faststart'] : []), outs[i]];
    return { args, out: outs[i], duration: D };
  });
}

// ---------- join ----------

/** Clips one after another, all made the size of the first (letterboxed), silent ones given silence. */
export function planJoin(files: { path: string; probe: MediaProbe }[], out: string, o: Pick<ConvertOptions, 'target' | 'quality'>, enc: string): Run {
  if (files.length < 2) throw new Error('Choose at least two videos to join.');
  const first = files[0].probe.video;
  if (!first) throw new Error(`${path.basename(files[0].path)} has no video picture.`);
  const W = even(first.width), H = even(first.height), fps = Math.round(first.fps || 30);
  const inputs: string[] = [];
  const fc: string[] = [];
  let silent = files.length;
  files.forEach((f, i) => {
    inputs.push('-i', f.path);
    if (!f.probe.video) throw new Error(`${path.basename(f.path)} has no video picture.`);
    fc.push(`[${i}:V:0]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
  });
  files.forEach((f, i) => {
    if (f.probe.audio.length) fc.push(`[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    else { inputs.push('-f', 'lavfi', '-t', String(r3(f.probe.duration)), '-i', 'anullsrc=r=48000:cl=stereo'); fc.push(`[${silent++}:a]anull[a${i}]`); }
  });
  fc.push(`${files.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${files.length}:v=1:a=1[vj][aj]`, `[vj]format=${pixFmt(enc)}[vout]`);
  const t = TARGETS[o.target];
  const q = ['small', 'balanced', 'best'].indexOf(o.quality) as 0 | 1 | 2;
  const D = files.reduce((n, f) => n + f.probe.duration, 0);
  return {
    out, duration: D,
    args: ['-hide_banner', '-v', 'error', '-y', ...inputs, '-filter_complex', fc.join(';'), '-map', '[vout]', '-map', '[aj]', '-c:v', enc, ...qualityArgs(enc, q, W, H, fps),
      ...(t.audio === 'opus' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'aac', '-b:a', '160k']), ...(t.video === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      '-progress', 'pipe:1', '-nostats', ...(t.ext === 'mp4' || t.ext === 'mov' ? ['-movflags', '+faststart'] : []), out],
  };
}
