// v2.2: stars and labels read back out of the files, merged so each shows once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { load } from './helper.mjs';

const { TagStore } = await load('library/tags');
const { parseEntry, uniqueNames, TagReader } = await load('library/file-tags');
const { writeTags } = await load('library/xmp');

const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-filetags-'));
const ref = p => { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };
const names = (s, p) => (s.tagsFor([p])[p]?.labels ?? []).map(id => s.labels().find(l => l.id === id).name).sort();

test('one label however many apps wrote it; Windows video ratings become stars', () => {
  const t = parseEntry({ 'XMP-dc:Subject': ['Trip', 'Goa'], 'IPTC:Keywords': ['trip'], 'IFD0:XPKeywords': 'Goa;Beach', 'XMP-xmp:Rating': 4, 'IFD0:Rating': 2 });
  assert.deepEqual(t.labels, ['Trip', 'Goa', 'Beach']);
  assert.equal(t.stars, 4, 'XMP rating wins');
  assert.equal(parseEntry({ 'Microsoft:SharedUserRating': 75 }).stars, 4);
  assert.equal(parseEntry({ 'XMP-xmp:Rating': -1 }).stars, 0, 'Lightroom "rejected" is not a rating');
  assert.deepEqual(parseEntry({ 'XMP-iptcExt:PersonInImage': ['Person 1'], 'XMP-mwg-rs:RegionName': ['person 1', 'Asha'] }).people, ['Person 1', 'Asha']);
  assert.deepEqual(uniqueNames(['  a  b ', 'A B', '']), ['a b']);
});

test('merging: first read adds up, later reads apply only what changed in the file', async () => {
  const f = path.join(tmp, 'a.jpg');
  fs.writeFileSync(f, 'x'.repeat(5000));
  const s = new TagStore(path.join(tmp, 'merge.db'));
  await s.addLabel([ref(f)], 'Mine');
  let r = await s.mergeFromFile(ref(f), { stars: 3, labels: ['Trip', 'mine'] });
  assert.ok(r.changed);
  assert.deepEqual(names(s, f), ['Mine', 'Trip'], '"mine" is the same label: shown once');
  assert.equal(s.tagsFor([f])[f].stars, 3);
  assert.equal(r.behind, false);
  // Same file again: nothing to do (not even read, see needsRead).
  assert.equal(s.needsRead([ref(f)]).length, 0);
  assert.equal((await s.mergeFromFile(ref(f), { stars: 3, labels: ['Trip', 'mine'] })).changed, false);
  // Another app took "Trip" off, added "Goa" and set 5 stars; the app added "Later" meanwhile.
  await s.addLabel([ref(f)], 'Later');
  fs.appendFileSync(f, 'changed');
  assert.equal(s.needsRead([ref(f)]).length, 1);
  r = await s.mergeFromFile(ref(f), { stars: 5, labels: ['mine', 'Goa'] });
  assert.deepEqual(names(s, f), ['Goa', 'Later', 'Mine']);
  assert.equal(s.tagsFor([f])[f].stars, 5);
  assert.ok(r.behind, 'the file still lacks "Later": it gets written');
  // A file with nothing in it creates no row.
  const g = path.join(tmp, 'b.jpg');
  fs.writeFileSync(g, 'y'.repeat(100));
  assert.equal((await s.mergeFromFile(ref(g), { stars: 0, labels: [] })).changed, false);
  assert.equal(s.isTagged(g), false);
  s.close();
});

test('labels written on one computer appear on another by reading the file — once each',
  { timeout: 60000, skip: !fs.existsSync(EXIFTOOL) && 'ExifTool not set up (npm run setup:engine)' }, async () => {
  const f = path.join(tmp, 'Holi é.jpg');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#a63' } }).jpeg().toFile(f);
  // Laptop A: two labels and 4 stars, written into the file (XMP, plus Explorer's own Rating and XPKeywords fields).
  const a = new TagStore(path.join(tmp, 'a.db'));
  await a.addLabel([ref(f)], 'Family'); await a.addLabel([ref(f)], 'Festival'); await a.setStars([ref(f)], 4);
  const w = await writeTags(EXIFTOOL, [{ file: f, ...a.writeState(f) }]);
  assert.ok(w[0].ok, w[0].error);
  await a.written(f, a.writeState(f).labels);
  assert.equal(a.needsRead([ref(f)]).length, 0, 'what was just written needs no reading back');
  a.close();
  // Laptop B: a fresh library; the folder is opened.
  const reader = new TagReader(EXIFTOOL);
  const got = await reader.read([f, path.join(tmp, 'gone.jpg')]);
  reader.stop();
  assert.equal(got.has(path.join(tmp, 'gone.jpg')), false, 'unreadable files are left out, not taken as "no labels"');
  assert.deepEqual(got.get(f).labels.sort(), ['Family', 'Festival'], 'XMP and XPKeywords hold the same labels: each counted once');
  assert.equal(got.get(f).stars, 4);
  const b = new TagStore(path.join(tmp, 'b.db'));
  await b.mergeFromFile(ref(f), got.get(f));
  assert.deepEqual(names(b, f), ['Family', 'Festival']);
  assert.equal(b.labels().length, 2);
  assert.equal(b.tagsFor([f])[f].stars, 4);
  b.close();
});
