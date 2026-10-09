// End-to-end check of v2.0 Phase C (labels and stars) in the built app, in three launches (scripts/run-e2e-tags.mjs):
//   tag      – 5 labels on one video, bulk-label 50, stars from the player keys and the grid, filter
//              "Family AND 2024, 4+ stars", rename inside and outside the app, manage labels, export JSON + CSV
//   restart  – a new launch with the same data: everything is still there; backups
//   laptop   – "another laptop": fresh app data, the videos in another folder, the old folder gone; import the export
// Done when (doc): labels and stars survive a rename, an app restart and an export/import onto another laptop.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const STEP = process.env.CLEARUP_E2E_STEP ?? 'tag';
const ROOT = path.join(OUT, 'Videos');
const LAPTOP = path.join(OUT, 'Laptop', 'D', 'My Videos');
const EXPECTED = path.join(OUT, 'expected.json');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

function makeVideos() {
  fs.rmSync(path.join(OUT, 'Videos'), { recursive: true, force: true });
  fs.rmSync(path.join(OUT, 'Laptop'), { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const ff = args => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  // 50 different one-second clips (a 50 s test pattern cut on every keyframe).
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=50', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-g', '25',
    '-f', 'segment', '-segment_time', '1', '-reset_timestamps', '1', path.join(ROOT, 'clip_%03d.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest', path.join(ROOT, 'goa.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=6', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', path.join(ROOT, 'birthday.mkv')]);
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(150); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 100) : `"${t}"`}`);
  }
  const check = (name, pass, detail = '') => { results.push({ name: `[${STEP}] ${name}`, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${STEP}] ${name} ${detail}`); };
  async function shot(name) { win.webContents.invalidate(); await sleep(500); fs.writeFileSync(path.join(OUT, `${STEP}-${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const clickSel = async sel => { if (!await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`)) throw new Error(`No ${sel}`); await sleep(250); };
  const clickText = async (label, scope = 'button') => { if (!await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`)) throw new Error(`No "${label}"`); await sleep(300); };
  const clickHas = async (label, scope = 'button') => { if (!await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.offsetParent && b.innerText.includes(${JSON.stringify(label)})); if (!b || b.disabled) return false; b.click(); return true; })()`)) throw new Error(`No "${label}"`); await sleep(300); };
  const key = async (k, opts = {}) => { await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!opts.ctrl} }))`); await sleep(250); };
  /** Scroll the grid until the tile is drawn, then click (or double-click) it. */
  const tile = async (name, how = 'click', mods = {}) => {
    const ok = await js(`(async () => { const box = document.querySelector('[role=listbox]');
      const find = () => [...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.split(/[\\\\/]/).pop() === ${JSON.stringify(name)});
      for (let y = 0; !find() && y <= box.scrollHeight; y += 200) { box.scrollTop = y; await new Promise(r => setTimeout(r, 50)); }
      const t = find(); if (!t) return false; t.scrollIntoView({ block: 'center' });
      t.dispatchEvent(new MouseEvent(${JSON.stringify(how)}, { bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} })); return true; })()`);
    if (!ok) throw new Error(`No tile ${name}`);
    await sleep(300);
  };
  /** Type into the label box inside `scope` and press Enter (auto-complete picks or creates). */
  const addLabel = async (name, scope) => {
    await js(`(() => { const i = document.querySelector(${JSON.stringify(scope + ' input[aria-label="Add a label"]')}); i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    await js(`document.querySelector(${JSON.stringify(scope + ' input[aria-label="Add a label"]')}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    await sleep(400);
  };
  const openFolder = async dir => {
    await js(`window.__clearupLibrary(${JSON.stringify(dir)})`);
    await waitFor(async () => (await js(`document.querySelectorAll('[role=option]').length`)) > 5, 15000);
    await sleep(800);
  };
  /** name → { stars, labels } for every video in the folder, as the app reports it. */
  const stateOf = async dir => {
    const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv)$/.test(f)).map(f => { const p = path.join(dir, f); const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; });
    const r = await js(`window.clearup.tags.forFiles(${JSON.stringify(files)})`);
    const labels = await js('window.clearup.tags.labels()');
    const name = id => labels.find(l => l.id === id)?.name;
    const out = {};
    for (const f of files) { const t = r.tags[f.path]; if (t) out[path.basename(f.path)] = { stars: t.stars, labels: t.labels.map(name).sort() }; }
    return out;
  };
  const visibleNames = () => js(`[...document.querySelectorAll('[role=option]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).sort()`);
  const counts = () => js(`document.querySelector('[data-testid=lib-counts]')?.innerText ?? ''`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    await js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, view: 'grid', size: 'm', type: 'all', sortBy: 'name', sortDesc: false } }); })()`);
    await waitFor('What would you like to do?');

    if (STEP === 'tag') {
      makeVideos();
      await openFolder(ROOT);

      // ---- five labels on one video (doc test), typed with auto-complete ----
      await tile('goa.mp4');
      await clickHas('Labels & stars', 'footer button');
      for (const l of ['Family', 'Goa trip', '2024', 'Friends', 'Beach']) await addLabel(l, '[aria-label="Labels and stars for the selection"]');
      const goa = (await stateOf(ROOT))['goa.mp4'];
      check('5 labels on one video', goa?.labels.length === 5, goa?.labels.join(', '));
      await shot('01-five-labels');

      // ---- bulk: Ctrl+A, then "2024" on everything; "Family" on 10 clips + birthday ----
      await js(`document.activeElement?.blur()`);
      await key('a', { ctrl: true });
      const sel = await js(`document.querySelector('footer')?.innerText.match(/(\\d+) selected/)?.[1]`);
      check('Ctrl+A selects every video', sel === '52', `${sel} selected`);
      // Auto-complete: typing "fam" offers the existing "Family" (on 1 of the 52, so not hidden).
      await js(`(() => { const i = document.querySelector('[aria-label="Labels and stars for the selection"] input'); i.focus();
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'fam'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await sleep(300);
      const offered = await js(`[...document.querySelectorAll('[aria-label="Labels and stars for the selection"] [role=listbox] [role=option]')].map(o => o.innerText.split('\\n')[0].trim())`);
      check('auto-complete offers existing labels', offered[0] === 'Family', offered.join(' | '));
      await js(`(() => { const i = document.querySelector('[aria-label="Labels and stars for the selection"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); })()`);
      await addLabel('2024', '[aria-label="Labels and stars for the selection"]');
      let st = await stateOf(ROOT);
      check('bulk label on 52 videos at once', Object.values(st).filter(t => t.labels.includes('2024')).length === 52);
      await shot('02-bulk');
      await tile('birthday.mkv');
      for (let i = 0; i < 10; i++) await tile(`clip_00${i}.mp4`, 'click', { ctrl: true });
      await addLabel('Family', '[aria-label="Labels and stars for the selection"]');
      // Stars for the 11 selected at once: 2.
      await js(`[...document.querySelectorAll('[aria-label="Labels and stars for the selection"] [role=radiogroup] button')][1].click()`);
      await sleep(400);
      st = await stateOf(ROOT);
      check('bulk stars + label on a selection of 11', Object.values(st).filter(t => t.labels.includes('Family')).length === 12 && st['clip_005.mp4'].stars === 2);
      await clickText('Clear');

      // ---- stars from the grid (TAG-03) and from the player keys (PLAY-04) ----
      await tile('clip_000.mp4');
      await js(`[...document.querySelectorAll('[data-tags="clip_000.mp4"] [role=radio]')][3].click()`);   // 4th star
      await sleep(400);
      await tile('goa.mp4', 'dblclick');
      await waitFor(async () => (await js(`document.querySelector('[data-testid=player-video]')?.currentTime ?? 0`)) > 0.3, 15000);
      await key('5');
      await sleep(400);
      if (!(await js(`!!document.querySelector('[aria-label="Labels and stars panel"]')`))) await clickSel('[aria-label="Labels and stars"]');
      await sleep(300);
      const panel = await js(`document.querySelector('[aria-label="Labels and stars panel"]')?.innerText ?? ''`);
      check('player: key 5 sets 5 stars, panel shows labels beside the video', (await stateOf(ROOT))['goa.mp4'].stars === 5 && panel.includes('Goa trip') && panel.includes('5 of 5'), panel.replace(/\n/g, ' | ').slice(0, 120));
      await js(`document.querySelector('[aria-label="Labels and stars panel"] [aria-label="Remove label Beach"]').click()`);
      await sleep(400);
      await addLabel('Seaside', '[aria-label="Labels and stars panel"]');
      check('player: edit labels while watching', JSON.stringify((await stateOf(ROOT))['goa.mp4'].labels) === JSON.stringify(['2024', 'Family', 'Friends', 'Goa trip', 'Seaside']));
      await shot('03-player-panel');
      await clickSel('[aria-label="Close player"]');
      await sleep(400);
      // birthday 5 stars (Family, no 2024 filter hit since it has 2024 too… set it to 3)
      await tile('birthday.mkv', 'click');
      await clickHas('Labels & stars', 'footer button').catch(() => {});
      await js(`[...document.querySelectorAll('[aria-label="Labels and stars for the selection"] [role=radiogroup] button')][2].click()`);
      await sleep(300);
      await clickText('Clear');

      // ---- filter "Family AND 2024, 4+ stars" (doc test) ----
      await clickSel('[aria-label="Filter by labels and stars"]');
      for (const l of ['Family', '2024']) {
        await clickText('+ label');
        await addLabel(l, '[data-testid=filter-bar]');
      }
      await js(`(() => { const s = document.querySelector('[aria-label="Minimum stars"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '4'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(500);
      const filtered = await visibleNames();
      check('filter: Family AND 2024, 4+ stars', JSON.stringify(filtered) === JSON.stringify(['clip_000.mp4', 'goa.mp4']), filtered.join(', '));
      await shot('04-filter');
      await clickText('Any of them', '[role=radio]');
      await js(`(() => { const s = document.querySelector('[aria-label="Minimum stars"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '0'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(500);
      check('filter: any of', await waitFor(async () => (await counts()).includes('52 videos'), 5000).catch(() => false), await counts());
      await clickText('Clear filter');

      // ---- labels list across drives ----
      await js(`document.querySelector('[data-label-view="Family"]').click()`);
      await waitFor(async () => (await js(`document.querySelector('[data-testid=lib-title]')?.innerText`)) === 'Labelled photos and videos', 5000);
      await sleep(600);
      check('Labels → Family shows its videos from the database', await waitFor(async () => (await counts()).startsWith('12 videos'), 5000).catch(() => false), await counts());
      await shot('05-labelled-view');
      await openFolder(ROOT);

      // ---- rename inside the app (F2) and outside it (Explorer) ----
      await tile('clip_001.mp4');
      await key('F2');
      await waitFor(async () => !!(await js(`document.querySelector('[role=dialog][aria-label=Rename] input')`)), 5000);
      await js(`(() => { const i = document.querySelector('[role=dialog][aria-label=Rename] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'renamed in app.mp4'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await clickText('Rename', '[role=dialog] button');
      await sleep(500);
      st = await stateOf(ROOT);
      check('renamed inside the app: labels and stars follow', st['renamed in app.mp4']?.stars === 2 && st['renamed in app.mp4'].labels.includes('Family') && !fs.existsSync(path.join(ROOT, 'clip_001.mp4')));
      fs.renameSync(path.join(ROOT, 'clip_002.mp4'), path.join(ROOT, 'renamed in Explorer.mp4'));
      await clickSel('[aria-label="Refresh"]');
      await sleep(1200);
      st = await stateOf(ROOT);
      check('renamed outside the app: found again by fingerprint', st['renamed in Explorer.mp4']?.stars === 2 && st['renamed in Explorer.mp4'].labels.includes('Family'));

      // ---- manage labels: rename (and merge), colour ----
      await clickText('Manage');
      await js(`[...document.querySelectorAll('[data-manage="Friends"] button')].find(b => b.innerText === 'Rename').click()`);
      await sleep(200);
      await js(`(() => { const i = document.querySelector('[data-manage="Friends"] input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'Pals'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await js(`[...document.querySelectorAll('[data-manage="Friends"] button')].find(b => b.innerText === 'Save').click()`);
      await sleep(500);
      check('rename a label everywhere', (await stateOf(ROOT))['goa.mp4'].labels.includes('Pals'));
      await shot('06-manage');
      await js(`document.querySelector('[role=dialog][aria-label="Manage labels"] [aria-label=Close]').click()`);

      // ---- export (JSON + CSV) and remember what to expect ----
      const n = await js(`window.clearup.tags.testExport(${JSON.stringify(path.join(OUT, 'labels.json'))})`);
      await js(`window.clearup.tags.testExport(${JSON.stringify(path.join(OUT, 'labels.csv'))})`);
      st = await stateOf(ROOT);
      fs.writeFileSync(EXPECTED, JSON.stringify(st, null, 1));
      check('export', n === 52 && fs.readFileSync(path.join(OUT, 'labels.csv'), 'utf8').includes('renamed in Explorer.mp4'), `${n} videos`);
    }

    if (STEP === 'restart') {
      const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
      await openFolder(ROOT);
      const st = await stateOf(ROOT);
      check('after a restart every label and star is still there', JSON.stringify(st) === JSON.stringify(expected), `${Object.keys(st).length} videos`);
      const shown = await js(`(() => { const t = document.querySelector('[data-tags="clip_000.mp4"]'); return t ? [t.querySelectorAll('[data-label]').length, t.querySelectorAll('[role=radio][aria-checked=true]').length] : null; })()`);
      check('grid shows them (stars and a label chip)', shown?.[0] >= 1 && shown?.[1] === 1, JSON.stringify(shown));
      await shot('01-after-restart');
      const b = await js('window.clearup.tags.backupNow()');
      const list = await js('window.clearup.tags.backups()');
      check('backup', list.length >= 1 && list[0].file === b.file, path.basename(b.file));
      await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText === 'Settings').click()`);
      await waitFor(async () => (await js(`document.querySelector('[aria-label="Labels and stars settings"]')?.innerText ?? ''`)).includes('Last:'), 8000)
        .then(() => check('Settings shows where labels are saved and the last backup', true), () => check('Settings shows where labels are saved and the last backup', false));
      await js(`document.querySelector('[aria-label="Labels and stars settings"]').scrollIntoView()`);
      await shot('02-settings');
    }

    if (STEP === 'laptop') {
      const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'));
      check('fresh library on "another laptop"', (await js('window.clearup.tags.labels()')).length === 0);
      const r = await js(`window.clearup.tags.testImport(${JSON.stringify(path.join(OUT, 'labels.json'))})`);
      check('import', r.waiting === 52 && r.labels === 6, JSON.stringify(r));   // 6: “Beach” is kept with no videos
      await openFolder(LAPTOP);
      await sleep(1500);
      const st = await stateOf(LAPTOP);
      // Same videos, other folder: labels and stars follow the content.
      check('after export → import on another laptop, every label and star is back', JSON.stringify(st) === JSON.stringify(expected), `${Object.keys(st).length} of ${Object.keys(expected).length}`);
      await clickSel('[aria-label="Filter by labels and stars"]');
      for (const l of ['Family', '2024']) { await clickText('+ label'); await addLabel(l, '[data-testid=filter-bar]'); }
      await js(`(() => { const s = document.querySelector('[aria-label="Minimum stars"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '4'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(500);
      check('filter works on the other laptop', JSON.stringify(await visibleNames()) === JSON.stringify(['clip_000.mp4', 'goa.mp4']));
      await shot('01-other-laptop');
      // CSV import into the same library: nothing new, nothing lost.
      const c = await js(`window.clearup.tags.testImport(${JSON.stringify(path.join(OUT, 'labels.csv'))})`);
      check('CSV import merges cleanly', c.labels === 0 && JSON.stringify(await stateOf(LAPTOP)) === JSON.stringify(expected), JSON.stringify(c));
    }
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, `results-${STEP}.json`), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
