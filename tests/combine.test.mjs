// v2.8 Combine people across sorted folders: matching by face, then the move (files, face data, names, people.json,
// sort logs). Two sorted folders on a temp drive; fingerprints are made up (one direction per person).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { load } from './helper.mjs';

const { openDb, folderId, embToBlob } = await load('db');
const { FACE_MODEL } = await load('faces/detect');
const { peopleOf, matchPeople, planTargets, estimateCombine, combineFolders } = await load('sorter/combine');
const { readManifest } = await load('sorter/people-manifest');
const { TagReader } = await load('library/file-tags');

const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const HAS_EXIFTOOL = fs.existsSync(EXIFTOOL);
const D = 512;

let seed = 7;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const unit = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return v.map(x => x / s); };
const identity = () => unit(Float32Array.from({ length: D }, gauss));
const faceOf = id => unit(Float32Array.from(id, x => x + gauss() * 0.035));   // ≈0.6 similar to the same person

async function jpg(file, shade) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 140 } } }).jpeg().toFile(file);
}

/**
 * Trip: Mom (named) + Person 1 (Ravi) + group photo kept in Mom's folder that Ravi's folder shows.
 * Family: Person 2 (same Mom, automatic name) + Person 1 (Asha, only here).
 */
async function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-combine-'));
  const db = openDb(path.join(base, 'faces.db'));
  const id = { mom: identity(), ravi: identity(), asha: identity() };
  const mk = async (root, people) => {
    const fid = folderId(db, root);
    const out = {};
    let shade = 10;
    for (const p of people) {
      const dir = path.join(root, p.folder);
      const pid = Number(db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)').run(fid, p.num, dir).lastInsertRowid);
      db.prepare('INSERT INTO sort_dirs (folder_id, dir) VALUES (?, ?)').run(fid, dir);
      out[p.key] = { pid, dir, files: [] };
      for (let i = 0; i < p.photos; i++) {
        const file = path.join(dir, `${p.key}-${i}.jpg`);
        await jpg(file, shade += 7);
        const st = fs.statSync(file);
        const img = Number(db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, ?, 'done', 1)").run(fid, file, st.size, Math.round(st.mtimeMs)).lastInsertRowid);
        db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 10, 10, 0.9, 50, 1, ?, ?, 0.9, ?)')
          .run(img, embToBlob(faceOf(id[p.id])), FACE_MODEL, pid);
        out[p.key].files.push(file);
        out[p.key].img = img;
      }
    }
    return { fid, people: out };
  };
  const trip = path.join(base, 'Trip'), family = path.join(base, 'Family');
  const T = await mk(trip, [{ key: 'mom', id: 'mom', folder: 'Mom', num: 1, photos: 4 }, { key: 'ravi', id: 'ravi', folder: 'Person 1', num: 2, photos: 3 }]);
  const F = await mk(family, [{ key: 'mom2', id: 'mom', folder: 'Person 2', num: 2, photos: 3 }, { key: 'asha', id: 'asha', folder: 'Person 1', num: 1, photos: 2 }]);
  // A group photo kept in Mom's folder with Ravi in it too; Ravi's folder shows it (people.json), and the sort log knows.
  const group = path.join(T.people.mom.dir, 'group.jpg');
  await jpg(group, 200);
  const gi = Number(db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, 0, 'done', 2)").run(T.fid, group, fs.statSync(group).size).lastInsertRowid);
  const ins = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 10, 10, 0.9, 50, 1, ?, ?, 0.9, ?)');
  ins.run(gi, embToBlob(faceOf(id.mom)), FACE_MODEL, T.people.mom.pid);
  ins.run(gi, embToBlob(faceOf(id.ravi)), FACE_MODEL, T.people.ravi.pid);
  fs.mkdirSync(path.join(trip, '.clearup'), { recursive: true });
  fs.writeFileSync(path.join(trip, '.clearup', 'people.json'), JSON.stringify({ app: 'PixHaven', version: 1, folders: { 'Person 1': [{ file: 'Mom/group.jpg', sort: 1 }] } }));
  fs.writeFileSync(path.join(trip, '.clearup', 'sort-log.jsonl'), JSON.stringify({ sort: 1, op: 'move', from: path.join(trip, 'group.jpg'), to: group, t: 1 }) + '\n');
  return { base, db, trip, family, T, F, group };
}

test('matching: the same person in two folders is found; different people and one folder are not merged', async () => {
  const s = await setup();
  const people = peopleOf(s.db, [s.T.fid, s.F.fid]);
  assert.equal(people.length, 4);
  assert.ok(people.every(p => p.set), 'every person has fingerprints');
  const groups = matchPeople(people, 0.36);
  assert.equal(groups.length, 1, JSON.stringify(groups));
  assert.deepEqual(new Set(groups[0].members), new Set([s.T.people.mom.pid, s.F.people.mom2.pid]));
  assert.ok(groups[0].score > 0.36);
  assert.equal(groups[0].sameName, false);    // "Mom" and "Person 2"
  s.db.close();
});

