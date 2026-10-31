// v2.11 Video editor, phase 2: what each output is made of (trim, cut out, split), fast lossless cuts, the filter graph
// for edits (rotate, crop, speed, sound, look, text, fades, music) and joining.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helper.mjs';

const { outputsOf, onlyCuts, atempo, cropBox, planEdit, planJoin } = await load('convert/edit');

const P = { duration: 60, start: 0, format: 'mov', video: { codec: 'h264', width: 1920, height: 1080, fps: 30, pixFmt: 'yuv420p', interlaced: false }, audio: [{ index: 0, codec: 'aac', channels: 2 }], subs: [] };
const E = {
  trim: { start: 0, end: 60 }, cuts: [], splits: [], exact: false, rotate: 0, flipH: false, flipV: false, crop: null, speed: 1, volume: 1, music: null,
  brightness: 0, contrast: 0, saturation: 1, stabilize: false, text: null, fadeIn: 0, fadeOut: 0, resolution: 'keep',
  output: { target: 'mp4-h264', quality: 'balanced' }, outDir: null,
};
const at = (args, flag) => args[args.indexOf(flag) + 1];

test('trim, cut out and split: the pieces each output is made of', () => {
  assert.deepEqual(outputsOf({ trim: { start: 5, end: 50 }, cuts: [], splits: [] }, 60), [[{ start: 5, end: 50 }]]);
  assert.deepEqual(outputsOf({ trim: { start: 0, end: 60 }, cuts: [{ start: 10, end: 20 }, { start: 30, end: 35 }], splits: [] }, 60),
    [[{ start: 0, end: 10 }, { start: 20, end: 30 }, { start: 35, end: 60 }]]);
  assert.deepEqual(outputsOf({ trim: { start: 0, end: 60 }, cuts: [{ start: 10, end: 20 }], splits: [15, 40] }, 60),
    [[{ start: 0, end: 10 }], [{ start: 20, end: 40 }], [{ start: 40, end: 60 }]]);
  assert.deepEqual(outputsOf({ trim: { start: 0, end: 60 }, cuts: [{ start: 0, end: 60 }], splits: [] }, 60), []);
});

test('a plain trim or split is cut without converting', () => {
  assert.equal(onlyCuts(E), true);
  assert.equal(onlyCuts({ ...E, cuts: [{ start: 1, end: 2 }] }), false);
  assert.equal(onlyCuts({ ...E, exact: true }), false);
  assert.equal(onlyCuts({ ...E, speed: 2 }), false);
  const runs = planEdit('in.mp4', ['a.mp4', 'b.mp4'], P, { ...E, trim: { start: 2, end: 50 }, splits: [20] }, null);
  assert.equal(runs.length, 2);
  assert.equal(at(runs[0].args, '-ss'), '2');
  assert.equal(at(runs[0].args, '-to'), '20');
  assert.equal(at(runs[1].args, '-ss'), '20');
  assert.equal(at(runs[0].args, '-c'), 'copy');
  assert.equal(runs[1].duration, 30);
});

test('rotate, crop to 9:16 (centred), speed 2×, fades, look and text in one graph', () => {
  const e = { ...E, rotate: 90, crop: { aspect: '9:16', x: 0.5, y: 0.5 }, speed: 2, fadeIn: 1, fadeOut: 2, brightness: 0.2, saturation: 1.3, contrast: 0.5,
    text: { value: 'Goa 2024', position: 'bottom', size: 'm' }, cuts: [{ start: 10, end: 20 }] };
  const [r] = planEdit('in.mp4', ['out.mp4'], P, e, 'h264_qsv', { textFile: 'C:\\t\\title.txt', font: 'C:\\Windows\\Fonts\\segoeui.ttf' });
  const fc = at(r.args, '-filter_complex');
  // Rotated 1920×1080 is 1080×1920, already 9:16: the crop keeps it whole.
  assert.match(fc, /transpose=1,crop=1080:1920:0:0/);
  assert.match(fc, /concat=n=2:v=1:a=1\[vj\]\[aj\]/);
  assert.match(fc, /hue=s=1\.3:b=1/);
  assert.match(fc, /curves=all='0\/0 0\.25\/0\.15 0\.75\/0\.85 1\/1'/);
  assert.match(fc, /setpts=PTS\/2/);
  assert.match(fc, /drawtext=fontfile='C\\:\/Windows\/Fonts\/segoeui\.ttf':textfile='C\\:\/t\/title\.txt'/);
  assert.match(fc, /fade=t=out:st=23:d=2/);                       // (60 − 10) / 2 = 25 s long
  assert.match(fc, /atempo=2,afade=t=in:st=0:d=1/);
  assert.equal(r.duration, 25);
  assert.equal(at(r.args, '-c:v'), 'h264_qsv');
  assert.equal(at(r.args, '-t'), '25');
});

