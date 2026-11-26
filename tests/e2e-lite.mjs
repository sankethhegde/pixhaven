// End-to-end check of 1.1.2 in the built app: Light mode (the switch on Home, the features kept in Settings, tabs and
// background work switched off), and the "Working in the background" note with Pause / Resume.
// Run: npm run e2e:lite. Screenshots + results.json land in e2e-output/lite/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const V = path.join(OUT, 'Clips');
const WIN = process.platform === 'win32';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function clip(file, pattern, seconds) {
  const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
  const r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', `${pattern}=size=320x240:rate=10:duration=${seconds}`, '-c:v', 'mpeg4', '-q:v', '6', '-y', file]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
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
  const nav = label => js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`).then(() => sleep(600));
  const tabs = () => js(`[...document.querySelectorAll('nav button[aria-current], nav > button')].map(b => b.innerText.trim()).filter(Boolean)`);
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`screenshot ${name} skipped: ${e.message}`); }
  }
  const count = () => js(`window.clearup.watch.query({ text: '', type: 'video', filter: { labels: [], mode: 'any', minStars: 0 }, root: null, limit: 100 })`).then(r => r.items.length);
  const setLite = v => js(`window.clearup.setSettings({ lite: ${JSON.stringify(v)} })`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 900);
    win.webContents.setBackgroundThrottling(false);
    fs.rmSync(V, { recursive: true, force: true }); fs.mkdirSync(V, { recursive: true });
    clip(path.join(V, 'one.mp4'), 'testsrc', 4);
    clip(path.join(V, 'two.mp4'), 'testsrc2', 4);
    for (const w of await js('window.clearup.watch.list()')) await js(`window.clearup.watch.remove(${JSON.stringify(w.path)})`);
    await setLite({ on: false, keep: ['watch', 'updates', 'attic'] });
    await js('location.reload()');
    await waitFor('What would you like to do?');

    // ---- the background note: paused by you, then resumed ----
    await js('window.clearup.watch.pauseUser(true)');
    await js(`window.clearup.watch.add(${JSON.stringify(V)})`);
    await soft(waitFor(async () => (await js(`document.querySelector('[data-testid=background-note]')?.dataset.state`)) === 'paused', 15000));
    const note = await js(`document.querySelector('[data-testid=background-note]')?.innerText ?? ''`);
    await shot('01-paused');
    check('the background note says checking is paused, with Resume', /Paused/.test(note) && /Resume/.test(note) && (await count()) === 0, note.replace(/\n/g, ' | '));
    await js(`document.querySelector('[data-testid=background-pause]').click()`);
    await soft(waitFor(async () => (await count()) === 2, 20000));
    await soft(waitFor(async () => !(await js(`!!document.querySelector('[data-testid=background-note]')`)), 10000));
    check('Resume: the folder is checked, then the note goes away', (await count()) === 2 && !(await js(`!!document.querySelector('[data-testid=background-note]')`)), `${await count()} videos`);

    // ---- Light mode on Home ----
    const before = await tabs();
    await js(`document.querySelector('[data-testid=lite-card] [role=switch]').click()`);
    await soft(waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=lite-badge]')`)), 5000));
    const after = await tabs();
    const card = await js(`document.querySelector('[data-testid=lite-card]').innerText`);
    await shot('02-lite-on');
    const gone = ['Wallpaper recommended', 'Video editor', 'Upscale', 'Image Generator', 'Sort by person', 'Tidy up'];
    check('Home: the Light mode switch hides the tabs not kept; browsing, playing and Attic stay', gone.every(t => before.includes(t) && !after.includes(t)) && ['Home', 'Library', 'Photos', 'Videos', 'Attic', 'Settings'].every(t => after.includes(t)),
      `${after.join(', ')} · ${card.replace(/\n/g, ' ')}`);
    check('Home: the upscale and sort drop areas and Tidy up are hidden too', !(await text()).includes('Upscale images') && !(await text()).includes('Find duplicates & blurry photos'));

    // ---- Settings: choose what is kept ----
    await nav('Settings');
    await waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=lite-settings]')`)), 5000);
    await js(`document.querySelector('[data-lite-feature=tidy] input').click()`);
    await soft(waitFor(async () => (await tabs()).includes('Tidy up'), 5000));
    check('Settings: ticking a feature brings it back in Light mode', (await tabs()).includes('Tidy up'), (await tabs()).join(', '));
    await shot('03-settings');

    // ---- hover preview off ----
    await nav('Videos');
    await waitFor(async () => (await js(`document.querySelectorAll('[data-testid=videos-page] [role=option][data-path]').length`)) === 2, 15000);
    await js(`document.querySelector('[data-testid=videos-page] [role=option][data-path] .relative').dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))`);
    await sleep(2500);
    check('Light mode without "Play videos when you rest on a thumbnail": no preview starts', !(await js(`!!document.querySelector('[data-testid=hover-preview]')`)));

    // ---- watching off: a new video is not picked up; back on, it is ----
    await setLite({ on: true, keep: ['updates', 'attic', 'tidy'] });
    await sleep(800);
    clip(path.join(V, 'three.mp4'), 'smptebars', 3);
    await sleep(6000);
    const whileOff = await count();
    await setLite({ on: true, keep: ['watch', 'updates', 'attic', 'tidy'] });
    await soft(waitFor(async () => (await count()) === 3, 20000));
    check('watching switched off: a new video is not picked up; switched on again, it is', whileOff === 2 && (await count()) === 3, `while off ${whileOff}, then ${await count()}`);

    // ---- off again: everything back ----
    await nav('Home');
    await js(`document.querySelector('[data-testid=lite-card] [role=switch]').click()`);
    await soft(waitFor(async () => (await tabs()).includes('Upscale'), 5000));
    check('Light mode off: every tab is back', (await tabs()).length === before.length, (await tabs()).join(', '));
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  try { await js(`window.clearup.setSettings({ lite: { on: false, keep: ['watch', 'updates', 'attic'] } })`); } catch { /* closing */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