test('combine: folders merge into the destination; face data, names, people.json and the old sort log follow', async () => {
  const s = await setup();
  const dest = path.join(s.base, 'People');
  const req = { dest, groups: [
    { people: [s.T.people.mom.pid, s.F.people.mom2.pid], name: 'Mom' },
    { people: [s.T.people.ravi.pid], name: 'Person 1' },
    { people: [s.F.people.asha.pid], name: 'Person 1' },
  ] };
  // Two "Person 1" from different folders are numbered again in the destination.
  const plan = planTargets(s.db, req);
  assert.deepEqual(plan.targets.map(t => t.name).sort(), ['Mom', 'Person 1', 'Person 2']);
  const est = estimateCombine(s.db, req);
  assert.equal(est.files, 4 + 1 + 3 + 3 + 2);
  assert.equal(est.sameDrive, true);
  assert.ok(est.seconds > 0 && est.seconds < 60, String(est.seconds));

  const events = [];
  const r = await combineFolders(s.db, req, p => events.push(p.phase), HAS_EXIFTOOL ? EXIFTOOL : undefined);
  assert.equal(r.people, 3);
  assert.equal(r.moved, 13);
  assert.deepEqual(r.skipped, []);
  assert.ok(events.includes('moving') && events.at(-1) === 'done');

  // Files: Mom's folder holds both folders' photos; the emptied person folders are gone.
  const momDir = path.join(dest, 'Mom');
  assert.equal(fs.readdirSync(momDir).filter(f => f.endsWith('.jpg')).length, 4 + 1 + 3);
  assert.ok(!fs.existsSync(s.T.people.mom.dir) && !fs.existsSync(s.F.people.mom2.dir));
  const raviDir = plan.targets.find(t => t.members[0].id === s.T.people.ravi.pid).dir;
  assert.equal(fs.readdirSync(raviDir).length, 3);

  // Face data: one person in the destination folder, with every photo; the old people are gone.
  const destFid = folderId(s.db, dest, false);
  const mom = s.db.prepare('SELECT id, dir FROM people WHERE folder_id = ? AND dir = ?').get(destFid, momDir);
  assert.ok(mom);
  assert.equal(s.db.prepare('SELECT COUNT(DISTINCT image_id) AS n FROM faces WHERE person_id = ?').get(mom.id).n, 8);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM images WHERE folder_id = ?').get(destFid).n, 13);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM people WHERE folder_id IN (?, ?)').get(s.T.fid, s.F.fid).n, 0);
  const paths = s.db.prepare('SELECT path FROM images WHERE folder_id = ?').all(destFid).map(x => x.path);
  assert.ok(paths.every(p => fs.existsSync(p)), 'every stored path exists');
  assert.ok(s.db.prepare('SELECT 1 FROM sort_dirs WHERE folder_id = ? AND dir = ?').get(destFid, momDir));

  // The group photo is still shown in Ravi's folder, now from the destination's list.
  assert.deepEqual(readManifest(dest).folders[path.basename(raviDir)].map(e => e.file), ['Mom/group.jpg']);
  assert.deepEqual(readManifest(s.trip).folders, {});
  // The old sort's log points at where the photo is now (Undo of that sort still finds it).
  const logged = JSON.parse(fs.readFileSync(path.join(s.trip, '.clearup', 'sort-log.jsonl'), 'utf8').trim());
  assert.equal(logged.to, path.join(momDir, 'group.jpg'));

  if (HAS_EXIFTOOL) {
    // "Person 2" in Family's photos of Mom now says "Mom"; Asha's "Person 1" became "Person 2".
    assert.ok(r.renamed >= 3 + 2);
    const reader = new TagReader(EXIFTOOL);
    try {
      const tags = await reader.read([path.join(momDir, 'mom2-0.jpg'), path.join(dest, 'Person 2', 'asha-0.jpg')]);
      assert.ok(tags.get(path.join(momDir, 'mom2-0.jpg')).people.includes('Mom'));
      assert.ok(!tags.get(path.join(momDir, 'mom2-0.jpg')).people.includes('Person 2'));
      assert.ok(tags.get(path.join(dest, 'Person 2', 'asha-0.jpg')).people.includes('Person 2'));
    } finally { reader.stop(); }
  }
  s.db.close();
});

test('combine: into one of the sorted folders, its own person stays where it is', async () => {
  const s = await setup();
  const req = { dest: s.trip, groups: [{ people: [s.F.people.mom2.pid, s.T.people.mom.pid], name: 'Mom' }] };
  const plan = planTargets(s.db, req);
  assert.equal(plan.targets[0].dir, s.T.people.mom.dir);
  const r = await combineFolders(s.db, req, () => {});
  assert.equal(r.moved, 3);
  assert.equal(fs.readdirSync(s.T.people.mom.dir).filter(f => f.endsWith('.jpg')).length, 5 + 3);
  assert.equal(s.db.prepare('SELECT COUNT(DISTINCT image_id) AS n FROM faces WHERE person_id = ?').get(s.T.people.mom.pid).n, 8);
  // Trip's own group photo list is untouched.
  assert.deepEqual(readManifest(s.trip).folders['Person 1'].map(e => e.file), ['Mom/group.jpg']);
  s.db.close();
});

test('combine: a destination inside a folder being moved is refused before anything moves', async () => {
  const s = await setup();
  const req = { dest: path.join(s.T.people.mom.dir, 'All'), groups: [{ people: [s.T.people.mom.pid, s.F.people.mom2.pid], name: 'Mom' }] };
  await assert.rejects(() => combineFolders(s.db, req, () => {}), /inside/);
  assert.ok(fs.existsSync(path.join(s.F.people.mom2.dir, 'mom2-0.jpg')));
  s.db.close();
});
