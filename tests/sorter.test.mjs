import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { load } from './helper.mjs';

const { openDb, folderId } = await load('db');
const { buildPlan } = await load('sorter/plan');
const { applyPlan, undoSort, readLog } = await load('sorter/apply');

const SETTINGS = { includeSubfolders: false, strictness: 0.42, minFaceSize: 40, noFacesFolder: false, minPhotos: 1, useOcr: false };

/** The doc's example: beach.jpg (Ravi + Asha), ravi1.jpg (Ravi), IMG_0042.jpg (Asha), sunset.jpg (no face). */
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-sort-'));
  const files = { 'beach.jpg': 'B', 'ravi1.jpg': 'R', 'IMG_0042.jpg': 'A', 'sunset.jpg': 'S' };
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(root, f), c.repeat(1000));
  const db = openDb(path.join(root, '..', path.basename(root) + '.db'));
  const fid = folderId(db, root);
  const img = (f, faces) => Number(db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, 1000, 0, 'done', ?)").run(fid, path.join(root, f), faces).lastInsertRowid);
  const person = (num, name) => Number(db.prepare("INSERT INTO people (folder_id, num, name, name_source) VALUES (?, ?, ?, 'file')").run(fid, num, name).lastInsertRowid);
  const face = (imageId, pid) => db.prepare('INSERT INTO faces (image_id, usable, person_id) VALUES (?, 1, ?)').run(imageId, pid);
  const ravi = person(1, 'Ravi'), asha = person(2, 'Asha');
  const beach = img('beach.jpg', 2); face(beach, ravi); face(beach, asha);
  face(img('ravi1.jpg', 1), ravi);
  face(img('IMG_0042.jpg', 1), asha);
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

test('dry run follows the sorting rules', () => {
  const { root, db, fid } = setup();
  const plan = buildPlan(db, fid, root, SETTINGS);
  assert.deepEqual(plan.counts, { folders: 3, moves: 2, copies: 2, groupMoves: 1, stays: 1 });
  assert.deepEqual(plan.stays.map(s => [path.basename(s.path), s.reason]), [['sunset.jpg', 'No faces']]);
  assert.equal(plan.copyBytes, 2000);
  const pass2 = plan.ops.filter(o => o.pass === 2);
  assert.equal(pass2.length, 1);
  assert.equal(path.relative(root, pass2[0].to), path.join('Group photos', 'beach.jpg'));
});

test('apply builds the folder exactly like the doc example, and undo restores it', async () => {
  const { root, db, fid } = setup();
  const before = snapshot(root);
  const plan = buildPlan(db, fid, root, SETTINGS);
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state, plan) VALUES (?, ?, 'applying', ?)").run(fid, Date.now(), JSON.stringify(plan)).lastInsertRowid);
  const phases = [];
  const res = await applyPlan(db, sortId, plan, p => phases.push(p.phase));
  assert.deepEqual([res.ok, res.moved, res.copied, res.groupMoved, res.skipped.length], [true, 2, 2, 1, 0]);
  // Pass 2 (group originals) only starts after every pass-1 op.
  assert.ok(phases.lastIndexOf('pass1') < phases.indexOf('pass2'));
  const after = Object.keys(snapshot(root)).sort();
  assert.deepEqual(after, ['Asha/', path.join('Asha', 'IMG_0042.jpg'), path.join('Asha', 'beach.jpg'),
    'Group photos/', path.join('Group photos', 'beach.jpg'),
    'Ravi/', path.join('Ravi', 'beach.jpg'), path.join('Ravi', 'ravi1.jpg'), 'sunset.jpg'].sort());
  assert.equal(readLog(root, sortId).length, 3 + 2 + 2 + 1);
  // DB follows the files; folders are remembered
  assert.ok(db.prepare('SELECT path FROM images WHERE path LIKE ?').get('%Group photos%beach.jpg'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sort_dirs').get().n, 3);

  // A re-run finds nothing left to do.
  const again = buildPlan(db, fid, root, SETTINGS);
  assert.deepEqual([again.counts.moves, again.counts.copies, again.counts.groupMoves], [0, 0, 0]);

  const u = undoSort(db, sortId, root);
  assert.equal(u.kept.length, 0);
  assert.deepEqual(snapshot(root), before);
  assert.equal(db.prepare("SELECT state FROM sorts WHERE id = ?").get(sortId).state, 'undone');
});

test('undo removes nested folders it created', async () => {
  const { root, db, fid } = setup();
  const before = snapshot(root);
  const plan = { folderId: fid, root, targets: [], stays: [], counts: {}, copyBytes: 0, freeBytes: null,
    ops: [{ kind: 'mkdir', pass: 0, to: path.join(root, 'India', 'Bengaluru') },
          { kind: 'move', pass: 1, from: path.join(root, 'sunset.jpg'), to: path.join(root, 'India', 'Bengaluru', 'sunset.jpg') }] };
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state) VALUES (?, ?, 'applying')").run(fid, Date.now()).lastInsertRowid);
  await applyPlan(db, sortId, plan, () => {});
  assert.ok(fs.existsSync(path.join(root, 'India', 'Bengaluru', 'sunset.jpg')));
  undoSort(db, sortId, root);
  assert.deepEqual(snapshot(root), before);
});

test('never overwrites, and keeps read-only files in place', async () => {
  const { root, db, fid } = setup();
  fs.mkdirSync(path.join(root, 'Ravi'));
  fs.writeFileSync(path.join(root, 'Ravi', 'ravi1.jpg'), 'already here');
  fs.chmodSync(path.join(root, 'IMG_0042.jpg'), 0o444);
  const plan = buildPlan(db, fid, root, SETTINGS);
  assert.ok(plan.stays.some(s => s.path.endsWith('IMG_0042.jpg') && s.reason === 'Read-only file'));
  assert.ok(plan.ops.some(o => o.to.endsWith(path.join('Ravi', 'ravi1 (2).jpg'))));
  const sortId = Number(db.prepare("INSERT INTO sorts (folder_id, created, state) VALUES (?, ?, 'applying')").run(fid, Date.now()).lastInsertRowid);
  await applyPlan(db, sortId, plan, () => {});
  assert.equal(fs.readFileSync(path.join(root, 'Ravi', 'ravi1.jpg'), 'utf8'), 'already here');
  assert.ok(fs.existsSync(path.join(root, 'Ravi', 'ravi1 (2).jpg')));
  assert.ok(fs.existsSync(path.join(root, 'IMG_0042.jpg')));
  fs.chmodSync(path.join(root, 'IMG_0042.jpg'), 0o644);
});

test('"No faces" folder option and minimum photos per person', () => {
  const { root, db, fid } = setup();
  const plan = buildPlan(db, fid, root, { ...SETTINGS, noFacesFolder: true, minPhotos: 2 });
  assert.ok(plan.ops.some(o => o.from?.endsWith('sunset.jpg') && o.to.includes(path.join('No faces', 'sunset.jpg'))));
  // Ravi and Asha both have 2 photos → still get folders; nobody goes to Unsorted.
  assert.ok(!plan.targets.some(t => t.key === 'unsorted'));
  const p3 = buildPlan(db, fid, root, { ...SETTINGS, minPhotos: 3 });
  assert.ok(p3.targets.some(t => t.key === 'unsorted'));
});