test('crop boxes: 1:1 and 9:16 from landscape, moved to the left edge', () => {
  assert.deepEqual(cropBox(1920, 1080, { rotate: 0, crop: { aspect: '1:1', x: 0.5, y: 0.5 } }), { w: 1080, h: 1080, x: 420, y: 0 });
  assert.deepEqual(cropBox(1920, 1080, { rotate: 0, crop: { aspect: '9:16', x: 0, y: 0.5 } }), { w: 606, h: 1080, x: 0, y: 0 });
  assert.deepEqual(cropBox(1920, 1080, { rotate: 0, crop: null }), { w: 1920, h: 1080, x: 0, y: 0 });
});

test('sound: speed beyond 2× chained, muted, music instead or mixed in', () => {
  assert.deepEqual(atempo(4), ['atempo=2', 'atempo=2']);
  assert.deepEqual(atempo(0.25), ['atempo=0.5', 'atempo=0.5']);
  assert.deepEqual(atempo(1.5), ['atempo=1.5']);
  const mute = planEdit('in.mp4', ['o.mp4'], P, { ...E, volume: 0, exact: true }, 'h264_qsv')[0].args;
  assert.ok(mute.includes('-an'));
  const music = planEdit('in.mp4', ['o.mp4'], P, { ...E, music: { path: 'song.mp3', volume: 0.5, mix: true } }, 'h264_qsv')[0].args;
  assert.ok(music.includes('-stream_loop') && music.includes('song.mp3'));
  assert.match(at(music, '-filter_complex'), /\[1:a:0\]atrim=0:60.*volume=0\.5.*amix=inputs=2/);
  const instead = planEdit('in.mp4', ['o.mp4'], P, { ...E, volume: 0, music: { path: 'song.mp3', volume: 1, mix: false } }, 'h264_qsv')[0].args;
  assert.equal(instead[instead.lastIndexOf('-map') + 1], '[music]');
});

test('everything cut out, or no encoder, says so; join evens sizes out and fills in silence', () => {
  assert.throws(() => planEdit('a', ['b'], P, { ...E, cuts: [{ start: 0, end: 60 }] }, 'h264_qsv'), /Nothing is left/);
  assert.throws(() => planEdit('a', ['b'], P, { ...E, speed: 2 }, null), /No encoder/);
  const quiet = { ...P, duration: 5, audio: [], video: { ...P.video, width: 1280, height: 720 } };
  const j = planJoin([{ path: 'a.mp4', probe: P }, { path: 'b.mp4', probe: quiet }], 'j.mp4', { target: 'mp4-h264', quality: 'balanced' }, 'h264_qsv');
  const fc = at(j.args, '-filter_complex');
  assert.match(fc, /\[1:V:0\]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080/);
  assert.ok(j.args.includes('anullsrc=r=48000:cl=stereo'));
  assert.match(fc, /concat=n=2:v=1:a=1/);
  assert.equal(j.duration, 65);
  assert.throws(() => planJoin([{ path: 'a.mp4', probe: P }], 'j.mp4', { target: 'mp4-h264', quality: 'balanced' }, 'h264_qsv'), /at least two/);
});
