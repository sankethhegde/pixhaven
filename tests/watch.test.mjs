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
  assert.equal((await store.missingRows()).length, 1);
  for (const row of await store.missingRows()) for (const cand of ix.bySize(row.size)) if (await quickFingerprint(cand.path, cand.size).catch(() => '') === row.fingerprint) store.moved(row.path, cand.path);
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
  assert.ok(Math.abs(fs.statSync(mp4).mtimeMs - mtime) < 2000, 'file date kept (to the second: ExifTool on Linux keeps whole seconds)');
  assert.deepEqual((await readTags(EXIFTOOL, path.join(dir, 'party.xmp'))).subject, ['Goa 2024']);
  assert.deepEqual((await readTags(EXIFTOOL, jpg)).subject.sort(), ['FromLightroom', 'Goa 2024']);
  // The file changed, but it is still recognised (new fingerprint stored).
  assert.equal((await store.missingRows()).length, 0);
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

test('1.0.9: a whole drive watched: changes in AppData, Temp and the like are never read (and old strays are cleaned)', async () => {
  const { inSkipped } = await load('library/media-index');
  // What the walk leaves out on each system: AppData and Program Files on Windows; dot-folders and node_modules on Linux.
  const APP = process.platform === 'win32' ? ['AppData', 'Local'] : ['.cache'];
  const PROG = process.platform === 'win32' ? 'Program Files' : 'node_modules';
  const root = path.join(tmp, 'Drive');
  put(path.join(root, 'Users', 'Me', 'Videos', 'trip.mp4'));
  for (let i = 0; i < 30; i++) put(path.join(root, 'Users', 'Me', ...APP, 'Browser', 'Cache', `c${i}`, `v${i}.mp4`));
  put(path.join(root, PROG, 'App', 'intro.mp4'));
  const ix = new MediaIndex(path.join(tmp, 'idx-drive', 'index.db'));
  const id = ix.addRoot(root);
  assert.equal(await ix.scan(id), 'done');
  const all = () => ix.query({}).items.map(e => path.relative(root, e.path)).sort();
  assert.deepEqual(all(), [path.join('Users', 'Me', 'Videos', 'trip.mp4')]);
  assert.ok(inSkipped(path.join(root, 'Users', 'Me', ...APP, 'Browser'), root, false));
  assert.ok(!inSkipped(path.join(root, 'Users', 'Me', 'Videos'), root, false));
  assert.ok(!inSkipped(root, root, false));
  // What the watcher reports from deep inside AppData: nothing read, nothing added
  const deep = path.join(root, 'Users', 'Me', ...APP, 'Browser', 'Cache', 'c3');
  assert.deepEqual(await ix.rescanDir(deep), { added: [], removed: [] });
  assert.deepEqual(await ix.rescanDir(path.join(root, 'Users', 'Me', APP[0])), { added: [], removed: [] });
  assert.equal(all().length, 1);
  // an unknown folder deep down (not a new subfolder of a known one) is not walked either
  put(path.join(root, 'Users', 'Me', 'Videos', 'a', 'b', 'c', 'deep.mp4'));
  assert.deepEqual((await ix.rescanDir(path.join(root, 'Users', 'Me', 'Videos', 'a', 'b'))).added, []);
  // …but a new folder inside a known one is indexed all the way down
  const got = await ix.rescanDir(path.join(root, 'Users', 'Me', 'Videos'));
  assert.deepEqual(got.added.map(f => path.basename(f.path)), ['deep.mp4']);
  // strays from an earlier version (indexed inside AppData) are cleaned
  ix.db.prepare('INSERT INTO dirs (path, root, parent, gen) VALUES (?, ?, ?, 1)').run(deep, id, path.dirname(deep));
  ix.db.prepare("INSERT INTO files (path, root, dir, name, kind, size, mtime, gen) VALUES (?, ?, ?, 'v3.mp4', 'video', 1, 1, 1)").run(path.join(deep, 'v3.mp4'), id, deep);
  assert.equal(all().length, 3);
  assert.equal(ix.purgeSkipped(false), 1);
  assert.equal(all().length, 2);
  ix.close();
});

test('1.0.9: a new folder full of files is indexed in one go (lists are built without push(...), which overflowed on huge ones)', async () => {
  const root = path.join(tmp, 'Huge');
  fs.mkdirSync(path.join(root, 'known'), { recursive: true });
  const ix = new MediaIndex(path.join(tmp, 'idx-huge', 'index.db'));
  const id = ix.addRoot(root);
  await ix.scan(id);
  const big = path.join(root, 'known', 'dump');
  fs.mkdirSync(big, { recursive: true });
  for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(big, `f${i}.mp4`), '');
  const c = await ix.rescanDir(path.join(root, 'known'));
  assert.equal(c.added.length, 2000);
  ix.close();
});

