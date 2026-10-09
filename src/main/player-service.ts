// Video player (v2.0 Phase B): opens a video, serves it to the built-in player (directly with seeking, or as an
// FFmpeg stream), subtitles, seek-bar previews and resume positions (PLAY-05).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import type { PlayerCaps, PlayInfo, PlayMode, PlayStream, RecentVideo, SubtitleCue, SubtitleTrack } from '@shared/types';
import { log } from './logger';
import { pauseThumbs } from './library-service';
import { tagStore } from './tags-service';
import { tool } from './library/ffmpeg';
import {
  keyframeAtOrBefore, pickEncoder, planPlayback, probeMedia, seekFrame, sidecarSubtitles, streamArgs, subtitleCues, type MediaProbe,
} from './library/player';

interface Session {
  id: string;
  file: string;
  probe: MediaProbe;
  caps: PlayerCaps;
  mode: PlayMode;
  audio: number;
  subs: Map<string, { label: string; file: string; index: number | null; text: boolean }>;
  proc: ChildProcess | null;
}
const sessions = new Map<string, Session>();

const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', '3gp': 'video/mp4', '3g2': 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };
const ext = (p: string) => path.extname(p).slice(1).toLowerCase();


const LANG: Record<string, string> = { eng: 'English', hin: 'Hindi', kan: 'Kannada', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', mar: 'Marathi', ben: 'Bengali', fre: 'French', fra: 'French', ger: 'German', deu: 'German', spa: 'Spanish', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese', ita: 'Italian', por: 'Portuguese', rus: 'Russian', ara: 'Arabic' };
const langName = (l?: string) => (l ? LANG[l] ?? l.toUpperCase() : undefined);

function subtitleList(s: Session): SubtitleTrack[] {
  return [...s.subs].map(([id, t]) => ({ id, label: t.label, source: t.index === null ? 'file' : 'embedded', text: t.text }));
}

export async function open(file: string, caps: PlayerCaps): Promise<PlayInfo> {
  const probe = await probeMedia(file);
  const id = crypto.randomUUID();
  const s: Session = { id, file, probe, caps, mode: 'direct', audio: 0, subs: new Map(), proc: null };
  probe.subs.forEach((t, n) => s.subs.set(`e${n}`, {
    label: [t.title, langName(t.language)].filter(Boolean).join(' · ') || `Track ${n + 1}`, file, index: t.index, text: t.text,
  }));
  sidecarSubtitles(file).forEach((f, n) => s.subs.set(`f${n}`, { label: path.basename(f), file: f, index: null, text: true }));
  sessions.set(id, s);
  const stream = await streamFor(s, 0, planPlayback(probe, caps, 0, ext(file)).mode);
  const saved = tagStore().position(file);
  const resumeAt = saved !== null && saved > 5 && !finished(saved, probe.duration) ? saved : null;
  log('info', `Play ${path.basename(file)}: ${stream.mode} (${stream.reason})${stream.encoder ? ` with ${stream.encoder}` : ''}`);
  return {
    ...stream, session: id, path: file, duration: probe.duration,
    width: probe.video?.width ?? 0, height: probe.video?.height ?? 0, videoCodec: probe.video?.codec ?? '',
    audio: probe.audio.map(a => ({ ...a, language: langName(a.language) })), subtitles: subtitleList(s), resumeAt,
  };
}

/** Where the player should load from to play from `t`; `force` moves up a step after the player failed. */
async function streamFor(s: Session, t: number, mode: PlayMode): Promise<PlayStream> {
  s.mode = mode;
  const plan = planPlayback(s.probe, s.caps, s.audio, ext(s.file));
  const reason = mode === plan.mode ? plan.reason
    : mode === 'remux' ? 'Repackaged on the fly (video copied, not converted)' : `${(s.probe.video?.codec ?? 'video').toUpperCase()} is converted on the fly`;
  if (mode === 'direct') return { url: `clearup://media/${encodeURIComponent(s.file)}`, base: 0, mode, reason };
  const base = mode === 'remux' ? await keyframeAtOrBefore(s.file, s.probe, t) : Math.max(0, t);
  const encoder = mode === 'transcode' ? await pickEncoder() : undefined;
  // A fresh URL each time: the player reloads, and the old FFmpeg is stopped when its stream is dropped.
  return { url: `clearup://stream/${s.id}?t=${base.toFixed(3)}&a=${s.audio}&n=${Date.now()}`, base, mode, reason, encoder };
}

const session = (id: string) => { const s = sessions.get(id); if (!s) throw new Error('This video was closed.'); return s; };

