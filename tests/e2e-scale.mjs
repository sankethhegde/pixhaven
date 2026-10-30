// Opening a very big sorted folder in the Photos tab must not freeze PixHaven ("Not Responding"). Like the user's
// combined folder: 2,500 person folders, 70,000 photos, 6,000 group photo shortcuts. The face data is written straight
// into the test's own database. Measures how long the main process and the window were blocked while opening it:
// first open (shortcuts made), again (nothing changed), and after folders were renamed and photos moved in Explorer.
// Run: npm run e2e:scale (SCALE_PEOPLE / SCALE_PHOTOS to change the size). Results in e2e-output/scale/.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';

const OUT = process.env.CLEARUP_E2E_DIR;
const PEOPLE = Number(process.env.SCALE_PEOPLE ?? 2500), PHOTOS = Number(process.env.SCALE_PHOTOS ?? 70000), GROUP = Math.round(PHOTOS / 12);
const ROOT = path.join(OUT, 'Scale', 'All people');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FACE_MODEL = 5, D = 512;

let seed = 5;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const unit = v => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return v.map(x => x / s); };

async function makeFixture(dbFile) {
  fs.rmSync(path.dirname(ROOT), { recursive: true, force: true });
  const jpg = await sharp({ create: { width: 48, height: 36, channels: 3, background: '#7a8' } }).jpeg().toBuffer();
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('BEGIN');
  const fid = Number(db.prepare('INSERT INTO folders (path, created, last_scan) VALUES (?, ?, ?)').run(ROOT, Date.now(), Date.now()).lastInsertRowid);
  db.prepare("INSERT INTO sorts (folder_id, created, state, kind, summary) VALUES (?, ?, 'done', 'people', '{}')").run(fid, Date.now());
  const addP = db.prepare('INSERT INTO people (folder_id, num, keep, dir) VALUES (?, ?, 1, ?)');
  const addD = db.prepare('INSERT INTO sort_dirs (folder_id, dir) VALUES (?, ?)');
  const addI = db.prepare("INSERT INTO images (folder_id, path, size, mtime, status, faces) VALUES (?, ?, ?, ?, 'done', 1)");
  const addF = db.prepare('INSERT INTO faces (image_id, x, y, w, h, score, sharpness, usable, emb, model, quality, person_id) VALUES (?, 0, 0, 40, 40, 0.9, 50, 1, ?, ?, 0.9, ?)');
  const people = [];
  for (let p = 0; p < PEOPLE; p++) {
    const dir = path.join(ROOT, `Person ${p + 1}`);
    fs.mkdirSync(dir, { recursive: true });
    people.push({ pid: Number(addP.run(fid, p + 1, dir).lastInsertRowid), dir, id: unit(Float32Array.from({ length: D }, gauss)), files: [] });
    addD.run(fid, dir);
  }
  for (let i = 0; i < PHOTOS; i++) {
    const p = people[i % PEOPLE];
    const file = path.join(p.dir, `IMG_${String(i).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, jpg);
    const img = Number(addI.run(fid, file, jpg.length, Math.round(fs.statSync(file).mtimeMs)).lastInsertRowid);
    const e = unit(Float32Array.from(p.id, x => x + gauss() * 0.035));
    addF.run(img, new Uint8Array(e.buffer), FACE_MODEL, p.pid);
    p.files.push(file);
  }
  db.exec('COMMIT');
  db.close();
  // Group photos kept in one person's folder and shown in another's.
  const folders = {};
  for (let g = 0; g < GROUP; g++) {
    const a = people[Math.floor(rnd() * PEOPLE)], b = people[Math.floor(rnd() * PEOPLE)];
    if (a === b) continue;
    const f = a.files[Math.floor(rnd() * a.files.length)];
    (folders[path.basename(b.dir)] ??= []).push({ file: `${path.basename(a.dir)}/${path.basename(f)}`, sort: 1 });
  }
  fs.mkdirSync(path.join(ROOT, '.clearup'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.clearup', 'people.json'), JSON.stringify({ app: 'PixHaven', version: 1, folders }));
  return people;
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 600000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text().catch(() => '')).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(700);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  // How long the main process could not answer: a 50 ms timer that runs late by that much.
  let worstMain = 0, lastTick = Date.now();
  setInterval(() => { const now = Date.now(); worstMain = Math.max(worstMain, now - lastTick - 50); lastTick = now; }, 50);
  const watchWindow = () => js(`(() => { window.__gap = 0; let last = performance.now(); const f = t => { window.__gap = Math.max(window.__gap, t - last); last = t; window.__raf = requestAnimationFrame(f); }; cancelAnimationFrame(window.__raf); window.__raf = requestAnimationFrame(f); })()`);
  /** Open the folder in Photos and measure: seconds until its people show, worst main-process and window freezes. */
  async function open(label) {
    await js(`window.__clearupPage('home')`);
    await sleep(500);
    await js(`window.__clearupPage('photos')`);
    // Back on the folder list (the tab remembers the open folder), so the people shown are from this open.
    for (let i = 0; i < 100 && !(await js(`!!document.querySelector('[data-known]')`)); i++) {
      await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.includes('All folders'))?.click()`);
      await sleep(300);
    }
    await sleep(500);
    await watchWindow();
    worstMain = 0; lastTick = Date.now();
    const t = Date.now();
    await js(`[...document.querySelectorAll('[data-known]')].find(b => b.dataset.known === ${JSON.stringify(ROOT)}).click()`);
    const end = Date.now() + 600000;
    while (Date.now() < end && !(await js(`!!document.querySelector('[data-photos-person]') && !document.querySelector('[data-known]')`))) await sleep(100);
    const secs = (Date.now() - t) / 1000;
    await sleep(1500);
    const windowGap = await js('window.__gap');
    const r = { secs, main: worstMain, window: Math.round(windowGap) };
    Object.defineProperty(r, 'seen', { value: { labels: await js(`[...document.querySelectorAll('[data-photos-person]')].map(c => c.dataset.photosPerson)`), text: await text() } });
    console.log(label, JSON.stringify(r));
    await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.includes('All folders'))?.click()`);
    await sleep(500);
    return r;
  }

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 900);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await waitFor('What would you like to do?', 60000);
    await js('window.clearup.sort.deleteData()');
    await js('window.clearup.photos.folders()');
    const dbFile = path.join(app.getPath('userData'), 'facedata', 'faces.db');
    let t = Date.now();
    const people = await makeFixture(dbFile);
    console.log(`fixture: ${PEOPLE} people, ${PHOTOS} photos, ${GROUP} group photos in ${((Date.now() - t) / 1000).toFixed(0)} s`);

    const first = await open('first open');
    await shot('01-people');
    // The shortcuts are made in the background (each takes Windows ~25 ms): wait for them, then measure opening again.
    const countLinks = () => fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .reduce((n, d) => n + fs.readdirSync(path.join(ROOT, d.name)).filter(f => f.endsWith('.lnk')).length, 0);
    const expected = Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, '.clearup', 'people.json'), 'utf8')).folders).reduce((n, l) => n + l.length, 0);
    t = Date.now();
    let lnks = 0;
    while (Date.now() - t < 600000 && (lnks = countLinks()) < expected * 0.95) await sleep(5000);
    await sleep(3000);
    check('group photo shortcuts made in the background', lnks >= expected * 0.95, `${lnks} of ${expected} in ${((Date.now() - t) / 1000).toFixed(0)} s after the folder opened`);
    const again = await open('open again');
    // Explorer: two person folders renamed, and 3,600 photos moved from one person's folder into another's.
    fs.renameSync(people[0].dir, path.join(ROOT, 'Renamed A'));
    fs.renameSync(people[1].dir, path.join(ROOT, 'Renamed B'));
    let moved = 0;
    for (let k = 2; k < PEOPLE && moved < 3600; k += 2) {
      for (const f of people[k].files) { fs.renameSync(f, path.join(people[k + 1].dir, `m_${path.basename(f)}`)); moved++; }
    }
    const changed = await open('after Explorer changes');
    const { labels, text: seen } = changed.seen;
    check('after Explorer changes: renamed folders recognised', labels.includes('Renamed A') && labels.includes('Renamed B') && seen.includes('Renamed person folders were recognised'), `${labels.length} people`);

    for (const [name, r] of [['first open', first], ['open again', again], ['after renames and moves', changed]]) {
      check(`${name}: PixHaven stays responsive (main process never blocked over 1 s)`, r.main < 1000, `main ${r.main} ms, window ${r.window} ms, people shown after ${r.secs.toFixed(1)} s`);
      check(`${name}: the window keeps drawing (no frame gap over 1 s)`, r.window < 1000, `${r.window} ms`);
    }
    check('open again: people shown within 5 s', again.secs < 5, `${again.secs.toFixed(1)} s`);
    await shot('02-after-changes');
  } catch (e) {
    check('run', false, String(e?.stack ?? e));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}
