// v2.1: watched-folder index (LIB-08: full pass, resume after cancel, changes, deletions while away, search),
// labels following files moved between watched folders, labels and stars on photos (TAG-09), playlists (PLAY-08)
// and writing stars and labels into files with ExifTool (TAG-08).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { load } from './helper.mjs';
import { FFMPEG_DIR } from './make-media.mjs';

const { MediaIndex, isInside } = await load('library/media-index');
const { TagStore, quickFingerprint } = await load('library/tags');
const { writeTags, readTags, writeTarget, writeArgs } = await load('library/xmp');

const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-watch-'));
const put = (p, bytes = 2048) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, crypto.randomBytes(bytes)); return p; };
const ref = p => { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };

test('a watched folder is indexed in full, skipping system folders and other files', async () => {
  const root = path.join(tmp, 'Pictures');
  put(path.join(root, 'a.jpg')); put(path.join(root, 'b.mp4')); put(path.join(root, 'notes.txt'));
  put(path.join(root, 'Goa 2024', 'beach.jpg')); put(path.join(root, 'Goa 2024', 'Day 2', 'sunset.heic')); put(path.join(root, 'Goa 2024', 'Day 2', 'boat.mkv'));
  put(path.join(root, '$Recycle.Bin', 'old.jpg')); put(path.join(root, '.thumbs', 'x.jpg'));
  const ix = new MediaIndex(path.join(tmp, 'idx1', 'index.db'));
  const id = ix.addRoot(root);
  let progress = 0;
  assert.equal(await ix.scan(id, { onProgress: n => { progress = n; } }), 'done');
  assert.equal(ix.root(id).files, 5);
  assert.equal(progress, 5);
  assert.deepEqual(ix.query({ text: 'sun' }).items.map(e => e.name), ['sunset.heic']);
  assert.equal(ix.query({ kind: 'video' }).total, 2);
  assert.equal(ix.query({ under: path.join(root, 'Goa 2024') }).total, 3);
  assert.equal(ix.query({ text: '%' }).total, 0, 'LIKE wildcards are taken literally');
  assert.ok(isInside(path.join(root, 'Goa 2024'), root) && !isInside(root + ' copy', root));
  ix.close();
});

test('indexing resumes after cancel and drops files deleted while it was not looking (Scale test)', async () => {
  const root = path.join(tmp, 'Big');
  for (let d = 0; d < 40; d++) for (let f = 0; f < 25; f++) put(path.join(root, `folder ${d}`, `img ${f}.jpg`), 16);
  const ix = new MediaIndex(path.join(tmp, 'idx2', 'index.db'));
  const id = ix.addRoot(root);
  const abort = new AbortController();
  const r1 = await ix.scan(id, { signal: abort.signal, onProgress: n => { if (n >= 300) abort.abort(); } });
  assert.equal(r1, 'stopped');
  const part = ix.root(id).files;
  assert.ok(part >= 300 && part < 1000, `stopped part-way (${part})`);
  assert.ok(ix.root(id).pending > 0 && ix.root(id).scanning === 1);
  ix.close();
  // A new launch: carries on (does not start again) and finishes.
  const ix2 = new MediaIndex(path.join(tmp, 'idx2', 'index.db'));
  let seen = 0;
  assert.equal(await ix2.scan(id, { onProgress: n => { seen = n; } }), 'done');
  assert.equal(ix2.root(id).files, 1000);
  assert.ok(seen <= 1000 - part + 25, `only the rest was read (${seen})`);
  // Deleted while PixHaven was closed: gone after the next pass.
  fs.rmSync(path.join(root, 'folder 3'), { recursive: true });
  fs.rmSync(path.join(root, 'folder 7', 'img 0.jpg'));
  let removed = [];
  await ix2.scan(id, { onChange: (_d, c) => { removed.push(...c.removed); } });
  assert.equal(ix2.root(id).files, 1000 - 26);
  assert.equal(removed.length, 26);
  ix2.close();
});

