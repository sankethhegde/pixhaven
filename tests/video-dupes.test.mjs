// 1.1.0 Duplicate videos: the same video found again whatever its name, size or quality; longer versions; two parts
// that overlap, put together. Videos are made with the bundled FFmpeg from moving test pictures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from './helper.mjs';
import { FFMPEG_DIR } from './make-media.mjs';

const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const skip = !fs.existsSync(ffmpeg) && 'FFmpeg not set up (npm run setup:engine)';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-vdupes-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ff = (...args) => { try { return execFileSync(ffmpeg, ["-v", "error", "-y", ...args], { stdio: "pipe" }); } catch (e) { throw new Error(`ffmpeg ${args.join(" ")}: ${e.stderr}`); } };
/** A 90 s video whose picture keeps changing (a slow, turning zoom into the Mandelbrot set, a different place for `seed`). */
const master = (out, seed) => ff('-f', 'lavfi', '-i', `mandelbrot=size=160x120:rate=5:start_x=${[-0.743643887, -1.25066][seed]}:start_y=${[0.131825904, 0.02012][seed]}:start_scale=3:end_scale=0.3:end_pts=90`,
  '-vf', 'rotate=a=t*0.06', '-t', '90', '-c:v', 'mpeg4', '-q:v', '4', out);
const cut = (from, to, src, out, extra = []) => ff('-ss', String(from), '-to', String(to), '-i', src, ...extra, '-c:v', 'mpeg4', '-q:v', '4', out);

test('the same video under another name or in a lower quality, a longer version, and two overlapping parts', { skip, timeout: 600000 }, async () => {
  const { fingerprint, fileHash, refineCut, setFfmpegDir } = await load('dupes/fingerprint');
  setFfmpegDir(FFMPEG_DIR);
  const { findPairs, planDupes } = await load('dupes/video-match');
  const p = n => path.join(tmp, n);
  master(p('trip.mp4'), 0);
  fs.copyFileSync(p('trip.mp4'), p('trip copy renamed.mp4'));                     // exact copy, other name
  cut(0, 90, p('trip.mp4'), p('trip small.mp4'), ['-vf', 'scale=96:72']);           // same video, smaller
  cut(20, 50, p('trip.mp4'), p('trip clip.mp4'));                                    // a piece of it
  master(p('party.mp4'), 1);
  cut(0, 60, p('party.mp4'), p('party part 1.mp4'));                                 // 0–60 s
  cut(25, 90, p('party.mp4'), p('party part 2.mp4'));                                // 25–90 s: 35 s overlap
  ff('-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=5', '-t', '40', '-c:v', 'mpeg4', p('other.mp4'));
  fs.rmSync(p('party.mp4'));

    const files = fs.readdirSync(tmp).filter(n => n.endsWith('.mp4')).sort();
  const t0 = Date.now();
  const fps = [];
  for (const n of files) fps.push(await fingerprint(p(n)));
  const ms = Date.now() - t0;
  const name = i => files[i];
  const pairs = findPairs(fps);
  const bySize = new Map();
  fps.forEach((f, i) => bySize.set(f.size, [...(bySize.get(f.size) ?? []), i]));
  const exact = [];
  for (const g of bySize.values()) if (g.length > 1) {
    const h = await Promise.all(g.map(i => fileHash(fps[i].path)));
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) if (h[x] === h[y]) exact.push([g[x], g[y]]);
  }
  const plan = planDupes(fps.map(f => ({ path: f.path, size: f.size, duration: f.duration, width: f.width, height: f.height })), pairs, exact);

  assert.equal(plan.same.length, 1, JSON.stringify(plan.same.map(g => g.members.map(name))));
  const g = plan.same[0];
  assert.deepEqual(g.members.map(name).sort(), ['trip copy renamed.mp4', 'trip small.mp4', 'trip.mp4']);
  assert.equal(g.keep, null, 'two copies of the same quality: you choose');
  assert.equal(g.exact, false);

  assert.equal(plan.longer.length, 1, JSON.stringify(plan.longer.map(l => [name(l.longer), name(l.shorter)])));
  assert.ok(['trip.mp4', 'trip copy renamed.mp4'].includes(name(plan.longer[0].longer)));
  assert.equal(name(plan.longer[0].shorter), 'trip clip.mp4');
  assert.ok(Math.abs(plan.longer[0].at - 20) <= 4, `found at ${plan.longer[0].at} s`);

  assert.equal(plan.combine.length, 1, JSON.stringify(plan.combine));
  const c = plan.combine[0];
  assert.equal(name(c.first), 'party part 1.mp4');
  assert.equal(name(c.second), 'party part 2.mp4');
  assert.ok(Math.abs(c.cut - 35) <= 4, `part 2 goes on from ${c.cut} s`);
  assert.ok(c.overlapSec >= 30);
  const exactCut = await refineCut(fps[c.first].path, fps[c.first].duration, fps[c.second].path, c.cut);
  assert.ok(Math.abs(exactCut - 35) <= 0.5, `fine cut at ${exactCut} s (rough ${c.cut} s); part 2 starts at 25 s, part 1 ends at 60 s`);
  assert.ok(!pairs.some(x => [x.a, x.b].map(name).includes('other.mp4')), 'an unrelated video matches nothing');
  console.log(`fingerprints of ${files.length} videos (${fps.reduce((n, f) => n + f.duration, 0).toFixed(0)} s of video) in ${ms} ms`);

  // Exact copies only: the copy and the original, and a smaller copy is clearly worse, so the bigger is kept.
  const two = planDupes([fps[files.indexOf('trip.mp4')], fps[files.indexOf('trip small.mp4')]].map(f => ({ path: f.path, size: f.size, duration: f.duration, width: f.width, height: f.height })),
    [{ a: 0, b: 1, rel: { kind: 'same' }, ratio: 1 }], []);
  assert.equal(two.same[0].keep, 0, 'the bigger copy is kept over the smaller one');
});
