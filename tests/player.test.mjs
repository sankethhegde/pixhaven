// Video player (v2.0 Phase B): how each format is played, FFmpeg streams that really decode, exact clock after
// seeking a copied stream, and subtitles (embedded, sidecar, non-UTF-8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from './helper.mjs';
import { makePlayerFolder, FFMPEG_DIR } from './make-media.mjs';

const P = await load('library/player');
P.setFfmpegDir?.(FFMPEG_DIR);
const { setFfmpegDir } = await load('library/thumbs');
setFfmpegDir(FFMPEG_DIR);   // the player bundle shares nothing with this one: set both

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-player-'));
const dir = path.join(tmp, 'media');
const files = await makePlayerFolder(dir);
const videos = files.filter(f => /\.(mp4|m4v|mkv|avi|mov|wmv|flv|webm|3gp|mpg|ts|mts|m2ts|vob|ogv)$/.test(f));
const CAPS = { hevc: true, av1: true, mkv: true };
const exe = n => path.join(FFMPEG_DIR, process.platform === 'win32' ? `${n}.exe` : n);

test('each format gets the lightest way to play', async () => {
  const want = {
    'clip h264.mp4': 'direct', 'clip.m4v': 'direct', 'clip.mov': 'direct', 'clip vp9.webm': 'direct', 'clip hevc.mkv': 'direct',
    'clip av1.mp4': 'direct', '4k hevc.mp4': 'direct', '4k av1.mp4': 'direct', 'phone video.mp4': 'direct', 'two tracks.mkv': 'direct',
    'clip.mts': 'remux', 'clip.m2ts': 'remux',                                       // H.264 with AC-3 sound in MPEG-TS
    'clip.avi': 'transcode', 'clip.wmv': 'transcode', 'clip.flv': 'transcode', 'clip.3gp': 'transcode', 'clip.mpg': 'transcode',
    'clip.ts': 'transcode', 'clip.vob': 'transcode', 'clip.ogv': 'transcode',
  };
  for (const f of videos) {
    const plan = P.planPlayback(await P.probeMedia(path.join(dir, f)), CAPS, 0, path.extname(f).slice(1));
    assert.equal(plan.mode, want[f], `${f}: ${plan.reason}`);
  }
  const mkv = await P.probeMedia(path.join(dir, 'two tracks.mkv'));
  assert.equal(P.planPlayback(mkv, CAPS, 1).mode, 'remux', 'second sound track is switched by remuxing');
  assert.equal(P.planPlayback(mkv, { ...CAPS, mkv: false }, 0, 'mkv').mode, 'remux', 'MKV not supported → remux');
  const hevc = await P.probeMedia(path.join(dir, '4k hevc.mp4'));
  assert.equal(P.planPlayback(hevc, { ...CAPS, hevc: false }).mode, 'transcode', 'no HEVC decoder → convert');
  assert.deepEqual(mkv.audio.map(a => [a.language, a.title]), [['eng', 'English'], ['hin', 'Hindi']]);
  assert.equal(mkv.subs.length, 1);
  assert.ok(mkv.subs[0].text);
});

test('every stream that is not played directly decodes as MP4 (from the middle, too)', { timeout: 240000 }, async () => {
  const encoder = await P.pickEncoder();
  assert.ok(encoder, 'an H.264 encoder');
  for (const f of videos) {
    const file = path.join(dir, f);
    const probe = await P.probeMedia(file);
    for (const mode of ['remux', 'transcode']) {
      const plan = P.planPlayback(probe, CAPS, 0, path.extname(f).slice(1)).mode;
      if (plan === 'direct' && mode === 'transcode' && !f.startsWith('4k')) continue;   // keep the test quick
      if (plan === 'transcode' && mode === 'remux') continue;                           // video can't be copied
      const start = probe.duration > 3 ? 1.5 : 0;
      const at = mode === 'remux' ? await P.keyframeAtOrBefore(file, probe, start) : start;
      const out = path.join(tmp, `${f}.${mode}.mp4`);
      const args = P.streamArgs(file, probe, mode, at, 0, encoder);
      args[args.length - 1] = out;                                                     // pipe:1 → file for inspection
      const r = spawnSync(exe('ffmpeg'), ['-y', ...args], { timeout: 120000 });
      assert.equal(r.status, 0, `${f} ${mode}: ${r.stderr}`);
      const info = JSON.parse(spawnSync(exe('ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).stdout.toString());
      const v = info.streams.find(s => s.codec_type === 'video');
      assert.equal(v?.codec_name, mode === 'remux' ? probe.video.codec : 'h264', `${f} ${mode}: video copied, or converted to H.264`);
      if (probe.audio.length) assert.equal(info.streams.find(s => s.codec_type === 'audio')?.codec_name, mode === 'remux' && probe.audio[0].codec === 'mp3' ? 'mp3' : 'aac', `${f} audio`);
      assert.ok(Math.abs(Number(info.format.duration) - (probe.duration - at)) < 1, `${f} ${mode}: ${info.format.duration} s from ${at}`);
      if (mode === 'transcode') assert.ok(v.height <= 1080, 'converted video is at most 1080p');
    }
  }
});

test('copied streams restart exactly on a keyframe', async () => {
  const file = path.join(dir, 'two tracks.mkv');                // keyframe every 2 s (-g 50 at 25 fps)
  const probe = await P.probeMedia(file);
  assert.equal(await P.keyframeAtOrBefore(file, probe, 0.2), 0);
  assert.ok(Math.abs(await P.keyframeAtOrBefore(file, probe, 7.3) - 6) < 0.05);
  assert.ok(Math.abs(await P.keyframeAtOrBefore(file, probe, 12) - 12) < 0.05);
  const ts = path.join(dir, 'clip.mts');                         // MPEG-TS starts at 1.4 s: times are relative to that
  const tp = await P.probeMedia(ts);
  assert.ok(tp.start > 0);
  const k = await P.keyframeAtOrBefore(ts, tp, 2.5);
  assert.ok(k >= 0 && k <= 2.5, `mts keyframe ${k}`);
});

test('subtitles: embedded track, file next to the video, and an old non-UTF-8 file', async () => {
  const cues = await P.subtitleCues(path.join(dir, 'two tracks.mkv'), 0);
  assert.deepEqual(cues.map(c => [c.start, c.end, c.text]), [[1, 4, 'Embedded subtitle line'], [12, 15, 'Second embedded line']]);
  assert.deepEqual(P.sidecarSubtitles(path.join(dir, 'clip h264.mp4')).map(f => path.basename(f)), ['clip h264.srt']);
  const side = await P.subtitleCues(path.join(dir, 'clip h264.srt'), null);
  assert.equal(side[0].text, 'Hello from the subtitle file');
  const latin = path.join(tmp, 'café.srt');
  fs.writeFileSync(latin, Buffer.from('1\r\n00:00:01,000 --> 00:00:02,000\r\nCaf\xe9 cr\xe8me\r\n', 'latin1'));
  assert.equal((await P.subtitleCues(latin, null))[0].text, 'Café crème');
  assert.deepEqual(P.parseVtt('WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<i>Hi</i> &amp; bye\n\n1:00:00.000 --> 1:00:01.000\nLate'),
    [{ start: 1, end: 2.5, text: 'Hi & bye' }, { start: 3600, end: 3601, text: 'Late' }]);
});

test('seek-bar preview frames', async () => {
  const jpg = await P.seekFrame(path.join(dir, '4k hevc.mp4'), 5);
  assert.equal(jpg[0], 0xff); assert.equal(jpg[1], 0xd8);
  assert.ok(jpg.length > 1000);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