/** Seek (streams restart at the new place), change sound track, or step up after a playback error. */
export async function seek(id: string, t: number, opts: { audio?: number; fallback?: boolean } = {}): Promise<PlayStream> {
  const s = session(id);
  if (opts.audio !== undefined) s.audio = opts.audio;
  const plan = planPlayback(s.probe, s.caps, s.audio, ext(s.file)).mode;
  const order: PlayMode[] = ['direct', 'remux', 'transcode'];
  let mode = order[Math.max(order.indexOf(plan), opts.audio !== undefined ? 0 : order.indexOf(s.mode))];
  if (opts.fallback) {
    mode = order[Math.min(2, order.indexOf(s.mode) + 1)];
    log('warn', `Playback of ${path.basename(s.file)} failed in ${s.mode} mode, trying ${mode}`);
  }
  return streamFor(s, t, mode);
}

export function close(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  s.proc?.kill();
  sessions.delete(id);
  if (!sessions.size) pauseThumbs(false);
}

export async function subtitles(id: string, track: string): Promise<SubtitleCue[]> {
  const s = session(id);
  const t = s.subs.get(track);
  if (!t) throw new Error('Unknown subtitle track');
  if (!t.text) throw new Error('Picture subtitles (DVD/Blu-ray) are not supported yet.');
  return subtitleCues(t.file, t.index);
}

export function addSubtitleFile(id: string, file: string): SubtitleTrack[] {
  const s = session(id);
  const n = [...s.subs.keys()].filter(k => k.startsWith('f')).length;
  s.subs.set(`f${n}`, { label: path.basename(file), file, index: null, text: true });
  return subtitleList(s);
}
export const subtitleTrackId = (id: string, file: string) => [...session(id).subs].find(([, t]) => t.file === file && t.index === null)?.[0];

export async function frame(file: string, t: number): Promise<string> {
  return `data:image/jpeg;base64,${(await seekFrame(file, t)).toString('base64')}`;
}

/** "Finished" = in the last 5 % (at most the last 10 s): nothing to resume. */
const finished = (position: number, duration: number) => duration > 0 && position >= duration - Math.min(10, duration * 0.05);

/** PLAY-05: remembered every few seconds; cleared when the video is (nearly) finished. */
export function savePosition(file: string, position: number, duration: number): void {
  // Finished (or a short clip watched): kept for "Recently played", but nothing to resume.
  const at = finished(position, duration) ? 0 : position;
  tagStore().savePosition(file, at, duration);
}

export function recent(limit = 12): RecentVideo[] {
  const rows = tagStore().recent(limit * 2);
  const out: RecentVideo[] = [];
  for (const r of rows) {
    try { const st = fs.statSync(r.path); out.push({ ...r, size: st.size, mtime: st.mtimeMs }); } catch { /* moved or deleted */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** Is this file open in the player? (TAG-08 waits before writing into it.) */
export const isOpen = (p: string) => [...sessions.values()].some(s => (process.platform === 'win32' ? s.file.toLowerCase() === p.toLowerCase() : s.file === p));

export function playing(p: boolean): void { pauseThumbs(p); }   // low-spec: no thumbnail work while a video plays

// ---------- serving to the player ----------

/** clearup://media/<path>: the file itself with byte ranges, so the player can seek. */
export async function serveFile(req: Request, file: string): Promise<Response> {
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !MIME[ext(file)]) return new Response('Not found', { status: 404 });
  const size = st.size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  let start = 0, end = size - 1;
  if (m) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); }
    else if (m[2]) start = Math.max(0, size - Number(m[2]));
  }
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
  return new Response(body, {
    status: m ? 206 : 200,
    headers: { 'Content-Type': MIME[ext(file)], 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) },
  });
}

/** clearup://stream/<session>?t=&a=: FFmpeg writing fragmented MP4, piped straight to the player. */
export async function serveStream(url: URL): Promise<Response> {
  const s = sessions.get(url.pathname.slice(1));
  if (!s || s.mode === 'direct') return new Response('Not found', { status: 404 });
  s.proc?.kill();
  const t = Number(url.searchParams.get('t') ?? 0);
  const audio = Number(url.searchParams.get('a') ?? 0);
  const encoder = s.mode === 'transcode' ? await pickEncoder() : '';
  const args = streamArgs(s.file, s.probe, s.mode, t, audio, encoder);
  const proc = spawn(tool('ffmpeg'), args, { windowsHide: true });
  s.proc = proc;
  let err = '';
  proc.stderr.on('data', d => { if (err.length < 2000) err += d; });
  proc.on('close', code => { if (code && !proc.killed) log('warn', `Stream of ${path.basename(s.file)} ended with ${code}: ${err.trim().slice(-300)}`); });
  // toWeb() keeps backpressure: when the player has enough buffered, FFmpeg waits instead of filling memory.
  // When the player drops the stream (seek, track change, closed), the pipe closes and FFmpeg is stopped.
  proc.stdout.on('close', () => { if (proc.exitCode === null) proc.kill(); });
  proc.on('error', e => log('error', 'FFmpeg could not start', e));
  const body = Readable.toWeb(proc.stdout) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' } });
}
