// End-to-end check of v2.8 in the built app: Photos → Combine people (two sorted folders, the same person in both),
// and Sort → Estimate time. Photos are made here (coloured noise) and the face data is written straight into the
// test's own face database (made-up fingerprints), so no real photos are needed.
// Run: npm run e2e:combine. Screenshots + results.json land in e2e-output/combine/.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
sharp.cache(false);

const OUT = process.env.CLEARUP_E2E_DIR;
const BASE = path.join(OUT, 'Combine');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FACE_MODEL = 5, D = 512;

let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const unit = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return v.map(x => x / s); };
const identity = () => unit(Float32Array.from({ length: D }, gauss));
const faceOf = id => unit(Float32Array.from(id, x => x + gauss() * 0.035));
const blob = e => new Uint8Array(e.buffer, e.byteOffset, e.byteLength);

async function photo(file, i) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = Buffer.alloc(320 * 240 * 3);
  for (let k = 0; k < raw.length; k++) raw[k] = (k * 31 + i * 97 + Math.floor(rnd() * 60)) & 255;
  await sharp(raw, { raw: { width: 320, height: 240, channels: 3 } }).jpeg({ quality: 80 }).toFile(file);
}

/** Trip (Mom, Person 1 = Ravi, a group photo of both in Mom's folder) and Family (Person 2 = Mom, Person 1 = Asha). */
async function makeFolders(dbFile) {
  fs.rmSync(BASE, { recursive: true, force: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000;');
  const id = { mom: identity(), ravi: identity(), asha: identity() };
  const face = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 40, 40, 0.9, 50, 1, ?, ?, 0.9, ?)');
  const img = db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, ?, 'done', ?)");
  let n = 0;
  const folder = async (name, people) => {
    const root = path.join(BASE, name);
    const fid = Number(db.prepare('INSERT INTO folders (path, created, last_scan) VALUES (?, ?, ?)').run(root, Date.now(), Date.now()).lastInsertRowid);
    db.prepare("INSERT INTO sorts (folder_id, created, state, kind, summary) VALUES (?, ?, 'done', 'people', '{}')").run(fid, Date.now());
    const out = { root, fid };
    for (const p of people) {
      const dir = path.join(root, p.folder);
      const pid = Number(db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)').run(fid, p.num, dir).lastInsertRowid);
      db.prepare('INSERT INTO sort_dirs (folder_id, dir) VALUES (?, ?)').run(fid, dir);
      out[p.key] = { pid, dir };
      for (let i = 0; i < p.photos; i++) {
        const file = path.join(dir, `${p.key}-${i}.jpg`);
        await photo(file, n++);
        const st = fs.statSync(file);
        face.run(Number(img.run(fid, file, st.size, Math.round(st.mtimeMs), 1).lastInsertRowid), blob(faceOf(id[p.who])), FACE_MODEL, pid);
      }
    }
    return out;
  };
  const trip = await folder('Trip', [{ key: 'mom', who: 'mom', folder: 'Mom', num: 1, photos: 4 }, { key: 'ravi', who: 'ravi', folder: 'Person 1', num: 2, photos: 3 }]);
  const family = await folder('Family', [{ key: 'mom2', who: 'mom', folder: 'Person 2', num: 2, photos: 3 }, { key: 'asha', who: 'asha', folder: 'Person 1', num: 1, photos: 2 }]);
  const group = path.join(trip.mom.dir, 'group.jpg');
  await photo(group, 99);
  const gi = Number(img.run(trip.fid, group, fs.statSync(group).size, 0, 2).lastInsertRowid);
  face.run(gi, blob(faceOf(id.mom)), FACE_MODEL, trip.mom.pid);
  face.run(gi, blob(faceOf(id.ravi)), FACE_MODEL, trip.ravi.pid);
  fs.mkdirSync(path.join(trip.root, '.clearup'), { recursive: true });
  fs.writeFileSync(path.join(trip.root, '.clearup', 'people.json'), JSON.stringify({ app: 'PixHaven', version: 1, folders: { 'Person 1': [{ file: 'Mom/group.jpg', sort: 1 }] } }));
  db.close();
  return { trip, family, group };
}

