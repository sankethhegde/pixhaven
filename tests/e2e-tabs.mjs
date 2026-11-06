// End-to-end check of 1.0.4 in the built app: Library tabs (copy a video in one tab, paste in another; drag a photo
// onto a tab; cut and paste back; tabs kept after a reload; Ctrl+T / Ctrl+W) and the details card (video, photo,
// several items). Run: npm run e2e:tabs. Screenshots + results.json land in e2e-output/tabs/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const A = path.join(OUT, 'Trips', 'Goa');
const B = path.join(OUT, 'Trips', 'Best of');
const WIN = process.platform === 'win32';
const EXIFTOOL = path.resolve(WIN ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function makeFixture() {
  fs.rmSync(path.join(OUT, 'Trips'), { recursive: true, force: true });
  fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(B, { recursive: true });
  const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
  const video = path.join(A, 'beach walk.mp4');
  let r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', video]);
  if (r.status !== 0) r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=duration=3',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', video]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
  const sharp = (await import('sharp')).default;
  const photo = path.join(A, 'sunset.jpg');
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#e07a3a' } }).jpeg().toFile(photo);
  const args = path.join(OUT, 'exif.args');
  fs.writeFileSync(args, ['-charset', 'filename=utf8', '-overwrite_original', '-Make=Apple', '-Model=iPhone 15 Pro', '-DateTimeOriginal=2024:12:24 18:05:00',
    '-FNumber=1.8', '-ExposureTime=1/120', '-ISO=64', photo].join('\n') + '\n', 'utf8');
  r = spawnSync(EXIFTOOL, ['-@', args]);
  if (r.status !== 0) throw new Error(`exiftool: ${r.stderr}`);
  return { video, photo };
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(200); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 100) : `"${t}"`}`);
  }
  const soft = p => p.then(() => true, () => false);
  const panel = `document.querySelector('[data-tab-panel]:not(.hidden)')`;
  /** A button in the visible tab (or anywhere, e.g. the tab strip). */
  async function click(label, exact = true) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.offsetParent && ${exact ? `(b.innerText.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(300);
  }
  const tile = async (name, opts = {}) => {
    const ok = await js(`(() => { const t = [...${panel}.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith(${JSON.stringify(path.sep + name)}));
      if (!t) return false; t.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${!!opts.ctrl} })); return true; })()`);
    if (!ok) throw new Error(`No tile ${name}`);
    await sleep(300);
  };
  const key = (k, mods = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} }))`).then(() => sleep(400));
  const card = () => js(`${panel}?.querySelector('[data-testid=details-card]')?.innerText ?? ''`);
  const detail = name => js(`${panel}?.querySelector('[data-testid=details-card] [data-detail=${name}]')?.innerText ?? ''`);
  const counts = () => js(`${panel}?.querySelector('[data-testid=lib-counts]')?.innerText ?? ''`);
  const tabs = () => js(`[...document.querySelectorAll('[role=tab]')].map(t => (t.getAttribute('aria-selected') === 'true' ? '*' : '') + t.innerText.trim())`);
  const tabClick = n => js(`document.querySelector('[role=tab][data-tab="${n}"]').click()`).then(() => sleep(500));
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`screenshot ${name} skipped: ${e.message}`); }
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const setLib = patch => js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, ...${JSON.stringify(patch)} } }); })()`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 880);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    const { video, photo } = await makeFixture();
    await js(`localStorage.removeItem('lib.tabs'); localStorage.removeItem('details.open')`);
    await setLib({ view: 'grid', size: 'm', type: 'all', sortBy: 'name', sortDesc: false, lastDir: null });
    await waitFor('What would you like to do?');

    // ---- one tab, the details card for a video ----
    await js(`window.__clearupLibrary(${JSON.stringify(A)})`);
    await waitFor(async () => /1 photo · 1 video/.test(await counts()));
    check('the Library opens with one tab named after the folder', JSON.stringify(await tabs()) === JSON.stringify(['*Goa']), (await tabs()).join(', '));
    await tile('beach walk.mp4');
    await soft(waitFor(async () => (await detail('codec')) !== '', 15000));
    const v = await card();
    check('details card: video name, length, resolution, codec, frame rate and audio',
      v.includes('beach walk.mp4') && /Length\s+0:03/.test(v) && /Resolution\s+640 × 360/.test(v) && /Video\s+(H\.264|MPEG-4) · 30 fps/.test(v) && /Audio\s+AAC stereo/.test(v),
      v.replace(/\n/g, ' | ').slice(0, 300));
    await shot('01-video-details');

    // ---- photo: EXIF ----
    await tile('sunset.jpg');
    await soft(waitFor(async () => (await detail('camera')) !== '', 15000));
    const p = await card();
    check('details card: photo resolution, megapixels, date taken, camera and exposure',
      /Resolution\s+1600 × 1200 · 1\.9 MP/.test(p) && /Camera\s+Apple iPhone 15 Pro/.test(p) && p.includes('f/1.8 · 1/120 s · ISO 64') && /Taken\s+.*2024/.test(p),
      p.replace(/\n/g, ' | ').slice(0, 300));
    await shot('02-photo-details');

    // ---- several items ----
    await key('a', { ctrl: true });
    const many = await card();
    const total = fs.statSync(video).size + fs.statSync(photo).size;
    check('details card: several items give a summary', many.includes('2 items selected') && /Photos\s+1/.test(many) && /Videos\s+1/.test(many) && /Total size/.test(many),
      `${many.replace(/\n/g, ' | ').slice(0, 200)} (${total} bytes)`);
    await key('Escape');

    // ---- hide / show the card (I) ----
    await key('i');
    const hidden = (await card()) === '';
    await key('i');
    check('I hides and shows the details card', hidden && (await card()) !== '');

    // ---- copy the video in tab 1, paste it in tab 2 ----
    await tile('beach walk.mp4');
    await click('Copy');
    check('the copied files are shown above the tabs', (await js(`document.querySelector('[data-testid=clip-status]')?.innerText ?? ''`)).includes('1 copied'));
    await click('New tab');
    check('New tab opens next to the first one, in the same folder', JSON.stringify(await tabs()) === JSON.stringify(['Goa', '*Goa']), (await tabs()).join(', '));
    await waitFor(async () => /1 photo · 1 video/.test(await counts()), 15000);   // the new tab has opened its folder
    await js(`window.__clearupLibrary(${JSON.stringify(B)})`);
    await waitFor(async () => JSON.stringify(await tabs()) === JSON.stringify(['Goa', '*Best of']));
    await click('Paste 1', false);
    await waitFor(async () => /1 video/.test(await counts()), 15000);
    check('Paste in the other tab copies the video there', fs.existsSync(path.join(B, 'beach walk.mp4')) && fs.existsSync(video), await counts());
    await shot('03-pasted-in-tab-2');

    // ---- tab 1 kept its folder and selection ----
    await tabClick(1);
    const back = await js(`[...${panel}.querySelectorAll('[role=option][aria-selected=true]')].map(e => e.dataset.path.split(/[\\\\/]/).pop())`);
    check('switching back: the first tab kept its folder and selection', /1 photo · 1 video/.test(await counts()) && back.join() === 'beach walk.mp4', `${await counts()}; selected ${back.join()}`);

    // ---- drag the photo onto tab 2 (moves it) ----
    await js(`(() => {
      const dt = new DataTransfer(); dt.setData('application/x-pixhaven-paths', JSON.stringify([${JSON.stringify(photo)}]));
      const t = document.querySelector('[role=tab][data-tab="2"]');
      t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    })()`);
    await waitFor(async () => fs.existsSync(path.join(B, 'sunset.jpg')), 10000).catch(() => {});
    await soft(waitFor(async () => /0 photos · 1 video/.test(await counts()), 8000));
    check('drop a photo on a tab: moved into that tab\'s folder, gone from this one',
      fs.existsSync(path.join(B, 'sunset.jpg')) && !fs.existsSync(photo) && /0 photos · 1 video/.test(await counts()), await counts());
    await tabClick(2);
    await soft(waitFor(async () => /1 photo · 1 video/.test(await counts()), 8000));
    check('the other tab shows the moved photo without a refresh', /1 photo · 1 video/.test(await counts()), await counts());

    // ---- cut in tab 2, paste back in tab 1 ----
    await tile('sunset.jpg');
    await key('x', { ctrl: true });
    await tabClick(1);
    await key('v', { ctrl: true });
    await soft(waitFor(async () => fs.existsSync(photo) && /1 photo · 1 video/.test(await counts()), 10000));
    check('Ctrl+X in one tab, Ctrl+V in another moves it back', fs.existsSync(photo) && !fs.existsSync(path.join(B, 'sunset.jpg')), await counts());
    check('after a move the clipboard is empty', !(await js(`!!document.querySelector('[data-testid=clip-status]')`)));
    await shot('04-moved-back');

    // ---- remembered after a restart (reload) ----
    await tabClick(2);
    const stale = await js(`${panel}.querySelector('footer')?.innerText ?? ''`);
    check('the tab it was cut from no longer counts it as selected', !/selected/.test(stale), stale.replace(/\n/g, ' '));
    await tabClick(1);
    await js('window.__beforeReload = 1');
    await new Promise(r => { win.webContents.once('did-finish-load', r); win.webContents.reload(); });
    await waitFor('What would you like to do?', 20000);
    check('the window really reloaded', (await js('window.__beforeReload ?? null')) === null);
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Library')?.click()`);
    await soft(waitFor(async () => (await tabs()).length === 2, 10000));
    const restored = await tabs();
    check('tabs are remembered after a restart', JSON.stringify(restored) === JSON.stringify(['*Goa', 'Best of']), restored.join(', '));
    await tabClick(2);
    await soft(waitFor(async () => /1 video/.test(await counts()), 10000));
    check('a restored tab opens its own folder', (await counts()).includes('1 video') && (await js(`${panel}.innerText`)).includes('Best of'), await counts());

    // ---- keyboard: Ctrl+T, Ctrl+Tab, Ctrl+W ----
    await key('t', { ctrl: true });
    const t3 = await tabs();
    await key('Tab', { ctrl: true });
    const wrapped = await tabs();
    await key('w', { ctrl: true });
    const closed = await tabs();
    check('Ctrl+T opens a tab, Ctrl+Tab goes to the next, Ctrl+W closes it',
      t3.length === 3 && t3[2].startsWith('*') && wrapped[0].startsWith('*') && closed.length === 2, `${t3.join(',')} → ${wrapped.join(',')} → ${closed.join(',')}`);
    await shot('05-tabs');

    // ---- a long folder keeps its scroll position while another tab is shown ----
    const MANY = path.join(OUT, 'Trips', 'Many');
    fs.mkdirSync(MANY, { recursive: true });
    const sharp = (await import('sharp')).default;
    const small = path.join(OUT, 'small.jpg');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#48a' } }).jpeg().toFile(small);
    for (let i = 0; i < 300; i++) fs.copyFileSync(small, path.join(MANY, `IMG_${String(i).padStart(4, '0')}.jpg`));
    await js(`window.__clearupLibrary(${JSON.stringify(MANY)})`);
    await waitFor(async () => /300 photos/.test(await counts()), 15000);
    await js(`(b => { b.scrollTop = b.scrollHeight; b.dispatchEvent(new Event('scroll')); })(${panel}.querySelector('[role=listbox]'))`);
    await sleep(500);
    const before = await js(`${panel}.querySelector('[role=listbox]').scrollTop`);
    await click('New tab');
    await sleep(500);
    await tabClick(1);
    await sleep(700);
    const after = await js(`${panel}.querySelector('[role=listbox]').scrollTop`);
    const last = await js(`[...${panel}.querySelectorAll('[role=option]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).pop()`);
    check('switching tabs keeps the scroll position of a long folder', before > 500 && Math.abs(after - before) < 2 && last === 'IMG_0299.jpg', `${before} → ${after}, last tile ${last}`);
    // and after visiting another page
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Home')?.click()`);
    await sleep(500);
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Library')?.click()`);
    await sleep(700);
    const after2 = await js(`${panel}.querySelector('[role=listbox]').scrollTop`);
    const last2 = await js(`[...${panel}.querySelectorAll('[role=option]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).pop()`);
    check('…and after visiting another page', Math.abs(after2 - before) < 2 && last2 === 'IMG_0299.jpg', `${after2}, last tile ${last2}`);
    await shot('06-scroll-kept');

    // ---- the arrow hides and shows the sidebar (labels, quick access), in every tab ----
    const sidebarShown = () => js(`!!${panel}.querySelector('[aria-label="Library sidebar"]')`);
    const wide0 = await js(`${panel}.querySelector('[role=listbox]').clientWidth`);
    await click('Hide sidebar');
    const goneHere = !(await sidebarShown());
    const wide1 = await js(`${panel}.querySelector('[role=listbox]').clientWidth`);
    await shot('07-sidebar-hidden');
    await tabClick(2);
    const goneThere = !(await sidebarShown());
    check('the arrow hides the sidebar in every tab and the grid gets wider', goneHere && goneThere && wide1 > wide0 + 200, `${wide0} → ${wide1} px`);
    await key('b', { ctrl: true });
    const back1 = await sidebarShown();
    await tabClick(1);
    check('Ctrl+B (or the arrow) shows it again', back1 && (await sidebarShown()) && (await js(`localStorage.getItem('lib.sidebar')`)) === '1');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
