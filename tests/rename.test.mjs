// 0.6.0 rename ClearUp → PixHaven: the old app data moves to the new folder once; old label exports still import.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './helper.mjs';

const { moveAppData } = await load('app-data-move');
const { TagStore } = await load('library/tags');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clearup-rename-'));
const put = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

test('old app data moves to the new name (whole folder)', () => {
  const old = path.join(tmp, 'a', 'ClearUp'), now = path.join(tmp, 'a', 'PixHaven');
  put(path.join(old, 'settings.json'), '{}'); put(path.join(old, 'library.db')); put(path.join(old, 'backups', 'library-2026-10-09.db'));
  assert.deepEqual(moveAppData(old, now), { moved: true, left: [] });
  assert.ok(fs.existsSync(path.join(now, 'backups', 'library-2026-10-09.db')) && !fs.existsSync(old));
  assert.equal(moveAppData(old, now).moved, false, 'only once');
});

test('new folder already made by Electron (or a self-test): the old data takes its place', () => {
  const old = path.join(tmp, 'b', 'ClearUp'), now = path.join(tmp, 'b', 'PixHaven');
  put(path.join(old, 'settings.json'), '{"theme":"dark"}'); put(path.join(old, 'facedata', 'faces.db')); put(path.join(old, 'Local Storage', 'x'));
  put(path.join(now, 'Local Storage', 'y')); put(path.join(now, 'facedata', 'empty.db'));
  const r = moveAppData(old, now);
  assert.equal(r.moved, true); assert.deepEqual(r.left, []);
  assert.ok(fs.existsSync(path.join(now, 'Local Storage', 'x')) && !fs.existsSync(path.join(now, 'facedata', 'empty.db')) && !fs.existsSync(old));
  assert.equal(fs.readFileSync(path.join(now, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  assert.ok(fs.existsSync(path.join(now, 'facedata', 'faces.db')));
});

test('existing PixHaven data is never overwritten', () => {
  const old = path.join(tmp, 'c', 'ClearUp'), now = path.join(tmp, 'c', 'PixHaven');
  put(path.join(old, 'settings.json'), 'old'); put(path.join(now, 'settings.json'), 'new');
  assert.equal(moveAppData(old, now).moved, false);
  assert.equal(fs.readFileSync(path.join(now, 'settings.json'), 'utf8'), 'new');
});

test('labels exported by ClearUp still import, new exports say PixHaven', async () => {
  const s = new TagStore(path.join(tmp, 'd', 'library.db'));
  const f = path.join(tmp, 'd', 'v.mp4'); put(f, 'video');
  const r = await s.importData({ app: 'ClearUp', kind: 'labels', version: 1, exported: '', labels: [{ name: 'Family', color: null }],
    media: [{ path: f, name: 'v.mp4', size: 5, fingerprint: 'nope', stars: 4, labels: ['Family'] }] });
  assert.equal(r.labels, 1);
  assert.equal(s.exportData().app, 'PixHaven');
  await assert.rejects(s.importData({ app: 'Other', kind: 'labels', media: [] }), /not a PixHaven labels file/);
  s.close();
});
