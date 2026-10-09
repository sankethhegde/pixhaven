// End-to-end check of the built app. Run: npm run e2e (builds, then launches Electron with this script).
// Drives the real UI, runs the real engine, writes screenshots + results to CLEARUP_E2E_DIR.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const OUT = process.env.CLEARUP_E2E_DIR;
const FIX = path.join(OUT, 'fixtures');
const BATCH = path.join(FIX, 'batch');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bmp24(w, h, color) {
  const row = Math.floor((24 * w + 31) / 32) * 4;
  const b = Buffer.alloc(54 + row * h);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = 54 + y * row + x * 3, t = (x + y) % 32 < 16;
    b[o] = t ? color[2] : 30; b[o + 1] = t ? color[1] : 30; b[o + 2] = t ? color[0] : 30;
  }
  return b;
}

async function makeFixtures() {
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(BATCH, { recursive: true });
  const photo = path.resolve('phase0/out/lowq.jpg'); // 480×720 low-quality JPEG from Phase 0
  // Single: stored sideways with EXIF orientation 6 + camera tags → must come out upright with EXIF kept.
  await sharp(photo).rotate(-90).withMetadata({ orientation: 6 }).withExif({ IFD0: { Make: 'E2ECam', Model: 'T1' } }).jpeg({ quality: 60 }).toFile(path.join(FIX, 'rotated.jpg'));
  await sharp(photo).resize(240).jpeg({ quality: 50 }).toFile(path.join(BATCH, 'a-photo.jpg'));
  const circle = Buffer.from('<svg width="200" height="150"><circle cx="100" cy="75" r="60" fill="#e33"/></svg>');
  await sharp(circle).png().toFile(path.join(BATCH, 'b-transparent.png'));
  fs.writeFileSync(path.join(BATCH, 'c-old.bmp'), bmp24(160, 120, [40, 160, 220]));
  await sharp(photo).resize(200).tiff().toFile(path.join(BATCH, 'd-scan.tiff'));
  await sharp(photo).resize(220).webp({ quality: 40 }).toFile(path.join(BATCH, 'e-web.webp'));
  await sharp({ create: { width: 4200, height: 200, channels: 3, background: '#4a7' } }).png().toFile(path.join(BATCH, 'f-wide.png'));
  fs.writeFileSync(path.join(BATCH, 'g-broken.jpg'), Buffer.from('this is not really a jpeg'));
  await sharp(photo).resize(100).png().toFile(path.join(BATCH, 'h_upscaled.png')); // must be skipped
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(250); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label, exact = true, scope = 'main') {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('${scope} button, ${scope} label, [role=dialog] button')].find(b => ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(200);
  }
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    for (let i = 0; ; i++) {
      try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); return; }
      catch (e) { if (i > 5) throw e; await sleep(500); }
    }
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 820);
    win.setAlwaysOnTop(true);                 // an occluded window stops repainting → stale screenshots
    win.webContents.setBackgroundThrottling(false);
    await makeFixtures();
    await waitFor('What would you like to do?');
    await shot('01-home');

    // ---- single image ----
    await js(`window.__clearupOpen(${JSON.stringify([path.join(FIX, 'rotated.jpg')])})`);
    await waitFor('480 × 720 px');                      // EXIF orientation applied: upright size
    check('EXIF orientation applied on open', true);
    await click('Fast', false); await click('4×'); await click('PNG');   // options are remembered between runs
    await shot('02-single-before');
    let t = Date.now();
    await click('Upscale');
    await waitFor('Done in', 120000);
    check('Fast 4× upscale', true, `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await shot('03-single-after');
    await click('Save');
    await waitFor('Show in folder');
    const saved = path.join(FIX, 'rotated_upscaled.png');
    const m = await sharp(saved).metadata();
    check('saved next to original', fs.existsSync(saved));
    check('output is 4× and upright', m.width === 1920 && m.height === 2880, `${m.width}×${m.height}`);
    check('orientation tag reset', (m.orientation ?? 1) === 1, String(m.orientation));
    check('EXIF camera tags kept', !!m.exif && m.exif.toString('latin1').includes('E2ECam'));

    // Best-quality model at 2× (x4plus runs 4× then Lanczos down)
    await click('General photo', false);
    await click('2×');
    t = Date.now();
    await click('Upscale');
    await waitFor('Upscaling…', 10000);
    await waitFor('Not saved yet', 180000);
    check('General photo 2× upscale', (await text()).includes('960 × 1,440'), `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await click('Save');
    await waitFor('Show in folder');
    check('second save does not overwrite', fs.existsSync(path.join(FIX, 'rotated_upscaled (2).png')));

    // Cancel mid-run
    await click('4×');
    await click('Upscale');
    await waitFor('Upscaling…', 10000);
    await sleep(1500);
    await shot('04-single-running');
    await click('Cancel');
    await waitFor('Cancelled. Nothing was saved.', 20000);
    check('cancel works', true);

    // ---- batch ----
    await js(`window.__clearupOpen(${JSON.stringify([BATCH])})`);
    await waitFor('Upscale 6 images');
    const tb = await text();
    check('batch scan: 6 images, 1 skipped, 1 unreadable', tb.includes('1 skipped') && tb.includes('1 unreadable'));
    check('Fast pre-selected for batches (low-spec)', await js(`document.querySelector('input[name=model]:checked')?.parentElement.innerText.includes('Fast')`));
    await click('JPG');
    await click('2×');
    await shot('05-batch-ready');
    await click('Upscale 6 images');
    await waitFor('Large image');
    await shot('06-large-warning');
    await click('Upscale all');
    t = Date.now();
    await waitFor('Finished:', 300000);
    check('batch finished', true, `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await shot('07-batch-done');
    const outs = fs.readdirSync(BATCH).filter(f => /_upscaled\.jpg$/.test(f));
    check('6 JPG outputs written', outs.length === 6, outs.join(', '));
    const tp = await sharp(path.join(BATCH, 'b-transparent_upscaled.jpg')).metadata();
    check('transparent PNG → JPG flattened', tp.channels === 3 && tp.width === 400, `${tp.width}×${tp.height} ch=${tp.channels}`);
    const bm = await sharp(path.join(BATCH, 'c-old_upscaled.jpg')).metadata();
    check('BMP upscaled', bm.width === 320 && bm.height === 240, `${bm.width}×${bm.height}`);
    await click('a-photo.jpg', false);
    await waitFor('Show in folder');
    await shot('08-batch-viewer');
    await js(`document.querySelector('[aria-label=Close]').click()`);

    // ---- resume: running the same folder again skips finished images ----
    await click('Upscale again');
    await waitFor('Large image'); await click('Upscale all');
    await waitFor('6 already done', 30000);
    check('re-run skips images already upscaled', fs.readdirSync(BATCH).filter(f => /_upscaled (2)/.test(f)).length === 0);

    // ---- job queue: a second job waits for the first ----
    await click('PNG'); await click('General photo', false); await click('4×');   // new outputs → real work
    await click('Upscale 6 images');
    await waitFor('Large image'); await click('Upscale all');
    await sleep(500);
    await js(`window.__clearupOpen(${JSON.stringify([path.join(FIX, 'rotated.jpg')])})`);
    await waitFor('480 × 720 px');
    await click('Fast', false); await click('2×');
    await click('Upscale');
    await sleep(800);
    const waiting = (await text()).includes('Waiting for another job to finish');
    const q = await js('window.clearup.queueList()');
    check('second job waits in the queue', waiting && q.length === 2, q.map(x => `${x.state}: ${x.label}`).join(' | '));
    await shot('08b-queue');
    for (const item of [...q].reverse()) await js(`window.clearup.queueCancel(${JSON.stringify(item.id)})`);
    await waitFor('Cancelled. Nothing was saved.', 30000);
    let left = -1;
    for (let i = 0; i < 30 && left !== 0; i++) { left = (await js('window.clearup.queueList()')).length; if (left) await sleep(500); }
    check('cancelling queued and running jobs empties the queue', left === 0);

    // ---- settings + dark mode ----
    await click('Settings', true, 'nav');
    await waitFor('Low-spec mode');
    await shot('09-settings');
    const { nativeTheme } = await import('electron');
    nativeTheme.themeSource = 'light';
    await click('Home', true, 'nav');
    await shot('10-home-light');
    await click('Upscale', true, 'nav');
    await shot('11-batch-light');
    nativeTheme.themeSource = 'system';
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
