// 1.0.8 with real faces: a folder of public photos (phase0/fetch-test-photos.mjs: Wikimedia Commons portraits of a
// few public figures) is scanned with PixHaven's real Sort scanner; a short video is made from two OTHER photos of one
// of them; "People in this video" must find that person, in that folder, and nobody else. Uses the test's own app
// data only. Run: npm run e2e:facevideo (needs phase0/testphotos).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const SRC = path.resolve(process.env.CLEARUP_TESTPHOTOS ?? 'phase0/testphotos');
const SORTED = path.join(OUT, 'Sorted people');
const VIDS = path.join(OUT, 'Videos');
const WIN = process.platform === 'win32';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Single-person portraits. Macron: 4 to sort, 2 others only in the video.
const SORT = [
  'Emmanuel Macron 2023 _cropped_.jpg', 'Emmanuel Macron June 2021 _cropped_.jpg', 'Emmanuel Macron June 2022 _cropped_.jpg', 'Emmanuel Macron August 2024.jpg',
  'Angela Merkel 2019 cropped.jpg', 'Angela Merkel Juli 2010 - 3zu4.jpg', 'Angela Merkel _Tobias Koch_.jpg', 'Angela Merkel. Tallinn Digital Summit.jpg',
  'CM Narendra Damodardas Modi.jpg', 'PM Modi 2015.jpg', 'Narendra Modi - 01.jpg', 'Prime Minister Narendra Modi June 2017.jpg',
  'New Zealand Prime Minister Jacinda Ardern in 2018.jpg', 'Jacinda Ardern - Waitangi 2022 _cropped_.jpg', 'NZ PM Jacinda Ardern - Kirk HargreavesCCC.jpg',
];
const VIDEO = ['Emmanuel Macron March 2024 _4_.jpg', 'Emmanuel Macron par Claude Truong-Ngoc avril 2015.jpg'];

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(500); } return false; }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  async function shot(name) { win.webContents.invalidate(); await sleep(600); try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch { /* skipped */ } }

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 900);
    win.webContents.setBackgroundThrottling(false);
    const missing = [...SORT, ...VIDEO].filter(f => !(fs.existsSync(path.join(SRC, f)) && fs.statSync(path.join(SRC, f)).size > 20000));
    if (missing.length) throw new Error(`Test photos missing (run phase0/fetch-test-photos.mjs): ${missing.join(', ')}`);
    for (const d of [SORTED, VIDS]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(SORTED, { recursive: true }); fs.mkdirSync(VIDS, { recursive: true });
    for (const f of SORT) fs.copyFileSync(path.join(SRC, f), path.join(SORTED, f));

    // ---- the video: 3 s of each Macron photo, with 3 s of a plain card between ----
    const sharp = (await import('sharp')).default;
    const frames = path.join(OUT, 'frames');
    fs.rmSync(frames, { recursive: true, force: true }); fs.mkdirSync(frames);
    const card = (await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#335' } }).jpeg().toBuffer());
    const fit = async f => sharp(path.join(SRC, f)).rotate().resize(1280, 720, { fit: 'contain', background: '#000' }).jpeg().toBuffer();
    const seq = [await fit(VIDEO[0]), card, await fit(VIDEO[1])];
    seq.forEach((b, i) => fs.writeFileSync(path.join(frames, `f${String(i).padStart(2, '0')}.jpg`), b));
    const video = path.join(VIDS, 'speech.mp4');
    const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
    const r = spawnSync(ff, ['-v', 'error', '-framerate', '1/3', '-i', path.join(frames, 'f%02d.jpg'), '-r', '25', '-c:v', 'mpeg4', '-q:v', '3', '-pix_fmt', 'yuv420p', '-y', video]);
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);

    // ---- scan the folder with the real scanner ----
    await js(`window.clearup.sort.scan(${JSON.stringify(SORTED)})`);
    const scanned = await waitFor(async () => { const s = await js(`window.clearup.sort.status(${JSON.stringify(SORTED)})`); return s?.lastScan && s.scannedImages >= SORT.length; }, 300000);
    const st = await js(`window.clearup.sort.status(${JSON.stringify(SORTED)})`);
    check('the photos were scanned for faces (real face engine)', scanned && st.people >= 3, `${st.scannedImages} photos, ${st.people} people`);
    // A sort gives each person a folder; here the test names the folders itself: who has most of the Macron photos.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(process.env.CLEARUP_USER_DATA, 'facedata', 'faces.db'));
    db.exec('PRAGMA busy_timeout = 5000;');
    const people = db.prepare(`SELECT p.id, p.num, GROUP_CONCAT(i.path, '|') AS files FROM people p JOIN faces f ON f.person_id = p.id JOIN images i ON i.id = f.image_id
      WHERE p.folder_id = ? AND f.removed = 0 GROUP BY p.id`).all(st.folderId);
    const who = files => ['Macron', 'Merkel', 'Modi', 'Ardern'].map(n => [n, files.split('|').filter(x => x.includes(n)).length]).sort((a, b) => b[1] - a[1])[0];
    const named = [];
    for (const p of people) {
      const [n, c] = who(p.files);
      if (!c || named.some(x => x.n === n)) continue;
      const dir = path.join(SORTED, n);
      fs.mkdirSync(dir, { recursive: true });
      db.prepare('UPDATE people SET dir = ?, keep = 1 WHERE id = ?').run(dir, p.id);
      for (const f of p.files.split('|').filter(x => x.includes(n))) fs.copyFileSync(f, path.join(dir, path.basename(f)));
      named.push({ n, id: p.id, c });
    }
    db.close();
    check('each public figure became a person with a folder', ['Macron', 'Merkel', 'Modi'].every(n => named.some(x => x.n === n)), named.map(x => `${x.n} (${x.c})`).join(', '));

    // ---- people in the video ----
    const s = fs.statSync(video);
    const t0 = Date.now();
    await js(`window.clearup.videoFaces.start(${JSON.stringify(video)}, ${s.size}, ${s.mtimeMs})`);
    let v = null;
    await waitFor(async () => { v = await js(`window.clearup.videoFaces.get(${JSON.stringify(video)}, ${s.size}, ${s.mtimeMs})`); return v.state === 'done' || v.state === 'error'; }, 120000);
    const found = (v?.people ?? []).map(p => `${p.name} ${p.sure}% (${p.frames} frames at ${p.times.join(',')} s)`);
    check('the person in the video is found, by face (photos never seen by the scan)', v?.state === 'done' && v.people[0]?.name === 'Macron', `${found.join(' · ') || v?.error || 'nobody'} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    check('nobody else is "found"', v?.state === 'done' && v.people.every(p => p.name === 'Macron'), found.join(' · '));
    const mac = v?.people?.find(p => p.name === 'Macron');
    check('with the folder the photos come from, and some of the photos', !!mac && mac.folder === path.join(SORTED, 'Macron') && mac.photos.length >= 3 && mac.photos.every(p => p.path.startsWith(path.join(SORTED, 'Macron'))),
      mac ? `${mac.folder} · ${mac.photos.length} photos` : '');
    check('seen where the photos are in the video (0–3 s and 6–9 s), not on the plain card', !!mac && mac.times.every(t => t < 3 || (t >= 6 && t < 9)) && mac.times.some(t => t < 3) && mac.times.some(t => t >= 6), mac ? mac.times.join(', ') : '');

    // ---- the same on the watch page, in Theatre ----
    for (const w of await js('window.clearup.watch.list()')) await js(`window.clearup.watch.remove(${JSON.stringify(w.path)})`);
    await js(`window.clearup.watch.add(${JSON.stringify(VIDS)})`);
    await js(`localStorage.setItem('watch.theatre', '1')`);
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Videos')?.click()`);
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid=videos-page] [role=option]').length`)) === 1, 20000);
    await js(`document.querySelector('[data-testid=videos-page] [role=option]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(async () => (await js(`document.querySelector('[data-testid=video-people]')?.dataset.state`)) === 'done', 20000);
    await js(`document.querySelector('[data-testid=video-people]')?.scrollIntoView({ block: 'center' })`);
    await sleep(800);
    const card2 = await js(`document.querySelector('[data-video-person="Macron"]')?.innerText ?? ''`);
    const imgs = await js(`[...document.querySelectorAll('[data-video-person="Macron"] img')].filter(i => i.complete && i.naturalWidth).length`);
    check('Theatre shows the person, how sure, when, their photos and the folder', /Macron/.test(card2) && /% sure/.test(card2) && /From .*Sorted people/.test(card2) && imgs >= 3, `${card2.replace(/\n/g, ' | ').slice(0, 220)} · ${imgs} pictures`);
    await shot('01-people-in-video');
    await js(`localStorage.setItem('watch.theatre', '0')`);
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