test('1.0.14: a .ts file is a video only when it is one (TypeScript code is left out of the index and the Library)', { skip: !fs.existsSync(ffmpeg) && 'FFmpeg not set up' }, async () => {
  const { listFolder } = await load('library/browse');
  const { looksLikeTs } = await load('library/ts-video');
  const root = path.join(tmp, 'TsMix');
  fs.mkdirSync(root, { recursive: true });
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'mpeg2video', '-f', 'mpegts', path.join(root, 'recording.ts')]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-c:v', 'mpeg2video', '-f', 'mpegts', '-mpegts_m2ts_mode', '1', path.join(root, 'camcorder.ts')]);
  fs.writeFileSync(path.join(root, 'attic-service.ts'), "import fs from 'node:fs';\nexport const x = 1;\n".repeat(40));
  fs.writeFileSync(path.join(root, 'tiny.ts'), 'export {};\n');
  put(path.join(root, 'b.mp4'));
  assert.ok(!looksLikeTs(Buffer.from("import fs from 'node:fs';\n".repeat(40))));

  const ix = new MediaIndex(path.join(tmp, 'idx-ts', 'index.db'));
  const id = ix.addRoot(root);
  assert.equal(await ix.scan(id, {}), 'done');
  const vids = ix.query({ kind: 'video' }).items.map(e => e.name).sort();
  assert.deepEqual(vids, ['b.mp4', 'camcorder.ts', 'recording.ts']);
  const listed = (await listFolder(root, false)).entries.map(e => e.name).sort();
  assert.deepEqual(listed, ['b.mp4', 'camcorder.ts', 'recording.ts']);

  // Code files indexed by an earlier version are cleaned at start.
  const code = path.join(root, 'attic-service.ts');
  const st = fs.statSync(code);
  ix.db.prepare('INSERT INTO files (path, root, dir, name, kind, size, mtime, gen) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(code, id, root, 'attic-service.ts', 'video', st.size, Math.floor(st.mtimeMs));
  assert.equal(ix.query({ kind: 'video' }).total, 4);
  assert.deepEqual(await ix.purgeTsCode(), [code]);
  assert.equal(ix.query({ kind: 'video' }).total, 3);
  ix.close();
});

test('1.1.2: after "too many changes", only the folders holding photos or videos are read again', async () => {
  const root = path.join(tmp, 'QuickDrive');
  put(path.join(root, 'Videos', 'a.mp4')); put(path.join(root, 'Phone', 'Camera', 'b.jpg'));
  for (let i = 0; i < 30; i++) put(path.join(root, 'Code', `p${i}`, 'notes.txt'));
  const ix = new MediaIndex(path.join(tmp, 'idx-quick', 'index.db'));
  ix.addRoot(root);
  assert.equal(await ix.scan(ix.rootOf(root).id, {}), 'done');
  assert.deepEqual(ix.mediaDirs(root).map(d => path.relative(root, d)).sort(), [path.join('Phone', 'Camera'), 'Videos']);
  ix.close();
});

test('1.1.3: code projects (folders with .git) are left out: their test videos are not your videos', async () => {
  const root = path.join(tmp, 'ProjDrive');
  put(path.join(root, 'Videos', 'holiday.mp4'));
  put(path.join(root, 'Code', 'grabber', '.git', 'HEAD'), 20);
  put(path.join(root, 'Code', 'grabber', 'test', 'video', 'sample-360.webm'));
  put(path.join(root, 'Code', 'attic', '.git', 'HEAD'), 20);
  put(path.join(root, 'Code', 'attic', 'fixtures', 'clip.mp4'));
  const ix = new MediaIndex(path.join(tmp, 'idx-proj', 'index.db'));
  const id = ix.addRoot(root);
  assert.equal(await ix.scan(id, {}), 'done');
  assert.deepEqual(ix.query({ kind: 'video' }).items.map(e => e.name), ['holiday.mp4']);
  // A change inside a project is not read either.
  put(path.join(root, 'Code', 'grabber', 'test', 'video', 'sample-720.webm'));
  const c = await ix.rescanDir(path.join(root, 'Code', 'grabber', 'test', 'video'));
  assert.equal(c.added.length, 0);
  // What an earlier version indexed inside a project is cleaned at start.
  const stray = path.join(root, 'Code', 'attic', 'fixtures', 'clip.mp4');
  ix.db.prepare('INSERT INTO files (path, root, dir, name, kind, size, mtime, gen) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(stray, id, path.dirname(stray), 'clip.mp4', 'video', 2048, 1);
  assert.deepEqual(ix.purgeProjects(), [stray]);
  assert.deepEqual(ix.query({ kind: 'video' }).items.map(e => e.name), ['holiday.mp4']);
  ix.close();
});
