// 1.0.8: people in a video — frames from FFmpeg, matching faces against sorted people, and who counts as found.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from './helper.mjs';
import { FFMPEG_DIR } from './make-media.mjs';

const V = await load('faces/video-faces');
const ff = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-vfaces-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// 512-d unit vectors: a person's faces cluster around their own direction.
const unit = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
const dir = k => { const v = new Array(512).fill(0); v[k] = 1; return v; };
const near = (k, j, w = 0.25) => { const v = dir(k); v[j] += w; return unit(v); };
const person = (id, k) => { const members = [near(k, 300), near(k, 301), near(k, 302)]; const sum = new Float32Array(512); for (const m of members) for (let i = 0; i < 512; i++) sum[i] += m[i]; return { id, set: { sum, n: members.length, members } }; };

test('how often and at what size frames are read', () => {
  assert.equal(V.frameStep(60), 2);
  assert.equal(V.frameStep(3600), 6, 'an hour: at most 600 frames');
  assert.deepEqual(V.frameSize(1920, 1080), { W: 1280, H: 720 });
  assert.deepEqual(V.frameSize(641, 361), { W: 640, H: 360 });
  assert.deepEqual(V.frameSize(1080, 1920), { W: 1080, H: 1920 }, 'upright phone video keeps its width');
});

test('FFmpeg hands over one raw RGB frame every few seconds', async () => {
  const clip = path.join(tmp, 'clip.mp4');
  assert.equal(spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=6', '-c:v', 'mpeg4', '-y', clip]).status, 0);
  const frames = [];
  for await (const f of V.videoFrames(ff, ['-i', clip], 2, 160, 120)) frames.push(f);
  assert.deepEqual(frames.map(f => f.t), [0, 2, 4]);
  assert.ok(frames.every(f => f.rgb.length === 160 * 120 * 3 && f.W === 160 && f.H === 120));
  let n = 0;
  for await (const f of V.videoFrames(ff, ['-i', clip], 2, 160, 120, () => ++n >= 1)) assert.equal(f.t, 0);   // stops early
  await assert.rejects(async () => { for await (const f of V.videoFrames(ff, ['-i', path.join(tmp, 'missing.mp4')], 2, 160, 120)) void f; });
});

test('a face goes to the closest sorted person, only above the threshold', () => {
  const people = [person(1, 10), person(2, 20)];
  assert.equal(V.bestMatch(near(10, 303), people, 0.4).id, 1);
  assert.equal(V.bestMatch(near(20, 303), people, 0.4).id, 2);
  assert.equal(V.bestMatch(unit(dir(99)), people, 0.4), null, 'a stranger');
});

test('who counts as found: seen in two frames, or once very clearly; strangers are counted apart', async () => {
  const people = [person(1, 10), person(2, 20), person(3, 30)];
  // frame 0: Mom + a stranger · frame 1: Mom · frame 2: Ravi once, only just above the threshold
  const script = [[near(10, 303)], [near(10, 304), unit(dir(99))], [near(20, 303, 2.0)]];   // ≈0.43: above 0.4, below 0.5
  async function* frames() { for (let i = 0; i < script.length; i++) yield { t: i * 2, rgb: Buffer.alloc(3), W: 1, H: 1 }; }
  let i = 0;
  const engine = { analyse: async () => script[i++].map(emb => ({ usable: true, emb })) };
  const seen = [];
  const r = await V.findPeople(frames(), engine, people, { threshold: 0.4, minFace: 40, minSharpness: 20, onFrame: n => seen.push(n) });
  assert.equal(r.frames, 3); assert.equal(r.faces, 4); assert.equal(r.unknown, 1);
  assert.deepEqual(r.people.map(p => [p.personId, p.frames, p.times]), [[1, 2, [0, 2]]], 'Ravi seen once, not clearly: left out');
  assert.deepEqual(seen, [1, 2, 3]);
  assert.ok(V.sureness(r.people[0].mean, 0.4) >= 50 && V.sureness(0.9, 0.4) === 99 && V.sureness(0.4, 0.4) === 50);
});
