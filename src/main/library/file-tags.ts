// Reading stars, labels and people back out of the files (v2.2), so they follow a photo or video to another computer:
// whatever PixHaven (TAG-08), Windows Explorer, Lightroom, digiKam or a phone wrote into the file — or into its .xmp
// sidecar — shows up in the app without importing anything. One ExifTool process stays open while there is work
// (-stay_open), so a folder of a few hundred files is read in a second or two. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeTarget } from './xmp';

export interface FileTags { stars: number; labels: string[]; people: string[] }

const TAGS = [
  '-XMP-xmp:Rating', '-IFD0:Rating', '-Microsoft:SharedUserRating',
  '-XMP-dc:Subject', '-IPTC:Keywords', '-IFD0:XPKeywords', '-Microsoft:Category',
  '-XMP-iptcExt:PersonInImage', '-XMP-mwg-rs:RegionName', '-XMP-MP:RegionPersonDisplayName',
];

const list = (v: unknown): string[] => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** The same word written by several apps (Subject, Keywords, XPKeywords…) is one label: first spelling wins. */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of names) {
    const n = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  return [...seen.values()];
}

/** Windows' video rating (1–99) → stars. */
const msStars = (v: number) => (v <= 0 ? 0 : v < 13 ? 1 : v < 38 ? 2 : v < 63 ? 3 : v < 88 ? 4 : 5);

/** One ExifTool JSON entry (-G1 names) → stars, labels and people. */
export function parseEntry(j: Record<string, unknown>): FileTags {
  const num = (k: string) => { const v = Number(j[k]); return Number.isFinite(v) ? v : 0; };
  let stars = Math.round(num('XMP-xmp:Rating')) || Math.round(num('IFD0:Rating'));
  if (!stars && j['Microsoft:SharedUserRating'] !== undefined) stars = msStars(num('Microsoft:SharedUserRating'));
  stars = Math.max(0, Math.min(5, stars));          // -1 = "rejected" in Lightroom: no stars here
  const labels = uniqueNames([
    ...list(j['XMP-dc:Subject']), ...list(j['IPTC:Keywords']), ...list(j['Microsoft:Category']),
    ...list(j['IFD0:XPKeywords']).flatMap(s => s.split(';')),
  ]);
  const people = uniqueNames([...list(j['XMP-iptcExt:PersonInImage']), ...list(j['XMP-mwg-rs:RegionName']), ...list(j['XMP-MP:RegionPersonDisplayName'])]);
  return { stars, labels, people };
}

const norm = (p: string) => { const n = path.normalize(p.replace(/\//g, path.sep)); return process.platform === 'win32' ? n.toLowerCase() : n; };

/** Where a file's tags live: inside it, or in its .xmp sidecar (RAW, MKV, AVI…) when there is one. */
function source(file: string): string | null {
  const t = writeTarget(file);
  if (!t.sidecar) return file;
  return fs.existsSync(t.target) ? t.target : null;
}

export class TagReader {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private out = '';
  private seq = 0;
  private current: { id: number; done: (s: string) => void; fail: (e: Error) => void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;

  constructor(private readonly exe: string) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const p = spawn(this.exe, ['-stay_open', 'True', '-@', '-', '-common_args', '-j', '-G1', '-n', '-charset', 'filename=utf8', '-q', '-q'], { windowsHide: true });
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      this.out += d;
      const c = this.current;
      if (!c) return;
      const mark = `{ready${c.id}}`;
      const at = this.out.indexOf(mark);
      if (at < 0) return;
      const text = this.out.slice(0, at);
      this.out = this.out.slice(at + mark.length).replace(/^\r?\n/, '');
      this.current = null;
      c.done(text);
    });
    p.stderr.on('data', () => { /* unreadable files are simply left out of the answer */ });
    const gone = () => { if (this.proc === p) this.proc = null; this.current?.fail(new Error('ExifTool stopped')); this.current = null; this.out = ''; };
    p.on('exit', gone);
    p.on('error', gone);
    this.proc = p;
    return p;
  }

  /** Reads many files in one go. Files that could not be read (unplugged drive, locked, damaged) are left out. */
  read(files: string[]): Promise<Map<string, FileTags>> {
    const run = this.chain.then(() => this.readNow(files));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async readNow(files: string[]): Promise<Map<string, FileTags>> {
    const res = new Map<string, FileTags>();
    const bySource = new Map<string, string[]>();
    for (const f of files) {
      const s = source(f);
      if (s) bySource.set(norm(s), [...(bySource.get(norm(s)) ?? []), f]);
      else if (fs.existsSync(f)) res.set(f, { stars: 0, labels: [], people: [] });    // RAW/MKV without a sidecar: nothing to read
    }
    if (!bySource.size) return res;
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const p = this.start();
    const id = ++this.seq;
    const text = await new Promise<string>((done, fail) => {
      const timer = setTimeout(() => { fail(new Error('ExifTool did not answer')); this.stop(); }, 30_000 + files.length * 200);
      this.current = { id, done: s => { clearTimeout(timer); done(s); }, fail: e => { clearTimeout(timer); fail(e); } };
      const sources = [...new Set([...bySource.keys()].map(k => source(bySource.get(k)![0])!))];
      p.stdin.write(Buffer.from([...TAGS, ...sources, `-execute${id}`].join('\n') + '\n', 'utf8'));
    });
    this.idle = setTimeout(() => this.stop(), 20_000);
    let arr: Record<string, unknown>[] = [];
    try { arr = text.trim() ? JSON.parse(text) : []; } catch { arr = []; }
    for (const j of arr) {
      const owners = bySource.get(norm(String(j.SourceFile ?? '')));
      if (owners) for (const f of owners) res.set(f, parseEntry(j));
    }
    return res;
  }

  stop(): void {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.stdin.write('-stay_open\nFalse\n'); p.stdin.end(); } catch { /* already gone */ }
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 3000).unref();
  }
}
