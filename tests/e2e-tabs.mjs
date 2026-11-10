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

    // ==== 1.0.5 ====
    const harbour = path.join(A, 'harbour.mp4');
    {  // a different video (an identical copy would share its fingerprint)
      const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
      const r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=4', '-c:v', 'mpeg4', '-q:v', '5', '-y', harbour]);
      if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    }
    const ref = p => { const st = fs.statSync(p); return { path: p, size: st.size, mtime: st.mtimeMs }; };
    const tagsOf = async p => (await js(`window.clearup.tags.forFiles([${JSON.stringify(ref(p))}])`)).tags[p] ?? { stars: 0, labels: [] };
    const labelId = async name => (await js(`window.clearup.tags.labels()`)).find(l => l.name === name)?.id;
    await js(`window.__clearupLibrary(${JSON.stringify(A)})`);
    await waitFor(async () => /1 photo · 2 videos/.test(await counts()), 15000);
    await sleep(1500);   // labels read from the files first
    await key('Escape');

    // ---- details card with nothing selected: the folder's totals ----
    const totals = await card();
    check('details card with nothing selected shows the folder totals', /In this folder/.test(totals) && /Files\s+3/.test(totals) && /Photos\s+1/.test(totals) && /Videos\s+2/.test(totals) && /Total size/.test(totals),
      totals.replace(/\n/g, ' | ').slice(0, 200));

    // ---- stars and labels for several videos, from the card ----
    await tile('beach walk.mp4');
    await tile('harbour.mp4', { ctrl: true });
    const editor = `${panel}.querySelector('[data-testid=details-tags]')`;
    check('several selected: the card offers stars and labels for all of them', /2 items/i.test(await js(`${editor}?.innerText ?? ''`)));
    await js(`${editor}.querySelector('[aria-label="3 stars"]').click()`);
    await soft(waitFor(async () => (await tagsOf(video)).stars === 3 && (await tagsOf(harbour)).stars === 3, 10000));
    await js(`(() => { const i = ${editor}.querySelector('input[aria-label="Add a label"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(i, 'Live wallpaper'); i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    await soft(waitFor(async () => { const id = await labelId('Live wallpaper'); return id && (await tagsOf(video)).labels.includes(id) && (await tagsOf(harbour)).labels.includes(id); }, 10000));
    const lid = await labelId('Live wallpaper');
    const [t1, t2] = [await tagsOf(video), await tagsOf(harbour)];
    check('stars and a new label set from the card reach both videos', t1.stars === 3 && t2.stars === 3 && !!lid && t1.labels.includes(lid) && t2.labels.includes(lid), JSON.stringify([t1, t2]));
    await shot('08-card-tags-two');
    await tile('harbour.mp4');
    await js(`${editor}.querySelector('[aria-label="5 stars"]').click()`);
    await soft(waitFor(async () => (await tagsOf(harbour)).stars === 5, 10000));
    check('one selected: its stars change on their own', (await tagsOf(harbour)).stars === 5 && (await tagsOf(video)).stars === 3);

    // ---- the watch page ----
    await js(`[...${panel}.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith('beach walk.mp4')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    const vid = `${panel}.querySelector('[data-testid=watch-page] video')`;
    await waitFor(async () => (await js(`${vid}?.currentTime ?? 0`)) > 0.3, 15000);
    const upNames = await js(`[...${panel}.querySelectorAll('[data-up-next]')].map(b => (b.dataset.nowPlaying ? '▶' : '') + b.dataset.upNext)`);
    check('opening a video shows the watch page: it plays large, Up next lists the folder\'s videos', (await js(`!!${panel}.querySelector('[data-testid=watch-page]')`)) && !(await js(`!!document.querySelector('[role=dialog][aria-label^="Player"]')`))
      && JSON.stringify(upNames) === JSON.stringify(['▶beach walk.mp4', 'harbour.mp4']), upNames.join(', '));
    check('the watch page shows the video\'s stars and labels', (await js(`${panel}.querySelector('[data-testid=watch-tags]')?.innerText ?? ''`)).includes('Live wallpaper'));
    await shot('09-watch-page');
    const box = await js(`(() => { const r = ${vid}.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    await click('Theatre');
    await sleep(600);
    const box2 = await js(`(() => { const r = ${vid}.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
    const tBefore = await js(`${vid}.currentTime`);
    await sleep(700);
    const tAfter = await js(`${vid}.currentTime`);
    check('Theatre makes the video wider and keeps it playing (no restart)', box2.w > box.w + 150 && tAfter > tBefore && !!(await js(`${panel}.querySelector('[data-theatre]')`)), `${box.w}×${box.h} → ${box2.w}×${box2.h}; ${tBefore.toFixed(2)} → ${tAfter.toFixed(2)} s`);
    await shot('10-theatre');
    await click('Normal view');
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === 'Full screen').click()`, true);
    await soft(waitFor(async () => !!(await js('document.fullscreenElement')), 5000));
    const fullOk = await js(`!!document.fullscreenElement?.matches('[data-embedded]')`);
    await js('document.exitFullscreen().catch(() => {})');
    check('Full screen fills the screen with the video, and comes back', fullOk && !(await js('!!document.fullscreenElement')));
    await js(`${panel}.querySelector('[data-up-next="harbour.mp4"]').click()`);
    await soft(waitFor(async () => (await js(`${panel}.querySelector('[data-testid=watch-title]')?.innerText`)) === 'harbour.mp4' && (await js(`${vid}?.currentTime ?? 0`)) > 0.2, 15000));
    check('clicking a video in Up next plays it', (await js(`${panel}.querySelector('[data-testid=watch-title]')?.innerText`)) === 'harbour.mp4');
    await tabClick(2);
    await sleep(500);
    const pausedAway = await js(`(() => { const v = [...document.querySelectorAll('[data-tab-panel] [data-testid=watch-page] video')]; return v.length === 1 ? v[0].paused : 'videos: ' + v.length; })()`);
    await tabClick(1);
    check('switching to another tab pauses the video', pausedAway === true, String(pausedAway));
    await key('Escape');
    await sleep(500);
    const selBack = await js(`[...${panel}.querySelectorAll('[role=option][aria-selected=true]')].map(e => e.dataset.path.split(/[\\\\/]/).pop())`);
    check('Esc goes back to the folder with the last video selected', !(await js(`!!${panel}.querySelector('[data-testid=watch-page]')`)) && selBack.join() === 'harbour.mp4', selBack.join());

    // ---- Video editor: the nightOwl live wallpaper recommendation ----
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Video editor')?.click()`);
    await waitFor(async () => !!(await js(`document.querySelector('[data-testid=wallpaper-tip]')`)), 10000);
    const tip = await js(`document.querySelector('[data-testid=wallpaper-tip]').innerText`);
    const badge = await js(`document.querySelector('[data-conv-target="mp4-h264"] [data-testid=best-for-wallpaper]')?.innerText ?? ''`);
    check('Video editor says which format is best for a nightOwl live wallpaper', tip.includes('MP4 (H.264)') && tip.includes('sound off') && badge.includes('Best for nightOwl'), tip.replace(/\n/g, ' ').slice(0, 220));
    await click('Use live wallpaper settings');
    const conv = await js(`({ target: document.querySelector('[data-conv-target][aria-checked=true]')?.dataset.convTarget, res: document.querySelector('select[aria-label=Resolution]')?.value,
      sound: document.querySelector('[aria-label="Keep the sound"]')?.getAttribute('aria-checked'), done: [...document.querySelectorAll('button')].some(b => b.innerText.includes('Using these settings')) })`);
    check('"Use live wallpaper settings" picks H.264, 1080p, sound off', conv.target === 'mp4-h264' && conv.res === '1080' && conv.sound === 'false' && conv.done, JSON.stringify(conv));
    await shot('11-wallpaper-tip');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
