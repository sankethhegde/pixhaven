// Version 2 "Scale" test from the doc: a 100,000-file library index completes and resumes after cancel.
// Run with: npm run test:scale   (makes 100,000 small files in the temp folder, then deletes them)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './helper.mjs';

const { MediaIndex } = await load('library/media-index');
const N_DIRS = 1000, PER_DIR = 100, TOTAL = N_DIRS * PER_DIR;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-scale-'));
const root = path.join(tmp, 'Library');
const exts = ['jpg', 'jpg', 'jpg', 'heic', 'png', 'mp4', 'mov', 'cr3'];
const fail = m => { console.error('FAIL', m); process.exitCode = 1; };

let t = Date.now();
for (let d = 0; d < N_DIRS; d++) {
  const dir = path.join(root, `${2000 + (d % 25)}`, `Event ${d}`);
  fs.mkdirSync(dir, { recursive: true });
  for (let f = 0; f < PER_DIR; f++) fs.writeFileSync(path.join(dir, `IMG_${d}_${f}.${exts[f % exts.length]}`), String(f));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not media');
}
console.log(`Made ${TOTAL.toLocaleString()} files in ${N_DIRS} folders in ${((Date.now() - t) / 1000).toFixed(1)} s`);

const dbFile = path.join(tmp, 'index.db');
let ix = new MediaIndex(dbFile);
const id = ix.addRoot(root);
// First pass, cancelled at 40,000 (like closing the app half way).
const abort = new AbortController();
t = Date.now();
let r = await ix.scan(id, { signal: abort.signal, onProgress: n => { if (n >= 40000) abort.abort(); } });
const part = ix.root(id).files;
console.log(`Cancelled: ${r}, ${part.toLocaleString()} indexed in ${((Date.now() - t) / 1000).toFixed(1)} s`);
if (r !== 'stopped' || part < 40000 || part >= TOTAL) fail('did not stop part-way');
ix.close();

// Resume in a "new launch".
ix = new MediaIndex(dbFile);
t = Date.now();
let rest = 0;
r = await ix.scan(id, { onProgress: n => { rest = n; } });
const resumeS = (Date.now() - t) / 1000;
const files = ix.root(id).files;
console.log(`Resumed: ${r}, read ${rest.toLocaleString()} more, ${files.toLocaleString()} indexed in total, ${resumeS.toFixed(1)} s`);
if (r !== 'done' || files !== TOTAL) fail(`expected ${TOTAL} files, got ${files}`);
if (rest > TOTAL - part + PER_DIR) fail(`started over instead of resuming (${rest} read)`);

// Instant search and filters over the whole index.
t = Date.now();
const hits = ix.query({ text: 'img_517_', limit: 5000 });
const videos = ix.query({ kind: 'video', limit: 20000 });
const q = Date.now() - t;
console.log(`Queries: ${hits.total} name matches, ${videos.total.toLocaleString()} videos, in ${q} ms`);
const wantVideos = N_DIRS * [...Array(PER_DIR).keys()].filter(f => ['mp4', 'mov'].includes(exts[f % exts.length])).length;
if (hits.total !== PER_DIR || videos.total !== wantVideos) fail(`query results (${hits.total}, ${videos.total} of ${wantVideos})`);
// A full pass with nothing changed (what happens at every start) — and the size of the index.
t = Date.now();
await ix.scan(id);
console.log(`Re-check of an unchanged library: ${((Date.now() - t) / 1000).toFixed(1)} s`);
ix.close();
console.log(`index.db: ${(fs.statSync(dbFile).size / 1024 / 1024).toFixed(1)} MB`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? 'Scale test FAILED' : 'Scale test passed');
