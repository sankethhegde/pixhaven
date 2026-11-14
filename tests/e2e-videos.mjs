// End-to-end check of 1.0.6 in the built app: the Videos tab (every video of the added folders, search, sort, where),
// the paused-only middle controls, labels and stars in full screen, and who made each label (Labels → Manage).
// Run: npm run e2e:videos. Screenshots + results.json land in e2e-output/videos/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const V = path.join(OUT, 'My videos');
const P = path.join(OUT, 'Phone photos');
const WIN = process.platform === 'win32';
const EXIFTOOL = path.resolve(WIN ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

function clip(file, pattern, seconds) {
  const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
  const r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', `${pattern}=size=480x270:rate=25:duration=${seconds}`, '-c:v', 'mpeg4', '-q:v', '6', '-y', file]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}
async function makeFixture() {
  for (const d of [V, P]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(V, 'Trips'), { recursive: true }); fs.mkdirSync(P, { recursive: true });
  clip(path.join(V, 'a lake.mp4'), 'testsrc', 6);
  clip(path.join(V, 'b hills.mp4'), 'testsrc2', 20);
  clip(path.join(V, 'c city.mp4'), 'smptebars', 4);
  clip(path.join(V, 'Trips', 'd goa.mp4'), 'rgbtestsrc', 3);
  const sharp = (await import('sharp')).default;
  const photo = path.join(P, 'kw.jpg');
  await sharp({ create: { width: 320, height: 240, channels: 3, background: '#4a8' } }).jpeg().toFile(photo);
  const args = path.join(OUT, 'kw.args');
  fs.writeFileSync(args, ['-charset', 'filename=utf8', '-overwrite_original', '-IPTC:Keywords=Phone album', '-XMP-dc:Subject=Phone album', photo].join('\n') + '\n', 'utf8');
  const r = spawnSync(EXIFTOOL, ['-@', args]);
  if (r.status !== 0) throw new Error(`exiftool: ${r.stderr}`);
}

export default async function run(win, app) {
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(200); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 100) : `"${t}"`}`);
  }
  const soft = p => p.then(() => true, () => false);
  const page = `document.querySelector('[data-testid=videos-page]')`;
  const nav = label => js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`).then(() => sleep(600));
  const key = (k, mods = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true, ctrlKey: ${!!mods.ctrl} }))`).then(() => sleep(400));
  const names = () => js(`[...${page}.querySelectorAll('[role=option][data-path]')].map(e => e.dataset.path.split(/[\\\\/]/).pop())`);
  const count = () => js(`document.querySelector('[data-testid=videos-count]')?.innerText ?? ''`);
  const player = `document.querySelector('[data-testid=watch-page] [aria-label^="Player"]')`;
  const vid = `document.querySelector('[data-testid=watch-page] video')`;
  const center = () => js(`[...document.querySelectorAll('[data-testid=center-controls] [data-center]')].map(b => b.dataset.center + (b.disabled ? ' (off)' : ''))`);
  const setInput = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`).then(() => sleep(500));
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`screenshot ${name} skipped: ${e.message}`); }
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const ref = p => { const st = fs.statSync(p); return { path: p, size: st.size, mtime: st.mtimeMs }; };
  const starsOf = async p => (await js(`window.clearup.tags.forFiles([${JSON.stringify(ref(p))}])`)).tags[p]?.stars ?? 0;

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 880);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await makeFixture();
    for (const w of await js('window.clearup.watch.list()')) await js(`window.clearup.watch.remove(${JSON.stringify(w.path)})`);
    await js(`localStorage.removeItem('videos.order'); localStorage.removeItem('player.tags')`);
    await waitFor('What would you like to do?');

    // ---- Videos tab: empty, then a folder added ----
    await nav('Videos');
    await waitFor(async () => !!(await js(`!!${page}`)), 10000);
    check('Videos tab: with nothing added it says how to start', (await js(`${page}.innerText`)).includes('Add a drive or folder'));
    await js(`document.querySelector('[data-testid=videos-page] button[aria-expanded]').click()`);
    await sleep(400);
    const menu = await js(`[...document.querySelectorAll('[role=menu][aria-label="Add a drive or folder"] [role=menuitem]')].map(b => b.innerText.trim())`);
    check('"Add a drive or folder" offers the drives and a folder chooser', menu.some(m => /\(C:\)|C:/.test(m)) && menu.includes('Choose a folder…'), menu.join(' | '));
    await key('Escape');
    await js(`document.querySelector('[data-testid=videos-page] button[aria-expanded]').click()`);
    await js(`window.clearup.watch.add(${JSON.stringify(V)})`);
    await waitFor(async () => /^4 videos/.test(await count()), 30000);
    check('Videos tab lists every video of the added folder, subfolders too', JSON.stringify((await names()).sort()) === JSON.stringify(['a lake.mp4', 'b hills.mp4', 'c city.mp4', 'd goa.mp4']), await count());
    await js(`(s => { s.value = 'name:asc'; s.dispatchEvent(new Event('change', { bubbles: true })); })(document.querySelector('select[aria-label="Sort videos"]'))`);
    await sleep(400);
    check('sort by name', (await names())[0] === 'a lake.mp4', (await names()).join(', '));
    await setInput('input[aria-label="Search videos"]', 'goa');
    await soft(waitFor(async () => (await names()).length === 1, 5000));
    check('search by name', JSON.stringify(await names()) === JSON.stringify(['d goa.mp4']));
    await setInput('input[aria-label="Search videos"]', '');
    await soft(waitFor(async () => (await names()).length === 4, 5000));
    const where = await js(`[...document.querySelectorAll('[role=radiogroup][aria-label=Where] [role=radio]')].map(b => b.innerText)`);
    check('"Where": This PC and external drives, with counts', where.includes('This PC (4)') && where.some(w => w.startsWith('External drives')), where.join(' | '));
    await shot('01-videos-tab');

    // ---- watch page: middle controls only while paused ----
    await js(`[...${page}.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith('a lake.mp4')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await waitFor(async () => (await js(`${vid}?.currentTime ?? 0`)) > 0.4, 15000);
    const whilePlaying = await center();
    await key(' ');
    await soft(waitFor(async () => (await center()).length > 0, 3000));
    const whilePaused = await center();
    check('paused: big previous / −10 / play / +10 / next buttons in the middle', JSON.stringify(whilePaused) === JSON.stringify(['Previous video (off)', 'Back 10 seconds', 'Play', 'Forward 10 seconds', 'Next video']), `${whilePaused.join(', ')}; while playing: ${whilePlaying.length}`);
    check('playing: no middle buttons', whilePlaying.length === 0);
    await shot('02-paused-controls');
    await js(`document.querySelector('[data-testid=center-controls] [data-center="Play"]').click()`);
    await soft(waitFor(async () => !(await js(`${vid}.paused`)) && !(await center()).length, 3000));
    check('the middle Play button plays and the buttons go away', !(await js(`${vid}.paused`)) && !(await center()).length);
    await key(' ');
    await soft(waitFor(async () => (await center()).length > 0, 3000));
    await js(`document.querySelector('[data-testid=center-controls] [data-center="Next video"]').click()`);
    await soft(waitFor(async () => (await js(`document.querySelector('[data-testid=watch-title]')?.innerText`)) === 'b hills.mp4', 8000));
    check('the middle Next button goes to the next video', (await js(`document.querySelector('[data-testid=watch-title]')?.innerText`)) === 'b hills.mp4');

    // ---- full screen: labels and stars are back ----
    await waitFor(async () => (await js(`${vid}?.currentTime ?? 0`)) > 0.3, 15000);
    for (let i = 0; i < 3 && !(await js('!!document.fullscreenElement')); i++) {
      await js(`[...document.querySelectorAll('[data-testid=watch-page] button')].find(b => b.innerText.trim() === 'Full screen').click()`, true);
      await soft(waitFor(async () => !!(await js('document.fullscreenElement')), 4000));
    }
    if (!(await js('!!document.fullscreenElement'))) throw new Error('Full screen did not start');
    await soft(waitFor(async () => !!(await js(`!!document.fullscreenElement?.querySelector('[aria-label="Labels and stars"]')`)), 3000));   // drawn for full screen
    const btn = await js(`!!document.fullscreenElement?.querySelector('[aria-label="Labels and stars"]')`);
    if (!(await js(`!!document.fullscreenElement?.querySelector('[data-tags-panel]')`))) await js(`document.fullscreenElement.querySelector('[aria-label="Labels and stars"]').click()`);
    await sleep(400);
    const panelShown = await js(`!!document.fullscreenElement?.querySelector('[data-tags-panel] [data-testid=tag-editor]')`);
    await js(`document.fullscreenElement.querySelector('[data-tags-panel] [aria-label="4 stars"]').click()`);
    await soft(waitFor(async () => (await starsOf(path.join(V, 'b hills.mp4'))) === 4, 8000));
    await shot('03-fullscreen-labels');
    check('full screen: the Labels button and panel are back, and stars set there stick', btn && panelShown && (await starsOf(path.join(V, 'b hills.mp4'))) === 4);
    await sleep(3500);   // playing, the panel fades with the controls
    const faded = await js(`getComputedStyle(document.fullscreenElement.querySelector('[data-tags-panel]')).opacity`);
    check('full screen: the panel fades with the controls while playing', Number(faded) < 0.2, `opacity ${faded}`);
    await js('document.exitFullscreen().catch(() => {})');
    await sleep(800);
    await key('Escape');
    await sleep(500);
    check('Esc goes back to the Videos grid', !(await js(`!!document.querySelector('[data-testid=watch-page]')`)) && (await names()).length === 4);

    // ---- who made each label ----
    await js(`window.__clearupLibrary(${JSON.stringify(P)})`);
    await waitFor(async () => (await js(`[...document.querySelectorAll('[data-label-view]')].map(b => b.dataset.labelView)`)).includes('Phone album'), 20000);
    const photo = path.join(P, 'kw.jpg');
    await js(`[...document.querySelectorAll('[data-tab-panel]:not(.hidden) [role=option][data-path]')].find(e => e.dataset.path.endsWith('kw.jpg')).click()`);
    await sleep(500);
    await setInput('[data-tab-panel]:not(.hidden) [data-testid=details-tags] input[aria-label="Add a label"]', 'Mine');
    await js(`document.querySelector('[data-tab-panel]:not(.hidden) [data-testid=details-tags] input[aria-label="Add a label"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await soft(waitFor(async () => (await js('window.clearup.tags.labels()')).some(l => l.name === 'Mine'), 8000));
    await js(`[...document.querySelectorAll('[data-tab-panel]:not(.hidden) button')].find(b => b.innerText.trim() === 'Manage').click()`);
    await waitFor(async () => !!(await js(`document.querySelector('[role=dialog][aria-label="Manage labels"]')`)), 5000);
    const originOf = n => js(`document.querySelector('[data-manage=${JSON.stringify(n)}] [data-origin]')?.innerText ?? ''`);
    const [fromFiles, mine] = [await originOf('Phone album'), await originOf('Mine')];
    check('Labels: a keyword found inside a photo says "From files" and which file', fromFiles.startsWith('From files') && fromFiles.includes('kw.jpg'), fromFiles);
    check('Labels: a label you made says "Made by you"', mine === 'Made by you', mine);
    const tip = await js(`document.querySelector('[data-manage="Phone album"] [data-origin]')?.title ?? ''`);
    check('hovering shows the full path it was first seen in', tip.includes(photo), tip.split('\n')[0]);
    await js(`[...document.querySelectorAll('[role=dialog] [role=radio]')].find(b => b.innerText.startsWith('From files')).click()`);
    await sleep(300);
    const filtered = await js(`[...document.querySelectorAll('[role=dialog] [data-manage]')].map(r => r.dataset.manage)`);
    check('"Made by" filter: From files shows only labels found in files', JSON.stringify(filtered) === JSON.stringify(['Phone album']), filtered.join(', '));
    await shot('04-label-origin');
    await key('Escape');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
