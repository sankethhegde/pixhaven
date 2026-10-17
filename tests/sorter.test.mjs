import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { load } from './helper.mjs';

const { openDb, folderId } = await load('db');
const { buildPlan, personLabel } = await load('sorter/plan');
const { applyPlan, undoSort, readLog } = await load('sorter/apply');
const { shownIn, readManifest, sortedFolders, movedFile } = await load('sorter/people-manifest');
const { TagReader } = await load('library/file-tags');

const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const HAS_EXIFTOOL = fs.existsSync(EXIFTOOL);
const SETTINGS = { includeSubfolders: false, strictness: 0.36, minFaceSize: 40, noFacesFolder: false, minPhotos: 1 };

/** beach.jpg (Person 1 big + Person 2 small), ravi1.jpg (Person 1), IMG_0042.jpg (Person 2), sunset.jpg (no face). */
async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-sort-'));
  const colours = { 'beach.jpg': '#48c', 'ravi1.jpg': '#c84', 'IMG_0042.jpg': '#4c8', 'sunset.jpg': '#c48' };
  for (const [f, c] of Object.entries(colours)) await sharp({ create: { width: 64, height: 48, channels: 3, background: c } }).jpeg().toFile(path.join(root, f));
  const db = openDb(path.join(root, '..', path.basename(root) + '.db'));
  const fid = folderId(db, root);
  const img = (f, faces) => Number(db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, 0, 'done', ?)")
    .run(fid, path.join(root, f), fs.statSync(path.join(root, f)).size, faces).lastInsertRowid);
  const person = num => Number(db.prepare('INSERT INTO people (folder_id, num) VALUES (?, ?)').run(fid, num).lastInsertRowid);
  const face = (imageId, pid, size = 100) => db.prepare('INSERT INTO faces (image_id, usable, person_id, x, y, w, h) VALUES (?, 1, ?, 0, 0, ?, ?)').run(imageId, pid, size, size);
  const p1 = person(1), p2 = person(2);
  const beach = img('beach.jpg', 2); face(beach, p2, 60); face(beach, p1, 140);
  face(img('ravi1.jpg', 1), p1);
  face(img('IMG_0042.jpg', 1), p2);
  img('sunset.jpg', 0);
  return { root, db, fid };
}

const snapshot = dir => {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.name === '.clearup') continue;
    if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = 'dir'; walk(p); }
    else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } };
  walk(dir);
  return out;
};

test('people are "Person 1", "Person 2" — or the folder an earlier sort gave them', () => {
  assert.equal(personLabel({ num: 3 }), 'Person 3');
  assert.equal(personLabel({ num: 12, dir: null }), 'Person 12');
  assert.equal(personLabel({ num: 1, dir: path.join('D:', 'Photos', 'Ravi') }), 'Ravi');
});

test('dry run: a group photo moves once, to the person with the biggest face, and is tagged for the others', async () => {
  const { root, db, fid } = await setup();
  const plan = buildPlan(db, fid, root, SETTINGS);
  assert.deepEqual(plan.counts, { folders: 2, moves: 3, tagged: 1, stays: 1 });
  assert.ok(!plan.ops.some(o => o.kind === 'copy' || o.pass === 2), 'no copies, no "Group photos"');
  assert.ok(!plan.targets.some(t => /group/i.test(t.label)));
  const beach = plan.ops.find(o => o.from?.endsWith('beach.jpg'));
  assert.equal(path.relative(root, beach.to), path.join('Person 1', 'beach.jpg'));
  assert.deepEqual(beach.people, ['Person 1', 'Person 2']);
  assert.deepEqual(beach.alsoIn.map(a => path.relative(root, a.dir)), ['Person 2']);
  assert.deepEqual(plan.stays.map(s => [path.basename(s.path), s.reason]), [['sunset.jpg', 'No faces']]);
});

