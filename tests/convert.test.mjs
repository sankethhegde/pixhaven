// v2.11 Video editor, phase 1: FFmpeg arguments for conversions (copy when nothing changes, quality, size limit,
// resolution, sound, GIF, audio only) and output names that never overwrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { load } from './helper.mjs';

const { planConvert, outSize, outputName, progressSeconds, TARGETS } = await load('convert/plan');

const hevc = { duration: 60, start: 0, format: 'mov', video: { codec: 'hevc', width: 3840, height: 2160, fps: 30, pixFmt: 'yuv420p10le', interlaced: false }, audio: [{ index: 0, codec: 'aac', channels: 2 }], subs: [] };
const O = { target: 'mp4-h264', quality: 'balanced', resolution: 'keep', maxMB: null, sound: true, outDir: null };
const at = (args, flag) => args[args.indexOf(flag) + 1];

test('HEVC → MP4 H.264 on Quick Sync: NV12, quality, sound copied, fast start', () => {
  const { args, copyVideo } = planConvert('in.mov', 'out.mp4', hevc, O, 'h264_qsv');
  assert.equal(copyVideo, false);
  assert.equal(at(args, '-c:v'), 'h264_qsv');
  assert.match(at(args, '-vf'), /format=nv12$/);
  assert.equal(at(args, '-global_quality'), '25');
  assert.equal(at(args, '-c:a'), 'copy');                  // AAC already
  assert.ok(args.includes('+faststart'));
  assert.equal(args.at(-1), 'out.mp4');
});

test('same codec and nothing to change: the video is copied, HEVC tagged hvc1', () => {
  const r = planConvert('in.mov', 'out.mp4', hevc, { ...O, target: 'mp4-hevc' }, 'hevc_qsv');
  assert.equal(r.copyVideo, true);
  assert.equal(at(r.args, '-c:v'), 'copy');
  assert.equal(at(r.args, '-tag:v'), 'hvc1');
  assert.ok(!r.args.includes('-vf'));
  // A size limit or a smaller resolution means converting after all.
  assert.equal(planConvert('in.mov', 'out.mp4', hevc, { ...O, target: 'mp4-hevc', resolution: 1080 }, 'hevc_qsv').copyVideo, false);
});

test('fit under a size: the bitrate fits the length, sound 128k, the rest for the picture', () => {
  const { args } = planConvert('in.mov', 'out.mp4', hevc, { ...O, maxMB: 25 }, 'h264_qsv');
  const k = parseInt(at(args, '-b:v'), 10);
  // 25 MB over 60 s: 25*8*1000*0.94/60 − 128 ≈ 2,999 kbit/s
  assert.ok(k > 2900 && k < 3100, String(k));
  assert.equal(at(args, '-b:a'), '128k');
  assert.ok(!args.includes('-global_quality'));
});

test('resolution only ever gets smaller, even sizes, portrait too', () => {
  assert.deepEqual(outSize(3840, 2160, 1080), { w: 1920, h: 1080 });
  assert.deepEqual(outSize(1080, 1920, 720), { w: 720, h: 1280 });
  assert.deepEqual(outSize(1280, 720, 1080), { w: 1280, h: 720 });
  assert.deepEqual(outSize(1918, 1078, 720), { w: 1282, h: 720 });
  const { args } = planConvert('in.mov', 'out.mp4', hevc, { ...O, resolution: 720 }, 'libopenh264');
  assert.match(at(args, '-vf'), /^scale=1280:720:flags=lanczos,format=yuv420p$/);
  assert.match(at(args, '-b:v'), /k$/);                     // OpenH264: a bitrate by picture size
});

test('no sound, WebM with Opus, sound only, GIF', () => {
  assert.ok(planConvert('a', 'b.mp4', hevc, { ...O, sound: false }, 'h264_qsv').args.includes('-an'));
  const webm = planConvert('a', 'b.webm', hevc, { ...O, target: 'webm-vp9' }, 'libvpx-vp9').args;
  assert.equal(at(webm, '-c:a'), 'libopus');
  assert.equal(at(webm, '-crf'), '33');
  const mp3 = planConvert('a', 'b.mp3', hevc, { ...O, target: 'mp3' }, null).args;
  assert.ok(mp3.includes('-vn') && at(mp3, '-c:a') === 'libmp3lame');
  const gif = planConvert('a', 'b.gif', hevc, { ...O, target: 'gif' }, null).args;
  assert.match(at(gif, '-vf'), /^fps=12,scale=480:-2.*palettegen.*paletteuse/);
  assert.throws(() => planConvert('a', 'b.mp3', { ...hevc, audio: [] }, { ...O, target: 'mp3' }, null), /no sound/);
  assert.throws(() => planConvert('a', 'b.mp4', hevc, { ...O, target: 'mp4-av1' }, null), /No encoder/);
});

test('output names never overwrite; progress is read from FFmpeg', () => {
  const taken = new Set([path.join('D', 'clip.mp4'), path.join('D', 'clip (converted).mp4')].map(p => p.toLowerCase()));
  const exists = p => taken.has(p.toLowerCase());
  assert.equal(outputName(path.join('D', 'clip.mkv'), 'mp4', 'D', exists), path.join('D', 'clip (converted 2).mp4'));
  assert.equal(outputName(path.join('D', 'film.mov'), 'mp4', 'D', exists), path.join('D', 'film.mp4'));
  assert.equal(outputName(path.join('D', 'film.mp4'), 'mp4', 'D', () => false), path.join('D', 'film (converted).mp4'), 'never the original itself');
  assert.equal(progressSeconds('frame=10\nout_time_us=2500000\nprogress=continue\n'), 2.5);
  assert.equal(progressSeconds('nothing'), null);
  assert.equal(Object.keys(TARGETS).length, 10);
});
