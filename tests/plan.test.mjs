import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { load } from './helper.mjs';

const { planScale, wantedFactor, outputPath, uniquePath, isUpscaledName } = await load('plan');

test('fixed factors pick the matching native scale', () => {
  assert.deepEqual(planScale(640, 480, { kind: 'scale', factor: 2 }, 'fast'),
    { model: 'realesr-animevideov3', engineScale: 2, factor: 2, width: 1280, height: 960, needsResize: false });
  const p = planScale(640, 480, { kind: 'scale', factor: 2 }, 'photo');
  assert.equal(p.engineScale, 4);           // x4plus only does 4x…
  assert.equal(p.width, 1280);              // …then resized down to 2x
  assert.equal(p.needsResize, true);
});

test('target sizes fit inside the box and keep orientation', () => {
  assert.equal(wantedFactor(640, 360, { kind: 'target', target: '1080p' }), 3);     // 16:9 landscape
  assert.equal(wantedFactor(360, 640, { kind: 'target', target: '1080p' }), 3);     // portrait uses 1080×1920
  const p = planScale(800, 600, { kind: 'target', target: '1080p' }, 'fast');        // 4:3 → limited by height
  assert.deepEqual([p.width, p.height, p.engineScale], [1440, 1080, 2]);
  const big = planScale(300, 200, { kind: 'target', target: '4k' }, 'fast');         // >4x: 4x then Lanczos up
  assert.deepEqual([big.width, big.height, big.engineScale, big.needsResize], [3240, 2160, 4, true]);
});

test('target smaller than the image is refused', () => {
  assert.ok('error' in planScale(2000, 1500, { kind: 'target', target: '1080p' }, 'fast'));
});

test('output names never overwrite', () => {
  const src = path.join('C:', 'pics', 'cat.jpeg');
  const out = outputPath(src, 'png', null);
  assert.equal(out, path.join('C:', 'pics', 'cat_upscaled.png'));
  assert.equal(outputPath(src, 'jpg', path.join('D:', 'out')), path.join('D:', 'out', 'cat_upscaled.jpg'));
  const taken = new Set([out, path.join('C:', 'pics', 'cat_upscaled (2).png')]);
  assert.equal(uniquePath(out, p => taken.has(p)), path.join('C:', 'pics', 'cat_upscaled (3).png'));
  assert.ok(isUpscaledName('cat_upscaled (3).png'));
  assert.ok(!isUpscaledName('cat.png'));
});
