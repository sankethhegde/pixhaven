// v2.6 Image Generator: tokenizer, scheduler and half-precision helpers; a real generation when the model is on this
// computer (PIXHAVEN_GEN_MODEL = its folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load } from './helper.mjs';

const G = await load('generator/pipeline');
const MODEL = process.env.PIXHAVEN_GEN_MODEL;
const HAS_MODEL = !!MODEL && fs.existsSync(path.join(MODEL, 'unet', 'model.onnx'));

test('CLIP tokenizer: same ids as the reference tokenizer', { skip: !HAS_MODEL && 'needs the model folder (PIXHAVEN_GEN_MODEL)' }, () => {
  const tok = new G.ClipTokenizer(path.join(MODEL, 'tokenizer'));
  const ids = tok.encode('A photo of a cat');
  assert.deepEqual(ids.slice(0, 7), [49406, 320, 1125, 539, 320, 2368, 49407]);
  assert.equal(ids.length, 77);
  assert.ok(ids.slice(6).every(i => i === 49407), 'padded with the end token');
  assert.equal(tok.count('A photo of a cat'), 5);
  const long = tok.encode('word '.repeat(200));
  assert.equal(long.length, 77);
  assert.equal(long[76], 49407, 'a long prompt is cut and still ends properly');
  assert.equal(tok.count('word '.repeat(200)), 200);
});

test('LCM scheduler: 4 steps are 999, 759, 519, 279; 8 steps start at 999', () => {
  const s = new G.LcmScheduler({ num_train_timesteps: 1000, beta_start: 0.00085, beta_end: 0.012, original_inference_steps: 50, set_alpha_to_one: true, timestep_scaling: 10 });
  assert.deepEqual(s.timesteps(4), [999, 759, 519, 279]);
  const eight = s.timesteps(8);
  assert.equal(eight.length, 8);
  assert.equal(eight[0], 999);
  assert.ok(eight.every((t, i) => i === 0 || t < eight[i - 1]));
  assert.ok(s.alphas[0] > 0.99 && s.alphas[999] < 0.01);
});

test('half precision round trip and seeded noise', () => {
  for (const v of [0, 1, -1, 0.5, 3.140625, -2048, 65504]) assert.equal(G.fromHalf(G.toHalf(v)), v);
  const a = G.gaussian(42), b = G.gaussian(42);
  const xs = Array.from({ length: 1000 }, a);
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, b));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.1 && Math.abs(sd - 1) < 0.1, `mean ${mean}, sd ${sd}`);
});

test('generates a 512×512 image (same seed, same picture)', { skip: !HAS_MODEL && 'needs the model folder (PIXHAVEN_GEN_MODEL)', timeout: 300000 }, async () => {
  const gen = await G.ImageGenerator.load(MODEL, true);
  try {
    const o = { prompt: 'a red apple on a wooden table, photo', seed: 5, steps: 4, width: 512, height: 512 };
    const steps = [];
    const a = await gen.generate(o, (d, t) => steps.push(`${d}/${t}`));
    assert.equal(a.rgb.length, 512 * 512 * 3);
    assert.deepEqual(steps, ['1/5', '2/5', '3/5', '4/5', '5/5']);
    const b = await gen.generate(o);
    assert.ok(a.rgb.equals(b.rgb), 'same seed, same image');
    // Red apples: plenty of red in the picture.
    let red = 0;
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) { const i = (y * 512 + x) * 3; if (a.rgb[i] > 120 && a.rgb[i] > a.rgb[i + 1] * 1.6) red++; }
    assert.ok(red > 512 * 512 * 0.03, `${red} red pixels`);
    assert.equal(a.nsfw, false);
    const cancelled = await gen.generate(o, undefined, () => true);
    assert.equal(cancelled, null);
    console.log(`  ${gen.device}: ${a.ms} ms, then ${b.ms} ms`);
  } finally { await gen.release(); }
});
