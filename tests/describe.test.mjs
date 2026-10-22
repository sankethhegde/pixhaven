// v2.7 "Describe a picture": the describer's sentences become a prompt and a style guess; a real description when the
// model is on this computer (PIXHAVEN_DESCRIBE_MODEL = its folder).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { load } from './helper.mjs';

const P = await load('describe/prompt');
const F = await load('describe/florence');
const MODEL = process.env.PIXHAVEN_DESCRIBE_MODEL;
const HAS_MODEL = !!MODEL && fs.existsSync(path.join(MODEL, 'onnx', 'vision_encoder_quantized.onnx'));

test('cleaning: what the picture is goes, what is in it stays', () => {
  assert.equal(P.clean('A painting of a beach scene with flowers.'), 'a beach scene with flowers');
  assert.equal(P.clean('In this image we can see a moon.'), 'a moon');
  assert.equal(P.clean('This is an animated image. A woman sitting on the floor.'), 'A woman sitting on the floor');
  assert.equal(P.clean('A picture of a blue sculpture.'), 'a blue sculpture');
});

test('style guess from the words', () => {
  assert.equal(P.guessStyle('A painting of a beach scene'), 'painting');
  assert.equal(P.guessStyle('This is an animated image of a woman'), 'illustration');
  assert.equal(P.guessStyle('anime girl with green hair'), 'anime');
  assert.equal(P.guessStyle('a 3d render of a car'), '3d');
  assert.equal(P.guessStyle('A photo of a dog on grass'), 'photo');
  assert.equal(P.guessStyle('A mountain range with a lake'), null);
});

test('prompt: subject first, new details only, meta and rambling left out, kept short', () => {
  const r = P.toPrompt('A woman in a green costume sitting on the floor.',
    'A woman is sitting on the ground. She is wearing a green outfit. She has long green hair and a crown on her head. There is a window behind her. The image is very dark.');
  assert.equal(r.prompt, 'A woman in a green costume sitting on the floor, wearing a green outfit, with long green hair and a crown on her head, a window behind her');
  assert.equal(r.style, null);
  const long = P.toPrompt('A street.', Array.from({ length: 4 }, (_, i) => `There are many different shops number${i} and colourful signs and people walking and cars parked along the road everywhere today.`).join(' '), 30);
  assert.ok(long.prompt.split(/\s+/).length <= 30, long.prompt);
});

test('BART tokenizer: task prompt ids', { skip: !HAS_MODEL && 'needs the model folder (PIXHAVEN_DESCRIBE_MODEL)' }, () => {
  const tok = new F.BartTokenizer(MODEL);
  const ids = tok.encode('Describe in detail what is shown in the image.');
  assert.deepEqual(ids, [0, 47066, 21700, 11, 4617, 99, 16, 2343, 11, 5, 2274, 4, 2]);
  assert.equal(tok.decode(ids), 'Describe in detail what is shown in the image.');
});

test('describes a picture', { skip: !HAS_MODEL && 'needs the model folder (PIXHAVEN_DESCRIBE_MODEL)', timeout: 120000 }, async () => {
  // A red circle on a white background.
  const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#fff"/><circle cx="200" cy="200" r="120" fill="#e01010"/></svg>')).png().toBuffer();
  const d = await F.PictureDescriber.load(MODEL);
  try {
    const s = await d.describe(png, 'short');
    assert.match(s, /red/i);
    assert.match(s, /circle|ball|dot|sphere|round/i);
    assert.equal(await d.describe(png, 'short', 50, () => true), null, 'cancelled');
  } finally { await d.release(); }
});
