// v2.5: Photos tab file actions, group photo shortcuts for File Explorer, and "also shown in" for group photos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from './helper.mjs';

const { pasteItems, newFolder, renameFolder, freeName } = await load('library/file-ops');
const { syncShortcuts, LINK_MARK } = await load('sorter/shortcuts');
const { alsoShownFrom, addShown, readManifest, remapManifest } = await load('sorter/people-manifest');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-ops-'));
const put = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); return p; };
const tree = dir => {
  const out = [];
  const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(d, e.name), r); } else out.push(r); } };
  walk(dir, '');
  return out.sort();
};

test('copy and move files and folders; names that are taken get " (2)"; never overwrites', async () => {
  const d = tmp();
  put(path.join(d, 'a', 'beach.jpg'), 'beach');
  put(path.join(d, 'a', 'shot.cr2'), 'raw');
  put(path.join(d, 'a', 'shot.xmp'), 'sidecar');
  put(path.join(d, 'b', 'shot.cr2'), 'other raw');
  put(path.join(d, 'a', 'Trip', 'one.jpg'), 'one');
  put(path.join(d, 'b', 'beach.jpg'), 'other beach');
  const moved = [];
  const hook = (pairs, dir) => { moved.push(...pairs.map(p => [path.relative(d, p.from), path.relative(d, p.to)])); if (dir) moved.push(['dir', path.relative(d, dir.to)]); };

  const c = await pasteItems([path.join(d, 'a', 'beach.jpg'), path.join(d, 'a', 'Trip'), path.join(d, 'a', 'shot.cr2')], path.join(d, 'b'), 'copy', hook);
  assert.equal(c.failed.length, 0);
  assert.equal(fs.readFileSync(path.join(d, 'b', 'beach (2).jpg'), 'utf8'), 'beach');
  assert.equal(fs.readFileSync(path.join(d, 'b', 'beach.jpg'), 'utf8'), 'other beach', 'not overwritten');
  assert.equal(fs.readFileSync(path.join(d, 'b', 'shot (2).xmp'), 'utf8'), 'sidecar', 'the sidecar of a RAW photo is copied with it');
  assert.ok(fs.existsSync(path.join(d, 'b', 'Trip', 'one.jpg')));
  assert.deepEqual(moved, [], 'copies do not move anything');

  const m = await pasteItems([path.join(d, 'a', 'Trip'), path.join(d, 'a', 'beach.jpg'), path.join(d, 'a', 'shot.cr2')], path.join(d, 'b'), 'move', hook);
  assert.equal(m.failed.length, 0);
  assert.deepEqual(tree(path.join(d, 'a')), []);
  assert.deepEqual(tree(path.join(d, 'b')), ['Trip (2)/', 'Trip (2)/one.jpg', 'Trip/', 'Trip/one.jpg', 'beach (2).jpg', 'beach (3).jpg', 'beach.jpg', 'shot (2).cr2', 'shot (2).xmp', 'shot (3).cr2', 'shot (3).xmp', 'shot.cr2']);
  assert.deepEqual(moved, [[path.join('a', 'Trip', 'one.jpg'), path.join('b', 'Trip (2)', 'one.jpg')], ['dir', path.join('b', 'Trip (2)')], [path.join('a', 'beach.jpg'), path.join('b', 'beach (3).jpg')], [path.join('a', 'shot.cr2'), path.join('b', 'shot (3).cr2')]]);
});

test('a folder cannot go inside itself; moving into the same folder does nothing', async () => {
  const d = tmp();
  put(path.join(d, 'Trip', 'Day 1', 'x.jpg'));
  const r = await pasteItems([path.join(d, 'Trip')], path.join(d, 'Trip', 'Day 1'), 'move', () => {});
  assert.equal(r.failed[0].reason, 'A folder cannot go inside itself');
  const same = await pasteItems([path.join(d, 'Trip', 'Day 1', 'x.jpg')], path.join(d, 'Trip', 'Day 1'), 'move', () => {});
  assert.deepEqual([same.done.length, same.failed.length], [0, 0]);
  assert.deepEqual(tree(d), ['Trip/', 'Trip/Day 1/', 'Trip/Day 1/x.jpg']);
});

