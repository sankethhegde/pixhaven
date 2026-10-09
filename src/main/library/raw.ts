// Camera RAW files (CR2, CR3, NEF, ARW, DNG, ORF, RW2) all carry a JPEG preview made by the camera.
// We show the largest one instead of developing the raw sensor data. No Electron imports.
import fs from 'node:fs';
import sharp, { type Sharp } from 'sharp';
import exifr from 'exifr';

const SOI = Buffer.from([0xff, 0xd8, 0xff]);

export interface RawPreview { jpeg: Buffer; width: number; height: number; orientation: number }

/** Finds every embedded JPEG, keeps the biggest one that decodes. Lossless-JPEG raw data does not, so it is skipped. */
export async function rawPreview(file: string): Promise<RawPreview> {
  const buf = await fs.promises.readFile(file);
  let best: { at: number; width: number; height: number } | null = null;
  for (let i = buf.indexOf(SOI); i >= 0; i = buf.indexOf(SOI, i + 3)) {
    try {
      const m = await sharp(buf.subarray(i), { failOn: 'none' }).metadata();
      if (m.format === 'jpeg' && m.width && m.height && (!best || m.width * m.height > best.width * best.height)) best = { at: i, width: m.width, height: m.height };
    } catch { /* not a JPEG, just bytes that look like one */ }
  }
  if (!best) throw new Error('This RAW file has no preview picture');
  const jpeg = jpegAt(buf, best.at);
  const orientation = await rawOrientation(buf);
  const swap = orientation >= 5;
  return { jpeg, width: swap ? best.height : best.width, height: swap ? best.width : best.height, orientation };
}

/** The JPEG starting at `at`, cut at its end marker (scans markers, then entropy data for FFD9). */
function jpegAt(buf: Buffer, at: number): Buffer {
  let i = at + 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd9) return buf.subarray(at, i + 2);
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
    if (marker === 0xda) {                                 // start of scan: entropy-coded data until a real marker
      while (i + 1 < buf.length) {
        if (buf[i] === 0xff && buf[i + 1] !== 0 && !(buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7)) break;
        i++;
      }
    }
  }
  return buf.subarray(at, i + 2 <= buf.length ? i + 2 : buf.length);
}

/** EXIF orientation of the raw file (TIFF-based raws directly; CR3 keeps its TIFF header in a "CMT1" box). */
async function rawOrientation(buf: Buffer): Promise<number> {
  let tiff: Buffer = buf;
  if (buf.toString('latin1', 4, 8) === 'ftyp') {
    const at = buf.indexOf('CMT1', 0, 'latin1');
    if (at < 4) return 1;
    tiff = buf.subarray(at + 4, at - 4 + buf.readUInt32BE(at - 4));
  }
  try {
    const o = await exifr.parse(tiff, { pick: ['Orientation'], translateValues: false });
    return Number(o?.Orientation) || 1;
  } catch { return 1; }
}

/** Sharp pipeline of the preview, turned the right way up. */
export function rotatedPreview(p: RawPreview) {
  const img = sharp(p.jpeg, { failOn: 'none' });
  // The camera's preview JPEG usually has no orientation of its own: apply the raw file's.
  const turn: Record<number, (s: Sharp) => Sharp> = {
    2: s => s.flop(), 3: s => s.rotate(180), 4: s => s.flip(), 5: s => s.rotate(90).flop(),
    6: s => s.rotate(90), 7: s => s.rotate(270).flop(), 8: s => s.rotate(270),
  };
  return (turn[p.orientation] ?? (s => s))(img);
}
