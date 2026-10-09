import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helper.mjs';

const { decodeBmp } = await load('bmp');

// Writes a BMP: pixels are [r,g,b,a] rows top to bottom.
function encode(pixels, { bpp = 24, topDown = false, bitfields = false, palette = null } = {}) {
  const h = pixels.length, w = pixels[0].length;
  const row = Math.floor((bpp * w + 31) / 32) * 4;
  const extra = bitfields ? 16 : 0;
  const pal = palette ? palette.length * 4 : 0;
  const off = 14 + 40 + extra + pal;
  const b = Buffer.alloc(off + row * h);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(off, 10);
  b.writeUInt32LE(40 + extra, 14); b.writeInt32LE(w, 18); b.writeInt32LE(topDown ? -h : h, 22);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(bpp, 28); b.writeUInt32LE(bitfields ? 3 : 0, 30);
  if (palette) b.writeUInt32LE(palette.length, 46);
  if (bitfields) { b.writeUInt32LE(0x00ff0000, 54); b.writeUInt32LE(0x0000ff00, 58); b.writeUInt32LE(0x000000ff, 62); b.writeUInt32LE(0xff000000, 66); }
  palette?.forEach(([r, g, bl], i) => { const o = 54 + i * 4; b[o] = bl; b[o + 1] = g; b[o + 2] = r; });
  pixels.forEach((line, y) => {
    const base = off + (topDown ? y : h - 1 - y) * row;
    line.forEach((px, x) => {
      if (bpp === 24) { b[base + x * 3] = px[2]; b[base + x * 3 + 1] = px[1]; b[base + x * 3 + 2] = px[0]; }
      else if (bpp === 32) b.writeUInt32LE(((px[3] << 24) | (px[0] << 16) | (px[1] << 8) | px[2]) >>> 0, base + x * 4);
      else if (bpp === 8) b[base + x] = px;
    });
  });
  return b;
}
const RED = [255, 0, 0, 255], GREEN = [0, 255, 0, 255], BLUE = [0, 0, 255, 255], WHITE = [255, 255, 255, 255];
const flat = img => [...img.data];

test('24-bit bottom-up with row padding', () => {
  const d = decodeBmp(encode([[RED, GREEN, BLUE], [WHITE, RED, GREEN]]));
  assert.deepEqual([d.width, d.height], [3, 2]);
  assert.deepEqual(flat(d), [...RED, ...GREEN, ...BLUE, ...WHITE, ...RED, ...GREEN]);
});

test('32-bit bitfields keep alpha, top-down', () => {
  const half = [10, 20, 30, 128];
  const d = decodeBmp(encode([[half, RED]], { bpp: 32, bitfields: true, topDown: true }));
  assert.deepEqual(flat(d), [...half, ...RED]);
});

test('8-bit palette', () => {
  const d = decodeBmp(encode([[0, 1], [1, 0]], { bpp: 8, palette: [[1, 2, 3], [200, 100, 50]] }));
  assert.deepEqual(flat(d), [1, 2, 3, 255, 200, 100, 50, 255, 200, 100, 50, 255, 1, 2, 3, 255]);
});

test('rejects non-BMP data', () => {
  assert.throws(() => decodeBmp(Buffer.from('not a bitmap at all, just some text here....................................')));
});