test('changes in a watched folder: new, renamed, moved, deleted files and folders', async () => {
  const root = path.join(tmp, 'Live');
  put(path.join(root, 'x.jpg')); put(path.join(root, 'Trip', 'y.mp4'));
  const ix = new MediaIndex(path.join(tmp, 'idx3', 'index.db'));
  const id = ix.addRoot(root);
  await ix.scan(id);
  put(path.join(root, 'new.png'));
  fs.renameSync(path.join(root, 'x.jpg'), path.join(root, 'renamed.jpg'));
  let c = await ix.rescanDir(root);
  assert.deepEqual(c.added.map(f => path.basename(f.path)).sort(), ['new.png', 'renamed.jpg']);
  assert.deepEqual(c.removed.map(p => path.basename(p)), ['x.jpg']);
  // A whole folder moved in from elsewhere, and one moved out.
  put(path.join(tmp, 'outside', 'Party', 'a.jpg')); put(path.join(tmp, 'outside', 'Party', 'Late', 'b.jpg'));
  fs.renameSync(path.join(tmp, 'outside', 'Party'), path.join(root, 'Party'));
  fs.renameSync(path.join(root, 'Trip'), path.join(tmp, 'outside', 'Trip'));
  c = await ix.rescanDir(root);
  assert.deepEqual(c.added.map(f => path.basename(f.path)).sort(), ['a.jpg', 'b.jpg']);
  assert.deepEqual(c.removed.map(p => path.basename(p)), ['y.mp4']);
  assert.equal(ix.root(id).files, 4);
  ix.close();
});

test('labels follow a file moved to another watched folder, and photos get labels and stars (TAG-06, TAG-09)', async () => {
  const a = path.join(tmp, 'WatchA'), b = path.join(tmp, 'WatchB');
  const vid = put(path.join(a, 'family day.mp4'), 3 * 1024 * 1024);
  const pic = put(path.join(a, 'portrait.jpg'), 200 * 1024);
  fs.mkdirSync(b);
  const store = new TagStore(path.join(tmp, 'tags1', 'library.db'));
  await store.addLabel([ref(vid), ref(pic)], 'Family');
  await store.setStars([ref(pic)], 5);
  assert.deepEqual(store.tagsFor([pic])[pic], { stars: 5, labels: [store.labels()[0].id] });
  const ix = new MediaIndex(path.join(tmp, 'idx4', 'index.db'));
  await ix.scan(ix.addRoot(a)); const bid = ix.addRoot(b); await ix.scan(bid);
  // Moved in Explorer from one watched folder to the other.
  const moved = path.join(b, 'Sub', 'family day.mp4');
  fs.mkdirSync(path.dirname(moved));
  fs.renameSync(vid, moved);
  const c = await ix.rescanDir(b);
  assert.equal(c.added.length, 1);
  assert.deepEqual(await store.relink(c.added), [moved]);
  assert.equal(store.tagsFor([moved])[moved].labels.length, 1);
  // Not seen by the watcher (app closed): found from the index by size + fingerprint.
  const pic2 = path.join(b, 'portrait (renamed).jpg');
  fs.renameSync(pic, pic2);
  await ix.scan(bid);
  assert.equal(store.missingRows().length, 1);
  for (const row of store.missingRows()) for (const cand of ix.bySize(row.size)) if (await quickFingerprint(cand.path, cand.size).catch(() => '') === row.fingerprint) store.moved(row.path, cand.path);
  assert.equal(store.tagsFor([pic2])[pic2].stars, 5);
  store.close(); ix.close();
});

test('playlists are saved filters; they follow label merges and survive export → import (PLAY-08)', async () => {
  const s = new TagStore(path.join(tmp, 'tags2', 'library.db'));
  const f = put(path.join(tmp, 'pl', 'x.mp4'), 4096);
  await s.addLabel([ref(f)], 'Family'); await s.addLabel([ref(f)], 'Fam'); await s.setStars([ref(f)], 5);
  const fam = s.labels().find(l => l.name === 'Fam').id, family = s.labels().find(l => l.name === 'Family').id;
  s.savePlaylist('Best of family', { labels: [fam], mode: 'all', minStars: 4 });
  assert.equal(s.playlists().length, 1);
  assert.throws(() => s.savePlaylist('  ', { labels: [], mode: 'all', minStars: 0 }), /needs a name/);
  s.renameLabel(fam, 'Family');                                 // merge
  assert.deepEqual(s.playlists()[0].filter.labels, [family]);
  assert.equal(s.query(s.playlists()[0].filter).length, 1);
  const b = new TagStore(path.join(tmp, 'tags3', 'library.db'));
  await b.importData(s.exportData());
  assert.equal(b.playlists()[0].name, 'Best of family');
  assert.equal(b.labels().find(l => l.id === b.playlists()[0].filter.labels[0]).name, 'Family');
  s.deleteLabel(family);
  assert.deepEqual(s.playlists()[0].filter.labels, []);
  s.close(); b.close();
});