test('apply: no copies, people written into the photos, other folders list them; undo restores everything',
  { timeout: 60000, skip: !HAS_EXIFTOOL && 'ExifTool not set up (npm run setup:engine)' }, async () => {
  const { root, db, fid } = await setup();
  const before = snapshot(root);
  const plan = buildPlan(db, fid, root, SETTINGS);
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state, plan) VALUES (?, ?, 'applying', ?)").run(fid, Date.now(), JSON.stringify(plan)).lastInsertRowid);
  const phases = [];
  const res = await applyPlan(db, sortId, plan, p => phases.push(p.phase), false, EXIFTOOL);
  assert.deepEqual([res.ok, res.moved, res.copied, res.tagged, res.skipped.length], [true, 3, 0, 1, 0], JSON.stringify(res.skipped));
  assert.ok(phases.includes('tagging'));
  assert.deepEqual(Object.keys(snapshot(root)).sort(), ['Person 1/', path.join('Person 1', 'beach.jpg'), path.join('Person 1', 'ravi1.jpg'),
    'Person 2/', path.join('Person 2', 'IMG_0042.jpg'), 'sunset.jpg'].sort());
  // Person 2's folder shows the group photo kept in Person 1's folder.
  assert.deepEqual(shownIn(path.join(root, 'Person 2')), [path.join(root, 'Person 1', 'beach.jpg')]);
  assert.deepEqual(shownIn(path.join(root, 'Person 1')), []);
  assert.deepEqual(readManifest(root).folders, { 'Person 2': [{ file: 'Person 1/beach.jpg', sort: sortId }] });
  // The people travel inside the photos.
  const r = new TagReader(EXIFTOOL);
  const tags = await r.read([path.join(root, 'Person 1', 'beach.jpg'), path.join(root, 'Person 2', 'IMG_0042.jpg')]);
  r.stop();
  assert.deepEqual(tags.get(path.join(root, 'Person 1', 'beach.jpg')).people, ['Person 1', 'Person 2']);
  assert.deepEqual(tags.get(path.join(root, 'Person 2', 'IMG_0042.jpg')).people, ['Person 2']);
  assert.equal(res.files.length, 3);
  // DB follows the files (size too, so a re-scan doesn't read them again); folders are remembered.
  const row = db.prepare('SELECT path, size FROM images WHERE path LIKE ?').get('%Person 1%beach.jpg');
  assert.equal(row.size, fs.statSync(row.path).size);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sort_dirs').get().n, 2);
  // On a computer without this face data, a scan leaves the sorted folders alone.
  assert.deepEqual(sortedFolders(root).map(d => path.relative(root, d)).sort(), ['Person 1', 'Person 2']);

  const again = buildPlan(db, fid, root, SETTINGS);
  assert.equal(again.counts.moves, 0);

  const u = await undoSort(db, sortId, root, undefined, EXIFTOOL);
  assert.equal(u.kept.length, 0);
  assert.deepEqual(snapshot(root), before, "every file back, byte for byte");
  const r2 = new TagReader(EXIFTOOL);
  const back = await r2.read([path.join(root, 'beach.jpg')]);
  r2.stop();
  assert.deepEqual(back.get(path.join(root, 'beach.jpg')).people, [], 'people taken out again');
  assert.ok(!fs.existsSync(path.join(root, '.clearup', 'people.json')));
  assert.equal(db.prepare('SELECT state FROM sorts WHERE id = ?').get(sortId).state, 'undone');
  assert.ok(readLog(root, sortId).length > 0);
});

test('the list of shown photos follows a photo renamed inside the app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-manifest-'));
  fs.mkdirSync(path.join(root, 'Person 1')); fs.mkdirSync(path.join(root, 'Person 2'));
  fs.writeFileSync(path.join(root, 'Person 1', 'a.jpg'), 'x');
  const { addShown } = await load('sorter/people-manifest');
  addShown(root, 1, [{ dir: path.join(root, 'Person 2'), file: path.join(root, 'Person 1', 'a.jpg') }]);
  fs.renameSync(path.join(root, 'Person 1', 'a.jpg'), path.join(root, 'Person 1', 'b.jpg'));
  movedFile(path.join(root, 'Person 1', 'a.jpg'), path.join(root, 'Person 1', 'b.jpg'));
  assert.deepEqual(shownIn(path.join(root, 'Person 2')), [path.join(root, 'Person 1', 'b.jpg')]);
});

