// End-to-end check of Phase 5 in the built app: Home theme switch, duplicates & blurry, sort by date / place, undo.
// Run: npm run e2e:tidy. Screenshots + results.json land in e2e-output/tidy/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const OUT = process.env.CLEARUP_E2E_DIR;
const SRC = path.resolve('phase0/testphotos');
const ROOT = path.join(OUT, 'Pics');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gps = (lat, lon) => {
  const dms = v => { const a = Math.abs(v), d = Math.floor(a), m = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - m) * 6000); return `${d}/1 ${m}/1 ${s}/100`; };
  return { GPSLatitudeRef: lat >= 0 ? 'N' : 'S', GPSLatitude: dms(lat), GPSLongitudeRef: lon >= 0 ? 'E' : 'W', GPSLongitude: dms(lon) };
};

async function makeFixtures() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const pick = re => fs.readdirSync(SRC).find(f => re.test(f));
  const merkel = pick(/^Angela Merkel 2019/), macron = pick(/^Emmanuel Macron August/), ardern = pick(/^Rt Hon Jacinda/);
  const modi = pick(/^PM Modi/), obama = pick(/^Obama Portrait/);
  fs.copyFileSync(path.join(SRC, merkel), path.join(ROOT, 'merkel.jpg'));
  fs.copyFileSync(path.join(SRC, merkel), path.join(ROOT, 'merkel (copy).jpg'));                       // identical file
  await sharp(path.join(SRC, macron)).jpeg({ quality: 90 }).toFile(path.join(ROOT, 'macron.jpg'));
  await sharp(path.join(SRC, macron)).resize(320).jpeg({ quality: 55 }).toFile(path.join(ROOT, 'macron small.jpg')); // resized copy
  await sharp(path.join(SRC, ardern)).blur(6).jpeg().toFile(path.join(ROOT, 'shaky.jpg'));                // blurry, no sharp twin
  await sharp(path.join(SRC, modi)).withExif({ IFD2: { DateTimeOriginal: '2023:12:25 09:15:00' }, IFD3: gps(12.972, 77.594) }).jpeg().toFile(path.join(ROOT, 'trip1.jpg'));
  await sharp(path.join(SRC, obama)).withExif({ IFD2: { DateTimeOriginal: '2021:06:03 18:00:00' }, IFD3: gps(48.858, 2.294) }).jpeg().toFile(path.join(ROOT, 'trip2.jpg'));
}

function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.clearup') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = 'dir'; walk(p); }
    else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } };
  walk(dir);
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
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button, main label, [role=dialog] button')].find(b => b.offsetParent && ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
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
  const bg = () => js(`getComputedStyle(document.body).backgroundColor`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await makeFixtures();
    const before = snapshot(ROOT);
    await waitFor('What would you like to do?');

    // ---- Home theme switch (☀️ Light / 🌙 Dark) ----
    await click('🌙Dark', false).catch(() => click('Dark', false));
    await sleep(600);
    const darkBg = await bg();
    check('theme switch: Dark', (await js('window.clearup.getSettings()')).theme === 'dark' && darkBg === 'rgb(15, 17, 21)', darkBg);
    await shot('01-home-dark');
    await click('☀️Light', false).catch(() => click('Light', false));
    await sleep(600);
    const lightBg = await bg();
    check('theme switch: Light', (await js('window.clearup.getSettings()')).theme === 'light' && lightBg === 'rgb(246, 247, 249)', lightBg);
    await shot('02-home-light');

    // ---- duplicates & blurry ----
    await js(`window.__clearupTidy(${JSON.stringify(ROOT)}, 'dupes')`);
    await waitFor(ROOT);                       // folder loaded → "Scan folder" is enabled
    await click('Scan folder');
    await waitFor('Duplicates (', 120000);
    await sleep(500);
    const t1 = await text();
    check('found 2 duplicate groups', t1.includes('Duplicates (2 groups)'));
    check('identical + resized copies recognised', t1.includes('Identical files') && t1.includes('Same picture'));
    check('blurry photo found', /Blurry photos \(\d+\)/.test(t1) && t1.includes('shaky.jpg'));
    check('keepers suggested, extras pre-selected', t1.includes('Suggested keep') && t1.includes('2 selected'));
    await shot('03-duplicates');

    await click('Move to “PixHaven - Duplicates”…', false);
    await waitFor('Preview: nothing has moved yet');
    check('nothing moved during preview', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));
    await click('Apply');
    await waitFor('Photos moved to', 60000);
    const set = fs.readdirSync(path.join(ROOT, 'PixHaven - Duplicates')).sort();
    check('extra copies set aside', set.length === 2 && set.includes('macron small.jpg') && set.some(f => f.startsWith('merkel')), set.join(', '));
    await shot('04-dupes-moved');
    await click('Undo');
    await waitFor('Undo finished', 60000);
    check('undo restores duplicates exactly', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));

    // ---- sort by date ----
    await click('Done');
    await click('By date or place');
    await click('Scan folder');
    await waitFor('photos checked', 120000);
    await click('Date taken');
    await waitFor('Photos without a camera date');
    await click('Treat as unknown');
    await click('Preview');
    await waitFor('Preview: nothing has moved yet');
    const t2 = await text();
    check('date folders planned', t2.includes(path.join('2023', '2023-12 December')) && t2.includes(path.join('2021', '2021-06 June')));
    await shot('05-date-preview');
    await click('Apply');
    await waitFor('Photos sorted into folders', 60000);
    check('photos moved into date folders',
      fs.existsSync(path.join(ROOT, '2023', '2023-12 December', 'trip1.jpg')) && fs.existsSync(path.join(ROOT, '2021', '2021-06 June', 'trip2.jpg')));
    await click('Undo');
    await waitFor('Undo finished', 60000);
    check('undo removes date folders too', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));

    // ---- sort by place ----
    await click('Done');
    await click('Scan folder');
    await waitFor('photos checked', 120000);
    await click('Place');
    await waitFor('have a location');
    await click('Preview');
    await waitFor('Preview: nothing has moved yet');
    const t3 = await text();
    check('place folders from GPS (offline)', t3.includes(path.join('India', 'Bengaluru')) && t3.includes(path.join('France', 'Paris')), '');
    await shot('06-place-preview');
    await click('Apply');
    await waitFor('Photos sorted into folders', 60000);
    check('photos moved into place folders', fs.existsSync(path.join(ROOT, 'India', 'Bengaluru', 'trip1.jpg')) && fs.existsSync(path.join(ROOT, 'France', 'Paris', 'trip2.jpg')));
    await click('Undo');
    await waitFor('Undo finished', 60000);
    check('undo restores the folder exactly', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));
    await js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ theme: 'system', tidy: { ...s.tidy, by: 'date', useFileDate: true } }); })()`);
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
