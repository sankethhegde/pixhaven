// v2.10 Wallpaper recommended: which photos fit a screen, and in what order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helper.mjs';

const { fit, rank, aspectName } = await load('wallpaper/fit');
const S = { width: 2880, height: 1800 };     // 16:10 laptop at 200 %

test('big enough and the screen\'s shape: ready', () => {
  assert.equal(fit(2880, 1800, S).kind, 'ready');
  assert.equal(fit(6000, 3750, S).kind, 'ready');
  const r = fit(3840, 2160, S);              // 16:9 photo on a 16:10 screen: ~10% cropped
  assert.equal(r.kind, 'ready');
  assert.ok(r.crop > 0.09 && r.crop < 0.11, String(r.crop));
});

test('the right shape but too few pixels: upscale 2× or 4×; far too small: left out', () => {
  assert.deepEqual([fit(1920, 1200, S).kind, fit(1920, 1200, S).upscale], ['upscale', 2]);
  assert.deepEqual([fit(1000, 625, S).kind, fit(1000, 625, S).upscale], ['upscale', 4]);
  assert.equal(fit(600, 375, S), null);
});

test('the wrong shape is left out: portrait, square, panoramas', () => {
  assert.equal(fit(3000, 4000, S), null);
  assert.equal(fit(4000, 4000, S), null);
  assert.equal(fit(8000, 2000, S), null);
  assert.equal(fit(4000, 3000, S).kind, 'ready');   // 4:3 on 16:10: 17% cropped, still fine
});

test('portrait screens want portrait photos', () => {
  const P = { width: 1080, height: 1920 };
  assert.equal(fit(3024, 4032, P)?.kind ?? null, null);   // 3:4 is too wide for 9:16 (25% crop)
  assert.equal(fit(2160, 3840, P).kind, 'ready');
  assert.equal(fit(3840, 2160, P), null);
});

test('best first: least cropped, then sharpest; screen shape names', () => {
  const a = { id: 'a', fit: fit(3840, 2160, S), sharp: 900 }, b = { id: 'b', fit: fit(2880, 1800, S), sharp: 300 }, c = { id: 'c', fit: fit(5760, 3600, S), sharp: 600 };
  assert.deepEqual(rank([a, b, c]).map(x => x.id), ['c', 'b', 'a']);
  assert.equal(aspectName(2880, 1800), '16:10');
  assert.equal(aspectName(1920, 1080), '16:9');
  assert.equal(aspectName(1080, 1920), '9:16');
  assert.equal(aspectName(3440, 1440), '21:9');
});
