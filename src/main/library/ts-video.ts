// 1.0.14: ".ts" is two things: MPEG transport-stream video (TV tuners, camcorders, screen recorders) and TypeScript
// code. Listing every .ts as a video put the code of programs on a watched drive into Videos with "No preview".
// A real transport stream is packets of 188 bytes, each starting with the sync byte 0x47 (some, like M2TS, put a
// 4-byte time code before each packet: 192 bytes). Code is text, so it is told apart by reading its first bytes.
import fs from 'node:fs';
import path from 'node:path';
import type { Dirent } from 'node:fs';

const SYNC = 0x47;
const cache = new Map<string, boolean>();

export const isTsName = (name: string) => /\.ts$/i.test(name);

/** The first bytes look like a transport stream (188- or 192-byte packets). */
export function looksLikeTs(b: Uint8Array): boolean {
  const at = (start: number, step: number) => b.length > start + step * 2 && b[start] === SYNC && b[start + step] === SYNC && b[start + step * 2] === SYNC;
  return at(0, 188) || at(4, 192);
}

/** Is this .ts file a video? (Read once per file version; files of other types are not asked.) */
export async function isTsVideo(p: string, size = 0, mtime = 0): Promise<boolean> {
  const key = `${p}|${size}|${Math.floor(mtime)}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let ok = false;
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const buf = Buffer.alloc(600);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    ok = looksLikeTs(buf.subarray(0, bytesRead));
  } catch { ok = false; } finally { await fh?.close().catch(() => {}); }
  if (cache.size > 20000) cache.clear();
  cache.set(key, ok);
  return ok;
}

/** A folder's media files with .ts code files left out (other files pass straight through). */
export async function dropTsCode<D extends Dirent>(dir: string, files: D[]): Promise<D[]> {
  if (!files.some(d => isTsName(d.name))) return files;
  const keep = await Promise.all(files.map(d => (isTsName(d.name) ? isTsVideo(path.join(dir, d.name)) : true)));
  return files.filter((_, i) => keep[i]);
}
