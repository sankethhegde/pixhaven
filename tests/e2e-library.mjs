// End-to-end check of v2.0 Phase A in the built app: drives, browsing (media only), thumbnails for every format,
// list view, search, viewer, send to Upscale, no-permission folder, a drive appearing, and a 5,000-file folder.
// Run: npm run e2e:library. Screenshots + results.json land in e2e-output/library/.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeMediaFolder } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const ROOT = path.join(OUT, 'Media');
const BIG = path.join(OUT, 'Big folder');
const PRIVATE = path.join(OUT, 'Private');
const WIN = process.platform === 'win32';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return; await sleep(200); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 80) : `"${t}"`}`);
  }
  async function click(label, exact = true) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('button, [role=radio]')].find(b => b.offsetParent && ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(250);
  }
  const radio = async label => { if (!await js(`(() => { const b = [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`)) throw new Error(`No option ${label}`); await sleep(300); };
  const clickSel = async sel => { if (!await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`)) throw new Error(`No ${sel}`); await sleep(250); };
  // The grid only draws what is on screen: scroll until the tile exists, then double-click it.
  const dbl = async name => {
    const ok = await js(`(async () => { const box = document.querySelector('[role=listbox]');
      const find = () => [...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith(${JSON.stringify(path.sep + name)}));
      for (let y = 0; !find() && y <= box.scrollHeight; y += 250) { box.scrollTop = y; await new Promise(r => setTimeout(r, 60)); }
      const t = find(); if (!t) return false; t.scrollIntoView({ block: 'center' }); t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error(`No tile ${name}`);
    await sleep(300);
  };
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const counts = () => js(`document.querySelector('[data-testid=lib-counts]')?.innerText ?? ''`);
  const setLib = patch => js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, ...${JSON.stringify(patch)} } }); })()`);
  let substDrive = null;

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    const mediaFiles = await makeMediaFolder(ROOT);
    await setLib({ view: 'grid', size: 's', type: 'all', sortBy: 'name', sortDesc: false, showSystem: false, lastDir: null });
    await js(`window.clearup.lib.clearCache()`);
    await waitFor('What would you like to do?');

    // ---- Home → Library, drives (LIB-01) ----
    await click('Browse my media', false);
    await waitFor(async () => /quick access/i.test(await text()));
    await waitFor(WIN ? '(C:)' : 'Computer (/)', 15000);
    check('drives listed', (await text()).includes(WIN ? '(C:)' : 'Computer (/)'));

    // ---- the mixed-format folder (LIB-02/03/04/06) ----
    await js(`window.__clearupLibrary(${JSON.stringify(ROOT)})`);
    await waitFor(async () => /17 videos/.test(await counts()));
    await waitFor(async () => (await counts()).startsWith('1 folder'), 10000).catch(() => {});
    const c1 = await counts();
    check('only photos and videos shown, other files hidden', c1.includes('17 photos') && c1.includes('17 videos') && c1.includes('2 other files hidden'), c1);
    const names = await js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path.split(/[\\\\/]/).pop())`);
    check('system folders and folders without media hidden', names.includes('Goa trip') && !names.includes('Documents only') && !names.includes('AppData') && !names.includes('.cache'), names.filter(n => !n.includes('.')).join(', '));

    // ---- every file gets a thumbnail (Phase A done-when) ----
    const refs = mediaFiles.map(f => { const p = path.join(ROOT, f); const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; });
    let ready = [];
    const t0 = Date.now();
    await waitFor(async () => { ready = await js(`window.clearup.lib.thumbs(${JSON.stringify(refs)})`); return ready.length === refs.length; }, 120000).catch(() => {});
    const missing = mediaFiles.filter(f => !ready.some(r => r.path.endsWith(path.sep + f) && r.thumb && !r.error));
    check(`every format has a thumbnail (${mediaFiles.length} files)`, missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await sleep(800);
    const shown = await js(`(() => { const imgs = [...document.querySelectorAll('[role=option] img')]; return { n: imgs.length, ok: imgs.filter(i => i.complete && i.naturalWidth > 0).length }; })()`);
    check('thumbnails drawn on screen', shown.n > 10 && shown.ok === shown.n, `${shown.ok}/${shown.n}`);
    await shot('01-grid');

    // ---- list view (LIB-05): name, size, date, length, resolution ----
    await radio('List');
    await sleep(800);
    const row = await js(`[...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith('clip hevc.mkv'))?.innerText ?? ''`);
    check('list view shows length and resolution', row.includes('0:04') && row.includes('640×360') && row.includes('MKV'), row.replace(/\n/g, ' | '));
    await js(`document.querySelector('[role=listbox]').scrollTop = 99999`);
    await sleep(500);
    const heicRow = await js(`[...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith('phone upright.heif'))?.innerText ?? ''`);
    check('rotated phone photo shows upright size', heicRow.includes('1000×1400'), heicRow.replace(/\n/g, ' | '));
    await shot('02-list');
    await radio('Grid');

    // ---- filters and search by name (LIB-07) ----
    await radio('Videos');
    await sleep(300);
    check('type filter: videos only', /0 photos · 17 videos/.test(await counts()), await counts());
    await radio('All');
    const typeIn = async q => js(`(() => { const i = document.querySelector('input[aria-label="Search by name"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await typeIn('clip');
    await sleep(300);
    check('name filter in this folder', /0 photos · 16 videos/.test(await counts()), await counts());
    await typeIn('sunset');
    await sleep(200);
    await js(`document.querySelector('input[aria-label="Search by name"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await waitFor(' found for “sunset”', 15000);
    await sleep(500);
    const found = await js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path)`);
    check('search finds a photo two folders down', found.length === 1 && found[0].endsWith(path.join('Goa trip', 'Day 1', 'beach sunset.jpg')), found.join(', '));
    await shot('03-search');
    await click('Back to folder');
    await typeIn('');
    await sleep(300);

    // ---- viewer (LIB-09) ----
    await dbl('phone upright.heif');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=viewer-image]')?.naturalWidth ?? 0`)) > 0, 20000);
    const v = await js(`(() => { const i = document.querySelector('[data-testid=viewer-image]'); return { src: i.src, w: i.naturalWidth, h: i.naturalHeight }; })()`);
    check('viewer shows HEIC (converted preview)', v.src.startsWith('clearup://preview/') && v.w === 1000 && v.h === 1400, `${v.w}×${v.h}`);
    const z0 = await js(`document.querySelector('[data-testid=viewer-zoom]').innerText`);
    await clickSel('[aria-label="Zoom in"]');
    const z1 = await js(`document.querySelector('[data-testid=viewer-zoom]').innerText`);
    check('viewer zooms', parseInt(z1) > parseInt(z0), `${z0} → ${z1}`);
    await shot('04-viewer-heic');
    await clickSel('[aria-label="Next"]');
    await sleep(300);
    // The next item is a video: it opens in the player (Phase B).
    await waitFor(async () => !!(await js(`document.querySelector('[data-testid=player-name]')?.innerText`)), 10000);
    const nextName = await js(`document.querySelector('[data-testid=player-name]').innerText`);
    check('viewer next (a video opens in the player)', nextName === 'phone video.mp4', nextName);
    await sleep(700);
    await js(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText === 'Start over')?.click()`);
    await js(`document.querySelector('[aria-label="Close player"]').click()`);
    await sleep(300);
    await dbl('canon.cr3');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=viewer-image]')?.naturalWidth ?? 0`)) > 0, 20000);
    check('viewer shows camera RAW (CR3)', (await text()).includes("camera's built-in preview"));
    await shot('05-viewer-raw');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    await sleep(300);

    // ---- send to Upscale ----
    await dbl('photo.jpg');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=viewer-image]')?.naturalWidth ?? 0`)) > 0, 20000);
    await clickSel('[role=dialog] button[title="Open in Upscale"]');
    await waitFor('photo.jpg', 10000);
    const onUpscale = await js(`document.querySelector('nav [aria-current=page]')?.innerText`);
    check('viewer sends the photo to Upscale', onUpscale === 'Upscale', onUpscale);
    await shot('06-sent-to-upscale');
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText === 'Library').click()`);
    await sleep(500);

    // ---- folders: open, up ----
    await dbl('Goa trip');
    await waitFor(async () => (await js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path).join()`)).endsWith('Day 1'), 10000);
    await clickSel('[aria-label="Up one folder"]');
    await waitFor(async () => /17 videos/.test(await counts()), 10000);
    check('open folder and go up', true);

    // ---- show system folders (LIB-06 setting) ----
    await setLib({ showSystem: true });
    await clickSel('[aria-label="Refresh"]');
    await sleep(800);
    const withSys = await js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path.split(/[\\\\/]/).pop())`);
    check('system folders appear when switched on', withSys.includes('AppData'));
    await setLib({ showSystem: false });

    // ---- no-permission folder (LIB-10) ----
    if (WIN) {
      fs.mkdirSync(PRIVATE, { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'photo.jpg'), path.join(PRIVATE, 'secret.jpg'));
      execFileSync('icacls', [PRIVATE, '/deny', `${process.env.USERNAME}:(RD)`], { stdio: 'ignore' });
      try {
        await js(`window.__clearupLibrary(${JSON.stringify(PRIVATE)})`);
        await waitFor("You don't have permission", 10000);
        check('folder without permission shows a message', true);
        await shot('07-no-permission');
      } finally {
        execFileSync('icacls', [PRIVATE, '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
      }
    }

    // ---- a new drive appears while the app is open (USB stick stand-in: subst) ----
    if (WIN) {
      const used = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(l => fs.existsSync(`${l}:\\`)));
      const letter = 'RSTUVWXYQP'.split('').find(l => !used.has(l));
      if (letter) {
        execFileSync('subst', [`${letter}:`, ROOT]);
        substDrive = letter;
        await waitFor(`(${letter}:)`, 15000).then(() => check('new drive shows up without restarting', true, `${letter}:`),
          () => check('new drive shows up without restarting', false, `${letter}:`));
        execFileSync('subst', [`${letter}:`, '/d']);
        substDrive = null;
        await waitFor(async () => !(await text()).includes(`(${letter}:)`), 15000).then(() => check('removed drive disappears', true), () => check('removed drive disappears', false));
      }
    }

    // ---- 5,000-file folder opens in under 2 seconds ----
    fs.rmSync(BIG, { recursive: true, force: true });
    fs.mkdirSync(BIG, { recursive: true });
    const small = path.join(OUT, 'small.jpg');
    const sharp = (await import('sharp')).default;
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#4a8' } }).jpeg().toFile(small);
    for (let i = 0; i < 5000; i++) fs.copyFileSync(small, path.join(BIG, `IMG_${String(i).padStart(5, '0')}.jpg`));
    await js(`window.__clearupLibrary(${JSON.stringify(BIG)})`);
    await waitFor(async () => /5000 photos/.test(await counts()), 15000);
    const ms = parseInt(await js(`document.querySelector('[data-testid=lib-open-ms]')?.innerText.replace(/\\D/g, '') ?? '99999'`));
    check('5,000-file folder opens in under 2 s', ms < 2000, `${ms} ms`);
    await waitFor(async () => (await js(`[...document.querySelectorAll('[role=option] img')].filter(i => i.complete && i.naturalWidth).length`)) >= 20, 30000)
      .then(() => check('thumbnails fill in on screen first', true), () => check('thumbnails fill in on screen first', false));
    await js(`(b => b.scrollTop = b.scrollHeight)(document.querySelector('[role=listbox]'))`);
    await sleep(1500);
    const lastVisible = await js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path).pop()`);
    check('scrolls to the end of a long folder', lastVisible?.endsWith('IMG_04999.jpg'), path.basename(lastVisible ?? ''));
    await shot('08-big-folder');
    await setLib({ lastDir: null, size: 'm' });
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  } finally {
    if (substDrive) try { execFileSync('subst', [`${substDrive}:`, '/d']); } catch { /* gone */ }
    if (WIN && fs.existsSync(PRIVATE)) try { execFileSync('icacls', [PRIVATE, '/remove:d', process.env.USERNAME], { stdio: 'ignore' }); } catch { /* ok */ }
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
