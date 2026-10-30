// v2.9 Photos → Merge into…: a person's photos matched by face to the people they really are, then merged (files,
// face data, names inside, the group photo list, the sort log).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { load } from './helper.mjs';

const { openDb, folderId, embToBlob } = await load('db');
const { FACE_MODEL } = await load('faces/detect');
const { suggestMerge, mergePerson } = await load('sorter/merge-person');
const { readManifest } = await load('sorter/people-manifest');
const { TagReader } = await load('library/file-tags');

const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const HAS_EXIFTOOL = fs.existsSync(EXIFTOOL);
let seed = 21;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const unit = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return v.map(x => x / s); };
const identity = () => unit(Float32Array.from({ length: 512 }, gauss));
const faceOf = id => unit(Float32Array.from(id, x => x + gauss() * 0.035));

/**
 * One sorted folder: Mom (4 photos), Ravi (3), Asha (3), a stranger (2) — and "Person 9", a split-off group:
 * 2 photos of Mom, 1 of Ravi, 1 of the stranger-like nobody (no match). Person 9 is also in a group photo kept in
 * Ravi's folder (with Ravi), which Person 9's folder shows.
 */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-merge-'));
  const db = openDb(path.join(root, '..', `${path.basename(root)}.db`));
  const fid = folderId(db, root);
  const id = { mom: identity(), ravi: identity(), asha: identity(), x: identity() };
  const P = {};
  const addPerson = (name, num) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    P[name] = { pid: Number(db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)').run(fid, num, dir).lastInsertRowid), dir };
    db.prepare('INSERT INTO sort_dirs (folder_id, dir) VALUES (?, ?)').run(fid, dir);
  };
  const face = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 10, 10, 0.9, 50, 1, ?, ?, 0.9, ?)');
  let n = 0;
  const photo = async (person, who, extra = []) => {
    const file = path.join(P[person].dir, `${person.replace(' ', '')}-${n++}.jpg`);
    await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: n * 9, g: 80, b: 120 } } }).jpeg().toFile(file);
    const img = Number(db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, 0, 'done', ?)").run(fid, file, fs.statSync(file).size, 1 + extra.length).lastInsertRowid);
    face.run(img, embToBlob(faceOf(id[who])), FACE_MODEL, P[person].pid);
    for (const [p, w] of extra) face.run(img, embToBlob(faceOf(id[w])), FACE_MODEL, P[p].pid);
    return { file, img };
  };
  addPerson('Mom', 1); addPerson('Ravi', 2); addPerson('Asha', 3); addPerson('Person 9', 9);
  for (let i = 0; i < 4; i++) await photo('Mom', 'mom');
  for (let i = 0; i < 3; i++) await photo('Ravi', 'ravi');
  for (let i = 0; i < 3; i++) await photo('Asha', 'asha');
  const m1 = await photo('Person 9', 'mom'), m2 = await photo('Person 9', 'mom'), r1 = await photo('Person 9', 'ravi'), x1 = await photo('Person 9', 'x');
  // Group photo kept in Ravi's folder: Ravi + Person 9's face (looks like Asha). Person 9's folder shows it.
  const group = await photo('Ravi', 'ravi', [['Person 9', 'asha']]);
  fs.mkdirSync(path.join(root, '.clearup'), { recursive: true });
  fs.writeFileSync(path.join(root, '.clearup', 'people.json'), JSON.stringify({ app: 'PixHaven', version: 1, folders: { 'Person 9': [{ file: `Ravi/${path.basename(group.file)}`, sort: 1 }] } }));
  fs.writeFileSync(path.join(root, '.clearup', 'sort-log.jsonl'), JSON.stringify({ sort: 1, op: 'move', from: path.join(root, 'orig.jpg'), to: m1.file, t: 1 }) + '\n');
  return { root, db, P, m1, m2, r1, x1, group };
}

