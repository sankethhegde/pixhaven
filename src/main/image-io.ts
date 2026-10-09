// Opens any supported image as a sharp pipeline (BMP via our own decoder). No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { decodeBmp } from './bmp';
import { IMAGE_EXTENSIONS } from '../shared/types';

// libvips keeps recently read files open in its cache by default; on Windows that stops the user from deleting or
// renaming those photos in Explorer while PixHaven runs. Keep no files open (results are still cached in memory).
sharp.cache({ files: 0 });

export function openImage(file: string): Sharp {
  if (/\.bmp$/i.test(file)) {
    const bmp = decodeBmp(fs.readFileSync(file));
    return sharp(bmp.data, { raw: { width: bmp.width, height: bmp.height, channels: 4 }, limitInputPixels: false });
  }
  return sharp(file, { limitInputPixels: false, failOn: 'error' });
}

/** Encoded bytes sharp can read (BMP converted to PNG). */
export async function readImageBuffer(file: string): Promise<Buffer> {
  return /\.bmp$/i.test(file) ? openImage(file).png().toBuffer() : fs.promises.readFile(file);
}

export function isImageFile(p: string): boolean {
  return IMAGE_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase());
}