test('undo removes nested folders it created', async () => {
  const { root, db, fid } = await setup();
  const before = snapshot(root);
  const plan = { folderId: fid, root, targets: [], stays: [], counts: {}, freeBytes: null,
    ops: [{ kind: 'mkdir', pass: 0, to: path.join(root, 'India', 'Bengaluru') },
          { kind: 'move', pass: 1, from: path.join(root, 'sunset.jpg'), to: path.join(root, 'India', 'Bengaluru', 'sunset.jpg') }] };
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state) VALUES (?, ?, 'applying')").run(fid, Date.now()).lastInsertRowid);
  await applyPlan(db, sortId, plan, () => {});
  assert.ok(fs.existsSync(path.join(root, 'India', 'Bengaluru', 'sunset.jpg')));
  await undoSort(db, sortId, root);
  assert.deepEqual(snapshot(root), before);
});

test('never overwrites, and keeps read-only files in place', async () => {
  const { root, db, fid } = await setup();
  fs.mkdirSync(path.join(root, 'Person 1'));
  fs.writeFileSync(path.join(root, 'Person 1', 'ravi1.jpg'), 'already here');
  fs.chmodSync(path.join(root, 'IMG_0042.jpg'), 0o444);
  const plan = buildPlan(db, fid, root, SETTINGS);
  assert.ok(plan.stays.some(s => s.path.endsWith('IMG_0042.jpg') && s.reason === 'Read-only file'));
  assert.ok(plan.ops.some(o => o.to.endsWith(path.join('Person 1', 'ravi1 (2).jpg'))));
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state) VALUES (?, ?, 'applying')").run(fid, Date.now()).lastInsertRowid);
  await applyPlan(db, sortId, plan, () => {});
  assert.equal(fs.readFileSync(path.join(root, 'Person 1', 'ravi1.jpg'), 'utf8'), 'already here');
  assert.ok(fs.existsSync(path.join(root, 'Person 1', 'ravi1 (2).jpg')));
  assert.ok(fs.existsSync(path.join(root, 'IMG_0042.jpg')));
  fs.chmodSync(path.join(root, 'IMG_0042.jpg'), 0o644);
});

test('"No faces" folder option and minimum photos per person', async () => {
  const { root, db, fid } = await setup();
  const plan = buildPlan(db, fid, root, { ...SETTINGS, noFacesFolder: true, minPhotos: 2 });
  assert.ok(plan.ops.some(o => o.from?.endsWith('sunset.jpg') && o.to.includes(path.join('No faces', 'sunset.jpg'))));
  // Both people have 2 photos → still get folders; nobody goes to Unsorted.
  assert.ok(!plan.targets.some(t => t.key === 'unsorted'));
  const p3 = buildPlan(db, fid, root, { ...SETTINGS, minPhotos: 3 });
  assert.ok(p3.targets.some(t => t.key === 'unsorted'));
  assert.ok(p3.ops.every(o => o.kind === 'mkdir' || !o.people?.length), 'nobody with a folder: no people tags');
});