test('stars and labels written into files and sidecars, and cleaned again (TAG-08)', { timeout: 120000, skip: !fs.existsSync(EXIFTOOL) && 'ExifTool not set up (npm run setup:engine)' }, async () => {
  const dir = path.join(tmp, 'write');
  fs.mkdirSync(dir);
  const ff = args => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const mp4 = path.join(dir, 'Goa – beach day.mp4'), mkv = path.join(dir, 'party.mkv'), jpg = path.join(dir, 'photo.jpg');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'libopenh264', mp4]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10:duration=1', '-c:v', 'mpeg4', mkv]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=1:duration=1', '-frames:v', '1', jpg]);
  // Another app's keyword stays.
  execFileSync(EXIFTOOL, ['-overwrite_original', '-XMP-dc:Subject=FromLightroom', jpg], { stdio: 'ignore' });
  assert.equal(writeTarget(mkv).target, path.join(dir, 'party.xmp'));
  assert.equal(writeArgs({ file: mkv, stars: 0, labels: [], previous: [] }), null, 'no empty sidecar');
  const mtime = fs.statSync(mp4).mtimeMs;
  const store = new TagStore(path.join(tmp, 'tags4', 'library.db'));
  await store.addLabel([ref(mp4), ref(mkv), ref(jpg)], 'Goa 2024');
  await store.addLabel([ref(mp4)], 'Family');
  await store.setStars([ref(mp4), ref(jpg)], 4);
  const jobs = [mp4, mkv, jpg].map(f => ({ file: f, ...store.writeState(f) }));
  const res = await writeTags(EXIFTOOL, jobs);
  assert.ok(res.every(r => r.ok), JSON.stringify(res));
  for (const j of jobs) await store.written(j.file, j.labels);
  const m = await readTags(EXIFTOOL, mp4);
  assert.equal(m.rating, 4); assert.deepEqual(m.subject.sort(), ['Family', 'Goa 2024']);
  assert.equal(m.msRating, 75, 'Windows Explorer rating'); assert.deepEqual(m.category.sort(), ['Family', 'Goa 2024']);
  assert.equal(Math.round(fs.statSync(mp4).mtimeMs / 1000), Math.round(mtime / 1000), 'file date kept');
  assert.deepEqual((await readTags(EXIFTOOL, path.join(dir, 'party.xmp'))).subject, ['Goa 2024']);
  assert.deepEqual((await readTags(EXIFTOOL, jpg)).subject.sort(), ['FromLightroom', 'Goa 2024']);
  // The file changed, but it is still recognised (new fingerprint stored).
  assert.equal(store.missingRows().length, 0);
  assert.equal(await quickFingerprint(mp4, fs.statSync(mp4).size), store.db.prepare('SELECT fingerprint FROM media WHERE path = ?').get(mp4).fingerprint);
  // Labels and stars taken off: only what PixHaven wrote is removed.
  const goa = store.labels().find(l => l.name === 'Goa 2024').id;
  store.removeLabel([jpg, mp4], goa);
  await store.setStars([ref(jpg)], 0);
  const again = [jpg, mp4].map(f => ({ file: f, ...store.writeState(f) }));
  assert.deepEqual(again[0].previous, ['Goa 2024'], 'remembered after the row went away');
  assert.ok((await writeTags(EXIFTOOL, again)).every(r => r.ok));
  const j2 = await readTags(EXIFTOOL, jpg);
  assert.deepEqual(j2.subject, ['FromLightroom']); assert.equal(j2.rating, 0);
  assert.deepEqual((await readTags(EXIFTOOL, mp4)).subject, ['Family']);
  // A file ExifTool can't write reports an error instead of failing the batch.
  const bad = put(path.join(dir, 'broken.jpg'), 100);
  const r3 = await writeTags(EXIFTOOL, [{ file: bad, stars: 3, labels: [], previous: [] }, { file: jpg, stars: 2, labels: [], previous: [] }]);
  assert.equal(r3[0].ok, false); assert.ok(r3[0].error);
  assert.equal(r3[1].ok, true);
  store.close();
});
