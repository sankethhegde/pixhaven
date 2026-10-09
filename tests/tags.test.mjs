// Labels and stars (v2.0 Phase C): labels, ratings, filters, renames and moves (inside and outside the app),
// export → import onto "another laptop" (other folders), CSV, backups.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { load } from './helper.mjs';

const { TagStore, toCsv, fromCsv, quickFingerprint } = await load('library/tags');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-tags-'));
const vids = path.join(tmp, 'Videos');
fs.mkdirSync(vids);
/** Distinct fake videos (random bytes, 3 MB so the fingerprint reads both ends). */
const make = (dir, name, bytes = 3 * 1024 * 1024) => { const p = path.join(dir, name); fs.writeFileSync(p, crypto.randomBytes(bytes)); return p; };
const ref = p => { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };
const files = ['goa beach.mp4', 'birthday.mkv', 'school day.mp4', 'diwali.mov', 'trek.mp4'].map(n => make(vids, n));
const store = new TagStore(path.join(tmp, 'a', 'library.db'));
const id = n => store.labels().find(l => l.name === n)?.id;

test('labels and stars (TAG-01, TAG-03, TAG-04)', async () => {
  for (const l of ['Family', 'Goa trip', '2024', 'Friends', 'Festival']) await store.addLabel([ref(files[0])], l);
  assert.equal(store.tagsFor([files[0]])[files[0]].labels.length, 5, 'five labels on one video');
  await store.addLabel(files.slice(0, 4).map(ref), 'family');           // same label, any case
  assert.equal(store.labels().length, 5);
  assert.equal(store.labels().find(l => l.name === 'Family').count, 4);
  await store.setStars(files.slice(0, 2).map(ref), 5);
  await store.setStars([ref(files[2])], 3);
  const t = store.tagsFor(files);
  assert.deepEqual(files.map(f => t[f]?.stars ?? 0), [5, 5, 3, 0, 0]);
  assert.equal(t[files[4]], undefined, 'untouched file has no row');
  await store.setStars([ref(files[4])], 0);
  assert.equal(store.tagsFor([files[4]])[files[4]], undefined, 'clearing stars on an untagged file adds nothing');
});

test('filters: all of / any of, minimum stars, text (TAG-05)', async () => {
  await store.addLabel([ref(files[1])], '2024');
  const names = r => r.map(x => x.name).sort();
  assert.deepEqual(names(store.query({ labels: [id('Family'), id('2024')], mode: 'all', minStars: 4 })), ['birthday.mkv', 'goa beach.mp4']);
  assert.deepEqual(names(store.query({ labels: [id('Family'), id('2024')], mode: 'all', minStars: 0 })), ['birthday.mkv', 'goa beach.mp4']);
  assert.deepEqual(names(store.query({ labels: [id('Festival'), id('2024')], mode: 'any', minStars: 0 })), ['birthday.mkv', 'goa beach.mp4']);
  assert.deepEqual(names(store.query({ labels: [], mode: 'all', minStars: 3 })), ['birthday.mkv', 'goa beach.mp4', 'school day.mp4']);
  assert.deepEqual(names(store.query({ labels: [], mode: 'all', minStars: 0 }, 'goa')), ['goa beach.mp4'], 'text matches names and label names');
  assert.equal(store.query({ labels: [], mode: 'all', minStars: 0 }, 'friends').length, 1);
});

test('remove, rename (merging), colour and delete labels everywhere (TAG-02)', async () => {
  store.removeLabel([files[3]], id('Family'));
  assert.equal(store.tagsFor([files[3]])[files[3]], undefined, 'no labels and no stars left: row dropped');
  store.renameLabel(id('Friends'), 'Pals');
  assert.ok(id('Pals') && !id('Friends'));
  const r = store.renameLabel(id('Pals'), 'family');                    // onto an existing name: merge
  assert.equal(r.mergedInto, id('Family'));
  assert.ok(!id('Pals'));
  store.setColor(id('Festival'), '#e5484d');
  assert.equal(store.labels().find(l => l.name === 'Festival').color, '#e5484d');
  store.deleteLabel(id('Festival'));
  assert.ok(!id('Festival'));
  assert.equal(store.tagsFor([files[0]])[files[0]].labels.length, 3);   // Family, Goa trip, 2024
});