/** v2.9: a sorted folder where "Person 9" is really two people (2 photos of Mom, 1 of Ravi), and "Person 10" is Ravi. */
async function makeSplit(dbFile) {
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000;');
  const id = { mom: identity(), ravi: identity() };
  const root = path.join(BASE, 'Split');
  const fid = Number(db.prepare('INSERT INTO folders (path, created, last_scan) VALUES (?, ?, ?)').run(root, Date.now(), Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO sorts (folder_id, created, state, kind, summary) VALUES (?, ?, 'done', 'people', '{}')").run(fid, Date.now());
  const face = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 40, 40, 0.9, 50, 1, ?, ?, 0.9, ?)');
  const img = db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, ?, 'done', 1)");
  const out = { root };
  let n = 0;
  for (const [name, num, who] of [['Mom', 1, ['mom', 'mom', 'mom', 'mom']], ['Ravi', 2, ['ravi', 'ravi', 'ravi']], ['Person 9', 9, ['mom', 'mom', 'ravi']], ['Person 10', 10, ['ravi', 'ravi']]]) {
    const dir = path.join(root, name);
    const pid = Number(db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)').run(fid, num, dir).lastInsertRowid);
    db.prepare('INSERT INTO sort_dirs (folder_id, dir) VALUES (?, ?)').run(fid, dir);
    out[name] = { pid, dir, files: [] };
    for (const w of who) {
      const file = path.join(dir, `${name.replace(' ', '')}-${w}-${n++}.jpg`);
      await photo(file, 300 + n);
      const st = fs.statSync(file);
      face.run(Number(img.run(fid, file, st.size, Math.round(st.mtimeMs)).lastInsertRowid), blob(faceOf(id[w])), FACE_MODEL, pid);
      out[name].files.push(file);
    }
  }
  db.close();
  return out;
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label, exact = true) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button, [role=dialog] button')].find(b => b.offsetParent && ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(300);
  }
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(700);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 900);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await waitFor('What would you like to do?');
    await js('window.clearup.sort.deleteData()');
    await js('window.clearup.photos.folders()');            // makes a fresh face database
    const dbFile = path.join(app.getPath('userData'), 'facedata', 'faces.db');
    const f = await makeFolders(dbFile);

    // ---- Photos → Combine people ----
    await js(`window.__clearupPage('photos')`);
    await waitFor('Combine people…');
    await click('Combine people…');
    await waitFor('Sorted folders to combine');
    const listed = await js(`[...document.querySelectorAll('[data-combine-folder]')].map(e => e.dataset.combineFolder)`);
    check('both sorted folders are offered, ticked', listed.length === 2 && (await js(`[...document.querySelectorAll('[data-combine-folder] input')].every(i => i.checked)`)), listed.map(p => path.basename(p)).join(', '));
    const dest = path.join(BASE, 'People');
    await js(`window.__clearupCombineDest(${JSON.stringify(dest)})`);
    await sleep(300);
    await shot('01-choose');
    await click('Find the same people');
    await waitFor('Check the matches', 60000);
    const matches = await js(`[...document.querySelectorAll('[data-combine-match]')].map(m => ({ name: m.querySelector('input[aria-label=Name]').value, people: m.querySelectorAll('[data-combine-person]').length, text: m.innerText }))`);
    check('Mom is found in both folders (one match, two people)', matches.length === 1 && matches[0].people === 2, JSON.stringify(matches.map(m => ({ name: m.name, people: m.people }))));
    check('the match takes the name given in Trip', matches[0]?.name === 'Mom');
    await waitFor('(estimate)', 30000);
    const est = await text();
    check('a time estimate is shown before anything moves', /under a minute|about \d/.test(est) && est.includes('13 files'), est.match(/.*\(estimate\).*\n.*/)?.[0]?.replace(/\n/g, ' | ') ?? '');
    check('nothing moved yet', fs.existsSync(f.family.mom2.dir) && !fs.existsSync(dest));
    await shot('02-matches');

    await click('Combine…');
    await waitFor('Move 3 people into');
    await shot('03-confirm');
    await click('Combine');
    await waitFor('People combined', 120000);
    await shot('04-done');
    const momDir = path.join(dest, 'Mom');
    const momFiles = fs.existsSync(momDir) ? fs.readdirSync(momDir).filter(x => x.endsWith('.jpg')) : [];
    check('Mom\'s photos from both folders are in one folder', momFiles.length === 8, momFiles.join(', '));
    const dirs = fs.readdirSync(dest).filter(x => x !== '.clearup').sort();
    check('the others are numbered again in the destination', JSON.stringify(dirs) === JSON.stringify(['Mom', 'Person 1', 'Person 2']), dirs.join(', '));
    check('the emptied person folders are gone', !fs.existsSync(f.trip.mom.dir) && !fs.existsSync(f.family.mom2.dir));
    // Automatic names are numbered in folder order (Family's Asha first), so Ravi is found by his photos.
    const raviName = dirs.find(d => fs.readdirSync(path.join(dest, d)).some(x => x.startsWith('ravi-'))) ?? 'Person 2';
    const ravi = fs.readdirSync(path.join(dest, raviName));
    check('Ravi keeps his photos', ravi.filter(x => x.endsWith('.jpg')).length === 3, `${raviName}: ${ravi.join(', ')}`);

    // Explorer: the group photo kept in Mom's folder is shown in Ravi's folder through a shortcut that points at the new place.
    const { shell } = await import('electron');
    const lnks = ravi.filter(x => x.endsWith('.lnk')).map(x => shell.readShortcutLink(path.join(dest, raviName, x)));
    check('group photo shortcut points at the new place', lnks.length === 1 && lnks[0].target.toLowerCase() === path.join(momDir, 'group.jpg').toLowerCase(), lnks.map(l => l.target).join(', '));
    const names = await js(`window.clearup.tags.peopleIn(${JSON.stringify(path.join(momDir, 'mom2-0.jpg'))})`).catch(() => null);
    if (names) check('the name inside Family\'s photos of Mom changed to Mom', names.includes('Mom') && !names.includes('Person 2'), names.join(', '));

    // The destination opens in Photos like any sorted folder.
    await click('Open in Photos');
    await waitFor('People (3)', 20000);
    const cards = await js(`[...document.querySelectorAll('[data-photos-person]')].map(c => c.dataset.photosPerson + ': ' + c.innerText.match(/(\\d+) photo/)?.[1])`);
    check('Photos shows the combined folder: Mom with 8 photos', cards.includes('Mom: 8'), cards.join(', '));
    await shot('05-photos');

    // ---- v2.8.1: Move to a new folder, rename a person, rename and move folders in the Library ----
    const pick = async p => { await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path.toLowerCase() === ${JSON.stringify(p.toLowerCase())}).click()`); await sleep(300); };
    const dialogClick = async label => {
      const ok = await js(`(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
      if (!ok) throw new Error(`No enabled dialog button "${label}"`);
      await sleep(400);
    };
    await js(`document.querySelector('[data-photos-person="Mom"]').click()`);
    await waitFor('Rename person');
    await sleep(800);
    const one = path.join(momDir, 'mom-0.jpg');
    await pick(one);
    await click('Move to…');
    await waitFor('Move 1 item to…');
    const rows = await js(`[...document.querySelectorAll('[data-move-folder]')].map(r => r.innerText.replace(/\\n/g, ' '))`);
    check('Move to: the chooser lists the folders and marks where the photo is now', rows.some(r => r.startsWith('Mom') && r.includes('(here)')) && rows.length === 3, rows.join(' | '));
    const hereDisabled = await js(`[...document.querySelectorAll('[data-move-folder]')].find(r => r.dataset.moveFolder === 'Mom').querySelector('button:last-child').disabled`);
    check('Move to: moving into its own folder is not offered', hereDisabled === true);
    await js(`(() => { const i = document.querySelector('[aria-label="New folder name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Mom best'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    await shot('07-move-to');
    await dialogClick('New folder and move');
    await waitFor('Moved 1 item');
    check('Move to a new folder: the photo moved', fs.existsSync(path.join(dest, 'Mom best', 'mom-0.jpg')) && !fs.existsSync(one));

    await click('Rename person');
    await js(`(() => { const i = document.querySelector('[role=dialog] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Amma'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await dialogClick('Rename');
    await sleep(1500);
    const head = await text();
    check('Rename person: folder renamed, the person view follows', fs.existsSync(path.join(dest, 'Amma')) && !fs.existsSync(momDir) && head.includes('folder “Amma”'), head.match(/\d+ photos · folder “[^”]+”/)?.[0] ?? '');
    await shot('08-renamed-person');

    // Library: a folder renamed (button) and moved (Move to… → "Move here").
    await js(`window.__clearupLibrary(${JSON.stringify(dest)})`);
    await waitFor('Mom best', 20000);
    await sleep(1000);
    const raviDir = path.join(dest, raviName);
    await pick(raviDir);
    await click('Rename');
    await js(`(() => { const i = document.querySelector('[role=dialog] input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'Ravi'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await dialogClick('Rename');
    await sleep(800);
    check('Library: a folder can be renamed', fs.existsSync(path.join(dest, 'Ravi')) && !fs.existsSync(raviDir));
    await pick(path.join(dest, 'Mom best'));
    await click('Move to…');
    await waitFor('Move 1 item to…');
    await js(`[...document.querySelectorAll('[data-move-folder]')].find(r => r.dataset.moveFolder === 'Amma').querySelector('button:last-child').click()`);
    await sleep(1200);
    check('Library: a folder can be moved into another', fs.existsSync(path.join(dest, 'Amma', 'Mom best', 'mom-0.jpg')) && !fs.existsSync(path.join(dest, 'Mom best')));
    await shot('09-library');

    // ---- v2.9: Merge into… (by face: each photo to its person; or everything into one person) ----
    const split = await makeSplit(dbFile);
    await js(`window.__clearupPage('photos')`);
    await sleep(500);
    for (let i = 0; i < 20 && !(await js(`!!document.querySelector('[data-known]')`)); i++) { await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.includes('All folders'))?.click()`); await sleep(300); }
    await js(`[...document.querySelectorAll('[data-known]')].find(b => b.dataset.known === ${JSON.stringify(split.root)}).click()`);
    await waitFor('People (4)', 20000);
    // Person 10 is Ravi: "Merge all into one person", picked by hand (like paste).
    await js(`document.querySelector('[data-photos-person="Person 10"]').click()`);
    await waitFor('Merge into…');
    await sleep(500);
    await click('Merge into…');
    for (let i = 0; i < 100 && !(await js(`!!document.querySelector('[data-merge-person]')`)); i++) await sleep(300);
    await js(`(() => { const i = document.querySelector('[aria-label="Find a person"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'rav'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(300);
    const shown = await js(`[...document.querySelectorAll('[data-merge-person]')].map(r => r.dataset.mergePerson)`);
    check('Merge: the person list can be searched', JSON.stringify(shown) === JSON.stringify(['Ravi']), shown.join(', '));
    await js(`document.querySelector('[data-merge-person="Ravi"] button').click()`);
    await waitFor('Merged 2 photos of Person 10 into Ravi', 30000);
    check('Merge all into one person: moved, person gone', fs.readdirSync(split.Ravi.dir).filter(x => x.endsWith('.jpg')).length === 5 && !fs.existsSync(split['Person 10'].dir));
    await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.trim() === 'People')?.click()`);
    await sleep(500);

    // Person 9 is two people: by face, each photo to its person.
    await js(`document.querySelector('[data-photos-person="Person 9"]').click()`);
    await waitFor('Merge into…');
    await sleep(500);
    await click('Merge into…');
    for (let i = 0; i < 100 && !(await js(`!!document.querySelector('[data-merge-target]')`)); i++) await sleep(300);
    const targets = await js(`[...document.querySelectorAll('[data-merge-target]')].map(t => t.dataset.mergeTarget + ': ' + t.innerText.match(/(\\d+) photo/)?.[1])`);
    check('Merge: Person 9\'s photos are matched to Mom (2) and Ravi (1)', targets.includes('Mom: 2') && targets.includes('Ravi: 1') && targets.length === 2, targets.join(', '));
    await shot('10-merge');
    await dialogClick('Merge 3 photos into 2 people');
    await waitFor('Merged 3 photos of Person 9', 30000);
    const momFilesNow = fs.readdirSync(split.Mom.dir).filter(x => x.endsWith('.jpg'));
    check('Merge: one click sends each photo to its person', momFilesNow.length === 6 && fs.readdirSync(split.Ravi.dir).filter(x => x.endsWith('.jpg')).length === 6, `Mom ${momFilesNow.length}, Ravi ${fs.readdirSync(split.Ravi.dir).length}`);
    check('Merge: the emptied person is gone (folder and card)', !fs.existsSync(split['Person 9'].dir) && (await text()).includes('People (2)'));
    const names9 = await js(`window.clearup.tags.peopleIn(${JSON.stringify(path.join(split.Mom.dir, path.basename(split['Person 9'].files[0])))})`).catch(() => null);
    if (names9) check('Merge: the name inside the photo follows', names9.includes('Mom') && !names9.includes('Person 9'), names9.join(', '));
    await shot('11-merged');

    // ---- Sort → Estimate time ----
    const scanDir = path.join(BASE, 'To scan');
    for (let i = 0; i < 30; i++) await photo(path.join(scanDir, `p${i}.jpg`), 200 + i);
    await js(`window.__clearupSort(${JSON.stringify(scanDir)})`);
    await waitFor('Estimate time');
    await sleep(800);
    await click('Estimate time');
    await waitFor('Scan time:', 120000);
    const card = await js(`document.querySelector('[data-scan-estimate]')?.innerText ?? ''`);
    check('scan estimate: photos counted and timed on this computer', card.includes('30 photos') && /measured on \d+ of your photos/.test(card) && /Scan time: (under a minute|about)/.test(card), card.replace(/\n/g, ' | '));
    const db = new DatabaseSync(dbFile);
    const scanned = db.prepare("SELECT COUNT(*) AS n FROM images i JOIN folders f ON f.id = i.folder_id WHERE f.path = ?").get(scanDir).n;
    db.close();
    check('estimating saves nothing (no photos scanned)', scanned === 0, String(scanned));
    await shot('06-estimate');
  } catch (e) {
    check('run', false, String(e?.stack ?? e));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}
