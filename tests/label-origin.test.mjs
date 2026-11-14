// 1.0.6: who made each label — new labels record it; labels from before 1.0.6 are worked out from the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { load } from './helper.mjs';

const { TagStore } = await load('library/tags');
const { decideOrigin, readKeywords } = await load('library/label-origin');
const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-origin-'));
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* databases still open on Windows: the temp folder is cleaned later */ } });
const ref = p => { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };
const video = n => { const p = path.join(tmp, n); fs.writeFileSync(p, crypto.randomBytes(200_000)); return p; };
const exif = (file, ...args) => {
  const a = path.join(tmp, 'w.args');
  fs.writeFileSync(a, ['-charset', 'filename=utf8', '-overwrite_original', ...args, file].join('\n') + '\n', 'utf8');
  const r = spawnSync(EXIFTOOL, ['-@', a]); assert.equal(r.status, 0, String(r.stderr));
};

test('new labels say who made them: you, from a file (and which), from a backup', async () => {
  const s = new TagStore(path.join(tmp, 'a', 'library.db'));
  const a = video('a.mp4'), b = video('b.mp4');
  await s.addLabel([ref(a)], 'Holiday');
  await s.mergeFromFile(ref(b), { stars: 0, labels: ['Screenshots'] });
  await s.importData({ app: 'PixHaven', kind: 'labels', labels: [{ name: 'Old trip', color: null }], media: [] });
  const by = n => s.labels().find(l => l.name === n);
  assert.deepEqual([by('Holiday').origin, by('Holiday').originSure], ['you', true]);
  assert.deepEqual([by('Screenshots').origin, by('Screenshots').originFile], ['files', b]);
  assert.equal(by('Old trip').origin, 'backup');
  assert.deepEqual(s.unclassifiedLabels(), [], 'nothing left to work out');
  s.close();
});

test('the decision for labels from before 1.0.6', () => {
  const k = (o = {}) => ({ iptc: [], other: [], mtime: 1000, ...o });
  const L = { name: 'Beach', created: 100_000, burst: 0 };
  assert.deepEqual(decideOrigin(L, new Map([['x.jpg', k({ iptc: ['beach'] , mtime: 999_999 })]])), { origin: 'files', file: 'x.jpg', sure: true }, 'IPTC keywords: another app');
  assert.deepEqual(decideOrigin(L, new Map([['x.jpg', k({ other: ['Beach'], mtime: 50_000 })]])), { origin: 'files', file: 'x.jpg', sure: true }, 'inside a file older than the label');
  assert.deepEqual(decideOrigin(L, new Map([['x.jpg', k({ other: ['Beach'], mtime: 200_000 })]])), { origin: 'you', file: null, sure: false }, 'written by PixHaven later: a guess');
  assert.deepEqual(decideOrigin({ ...L, burst: 4 }, new Map([['x.jpg', k({ mtime: 200_000 })]])), { origin: 'files', file: 'x.jpg', sure: false }, 'made with many others at once: a folder read');
  assert.equal(decideOrigin(L, null), null, 'drive not connected: later');
  assert.deepEqual(decideOrigin(L, new Map()), { origin: 'unknown', file: null, sure: false });
});

test('keywords read from photos: IPTC kept apart from the other places', async () => {
  const p = path.join(tmp, 'kw ಕನ್ನಡ.jpg');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#357' } }).jpeg().toFile(p);
  exif(p, '-IPTC:Keywords=Phone album', '-XMP-dc:Subject=Family', '-XPKeywords=Trip;Goa');
  const got = (await readKeywords(EXIFTOOL, [p, path.join(tmp, 'gone.jpg')])).get(p);
  assert.deepEqual(got.iptc, ['Phone album']);
  assert.deepEqual(got.other.sort(), ['Family', 'Goa', 'Trip']);
  assert.ok(got.mtime > 0);
});

test('old labels are listed with when they were made, their files and how many were made at the same moment', async () => {
  const s = new TagStore(path.join(tmp, 'b', 'library.db'));
  const a = video('c.mp4');
  await s.addLabel([ref(a)], 'One');
  await s.addLabel([ref(a)], 'Two');
  s.db.exec('UPDATE labels SET origin = NULL');   // as if made before 1.0.6
  const list = s.unclassifiedLabels();
  assert.equal(list.length, 2);
  assert.deepEqual(list[0].files, [a]);
  assert.equal(list[0].burst, 1, 'the other label was made within 3 s');
  s.setLabelOrigin(list[0].id, 'you', null, false);
  assert.equal(s.unclassifiedLabels().length, 1);
  assert.equal(s.labels().find(l => l.id === list[0].id).originSure, false);
  s.close();
});
