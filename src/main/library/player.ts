// Video playback planning (v2.0 Phase B). The built-in Chromium player decodes H.264, HEVC, VP9 and AV1 on the GPU;
// anything else is fed to it through FFmpeg as fragmented MP4: "remux" copies the video and only fixes the container or
// audio (near-instant), "transcode" converts the video (Intel Quick Sync first). No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { AudioTrack, PlayerCaps, PlayMode, SubtitleCue } from '../../shared/types';
import { run } from './ffmpeg';

export interface SubStream { index: number; codec: string; language?: string; title?: string; text: boolean }
export interface MediaProbe {
  duration: number;
  start: number;                  // container start time: ffmpeg -ss and our timeline are relative to it
  format: string;
  video: { codec: string; width: number; height: number; fps: number; pixFmt: string; interlaced: boolean } | null;
  audio: AudioTrack[];
  subs: SubStream[];
}

/** Text subtitles we can turn into cues; picture subtitles (DVD/Blu-ray) are not. */
const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'subviewer1', 'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl'];
const AUDIO_OK = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];     // Chromium plays these
const AUDIO_IN_MP4 = ['aac', 'mp3'];                             // copied as-is when remuxing; others become AAC

export async function probeMedia(file: string): Promise<MediaProbe> {
  const j = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file])).toString('utf8'));
  const streams: any[] = j.streams ?? [];
  const v = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const fps = (r: string | undefined) => { const [a, b] = String(r ?? '0/1').split('/').map(Number); return b ? a / b : 0; };
  const tags = (s: any) => ({ language: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : undefined, title: s.tags?.title || undefined });
  return {
    duration: Number(j.format?.duration ?? v?.duration ?? 0) || 0,
    start: Number(j.format?.start_time ?? 0) || 0,
    format: String(j.format?.format_name ?? ''),
    video: v ? {
      codec: String(v.codec_name ?? ''), width: v.width ?? 0, height: v.height ?? 0, fps: fps(v.avg_frame_rate) || fps(v.r_frame_rate) || 25,
      pixFmt: String(v.pix_fmt ?? ''), interlaced: ['tt', 'bb', 'tb', 'bt'].includes(v.field_order),
    } : null,
    audio: streams.filter(s => s.codec_type === 'audio').map((s, i) => ({ index: i, codec: String(s.codec_name ?? ''), channels: s.channels ?? 2, ...tags(s) })),
    subs: streams.filter(s => s.codec_type === 'subtitle').map((s, i) => ({ index: i, codec: String(s.codec_name ?? ''), ...tags(s), text: TEXT_SUBS.includes(s.codec_name) })),
  };
}

/** Picks the lightest way to play `audioIndex` of this file. */
export function planPlayback(p: MediaProbe, caps: PlayerCaps, audioIndex = 0, ext = ''): { mode: PlayMode; reason: string } {
  const playable = ['h264', 'vp8', 'vp9', ...(caps.hevc ? ['hevc'] : []), ...(caps.av1 ? ['av1'] : [])];
  const v = p.video;
  // Chromium has no 10-bit H.264 ("Hi10P") decoder; 10-bit HEVC/AV1/VP9 are fine.
  const videoOk = !!v && playable.includes(v.codec) && !(v.codec === 'h264' && /10|12/.test(v.pixFmt));
  if (!videoOk) return { mode: 'transcode', reason: v ? `${v.codec.toUpperCase()} video is converted on the fly` : 'No video picture' };
  const a = p.audio[audioIndex];
  const audioOk = !a || AUDIO_OK.includes(a.codec);
  const mp4 = /mov|mp4|3gp/.test(p.format);
  const mkv = /matroska|webm/.test(p.format) && (caps.mkv || ext === 'webm');
  if ((mp4 || mkv) && audioOk && audioIndex === 0) return { mode: 'direct', reason: 'Played directly with hardware decoding' };
  return {
    mode: 'remux',
    reason: !(mp4 || mkv) ? 'Repackaged on the fly (video copied, not converted)'
      : !audioOk ? `${a!.codec.toUpperCase()} sound is converted on the fly` : 'Switched sound track (video copied, not converted)',
  };
}

let encoderPick: Promise<string> | null = null;
const CANDIDATES = process.platform === 'win32'
  ? ['h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf', 'libopenh264']
  : ['h264_qsv', 'h264_nvenc', 'libopenh264'];

/** First H.264 encoder that works here: the GPU's (Quick Sync on Intel) before the CPU's. Tested once per run. */
export function pickEncoder(): Promise<string> {
  encoderPick ??= (async () => {
    for (const e of CANDIDATES) {
      try {
        await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=256x256:rate=25', '-frames:v', '2', '-vf', 'format=nv12', '-c:v', e, '-f', 'null', '-'], 15000);
        return e;
      } catch { /* not on this machine */ }
    }
    return 'libopenh264';
  })();
  return encoderPick;
}

function encoderArgs(e: string, fps: number): string[] {
  const gop = String(Math.max(12, Math.round(fps * 2)));
  switch (e) {
    case 'h264_qsv': return ['-c:v', e, '-preset', 'veryfast', '-global_quality', '24', '-look_ahead', '0', '-g', gop];
    case 'h264_nvenc': return ['-c:v', e, '-preset', 'p2', '-cq', '24', '-g', gop];
    case 'h264_amf': return ['-c:v', e, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '24', '-g', gop];
    case 'h264_mf': return ['-c:v', e, '-rate_control', 'quality', '-quality', '75', '-g', gop];
    default: return ['-c:v', 'libopenh264', '-b:v', '6M', '-g', gop];
  }
}