test('suggest: each photo goes to the person it looks like; someone already in the photo is never chosen', async () => {
  const s = await setup();
  const plan = suggestMerge(s.db, s.P['Person 9'].pid, 0.34);
  const by = Object.fromEntries(plan.targets.map(t => [t.label, t.photos.map(p => p.imageId).sort()]));
  assert.deepEqual(by.Mom, [s.m1.img, s.m2.img].sort());
  assert.deepEqual(by.Ravi, [s.r1.img]);
  assert.deepEqual(by.Asha, [s.group.img]);                       // the group photo face looks like Asha, not Ravi (he is in it)
  assert.deepEqual(plan.unmatched.map(p => p.imageId), [s.x1.img]);
  assert.equal(plan.photos, 5);
  s.db.close();
});

test('merge each photo to its person: files move, faces follow, names change, the group photo list follows', async () => {
  const s = await setup();
  const plan = suggestMerge(s.db, s.P['Person 9'].pid, 0.34);
  const moves = plan.targets.flatMap(t => t.photos.map(p => ({ imageId: p.imageId, to: t.personId })));
  const r = await mergePerson(s.db, s.P['Person 9'].pid, moves, HAS_EXIFTOOL ? EXIFTOOL : undefined);
  assert.equal(r.merged, 4);
  assert.equal(r.moved, 3);                                       // the group photo stays in Ravi's folder
  assert.equal(r.left, 1);
  assert.equal(r.removed, false);
  assert.deepEqual(r.skipped, []);
  const inMom = path.join(s.P.Mom.dir, path.basename(s.m1.file));
  assert.ok(fs.existsSync(inMom) && !fs.existsSync(s.m1.file));
  assert.ok(fs.existsSync(path.join(s.P.Ravi.dir, path.basename(s.r1.file))));
  assert.ok(fs.existsSync(s.x1.file), 'the unmatched photo stays');
  const owner = img => s.db.prepare('SELECT person_id FROM faces WHERE image_id = ? ORDER BY id DESC LIMIT 1').get(img).person_id;
  assert.equal(owner(s.m1.img), s.P.Mom.pid);
  assert.equal(owner(s.group.img), s.P.Asha.pid);
  assert.equal(s.db.prepare('SELECT path FROM images WHERE id = ?').get(s.m1.img).path, inMom);
  // The group photo kept in Ravi's folder is now shown in Asha's folder instead of Person 9's.
  assert.deepEqual(readManifest(s.root).folders, { Asha: [{ file: `Ravi/${path.basename(s.group.file)}`, sort: 1 }] });
  // The old sort's log follows the moved photo.
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.root, '.clearup', 'sort-log.jsonl'), 'utf8')).to, inMom);
  if (HAS_EXIFTOOL) {
    const reader = new TagReader(EXIFTOOL);
    try {
      const t = (await reader.read([inMom])).get(inMom);
      assert.ok(t.people.includes('Mom') && !t.people.includes('Person 9'), t.people.join(','));
    } finally { reader.stop(); }
  }
  s.db.close();
});

test('merge all into one person: everything goes, the person is removed', async () => {
  const s = await setup();
  const all = s.db.prepare('SELECT DISTINCT image_id FROM faces WHERE person_id = ?').all(s.P['Person 9'].pid).map(r => ({ imageId: r.image_id, to: s.P.Mom.pid }));
  const r = await mergePerson(s.db, s.P['Person 9'].pid, all);
  assert.equal(r.merged, 5);
  assert.equal(r.left, 0);
  assert.equal(r.removed, true);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM people WHERE id = ?').get(s.P['Person 9'].pid).n, 0);
  assert.equal(fs.readdirSync(s.P['Person 9'].dir).length, 0);
  assert.equal(fs.readdirSync(s.P.Mom.dir).length, 4 + 4);
  s.db.close();
});

test('merging into someone of another sorted folder is refused', async () => {
  const s = await setup();
  const other = folderId(s.db, path.join(s.root, '..', 'elsewhere'));
  const pid = Number(s.db.prepare('INSERT INTO people (folder_id, num) VALUES (?, 1)').run(other).lastInsertRowid);
  await assert.rejects(() => mergePerson(s.db, s.P['Person 9'].pid, [{ imageId: s.m1.img, to: pid }]), /one sorted folder/);
  s.db.close();
});
