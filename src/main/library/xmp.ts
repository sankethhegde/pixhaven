// TAG-08 (v2.1, optional, off by default): stars and labels also written into the files with ExifTool, so other apps
// see them — Windows Explorer shows them as "Rating" and "Tags". Photos and MP4/MOV get them inside the file (XMP,
// plus the Microsoft rating/category fields Explorer reads for videos); camera RAW files and video formats ExifTool
// can't write (MKV, AVI, WMV…) get an .xmp sidecar next to them (photo.CR2 → photo.xmp), so originals stay untouched.
// The file's modified date is kept (-P). Keywords added by other apps are left alone: only labels PixHaven wrote
// before are removed when they come off. No Electron imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const IN_FILE = new Set(['jpg', 'jpeg', 'jfif', 'png', 'webp', 'tif', 'tiff', 'heic', 'heif', 'hif', 'avif', 'gif', 'mp4', 'm4v', 'mov', '3gp', '3g2']);
const QUICKTIME = new Set(['mp4', 'm4v', 'mov', '3gp', '3g2']);
/** Windows' own 1–5 star scale for videos (Microsoft "SharedUserRating"). */
const MS_RATING = [0, 1, 25, 50, 75, 99];

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

export interface WriteTarget { target: string; sidecar: boolean; quicktime: boolean }

export function writeTarget(file: string): WriteTarget {
  const e = ext(file);
  if (IN_FILE.has(e)) return { target: file, sidecar: false, quicktime: QUICKTIME.has(e) };
  return { target: path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.xmp'), sidecar: true, quicktime: false };
}

export interface WriteJob { file: string; stars: number; labels: string[]; previous: string[] }

/** ExifTool arguments for one file (one block of an -@ argument file), or null when there is nothing to write. */
export function writeArgs(j: WriteJob): string[] | null {
  const t = writeTarget(j.file);
  // Nothing to say and no sidecar yet: don't create an empty one.
  if (t.sidecar && !j.stars && !j.labels.length && !fs.existsSync(t.target)) return null;
  const a: string[] = [];
  a.push(j.stars ? `-XMP-xmp:Rating=${j.stars}` : '-XMP-xmp:Rating=');
  const lists = ['XMP-dc:Subject', ...(t.quicktime ? ['Microsoft:Category'] : [])];
  for (const tag of lists) {
    for (const old of j.previous) if (!j.labels.includes(old)) a.push(`-${tag}-=${old}`);
    for (const l of j.labels) a.push(`-${tag}-=${l}`, `-${tag}+=${l}`);    // the documented way to add without duplicates
  }
  if (t.quicktime) a.push(j.stars ? `-Microsoft:SharedUserRating=${MS_RATING[j.stars]}` : '-Microsoft:SharedUserRating=');
  a.push(t.target);
  return a;
}

export interface WriteResult { file: string; ok: boolean; target: string; error?: string }

/**
 * Writes a batch in one ExifTool run. Each file is its own command (-execute), so one bad file doesn't stop the
 * rest; markers echoed after each command split the output per file.
 */
export async function writeTags(exiftool: string, jobs: WriteJob[]): Promise<WriteResult[]> {
  const blocks = jobs.map(j => ({ j, args: writeArgs(j) }));
  const todo = blocks.filter(b => b.args);
  const results = new Map<WriteJob, WriteResult>();
  for (const b of blocks) if (!b.args) results.set(b.j, { file: b.j.file, ok: true, target: writeTarget(b.j.file).target });
  if (todo.length) {
    const lines: string[] = [];
    todo.forEach((b, i) => lines.push(...b.args!, `-echo3`, `@@${i}`, `-echo4`, `@@${i}`, '-execute'));
    const argFile = path.join(os.tmpdir(), `clearup-exiftool-${process.pid}-${Date.now()}.args`);
    fs.writeFileSync(argFile, lines.join('\n') + '\n', 'utf8');
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(resolve => {
      execFile(exiftool, ['-@', argFile, '-common_args', '-charset', 'filename=utf8', '-P', '-overwrite_original'],
        { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, out, errOut) => resolve({ stdout: String(out ?? ''), stderr: String(errOut ?? '') + (err && !out ? String(err.message) : '') }));
    }).finally(() => fs.rmSync(argFile, { force: true }));
    const split = (s: string) => {
      const parts: string[] = [];
      let rest = s;
      for (let i = 0; i < todo.length; i++) {
        const m = rest.indexOf(`@@${i}`);
        if (m < 0) { parts.push(rest); rest = ''; continue; }
        parts.push(rest.slice(0, m)); rest = rest.slice(m + `@@${i}`.length);
      }
      return parts;
    };
    const outs = split(stdout), errs = split(stderr);
    todo.forEach((b, i) => {
      const err = (errs[i] ?? '').split(/\r?\n/).find(l => /^Error/i.test(l.trim()));
      const ok = !err && /files? (updated|created|unchanged)/.test(outs[i] ?? '');
      results.set(b.j, { file: b.j.file, ok, target: writeTarget(b.j.file).target, error: ok ? undefined : (err?.replace(/^Error:\s*/i, '').replace(/ - .*$/, '') || (errs[i] || outs[i] || 'ExifTool did not answer').trim().slice(0, 200)) });
    });
  }
  return jobs.map(j => results.get(j)!);
}

/** Reads back Rating and keywords (tests and the self-test). File names go in a UTF-8 argument file: on Windows the
 * command line would lose characters outside the system code page (é, –, Hindi or Kannada names…). */
export async function readTags(exiftool: string, file: string): Promise<{ rating: number; subject: string[]; msRating?: number; category?: string[] }> {
  const argFile = path.join(os.tmpdir(), `clearup-exiftool-read-${process.pid}-${Date.now()}.args`);
  fs.writeFileSync(argFile, ['-j', '-charset', 'filename=utf8', '-XMP-xmp:Rating', '-XMP-dc:Subject', '-Microsoft:SharedUserRating', '-Microsoft:Category', file].join('\n') + '\n', 'utf8');
  const out = await new Promise<string>((resolve, reject) => execFile(exiftool, ['-@', argFile],
    { windowsHide: true, timeout: 60_000 }, (e, o) => (e && !o ? reject(e) : resolve(String(o))))).finally(() => fs.rmSync(argFile, { force: true }));
  const j = JSON.parse(out)[0] ?? {};
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  return { rating: Number(j.Rating ?? 0), subject: list(j.Subject), msRating: j.SharedUserRating, category: j.Category === undefined ? undefined : list(j.Category) };
}