test('new folder and folder rename', async () => {
  const d = tmp();
  assert.equal(path.basename(newFolder(d, 'New folder')), 'New folder');
  assert.equal(path.basename(newFolder(d, 'New folder')), 'New folder (2)');
  assert.throws(() => newFolder(d, 'bad:name'), /characters/);
  put(path.join(d, 'Person 2', 'p.jpg'));
  let seen = null;
  const to = await renameFolder(path.join(d, 'Person 2'), 'Mom', (pairs, dir) => { seen = { pairs: pairs.length, dir: path.basename(dir.to) }; });
  assert.equal(path.basename(to), 'Mom');
  assert.deepEqual(seen, { pairs: 1, dir: 'Mom' });
  await assert.rejects(renameFolder(path.join(d, 'Mom'), 'New folder', () => {}), /already/);
  assert.equal(path.basename(freeName(path.join(d, 'Mom'), true)), 'Mom (2)');
});

test('group photos: the folder keeping one knows which folders show it; folder renames follow in the list', () => {
  const root = tmp();
  const beach = put(path.join(root, 'Person 1', 'beach.jpg'));
  put(path.join(root, 'Person 2', 'p2.jpg')); put(path.join(root, 'Person 3', 'p3.jpg'));
  addShown(root, 1, [{ dir: path.join(root, 'Person 2'), file: beach }, { dir: path.join(root, 'Person 3'), file: beach }]);
  const also = alsoShownFrom(path.join(root, 'Person 1'));
  const k = process.platform === 'win32' ? beach.toLowerCase() : beach;
  assert.deepEqual(also.get(k), ['Person 2', 'Person 3']);
  assert.equal(alsoShownFrom(path.join(root, 'Person 2')).size, 0);
  // "Person 2" renamed to "Mom" in the app.
  fs.renameSync(path.join(root, 'Person 2'), path.join(root, 'Mom'));
  const from = path.join(root, 'Person 2');
  remapManifest(root, p => (p.toLowerCase() === from.toLowerCase() ? path.join(root, 'Mom') : p));
  assert.deepEqual(Object.keys(readManifest(root).folders).sort(), ['Mom', 'Person 3']);
  assert.deepEqual(alsoShownFrom(path.join(root, 'Person 1')).get(k), ['Mom', 'Person 3']);
});

test('Explorer shortcuts follow people.json: made, kept, retargeted, removed; others\' shortcuts untouched', () => {
  const root = tmp();
  const beach = put(path.join(root, 'Person 1', 'beach.jpg'));
  put(path.join(root, 'Person 2', 'beach.jpg'), 'a different photo with the same name');
  put(path.join(root, 'Person 2', 'mine.lnk'), 'someone else\'s shortcut');
  // A fake shortcut writer/reader: the .lnk holds JSON.
  const links = {
    write: (lnk, target, description) => { fs.writeFileSync(lnk, JSON.stringify({ target, description })); return true; },
    read: lnk => { try { return JSON.parse(fs.readFileSync(lnk, 'utf8')); } catch { return null; } },
  };
  addShown(root, 7, [{ dir: path.join(root, 'Person 2'), file: beach }]);
  assert.deepEqual(syncShortcuts(root, links), { made: 1, removed: 0 });
  const lnk = path.join(root, 'Person 2', 'beach (2).jpg.lnk');
  assert.deepEqual(links.read(lnk), { target: beach, description: LINK_MARK });
  assert.deepEqual(syncShortcuts(root, links), { made: 0, removed: 0 }, 'nothing to do the second time');

  // The photo is renamed in the app: the shortcut is remade to point at it.
  const renamed = path.join(root, 'Person 1', 'beach day.jpg');
  fs.renameSync(beach, renamed);
  remapManifest(root, p => (p.toLowerCase() === beach.toLowerCase() ? renamed : p));
  assert.deepEqual(syncShortcuts(root, links), { made: 1, removed: 1 });
  assert.equal(links.read(path.join(root, 'Person 2', 'beach day.jpg.lnk')).target, renamed);

  // Undo: all of PixHaven's shortcuts go, the user's own stays.
  assert.deepEqual(syncShortcuts(root, links, true), { made: 0, removed: 1 });
  assert.deepEqual(tree(path.join(root, 'Person 2')), ['beach.jpg', 'mine.lnk']);
});
