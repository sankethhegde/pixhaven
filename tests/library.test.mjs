// Media library (v2.0 Phase A): every format gets a thumbnail; folders show only media; search; the cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './helper.mjs';
import { makeMediaFolder, FFMPEG_DIR } from './make-media.mjs';

const { ThumbCache, ThumbQueue, setFfmpegDir } = await load('library/thumbs');
const { listFolder, folderHasMedia, searchNames, isSystemName } = await load('library/browse');
setFfmpegDir(FFMPEG_DIR);

const WIN = process.platform === 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-lib-'));
const dir = path.join(tmp, 'media');
const files = await makeMediaFolder(dir);
const ref = name => { const p = path.join(dir, name); const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };

test('folder listing shows only photos, videos and folders that hold them (LIB-02, LIB-06)', async () => {
  const l = await listFolder(dir, false);
  const names = l.entries.map(e => e.name);
  assert.equal(l.entries.filter(e => e.kind !== 'folder').length, files.length);
  assert.ok(!names.includes('notes.txt') && !names.includes('report.pdf'));
  assert.equal(l.hiddenFiles, 2);
  // AppData is a system folder on Windows only; dot and $ folders everywhere.
  for (const sys of [...(WIN ? ['AppData'] : []), '.cache', '$Recycle.Bin']) assert.ok(!names.includes(sys), `${sys} hidden`);
  assert.ok(names.includes('Goa trip') && names.includes('Documents only'));
  assert.equal(l.entries.filter(e => e.kind === 'video').length, 17);
  const all = await listFolder(dir, true);
  assert.ok(all.entries.some(e => e.name === '.cache'), 'shown when system folders are on');
  assert.equal(await folderHasMedia(path.join(dir, 'Goa trip'), false), true);
  assert.equal(await folderHasMedia(path.join(dir, 'Documents only'), false), false);
  assert.ok(isSystemName('Program Files') === (process.platform === 'win32'));
});

test('a missing folder reports an error instead of throwing (LIB-10)', async () => {
  const l = await listFolder(path.join(dir, 'nope'), false);
  assert.match(l.error, /no longer exists/);
});

test('every format in the test folder gets a thumbnail (Phase A done-when)', { timeout: 180000 }, async () => {
  const cache = new ThumbCache(path.join(tmp, 'cache'));
  const failed = [];
  const info = {};
  for (const f of files) {
    const i = await cache.make(ref(f));
    info[f] = i;
    if (!i.thumb || i.error) failed.push(`${f}: ${i.error}`);
    else assert.ok(fs.statSync(cache.thumbFile(ThumbCache.key(ref(f)))).size > 1000, `${f} thumb has content`);
  }
  assert.deepEqual(failed, []);
  // Sizes as shown (rotation applied), durations for videos.
  assert.deepEqual([info['phone.heic'].width, info['phone.heic'].height], [1400, 1000]);
  assert.deepEqual([info['phone upright.heif'].width, info['phone upright.heif'].height], [1000, 1400]);
  assert.deepEqual([info['nikon.nef'].width, info['nikon.nef'].height], [6000, 4000]);
  assert.deepEqual([info['portrait.jpeg'].width, info['portrait.jpeg'].height], [800, 1200], 'EXIF orientation applied');
  assert.deepEqual([info['phone video.mp4'].width, info['phone video.mp4'].height], [360, 640]);
  for (const v of files.filter(f => /\.(mp4|m4v|mkv|avi|mov|wmv|flv|webm|3gp|mpg|ts|mts|m2ts|vob|ogv)$/.test(f))) {
    assert.ok(Math.abs(info[v].duration - 4) < 0.6, `${v} duration ${info[v].duration}`);
  }
  assert.equal(info['clip hevc.mkv'].codec, 'hevc');
  assert.equal(info['clip av1.mp4'].codec, 'av1');
  // Cached: a second look is a database hit, and a changed file gets a new key.
  assert.equal(cache.get(ref('photo.jpg')).thumb, info['photo.jpg'].thumb);
  assert.equal(cache.get({ ...ref('photo.jpg'), mtime: 1 }), null);
  assert.ok(cache.sizeOnDisk() > 0);
});

test('viewer previews: browser formats direct, HEIC and RAW converted', { timeout: 60000 }, async () => {
  const cache = new ThumbCache(path.join(tmp, 'cache2'));
  const jpg = await cache.preview(ref('photo.jpg'));
  assert.ok(jpg.url.startsWith('clearup://img/') && !jpg.converted);
  const heic = await cache.preview(ref('phone upright.heif'));
  assert.ok(heic.converted && heic.url.startsWith('clearup://preview/'));
  assert.deepEqual([heic.width, heic.height], [1000, 1400]);
  const cr3 = await cache.preview(ref('canon.cr3'));
  assert.deepEqual([cr3.width, cr3.height], [4096, 2731], 'CR3: the 6000×4000 camera preview, capped at 4096');
  cache.clear();
  assert.equal(cache.sizeOnDisk(), 0);
});

test('thumbnail queue returns cached ones at once and works through the rest', { timeout: 60000 }, async () => {
  const cache = new ThumbCache(path.join(tmp, 'cache3'));
  await cache.make(ref('photo.png'));
  const done = [];
  const q = new ThumbQueue(cache, 2, i => done.push(i.path));
  const want = ['photo.png', 'photo.webp', 'clip.avi', 'photo.gif'].map(ref);
  const ready = q.request(want);
  assert.deepEqual(ready.map(r => path.basename(r.path)), ['photo.png']);
  q.request(want.slice(1, 3));                    // scrolled: photo.gif is no longer wanted
  while (q.busy) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(done.map(p => path.basename(p)).sort(), ['clip.avi', 'photo.webp']);
});

test('trim keeps the cache under its limit, newest first', { timeout: 60000 }, async () => {
  const cache = new ThumbCache(path.join(tmp, 'cache4'));
  for (const f of ['photo.jpg', 'photo.png', 'photo.webp']) { await cache.make(ref(f)); await new Promise(r => setTimeout(r, 5)); }
  const one = fs.statSync(cache.thumbFile(ThumbCache.key(ref('photo.webp')))).size;
  cache.trim(one * 1.4 / 0.75);
  assert.ok(cache.get(ref('photo.webp')), 'newest kept');
  assert.equal(cache.get(ref('photo.jpg')), null, 'oldest dropped');
});

test('search by name looks through subfolders, skipping system folders (LIB-07)', async () => {
  const found = [];
  const ctl = new AbortController();
  const r = await searchNames(dir, 'sunset', false, ctl.signal, items => found.push(...items));
  assert.deepEqual(found.map(f => f.name), ['beach sunset.jpg']);
  assert.ok(r.scanned > 30);
  const hidden = [];
  await searchNames(dir, 'hidden', false, ctl.signal, items => hidden.push(...items));
  assert.deepEqual(hidden.map(f => f.path.split(/[\\/]/).slice(-2, -1)[0]), WIN ? [] : ['AppData'], 'system and dot folders are not searched');
  const multi = [];
  await searchNames(dir, 'CLIP mp4', false, ctl.signal, items => multi.push(...items));
  assert.deepEqual(multi.map(f => f.name).sort(), ['clip av1.mp4', 'clip h264.mp4']);
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* database files still open on Windows */ } });
