// Minimal BMP decoder (sharp/libvips cannot read BMP). Handles uncompressed 1/4/8/24/32-bit
// and 16/32-bit BI_BITFIELDS, bottom-up or top-down. Returns RGBA pixels.

export interface Decoded { data: Buffer; width: number; height: number; channels: 4 }

export function decodeBmp(buf: Buffer): Decoded {
  if (buf.length < 54 || buf.toString('latin1', 0, 2) !== 'BM') throw new Error('Not a BMP file');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width <= 0 || height === 0 || width * height > 400e6) throw new Error('Unsupported BMP size');
  if (compression !== 0 && compression !== 3) throw new Error('Compressed BMP files are not supported');

  // Channel masks for BI_BITFIELDS (stored after a 40-byte header, or inside V4/V5 headers).
  let masks = bpp === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0x00ff0000, 0x0000ff00, 0x000000ff, 0];
  if (compression === 3) {
    masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62), headerSize >= 56 ? buf.readUInt32LE(66) : 0];
  } else if (bpp === 32) {
    masks[3] = 0; // plain 32-bit BMPs usually leave the 4th byte unused
  }

  const paletteStart = 14 + headerSize + (compression === 3 && headerSize === 40 ? 12 : 0);
  const palette: number[][] = [];
  if (bpp <= 8) {
    const colours = buf.readUInt32LE(46) || 1 << bpp;
    for (let i = 0; i < colours; i++) {
      const o = paletteStart + i * 4;
      palette.push([buf[o + 2], buf[o + 1], buf[o]]);
    }
  }

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  const out = Buffer.alloc(width * height * 4);
  const channel = (v: number, mask: number) => {
    if (!mask) return 255;
    const shift = Math.log2(mask & -mask);
    const max = mask >>> shift;
    return Math.round((((v & mask) >>> shift) * 255) / max);
  };
  let anyAlpha = false;

  for (let y = 0; y < height; y++) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r: number, g: number, b: number, a = 255;
      if (bpp === 24) {
        const p = row + x * 3; b = buf[p]; g = buf[p + 1]; r = buf[p + 2];
      } else if (bpp === 32 || bpp === 16) {
        const v = bpp === 32 ? buf.readUInt32LE(row + x * 4) : buf.readUInt16LE(row + x * 2);
        r = channel(v, masks[0]); g = channel(v, masks[1]); b = channel(v, masks[2]);
        a = masks[3] ? channel(v, masks[3]) : 255;
      } else if (bpp <= 8) {
        const bitPos = x * bpp;
        const byte = buf[row + (bitPos >> 3)];
        const idx = (byte >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1);
        [r, g, b] = palette[idx] ?? [0, 0, 0];
      } else {
        throw new Error(`${bpp}-bit BMP files are not supported`);
      }
      if (a !== 255) anyAlpha = true;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  // Some writers store 0 in an alpha mask they never fill in: treat all-zero alpha as opaque.
  if (anyAlpha && masks[3]) {
    let allZero = true;
    for (let i = 3; i < out.length; i += 4) if (out[i] !== 0) { allZero = false; break; }
    if (allZero) for (let i = 3; i < out.length; i += 4) out[i] = 255;
  }
  return { data: out, width, height, channels: 4 };
}
