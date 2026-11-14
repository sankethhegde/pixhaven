// 1.0.6: who made each label from before 1.0.6, worked out once. PixHaven never stored it, so the files are asked:
// - a label in a file's IPTC keywords was put there by another app (PixHaven never adds IPTC keywords) → from files;
// - a label inside a file that has not changed since before the label existed in PixHaven → from files;
// - otherwise a guess: many labels made within seconds of each other is a folder being read (from files), a label made
//   on its own is you. Guesses are marked as such. No Electron imports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { LabelOrigin } from '../../shared/types';

export interface FileKeywords { iptc: string[]; other: string[]; mtime: number }
export interface OriginAnswer { origin: LabelOrigin; file: string | null; sure: boolean }

const has = (list: string[], name: string) => list.some(x => x.trim().toLowerCase() === name.trim().toLowerCase());

/** The decision for one label. `files` maps each readable file carrying it to its keywords; null = none could be read. */
export function decideOrigin(label: { name: string; created: number; burst: number }, files: Map<string, FileKeywords> | null): OriginAnswer | null {
  if (files === null) return null;                                   // drive not connected: try again another time
  for (const [p, k] of files) if (has(k.iptc, label.name)) return { origin: 'files', file: p, sure: true };
  for (const [p, k] of files) if (has(k.other, label.name) && k.mtime < label.created - 5000) return { origin: 'files', file: p, sure: true };
  if (!files.size) return { origin: 'unknown', file: null, sure: false };   // on no file at all any more
  const first = [...files.keys()][0];
  return label.burst >= 2 ? { origin: 'files', file: first, sure: false } : { origin: 'you', file: null, sure: false };
}

/** Keywords of these files, from every place apps keep them, plus each file's modified time. */
export async function readKeywords(exiftool: string, files: string[]): Promise<Map<string, FileKeywords>> {
  const out = new Map<string, FileKeywords>();
  const there = files.filter(f => fs.existsSync(f));
  if (!there.length) return out;
  const argFile = path.join(os.tmpdir(), `clearup-exiftool-origin-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.args`);
  fs.writeFileSync(argFile, ['-j', '-charset', 'filename=utf8', '-IPTC:Keywords', '-XMP-dc:Subject', '-IFD0:XPKeywords', '-Microsoft:Category', ...there].join('\n') + '\n', 'utf8');
  const text = await new Promise<string>((resolve, reject) => execFile(exiftool, ['-@', argFile], { windowsHide: true, timeout: 60_000, maxBuffer: 16 << 20 },
    (e, o) => (e && !o ? reject(e) : resolve(String(o))))).finally(() => fs.rmSync(argFile, { force: true }));
  const list = (v: unknown) => (v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
  for (const j of JSON.parse(text || '[]') as any[]) {
    const file = path.normalize(String(j.SourceFile ?? ''));
    const match = there.find(f => path.normalize(f).toLowerCase() === file.toLowerCase());
    if (!match) continue;
    out.set(match, {
      iptc: list(j.Keywords),
      other: [...list(j.Subject), ...list(j.Category), ...list(j.XPKeywords).flatMap(s => s.split(';'))],
      mtime: fs.statSync(match).mtimeMs,
    });
  }
  return out;
}