test('renamed or moved by the app, or outside it (TAG-06)', async () => {
  const before = store.tagsFor([files[0]])[files[0]];
  const renamed = path.join(vids, 'Goa 2024.mp4');
  fs.renameSync(files[0], renamed);
  store.moved(files[0], renamed);                                        // inside the app
  assert.deepEqual(store.tagsFor([renamed])[renamed], before);
  store.savePosition(renamed, 42, 600);
  const other = path.join(tmp, 'Elsewhere');
  fs.mkdirSync(other);
  const outside = path.join(other, 'goa.mp4');
  fs.renameSync(renamed, outside);                                       // outside the app (Explorer)
  assert.deepEqual(await store.relink([ref(outside)]), [outside]);
  assert.deepEqual(store.tagsFor([outside])[outside], before);
  assert.equal(store.position(outside), 42, 'resume position follows too');
  // A copy is not a move: the original still exists, so the copy does not take its labels.
  const copy = path.join(other, 'goa copy.mp4');
  fs.copyFileSync(outside, copy);
  assert.deepEqual(await store.relink([ref(copy)]), []);
  files[0] = outside;
});

test('export → import on another laptop with different folders (TAG-07)', async () => {
  const data = store.exportData();
  assert.equal(data.media.length, 3);
  // "Another laptop": a fresh library, the same videos under other paths and names.
  const laptop = path.join(tmp, 'laptop', 'D', 'My Videos');
  fs.mkdirSync(laptop, { recursive: true });
  const copies = files.map((f, i) => { const p = path.join(laptop, `video ${i}${path.extname(f)}`); fs.copyFileSync(f, p); return p; });
  const store2 = new TagStore(path.join(tmp, 'b', 'library.db'));
  // Imported where the old paths still hold the same files, too (this test runs on one machine): put those out of reach.
  const json = JSON.parse(JSON.stringify(data).split(tmp.replace(/\\/g, '\\\\')).join('Q:\\\\old-laptop'));
  const r = await store2.importData(json);
  assert.deepEqual(r, { labels: 3, applied: 0, waiting: 3, skipped: 0 });
  // Browsing the folder finds them by fingerprint.
  const linked = await store2.relink(copies.map(ref));
  assert.equal(linked.length, 3);
  const t = store2.tagsFor(copies);
  assert.equal(t[copies[0]].stars, 5);
  assert.deepEqual(t[copies[0]].labels.map(l => store2.labels().find(x => x.id === l).name).sort(), ['2024', 'Family', 'Goa trip']);
  assert.equal(t[copies[2]].stars, 3);
  // Importing the same file again changes nothing; merging adds labels.
  const again = await store2.importData(json);
  assert.equal(again.applied, 3);
  assert.equal(store2.labels().length, 3);
  store2.close();
});

test('CSV export and import round-trip', async () => {
  const data = store.exportData();
  data.media[0].name = 'with "quotes", commas';
  const back = fromCsv(toCsv(data));
  assert.equal(back.media.length, data.media.length);
  assert.deepEqual(back.media[0], { ...data.media[0] });
  assert.throws(() => fromCsv('a,b\n1,2'), /no "path"/);
});

test('backup copy opens with the same labels; import rejects other files', async () => {
  const bak = path.join(tmp, 'backups', 'library-2026-10-09.db');
  store.backupTo(bak);
  const copy = new TagStore(bak);
  assert.equal(copy.labels().length, store.labels().length);
  assert.equal(copy.query({ labels: [], mode: 'all', minStars: 0 }).length, 3);
  copy.close();
  await assert.rejects(store.importData({ hello: 1 }), /not a PixHaven labels file/);
});

test('fingerprint reads both ends of the file', async () => {
  const a = make(tmp, 'a.bin'), b = path.join(tmp, 'b.bin');
  const buf = fs.readFileSync(a); buf[buf.length - 10] ^= 0xff; fs.writeFileSync(b, buf);
  assert.notEqual(await quickFingerprint(a, buf.length), await quickFingerprint(b, buf.length));
  const small = make(tmp, 'small.bin', 1000);
  assert.match(await quickFingerprint(small, 1000), /^[0-9a-f]{40}$/);
});

test.after(() => { try { store.close(); fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* busy */ } });
