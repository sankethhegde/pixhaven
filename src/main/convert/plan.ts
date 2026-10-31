// v2.11 Video editor, phase 1: conversion (no upscaling). Turns a choice — target format, quality, size limit, sound —
// into FFmpeg arguments for one file. The bundled FFmpeg is an LGPL build: H.264 and HEVC are made by the graphics
// chip's encoder when there is one (Intel Quick Sync first) — else OpenH264 and Kvazaar (HEVC) — AV1 by Quick Sync or SVT-AV1, VP9 by
// libvpx, ProRes by prores_ks. Same codec and nothing to change → the video is copied (seconds, no quality lost).
// No Electron imports.
import path from 'node:path';
import type { ConvertOptions, ConvertTarget } from '../../shared/types';
import type { MediaProbe } from '../library/player';

export type Codec = 'h264' | 'hevc' | 'av1' | 'vp9' | 'prores';

export interface TargetSpec { ext: string; video: Codec | 'gif' | null; audio: 'aac' | 'opus' | 'mp3' | null; kind: 'video' | 'audio' | 'gif' | 'photo' }
export const TARGETS: Record<ConvertTarget, TargetSpec> = {
  'mp4-h264': { ext: 'mp4', video: 'h264', audio: 'aac', kind: 'video' },
  'mp4-hevc': { ext: 'mp4', video: 'hevc', audio: 'aac', kind: 'video' },
  'mp4-av1': { ext: 'mp4', video: 'av1', audio: 'aac', kind: 'video' },
  'webm-vp9': { ext: 'webm', video: 'vp9', audio: 'opus', kind: 'video' },
  'mov-prores': { ext: 'mov', video: 'prores', audio: 'aac', kind: 'video' },
  'mp3': { ext: 'mp3', video: null, audio: 'mp3', kind: 'audio' },
  'm4a': { ext: 'm4a', video: null, audio: 'aac', kind: 'audio' },
  'gif': { ext: 'gif', video: 'gif', audio: null, kind: 'gif' },
  'jpg': { ext: 'jpg', video: null, audio: null, kind: 'photo' },
  'png': { ext: 'png', video: null, audio: null, kind: 'photo' },
};

/** Encoders to try for each codec, best first (graphics chip, then processor). */
export const ENCODERS: Record<Codec, string[]> = {
  h264: process.platform === 'win32' ? ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf', 'libopenh264'] : ['h264_qsv', 'h264_nvenc', 'h264_vaapi', 'libopenh264'],
  hevc: process.platform === 'win32' ? ['hevc_qsv', 'hevc_nvenc', 'hevc_amf', 'hevc_mf', 'libkvazaar'] : ['hevc_qsv', 'hevc_nvenc', 'hevc_vaapi', 'libkvazaar'],
  av1: ['av1_qsv', 'av1_nvenc', 'av1_amf', 'libsvtav1'],
  vp9: ['libvpx-vp9'],
  prores: ['prores_ks'],
};
const HARDWARE = /_(qsv|nvenc|amf|mf|vaapi)$/;
/** Pixel format the encoder wants (hardware encoders take NV12; ProRes 4:2:2 10-bit). */
export const pixFmt = (enc: string) => (HARDWARE.test(enc) ? 'nv12' : enc === 'prores_ks' ? 'yuv422p10le' : 'yuv420p');

const Q = { small: 0, balanced: 1, best: 2 } as const;
/** Quality settings per encoder: [small, balanced, best]. Also used by edits (edit.ts). */
export function qualityArgs(enc: string, q: 0 | 1 | 2, w: number, h: number, fps: number): string[] {
  const pick = <T>(a: [T, T, T]) => a[q];
  switch (enc) {
    case 'h264_qsv': return ['-preset', 'medium', '-global_quality', String(pick([30, 25, 21])), '-look_ahead', '0'];
    case 'hevc_qsv': return ['-preset', 'medium', '-global_quality', String(pick([31, 26, 22]))];
    case 'av1_qsv': return ['-preset', 'medium', '-global_quality', String(pick([130, 100, 75]))];
    case 'h264_nvenc': case 'hevc_nvenc': case 'av1_nvenc': return ['-preset', 'p5', '-rc', 'vbr', '-cq', String(pick([31, 26, 21])), '-b:v', '0'];
    case 'h264_amf': case 'hevc_amf': case 'av1_amf': { const v = String(pick([30, 25, 20])); return ['-rc', 'cqp', '-qp_i', v, '-qp_p', v]; }
    case 'h264_mf': case 'hevc_mf': return ['-rate_control', 'quality', '-quality', String(pick([45, 65, 85]))];
    case 'h264_vaapi': case 'hevc_vaapi': return ['-qp', String(pick([30, 25, 21]))];
    case 'libkvazaar': return ['-kvazaar-params', `preset=faster,qp=${pick([34, 29, 24])}`];
    case 'libsvtav1': return ['-preset', '8', '-crf', String(pick([42, 34, 27]))];
    case 'libvpx-vp9': return ['-crf', String(pick([40, 33, 27])), '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'];
    case 'prores_ks': return ['-profile:v', String(pick([0, 2, 3]))];     // Proxy, Standard, HQ
    default: {
      // OpenH264 has no quality mode: a bitrate by picture size (bits per pixel per frame).
      const bpp = pick([0.05, 0.08, 0.12]);
      return ['-b:v', `${Math.max(300, Math.round((w * h * fps * bpp) / 1000))}k`];
    }
  }
}