test('a sorted folder renamed in Explorer (and its person folders) is found again; Undo still works', { skip: !HAS_EXIFTOOL && 'needs ExifTool' }, async () => {
  const { reconcileFolder, relocateFolder, renamePeople } = await load('sorter/reconcile');
  const { root, db, fid } = await setup();
  const before = snapshot(root);
  const plan = buildPlan(db, fid, root, SETTINGS);
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state, plan) VALUES (?, ?, 'applying', ?)").run(fid, Date.now(), JSON.stringify(plan)).lastInsertRowid);
  await applyPlan(db, sortId, plan, () => {}, false, EXIFTOOL);
  // Nothing renamed: nothing changes.
  assert.deepEqual(reconcileFolder(db, fid, root), { folders: [], photos: 0, moved: [] });

  // The user renames the person folders and the sorted folder itself.
  fs.renameSync(path.join(root, 'Person 1'), path.join(root, 'Ravi'));
  fs.renameSync(path.join(root, 'Person 2'), path.join(root, 'Mom'));
  const moved = root + '-renamed';
  fs.renameSync(root, moved);
  assert.equal(relocateFolder(db, root), null, 'a folder that is not there is not matched');
  assert.equal(relocateFolder(db, moved)?.from, root);
  assert.equal(folderId(db, moved, false), fid);
  const r = reconcileFolder(db, fid, moved);
  assert.equal(r.photos, 3);
  assert.deepEqual(r.folders.map(f => [path.basename(f.from), path.basename(f.to)]).sort(), [['Person 1', 'Ravi'], ['Person 2', 'Mom']]);
  const paths = db.prepare('SELECT path FROM images WHERE folder_id = ?').all(fid).map(x => x.path);
  assert.ok(paths.every(p => fs.existsSync(p)), paths.join(', '));
  const dirs = db.prepare('SELECT num, dir FROM people WHERE folder_id = ? ORDER BY num').all(fid).map(x => [x.num, path.basename(x.dir)]);
  assert.deepEqual(dirs, [[1, 'Ravi'], [2, 'Mom']]);
  assert.deepEqual(personLabel(db.prepare('SELECT * FROM people WHERE num = 2 AND folder_id = ?').get(fid)), 'Mom');
  // The group photo still shows in Mom's folder; later scans skip the renamed folders.
  assert.deepEqual(shownIn(path.join(moved, 'Mom')), [path.join(moved, 'Ravi', 'beach.jpg')]);
  assert.deepEqual(sortedFolders(moved).map(d => path.basename(d)).sort(), ['Mom', 'Ravi']);
  assert.deepEqual(db.prepare('SELECT dir FROM sort_dirs WHERE folder_id = ?').all(fid).map(x => path.basename(x.dir)).sort(), ['Mom', 'Ravi']);

  // The names inside the photos follow the folder names (the group photo kept in Ravi's folder names Mom too).
  assert.deepEqual(db.prepare('SELECT old, new FROM name_changes WHERE folder_id = ? ORDER BY id').all(fid).map(x => [x.old, x.new]).sort(),
    [['Person 1', 'Ravi'], ['Person 2', 'Mom']]);
  const changed = await renamePeople(db, fid, moved, EXIFTOOL);
  assert.equal(changed.length, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM name_changes').get().n, 0);
  const rd = new TagReader(EXIFTOOL);
  const inFiles = await rd.read([path.join(moved, 'Ravi', 'beach.jpg'), path.join(moved, 'Ravi', 'ravi1.jpg'), path.join(moved, 'Mom', 'IMG_0042.jpg')]);
  rd.stop();
  assert.deepEqual([...inFiles.values()].map(t => [...t.people].sort()), [['Mom', 'Ravi'], ['Ravi'], ['Mom']]);
  const row = db.prepare('SELECT size, mtime FROM images WHERE path = ?').get(path.join(moved, 'Ravi', 'beach.jpg'));
  const st = fs.statSync(path.join(moved, 'Ravi', 'beach.jpg'));
  assert.deepEqual([row.size, row.mtime], [st.size, Math.round(st.mtimeMs)], 'not scanned again');

  // Undo puts everything back where it was in the (renamed) folder, and takes the new names out again.
  await undoSort(db, sortId, moved, undefined, EXIFTOOL);
  const after = snapshot(moved);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const rd2 = new TagReader(EXIFTOOL);
  const left = await rd2.read(['beach.jpg', 'ravi1.jpg', 'IMG_0042.jpg'].map(f => path.join(moved, f)));
  rd2.stop();
  assert.deepEqual([...left.values()].flatMap(t => t.people), []);
});