/** FFmpeg arguments that write fragmented MP4 to stdout, starting at `start` seconds (relative to the file start). */
export function streamArgs(file: string, p: MediaProbe, mode: Exclude<PlayMode, 'direct'>, start: number, audioIndex: number, encoder: string): string[] {
  const a = p.audio[audioIndex];
  const args = ['-v', 'error', '-nostdin'];
  // GPU decoding where FFmpeg can (MPEG-2, VC-1, H.264…) on Windows (D3D11/DXVA). On Linux "auto" probes CUDA, VAAPI
  // and Vulkan one after another and can stall on a machine without a working GPU, so it decodes on the CPU there.
  if (mode === 'transcode' && process.platform === 'win32') args.push('-hwaccel', 'auto');
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', file, '-map', '0:V:0?');
  if (a) args.push('-map', `0:a:${audioIndex}`);
  if (mode === 'remux') {
    args.push('-c:v', 'copy');
    if (p.video?.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else {
    const vf = [p.video?.interlaced ? 'bwdif=deint=interlaced' : '', "scale=w=-2:h='min(ih,1080)'", 'format=nv12'].filter(Boolean).join(',');
    args.push('-vf', vf, ...encoderArgs(encoder, p.video?.fps ?? 25));
  }
  if (a) args.push(...(mode === 'remux' && AUDIO_IN_MP4.includes(a.codec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ac', '2']));
  args.push('-sn', '-dn', '-max_muxing_queue_size', '2048', '-f', 'mp4',
    '-movflags', 'empty_moov+default_base_moof+frag_keyframe', '-frag_duration', '1000000', 'pipe:1');
  return args;
}

/**
 * Copying video can only start on a keyframe. To keep the clock right after a seek, we start exactly on the
 * keyframe at or before `t` (read from the packet index, no decoding) and tell the player that is where it is.
 */
export async function keyframeAtOrBefore(file: string, p: MediaProbe, t: number): Promise<number> {
  if (t < 0.5) return 0;
  for (const back of [20, 120, Infinity]) {
    const from = Math.max(0, t - back);
    const out = (await run('ffprobe', ['-v', 'error', '-select_streams', 'V:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0',
      '-read_intervals', `${(from + p.start).toFixed(3)}%${(t + p.start + 0.001).toFixed(3)}`, file], 20000)).toString('utf8');
    let best = -1;
    for (const line of out.split(/\r?\n/)) {
      const [pts, flags] = line.split(',');
      const time = Number(pts) - p.start;
      if (flags?.includes('K') && Number.isFinite(time) && time <= t + 0.001 && time > best) best = time;
    }
    if (best >= 0) return best;
    if (from === 0) return 0;
  }
  return 0;
}

/** A small frame for the seek-bar preview: nearest keyframe at or before `t`, only keyframes decoded (fast). */
export async function seekFrame(file: string, t: number, width = 192): Promise<Buffer> {
  const tail = ['-map', '0:V:0', '-frames:v', '1', '-vf', `scale=${width}:-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '6', '-'];
  const at = Math.max(0, t).toFixed(2);
  try {
    const jpg = await run('ffmpeg', ['-v', 'error', '-skip_frame', 'nokey', '-noaccurate_seek', '-ss', at, '-i', file, ...tail], 15000);
    if (jpg.length) return jpg;
  } catch { /* below */ }
  // Few keyframes (screen recordings, some encoders): none at or after the jump point, so decode up to it instead.
  return run('ffmpeg', ['-v', 'error', '-ss', at, '-i', file, ...tail], 20000);
}

// ---------- subtitles (PLAY-03) ----------

export const SUB_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt'];

/** Subtitle files next to a video: "Film.srt", "Film.en.srt", "Film.hindi.ass"… */
export function sidecarSubtitles(video: string): string[] {
  const dir = path.dirname(video);
  const base = path.basename(video, path.extname(video)).toLowerCase();
  try {
    return fs.readdirSync(dir).filter(f => {
      const ext = path.extname(f).slice(1).toLowerCase();
      const stem = path.basename(f, path.extname(f)).toLowerCase();
      return SUB_EXTENSIONS.includes(ext) && (stem === base || stem.startsWith(base + '.'));
    }).sort().map(f => path.join(dir, f));
  } catch { return []; }
}

/** Embedded track (`index` = n-th subtitle stream) or a subtitle file → timed cues. */
export async function subtitleCues(file: string, index: number | null): Promise<SubtitleCue[]> {
  const args = ['-v', 'error'];
  if (index === null) {
    // Old .srt files are often not UTF-8 (Windows-1252 and friends).
    try { new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)); } catch { args.push('-sub_charenc', 'CP1252'); }
  }
  args.push('-i', file, ...(index === null ? [] : ['-map', `0:s:${index}`]), '-f', 'webvtt', '-');
  return parseVtt((await run('ffmpeg', args, 30000)).toString('utf8'));
}

const clock = (s: string) => { const p = s.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };

export function parseVtt(vtt: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of vtt.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex(l => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const text = lines.slice(at + 1).join('\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
    if (text) cues.push({ start: clock(a), end: clock(b.trim().split(/\s+/)[0]), text });
  }
  return cues;
}
export { setFfmpegDir } from './ffmpeg';