/** Short side after "Resolution" (only ever made smaller). */
export function outSize(w: number, h: number, res: ConvertOptions['resolution']): { w: number; h: number } {
  if (res === 'keep' || !w || !h) return { w, h };
  const short = Math.min(w, h);
  if (short <= res) return { w, h };
  const k = res / short;
  const even = (n: number) => Math.max(2, Math.round(n * k / 2) * 2);
  return { w: even(w), h: even(h) };
}

export interface Plan { args: string[]; copyVideo: boolean; note?: string }

/** FFmpeg arguments that write `out` from `file`. `enc` is the encoder picked for the target codec (null: copy). */
export function planConvert(file: string, out: string, p: MediaProbe, o: ConvertOptions, enc: string | null): Plan {
  const t = TARGETS[o.target];
  const q = Q[o.quality];
  const base = ['-hide_banner', '-v', 'error', '-y', '-i', file, '-map_metadata', '0', '-progress', 'pipe:1', '-nostats'];
  const v = p.video;
  const audio = p.audio.length > 0 && o.sound;

  if (t.kind === 'audio') {
    if (!p.audio.length) throw new Error('This file has no sound to save.');
    const a = t.audio === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', String([5, 2, 0][q])] : ['-c:a', 'aac', '-b:a', ['128k', '192k', '256k'][q]];
    return { args: [...base, '-map', '0:a:0', '-vn', ...a, out], copyVideo: false };
  }
  if (!v) throw new Error('This file has no video picture.');

  if (t.kind === 'gif') {
    const width = Math.min(v.width || 480, [320, 480, 640][q], o.resolution === 'keep' ? 10000 : o.resolution * 16 / 9);
    const fps = [10, 12, 15][q];
    const vf = `fps=${fps},scale=${Math.round(width / 2) * 2}:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=${[64, 128, 256][q]}[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`;
    return { args: [...base, '-map', '0:V:0', '-an', '-vf', vf, '-loop', '0', out], copyVideo: false };
  }

  // Video: copied when it already is the target codec and nothing about it has to change.
  const size = outSize(v.width, v.height, o.resolution);
  const resize = size.w !== v.width || size.h !== v.height;
  const same = (t.video === 'h264' && v.codec === 'h264') || (t.video === 'hevc' && v.codec === 'hevc') || (t.video === 'av1' && v.codec === 'av1') || (t.video === 'vp9' && v.codec === 'vp9') || (t.video === 'prores' && v.codec === 'prores');
  const copyVideo = same && !resize && !o.maxMB && !o.forceEncode;
  const args = [...base, '-map', '0:V:0'];
  if (audio) args.push('-map', '0:a:0');
  if (copyVideo) {
    args.push('-c:v', 'copy');
    if (t.video === 'hevc') args.push('-tag:v', 'hvc1');                 // so Apple devices and Windows play it
  } else {
    if (!enc) throw new Error('No encoder for this format on this computer.');
    const filters = [...(resize ? [`scale=${size.w}:${size.h}:flags=lanczos`] : []), ...(v.interlaced ? ['bwdif'] : []), `format=${pixFmt(enc)}`];
    args.push('-vf', filters.join(','), '-c:v', enc);
    const fps = v.fps || 25;
    if (o.maxMB) {
      // Fit under a size: the video gets what is left after the sound, a little kept back for the container.
      const seconds = Math.max(1, p.duration);
      const audioK = audio ? (t.audio === 'opus' ? 96 : 128) : 0;
      const videoK = Math.max(150, Math.floor((o.maxMB * 8 * 1000 * 0.94) / seconds - audioK));
      args.push('-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.3)}k`, '-bufsize', `${videoK * 2}k`);
      if (/_mf$/.test(enc)) args.push('-rate_control', 'cbr');
    } else args.push(...qualityArgs(enc, q, size.w, size.h, fps));
    args.push('-g', String(Math.max(12, Math.round(fps * 2))));
    if (t.video === 'hevc') args.push('-tag:v', 'hvc1');
  }
  if (audio) {
    const src = p.audio[0].codec;
    const keep = !o.maxMB && ((t.audio === 'aac' && src === 'aac') || (t.audio === 'opus' && src === 'opus'));
    if (keep) args.push('-c:a', 'copy');
    else if (t.audio === 'opus') args.push('-c:a', 'libopus', '-b:a', o.maxMB ? '96k' : ['96k', '128k', '160k'][q]);
    else args.push('-c:a', 'aac', '-b:a', o.maxMB ? '128k' : ['128k', '160k', '192k'][q]);
  } else args.push('-an');
  args.push('-sn');
  if (t.ext === 'mp4' || t.ext === 'mov') args.push('-movflags', '+faststart');
  args.push(out);
  return { args, copyVideo, note: copyVideo ? 'Same format: copied without converting (no quality lost)' : undefined };
}

/** "clip.mkv" → "clip.mp4" in `dir`, or "clip (converted).mp4" when the name is taken (never overwrites). */
export function outputName(file: string, ext: string, dir: string, exists: (p: string) => boolean): string {
  const stem = path.basename(file, path.extname(file));
  const first = path.join(dir, `${stem}.${ext}`);
  if (!exists(first) && path.resolve(first).toLowerCase() !== path.resolve(file).toLowerCase()) return first;
  for (let i = 1; ; i++) {
    const p = path.join(dir, `${stem} (converted${i > 1 ? ` ${i}` : ''}).${ext}`);
    if (!exists(p)) return p;
  }
}

/** FFmpeg's -progress output: seconds written so far. */
export function progressSeconds(chunk: string): number | null {
  const m = [...chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)].pop();
  return m ? Number(m[1]) / 1e6 : null;
}
