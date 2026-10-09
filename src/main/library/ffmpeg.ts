// Bundled FFmpeg / FFprobe (LGPL build): video facts, video frames and HEIC photos for the media library.
// No Electron imports: the app (or a test) says where the tools are with setFfmpegDir().
import path from 'node:path';
import { spawn } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
let toolDir = '';
/** Folder holding ffmpeg(.exe) and ffprobe(.exe). */
export function setFfmpegDir(dir: string): void { toolDir = dir; }
export const tool = (name: 'ffmpeg' | 'ffprobe') => path.join(toolDir, IS_WIN ? `${name}.exe` : name);

/** Runs a tool and collects stdout; kills it after `timeoutMs`. */
export function run(name: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 20000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(tool(name), args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`${name} took too long`)); }, timeoutMs);
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { if (err.length < 4000) err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(err.trim().split(/\r?\n/).pop() || `${name} exited with code ${code}`));
    });
  });
}

export interface VideoFacts { duration: number; width: number; height: number; codec: string; hasVideo: boolean }

export async function probeVideo(file: string): Promise<VideoFacts> {
  const json = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).toString('utf8'));
  const v = (json.streams ?? []).find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const duration = Number(json.format?.duration ?? v?.duration ?? 0) || 0;
  if (!v) return { duration, width: 0, height: 0, codec: '', hasVideo: false };
  // Phone videos are stored sideways with a rotation tag: report the size as shown.
  const rot = Math.abs(Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0)) % 180;
  return { duration, width: rot === 90 ? v.height : v.width, height: rot === 90 ? v.width : v.height, codec: String(v.codec_name ?? ''), hasVideo: true };
}

/** One JPEG frame, at most `max` pixels on the long side. Seeks to `at` seconds (falls back to the first frame). */
export async function videoFrame(file: string, at: number, max: number): Promise<Buffer> {
  const args = (t: number) => [
    '-v', 'error', ...(t > 0 ? ['-ss', t.toFixed(2)] : []), '-i', file, '-map', '0:V:0', '-frames:v', '1', '-an', '-sn',
    '-vf', `scale=w=${max}:h=${max}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', '-',
  ];
  let buf = await run('ffmpeg', args(at)).catch(() => Buffer.alloc(0));
  if (!buf.length && at > 0) buf = await run('ffmpeg', args(0));
  if (!buf.length) throw new Error('No picture in this video');
  return buf;
}

/** Decodes a HEIC/HEIF photo (phone tile grids and rotation included) to a PNG. */
export function decodeStill(file: string): Promise<Buffer> {
  return run('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1', '-'], 30000);
}
