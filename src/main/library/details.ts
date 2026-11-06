// v1.0.4: what the details card shows for one file — size and dates for anything, FFprobe facts for videos
// (length, resolution, codec, frame rate, bitrate, audio), ExifTool facts for photos (date taken, camera, lens,
// exposure). Read only for the file selected, so big folders are not slowed down. No Electron imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { FileDetails } from '../../shared/types';
import { mediaKind } from '../../shared/types';
import { run } from './ffmpeg';

const CODECS: Record<string, string> = {
  h264: 'H.264', hevc: 'HEVC (H.265)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1',
  wmv3: 'WMV', vc1: 'VC-1', prores: 'ProRes', mjpeg: 'Motion JPEG', theora: 'Theora',
  aac: 'AAC', mp3: 'MP3', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', ac3: 'Dolby Digital', eac3: 'Dolby Digital Plus', dts: 'DTS',
  pcm_s16le: 'PCM', pcm_s24le: 'PCM', alac: 'ALAC', wmav2: 'WMA', amr_nb: 'AMR',
};
export const codecName = (c: string) => CODECS[c] ?? c.toUpperCase();
const channels = (n: number) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : n === 6 ? '5.1' : n === 8 ? '7.1' : `${n} channels`);
const ratio = (r: string | undefined) => { const [a, b] = String(r ?? '0/1').split('/').map(Number); return b ? a / b : 0; };

/** Video facts from FFprobe's JSON (exported for tests). */
export function videoFacts(j: any): Partial<FileDetails> {
  const streams: any[] = j.streams ?? [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const out: Partial<FileDetails> = {};
  const duration = Number(j.format?.duration ?? v?.duration ?? 0);
  if (duration > 0) out.duration = duration;
  const bitrate = Number(j.format?.bit_rate ?? 0);
  if (bitrate > 0) out.bitrate = bitrate;
  if (v) {
    const rot = Math.abs(Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
    if (v.width && v.height) { out.width = rot === 90 ? v.height : v.width; out.height = rot === 90 ? v.width : v.height; }
    out.videoCodec = codecName(String(v.codec_name ?? ''));
    const fps = ratio(v.avg_frame_rate) || ratio(v.r_frame_rate);
    if (fps > 0 && fps < 1000) out.fps = Math.round(fps * 100) / 100;
  }
  const audio = streams.filter(s => s.codec_type === 'audio').map(s => {
    const lang = s.tags?.language && s.tags.language !== 'und' ? ` (${s.tags.language})` : '';
    return `${codecName(String(s.codec_name ?? ''))} ${channels(Number(s.channels ?? 2))}${lang}`;
  });
  if (audio.length) out.audio = audio;
  const container = String(j.format?.format_name ?? '').split(',')[0];
  if (container) out.format = container === 'mov' ? 'MP4 / MOV' : container === 'matroska' ? 'MKV' : container.toUpperCase();
  return out;
}

/** Photo facts from ExifTool's JSON (exported for tests). */
export function photoFacts(j: any): Partial<FileDetails> {
  const out: Partial<FileDetails> = {};
  const s = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
  const w = Number(j.ImageWidth ?? j.ExifImageWidth ?? 0), h = Number(j.ImageHeight ?? j.ExifImageHeight ?? 0);
  if (w > 0 && h > 0) {
    // Turned by the camera (Orientation 5–8): report the size as shown.
    const turned = [5, 6, 7, 8].includes(Number(j.Orientation));
    out.width = turned ? h : w; out.height = turned ? w : h;
  }
  if (s(j.FileType)) out.format = s(j.FileType);
  const taken = s(j.DateTimeOriginal) || s(j.CreateDate);
  if (taken && !taken.startsWith('0000')) out.taken = taken;
  const make = s(j.Make), model = s(j.Model);
  // "Canon" + "Canon EOS R6" → "Canon EOS R6"
  const camera = model.toLowerCase().startsWith(make.toLowerCase().split(' ')[0]) ? model : [make, model].filter(Boolean).join(' ');
  if (camera) out.camera = camera;
  const lens = s(j.LensModel) || s(j.Lens);
  if (lens) out.lens = lens;
  const exp: string[] = [];
  if (Number(j.FNumber) > 0) exp.push(`f/${Number(j.FNumber)}`);
  if (s(j.ExposureTime)) exp.push(`${s(j.ExposureTime)} s`);
  if (Number(j.ISO) > 0) exp.push(`ISO ${Number(j.ISO)}`);
  const fl = s(j.FocalLength).replace(/\.0 mm$/, ' mm');
  if (fl) exp.push(fl);
  if (exp.length) out.exposure = exp.join(' · ');
  return out;
}

const EXIF_TAGS = ['-FileType', '-ImageWidth', '-ImageHeight', '-ExifImageWidth', '-ExifImageHeight', '-Orientation#', '-DateTimeOriginal', '-CreateDate',
  '-Make', '-Model', '-LensModel', '-Lens', '-FNumber', '-ExposureTime', '-ISO', '-FocalLength'];

/** ExifTool JSON for one file. The name goes in a UTF-8 argument file (names outside the system code page). */
async function exif(exiftool: string, file: string): Promise<any> {
  const argFile = path.join(os.tmpdir(), `clearup-exiftool-details-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.args`);
  fs.writeFileSync(argFile, ['-j', '-charset', 'filename=utf8', ...EXIF_TAGS, file].join('\n') + '\n', 'utf8');
  const out = await new Promise<string>((resolve, reject) => execFile(exiftool, ['-@', argFile],
    { windowsHide: true, timeout: 20_000 }, (e, o) => (e && !o ? reject(e) : resolve(String(o))))).finally(() => fs.rmSync(argFile, { force: true }));
  return JSON.parse(out)[0] ?? {};
}

export interface DetailTools {
  exiftool: string | null;                              // null: ExifTool not available
  imageSize?: (file: string) => Promise<{ width: number; height: number; format?: string } | null>;   // sharp fallback
  people?: (file: string) => Promise<string[]>;
}

export async function fileDetails(file: string, tools: DetailTools): Promise<FileDetails> {
  const st = await fs.promises.stat(file);
  const kind = st.isDirectory() ? 'folder' : mediaKind(file) ?? 'image';
  const base: FileDetails = {
    path: file, name: path.basename(file), folder: path.dirname(file), kind,
    size: st.isDirectory() ? 0 : st.size, modified: st.mtimeMs, created: st.birthtimeMs || st.ctimeMs,
  };
  if (kind === 'folder') return base;
  try {
    if (kind === 'video') {
      const j = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 15000)).toString('utf8'));
      return { ...base, ...videoFacts(j) };
    }
    const [facts, people] = await Promise.all([
      tools.exiftool ? exif(tools.exiftool, file).then(photoFacts).catch(() => ({} as Partial<FileDetails>)) : Promise.resolve({} as Partial<FileDetails>),
      tools.people ? tools.people(file).catch(() => []) : Promise.resolve([]),
    ]);
    const out: FileDetails = { ...base, ...facts };
    if ((!out.width || !out.height) && tools.imageSize) {
      const m = await tools.imageSize(file).catch(() => null);
      if (m) { out.width = m.width; out.height = m.height; out.format ??= m.format?.toUpperCase(); }
    }
    if (people.length) out.people = people;
    return out;
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export { setFfmpegDir } from './ffmpeg';
