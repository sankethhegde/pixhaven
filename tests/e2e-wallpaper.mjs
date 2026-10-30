// End-to-end check of v2.10 Wallpaper recommended in the built app. Photos are made for this computer's own screen:
// one exactly its size (sharp), one bigger, one half its size (upscale 2×), one blurry, one square, one tiny — then
// the tab is checked, a wallpaper "set" (PIXHAVEN_WALL_FAKE: the real desktop is never changed) and Upscale opened.
// Run: npm run e2e:wallpaper. Screenshots + results.json land in e2e-output/wallpaper/.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
sharp.cache(false);

const OUT = process.env.CLEARUP_E2E_DIR;
const ROOT = path.join(OUT, 'Wallpapers');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function picture(file, w, h, sharpOne) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!sharpOne) { await sharp({ create: { width: w, height: h, channels: 3, background: '#6a8caf' } }).jpeg().toFile(file); return; }
  // Fine detail everywhere (high sharpness score): a noisy pattern.
  const raw = Buffer.alloc(w * h * 3);
  let s = w * 7 + h;
  for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; raw[i] = (s >> 16) & 255; }
  await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toFile(file);
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button, [role=radio]')].find(b => b.offsetParent && b.innerText.trim().startsWith(${JSON.stringify(label)}));
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(400);
  }
  const shown = () => js(`[...document.querySelectorAll('[data-path]')].map(b => b.dataset.path.split(/[\\\\/]/).pop())`);
  async function shot(name) { win.webContents.invalidate(); await sleep(700); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await waitFor('What would you like to do?');
    const [scr] = await js('window.clearup.wall.screens()');
    const W = scr.width, H = scr.height;
    console.log('screen', JSON.stringify(scr));
    fs.rmSync(ROOT, { recursive: true, force: true });
    await picture(path.join(ROOT, 'exact.jpg'), W, H, true);
    await picture(path.join(ROOT, 'Trips', 'bigger.jpg'), Math.round(W * 1.25), Math.round(H * 1.25), true);
    await picture(path.join(ROOT, 'half.jpg'), Math.round(W / 2), Math.round(H / 2), true);
    await picture(path.join(ROOT, 'blurry.jpg'), W, H, false);
    await picture(path.join(ROOT, 'square.jpg'), Math.max(W, H), Math.max(W, H), true);
    await picture(path.join(ROOT, 'tiny.jpg'), Math.round(W / 8), Math.round(H / 8), true);

    // The folder is checked by the tab (the folder picker is skipped: the scan is started the way the tab starts it).
    await js(`localStorage.setItem('wall.source', ${JSON.stringify(ROOT)})`);
    await js(`window.__clearupPage('wallpaper')`);
    await waitFor('photos checked', 120000);
    await sleep(800);
    check('the screen size is shown', (await text()).includes(`${W} × ${H}`), `${W} × ${H}`);
    let names = await shown();
    check('Ready: the screen-sized and bigger photos, nothing else', JSON.stringify([...names].sort()) === JSON.stringify(['bigger.jpg', 'exact.jpg']), names.join(', '));
    const summary = await js(`document.querySelector('[data-testid=wall-summary]').innerText`);
    check('all photos checked, the blurry one left out', summary.includes('6 photos checked') && summary.includes('1 blurry'), summary);
    await shot('01-ready');

    await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path.endsWith('exact.jpg')).click()`);
    await sleep(300);
    await click('Set as wallpaper');
    await waitFor('is now your wallpaper');
    const set = fs.existsSync(process.env.PIXHAVEN_WALL_FAKE) ? fs.readFileSync(process.env.PIXHAVEN_WALL_FAKE, 'utf8') : '';
    check('Set as wallpaper uses the chosen photo', set.toLowerCase() === path.join(ROOT, 'exact.jpg').toLowerCase(), set);

    await click('Upscale first');
    await sleep(500);
    names = await shown();
    check('Upscale first: the half-size photo', JSON.stringify(names) === JSON.stringify(['half.jpg']), names.join(', '));
    await js(`document.querySelector('[data-path]').click()`);
    await sleep(300);
    const info = await text();
    check('it says how much upscaling it needs', info.includes('needs 2×'));
    await shot('02-upscale');
    await click('Upscale 1');
    await sleep(1500);
    check('Upscale opens with the photo', (await text()).includes('half.jpg'));

    // Checking again is quick (measured once), and a hidden photo is left out.
    await js(`window.clearup.privacy.setPassword(null, 'pw1234')`);
    await js(`window.clearup.privacy.hide([{ path: ${JSON.stringify(path.join(ROOT, 'Trips'))}, folder: true }], true)`);
    const t = Date.now();
    const again = await js(`window.clearup.wall.scan(${JSON.stringify(ROOT)}, null)`);
    check('checking again is quick and leaves hidden photos out', again.ready.map(x => x.name).join() === 'exact.jpg' && Date.now() - t < 3000, `${Date.now() - t} ms: ${again.ready.map(x => x.name).join(', ')}`);
  } catch (e) {
    check('run', false, String(e?.stack ?? e));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}
