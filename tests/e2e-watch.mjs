// End-to-end check of v2.1 in the built app, in two launches (scripts/run-e2e-watch.mjs, own app-data folder):
//   watch   – watch two folders (button + API), instant search from the index, keyboard shortcuts, labels and stars on
//             photos in the viewer, the "all watched folders" view filtered without browsing, a playlist saved from a
//             filter and played (goes on by itself), indexing paused while a video plays, live changes (new, moved with
//             labels, deleted), stars and labels written into the files (TAG-08) and kept up to date
//   restart – same app data: folders, index and playlist still there; a file added while PixHaven was closed is found
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const STEP = process.env.CLEARUP_E2E_STEP ?? 'watch';
const A = path.join(OUT, 'Watched A'), B = path.join(OUT, 'Watched B');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const ref = p => { const s = fs.statSync(p); return { path: p, size: s.size, mtime: s.mtimeMs }; };

function makeMedia() {
  for (const d of [A, B]) fs.rmSync(d, { recursive: true, force: true });
  const ff = args => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const photo = (p, hue) => { fs.mkdirSync(path.dirname(p), { recursive: true }); ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=1:duration=1', '-vf', `hue=h=${hue}`, '-frames:v', '1', p]); };
  const video = (p, hue, codec = 'libopenh264') => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-vf', `hue=h=${hue}`,
      '-pix_fmt', 'yuv420p', '-c:v', codec, '-c:a', 'aac', '-shortest', p]);
  };
  ['beach_1', 'beach_2', 'beach_3', 'beach_4'].forEach((n, i) => photo(path.join(A, 'Goa 2024', `${n}.jpg`), i * 40));
  photo(path.join(A, 'Goa 2024', 'Day 2', 'sunset.jpg'), 200);
  photo(path.join(A, 'portrait.jpg'), 260);
  video(path.join(A, 'Goa 2024', 'surf.mp4'), 10);
  video(path.join(A, 'Goa 2024', 'Day 2', 'boat.mp4'), 60);
  video(path.join(A, 'family_dinner.mp4'), 120);
  video(path.join(A, 'party.mkv'), 180);
  photo(path.join(B, 'old.jpg'), 300);
  video(path.join(B, 'clip.mp4'), 330);
}

/** Rating and keywords as ExifTool reads them (an argument file keeps any name intact). */
function readTags(file) {
  const args = path.join(os.tmpdir(), `clearup-e2e-read-${Date.now()}.args`);
  fs.writeFileSync(args, ['-j', '-charset', 'filename=utf8', '-XMP-xmp:Rating', '-XMP-dc:Subject', '-Microsoft:SharedUserRating', file].join('\n') + '\n');
  try {
    const j = JSON.parse(execFileSync(EXIFTOOL, ['-@', args], { encoding: 'utf8' }))[0];
    const list = v => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);
    return { rating: Number(j.Rating ?? 0), subject: list(j.Subject), ms: j.SharedUserRating };
  } finally { fs.rmSync(args, { force: true }); }
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 20000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(150); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 120) : `"${t}"`}`);
  }
  const soon = async (fn, ms = 15000) => { try { return await waitFor(fn, ms); } catch { return false; } };
  const check = (name, pass, detail = '') => { results.push({ name: `[${STEP}] ${name}`, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} [${STEP}] ${name} ${detail}`); };
  async function shot(name) { win.webContents.invalidate(); await sleep(500); fs.writeFileSync(path.join(OUT, `${STEP}-${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const clickSel = async sel => { if (!await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`)) throw new Error(`No ${sel}`); await sleep(300); };
  const clickHas = async (label, scope = 'button') => { if (!await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.offsetParent && b.innerText.includes(${JSON.stringify(label)})); if (!b || b.disabled) return false; b.click(); return true; })()`)) throw new Error(`No "${label}"`); await sleep(300); };
  const key = async (k, o = {}) => { await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true, ctrlKey: ${!!o.ctrl}, shiftKey: ${!!o.shift}, altKey: ${!!o.alt} }))`); await sleep(250); };
  const tile = async (name, how = 'click', mods = {}) => {
    const ok = await js(`(async () => { const box = document.querySelector('[role=listbox]');
      const find = () => [...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.split(/[\\\\/]/).pop() === ${JSON.stringify(name)});
      for (let y = 0; !find() && y <= box.scrollHeight; y += 200) { box.scrollTop = y; await new Promise(r => setTimeout(r, 50)); }
      const t = find(); if (!t) return false; t.scrollIntoView({ block: 'center' });
      t.dispatchEvent(new MouseEvent(${JSON.stringify(how)}, { bubbles: true, ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift} })); return true; })()`);
    if (!ok) throw new Error(`No tile ${name}`);
    await sleep(300);
  };
  const hasTile = name => js(`[...document.querySelectorAll('[role=option][data-path]')].some(e => e.dataset.path.split(/[\\\\/]/).pop() === ${JSON.stringify(name)})`);
  const setInput = async (sel, value, enter = false) => {
    await js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(250);
    if (enter) { await js(`document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`); await sleep(400); }
  };
  const addLabel = (name, scope) => setInput(`${scope} input[aria-label="Add a label"]`, name, true);
  const openFolder = async (dir, expect) => { await js(`window.__clearupLibrary(${JSON.stringify(dir)})`); await waitFor(() => hasTile(expect), 15000); await sleep(600); };
  const counts = () => js(`document.querySelector('[data-testid=lib-counts]')?.innerText ?? ''`);
  const tagsOf = async file => {
    const r = await js(`window.clearup.tags.forFiles(${JSON.stringify([ref(file)])})`);
    const labels = await js('window.clearup.tags.labels()');
    const t = r.tags[file];
    return t ? { stars: t.stars, labels: t.labels.map(id => labels.find(l => l.id === id)?.name).sort() } : null;
  };
  const watched = () => js('window.clearup.watch.list()');
  const allReady = async n => { const w = await watched(); return w.length === n && w.every(x => x.state === 'ready'); };
  const NO = { labels: [], mode: 'all', minStars: 0 };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    await waitFor('What would you like to do?');
    await js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, view: 'grid', size: 'm', type: 'all', sortBy: 'name', sortDesc: false } }); })()`);

    if (STEP === 'watch') {
      makeMedia();
      // ---- watch two folders: the footer button and the API ----
      await openFolder(A, 'portrait.jpg');
      await clickHas('Watch this folder', 'footer button');
      await js(`window.clearup.watch.add(${JSON.stringify(B)})`);
      await waitFor(() => allReady(2), 30000);
      const w = await watched();
      check('two folders watched and indexed', w[0].files === 10 && w[1].files === 2, w.map(x => `${path.basename(x.path)}: ${x.files} ${x.state}`).join(', '));
      check('watched folders listed on the left', await soon(async () => (await js(`document.querySelectorAll('[data-watch-view]').length`)) === 3, 5000));
      await shot('01-watched');

      // ---- LIB-08: search answered from the index ----
      await setInput('input[aria-label="Search by name"]', 'sunset', true);
      await soon(async () => (await js(`document.querySelector('[data-testid=search-status]')?.innerText ?? ''`)).includes('1 found'), 5000);
      const st = await js(`document.querySelector('[data-testid=search-status]')?.innerText ?? ''`);
      check('search inside a watched folder comes from the index', st.includes('1 found') && st.includes('watched-folder index') && await hasTile('sunset.jpg'), st);
      await clickHas('Back to folder');
      await setInput('input[aria-label="Search by name"]', '');
      await js('document.activeElement?.blur()');

      // ---- keyboard shortcuts in the grid ----
      await key('Home');
      await key('ArrowRight');                                   // folder "Goa 2024", then family_dinner.mp4
      await key('ArrowRight', { shift: true });                  // + party.mkv
      const sel = await js(`[...document.querySelectorAll('[role=option][aria-selected=true]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).join(',')`);
      await key('4');
      await sleep(400);
      const fd = await tagsOf(path.join(A, 'family_dinner.mp4')), pm = await tagsOf(path.join(A, 'party.mkv'));
      check('arrow keys select, Shift extends, 4 rates the selection', sel === 'family_dinner.mp4,party.mkv' && fd?.stars === 4 && pm?.stars === 4, sel);
      await key('End');
      await key('Enter');
      await waitFor(() => js(`!!document.querySelector('[role=dialog][aria-label="Viewer: portrait.jpg"]')`), 8000);
      // ---- TAG-09: labels and stars on a photo, from the viewer ----
      await key('3');
      await key('s');
      await waitFor(() => js(`!!document.querySelector('[aria-label="Labels and stars panel"] input')`), 5000);
      await addLabel('Holiday', '[aria-label="Labels and stars panel"]');
      const pt = await tagsOf(path.join(A, 'portrait.jpg'));
      check('photo: stars with key 3 and a label in the viewer panel (TAG-09)', pt?.stars === 3 && pt.labels.join() === 'Holiday', JSON.stringify(pt));
      await shot('02-photo-labels');
      await js('document.activeElement?.blur()');
      await key('Escape');
      await sleep(300);
      check('photo tile shows its stars and label', await js(`!!document.querySelector('[data-tags="portrait.jpg"] [data-label="Holiday"]')`));
      await key('?');
      check('? shows the keyboard shortcuts', await js(`!!document.querySelector('[role=dialog][aria-label="Keyboard shortcuts"]')`));
      await key('Escape');

      // Labels for the playlist (videos in subfolders that were never opened).
      const fam = [path.join(A, 'family_dinner.mp4'), path.join(A, 'party.mkv'), path.join(A, 'Goa 2024', 'surf.mp4'), path.join(A, 'Goa 2024', 'Day 2', 'boat.mp4')];
      await js(`window.clearup.tags.addLabel(${JSON.stringify(fam.map(ref))}, 'Family', null)`);
      await js(`window.clearup.tags.setStars(${JSON.stringify([ref(fam[2])])}, 5)`);
      await js(`window.clearup.tags.setStars(${JSON.stringify([ref(fam[3])])}, 2)`);

      // ---- "All watched folders": search and filter without browsing ----
      await clickSel('[data-watch-view="all"]');
      await waitFor(async () => (await counts()).includes('7 photos · 5 videos'), 8000);
      check('all watched folders: every photo and video', true, await counts());
      await setInput('input[aria-label="Search by name"]', 'beach');
      await waitFor(async () => (await counts()) === '4 photos · 0 videos', 5000).catch(() => {});
      check('search in the watched view', (await counts()).startsWith('4 photos'), await counts());
      await setInput('input[aria-label="Search by name"]', '');
      await js('document.activeElement?.blur()');
      if (!(await js(`!!document.querySelector('[data-testid=filter-bar]')`))) await clickSel('[aria-label="Filter by labels and stars"]');
      await clickHas('+ label', '[data-testid=filter-bar] button');
      await setInput('[data-testid=filter-bar] input[aria-label="Add a label"]', 'Family', true);
      await js(`(() => { const s = document.querySelector('select[aria-label="Minimum stars"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '4'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await soon(async () => (await counts()).includes('3 videos'), 8000);
      const names = await js(`[...document.querySelectorAll('[role=option][data-path]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).sort().join(',')`);
      check('filter "Family, 4+ stars" over watched folders, never browsed', names === 'family_dinner.mp4,party.mkv,surf.mp4', names);

      // ---- PLAY-08: save as playlist, play all ----
      await clickHas('Save as playlist', '[data-testid=filter-bar] button');
      await setInput('input[aria-label="Playlist name"]', 'Best of family', true);
      await waitFor(() => js(`!!document.querySelector('[data-playlist="Best of family"]')`), 5000);
      check('playlist saved and listed on the left', (await js(`document.querySelector('[data-testid=lib-title]')?.innerText`)) === 'Best of family');
      await shot('03-playlist');
      await clickHas('Play all');
      await waitFor(async () => (await js(`document.querySelector('[data-testid=player-video]')?.currentTime ?? 0`)) > 0.3, 15000);
      const p1 = await js(`document.querySelector('[data-testid=player-playlist]')?.innerText ?? ''`);
      // Indexing waits while a video plays (low-spec): ask for a fresh pass now.
      await js(`window.clearup.watch.reindex(${JSON.stringify(A)})`);
      const paused = await soon(async () => (await watched()).find(x => x.path === A)?.state === 'paused', 6000);
      check('indexing pauses while a video plays', paused, (await watched()).map(x => x.state).join(','));
      await js(`(() => { const v = document.querySelector('[data-testid=player-video]'); v.currentTime = Math.max(0, v.duration - 0.15); v.play(); })()`);
      const p2ok = await soon(async () => (await js(`document.querySelector('[data-testid=player-playlist]')?.innerText ?? ''`)).includes('2 of 3'), 15000);
      check('playlist plays the next video by itself', p1.includes('Best of family · 1 of 3') && p2ok, `${p1} → ${await js(`document.querySelector('[data-testid=player-playlist]')?.innerText ?? ''`)}`);
      await shot('04-playing');
      await key('Escape');
      await waitFor(() => allReady(2), 20000);
      check('indexing carries on when the video closes', true);

      // ---- live changes in watched folders ----
      await clickSel('[data-watch-view="all"]');
      await clickHas('Clear filter', '[data-testid=filter-bar] button');
      await waitFor(async () => (await counts()).includes('7 photos'), 8000);
      fs.copyFileSync(path.join(A, 'portrait.jpg'), path.join(A, 'Goa 2024', 'new photo.jpg'));
      check('a new photo shows up by itself', await soon(async () => (await counts()).includes('8 photos'), 15000), await counts());
      fs.mkdirSync(path.join(B, 'Moved'));
      const movedTo = path.join(B, 'Moved', 'family_dinner.mp4');
      fs.renameSync(path.join(A, 'family_dinner.mp4'), movedTo);
      const followed = await soon(async () => (await js(`window.clearup.tags.query(${JSON.stringify(NO)}, '')`)).some(r => r.path === movedTo && r.stars === 4), 15000);
      const mt = await tagsOf(movedTo);
      check('labels follow a file moved to another watched folder outside the app', followed && mt?.labels.join() === 'Family', JSON.stringify(mt));
      // A subfolder renamed in Explorer: everything in it is re-indexed, labels follow.
      fs.renameSync(path.join(A, 'Goa 2024', 'Day 2'), path.join(A, 'Goa 2024', 'Day two'));
      const boat = path.join(A, 'Goa 2024', 'Day two', 'boat.mp4');
      const bt = await soon(async () => (await js(`window.clearup.tags.query(${JSON.stringify(NO)}, '')`)).some(r => r.path === boat), 15000);
      const sunsetIdx = await js(`window.clearup.watch.query({ text: 'sunset', type: 'all', filter: ${JSON.stringify(NO)}, root: null })`);
      check('a renamed subfolder: index and labels follow', bt && sunsetIdx.items[0]?.path === path.join(A, 'Goa 2024', 'Day two', 'sunset.jpg'), sunsetIdx.items[0]?.path ?? '');
      // Windows refuses to delete a file another program has open: check PixHaven doesn't keep photos open.
      let lockedMs = 0;
      for (const t0 = Date.now(); ; await sleep(250)) {
        try { fs.rmSync(path.join(B, 'old.jpg')); break; } catch (e) { lockedMs = Date.now() - t0; if (lockedMs > 20000) throw e; }
      }
      check('PixHaven does not keep photos open (Explorer can delete them)', lockedMs === 0, lockedMs ? `locked for ${lockedMs} ms` : '');
      check('a deleted photo disappears', await soon(async () => (await counts()).includes('7 photos'), 15000), await counts());
      await js(`window.__clearupLibrary(${JSON.stringify(B)})`);
      await waitFor(() => hasTile('clip.mp4'), 10000);
      fs.copyFileSync(path.join(A, 'Goa 2024', 'beach_1.jpg'), path.join(B, 'live.jpg'));
      check('the open folder updates by itself', await soon(() => hasTile('live.jpg'), 15000));
      await shot('05-live');

      // ---- TAG-08: write into the files (Settings switch) ----
      await clickHas('Settings', 'nav button');
      await waitFor(() => js(`!!document.querySelector('[role=switch][aria-label="Also write stars and labels into the files"]')`), 5000);
      check('settings: watched folders card lists both', (await js(`document.querySelectorAll('[data-watched]').length`)) === 2);
      const surf = path.join(A, 'Goa 2024', 'surf.mp4');
      const surfDate = fs.statSync(surf).mtimeMs;
      await clickSel('[role=switch][aria-label="Also write stars and labels into the files"]');
      await waitFor(async () => (await js('window.clearup.tags.writeStatus()')).written >= 5, 30000);
      const ws = await js('window.clearup.tags.writeStatus()');
      await js(`document.querySelector('[aria-label="Watched folders settings"]').scrollIntoView({ block: 'start' })`);
      await shot('06-write-setting');
      const s1 = readTags(surf), p1t = readTags(path.join(A, 'portrait.jpg')), side = path.join(A, 'party.xmp');
      const sd = fs.existsSync(side) ? readTags(side) : null;
      check('written into MP4 (Explorer rating too) and JPG', s1.rating === 5 && s1.subject.join() === 'Family' && s1.ms === 99 && p1t.rating === 3 && p1t.subject.join() === 'Holiday', JSON.stringify({ s1, p1t }));
      check('MKV gets an .xmp sidecar', sd?.rating === 4 && sd.subject.join() === 'Family', JSON.stringify(sd));
      check('file dates are kept', Math.abs(fs.statSync(surf).mtimeMs - surfDate) < 2000);
      check('nothing failed to write', ws.failed.length === 0, JSON.stringify(ws.failed));
      await js(`window.clearup.tags.setStars(${JSON.stringify([ref(surf)])}, 2)`);
      check('a new rating follows into the file', await soon(async () => readTags(surf).rating === 2, 15000), JSON.stringify(readTags(surf)));
      // Renamed outside the app after the write: still recognised (the fingerprint was updated after writing).
      const surf2 = path.join(A, 'Goa 2024', 'surfing.mp4');
      fs.renameSync(surf, surf2);
      const kept = await soon(async () => (await tagsOf(surf2))?.stars === 2, 15000);
      check('a written file renamed in Explorer keeps its labels', kept, JSON.stringify(await tagsOf(surf2)));
      // Renamed in the app: its .xmp sidecar goes with it.
      await js(`window.clearup.tags.renameFile(${JSON.stringify(path.join(A, 'party.mkv'))}, 'party night.mkv')`);
      check('renaming in the app takes the sidecar along', fs.existsSync(path.join(A, 'party night.xmp')) && !fs.existsSync(side));

      fs.writeFileSync(path.join(OUT, 'expected.json'), JSON.stringify({ movedTo, surf2 }));
    }

    if (STEP === 'restart') {
      const exp = JSON.parse(fs.readFileSync(path.join(OUT, 'expected.json'), 'utf8'));
      const w0 = await watched();
      check('watched folders kept after a restart', w0.length === 2, w0.map(x => x.state).join(','));
      await waitFor(() => allReady(2), 30000);
      const q = await js(`window.clearup.watch.query({ text: 'added while closed', type: 'all', filter: ${JSON.stringify(NO)}, root: null })`);
      check('a photo added while PixHaven was closed is found', q.total === 1);
      await js(`window.__clearupLibrary(${JSON.stringify(A)})`);
      await waitFor(() => js(`!!document.querySelector('[data-playlist="Best of family"]')`), 8000);
      await clickSel('[data-playlist="Best of family"]');
      // surf.mp4 went down to 2 stars, so "Family, 4+ stars" now holds the moved dinner video and the renamed party video.
      await soon(async () => (await counts()).includes('2 videos'), 8000);
      const pl = await js(`[...document.querySelectorAll('[role=option][data-path]')].map(e => e.dataset.path.split(/[\\\\/]/).pop()).sort().join(',')`);
      check('playlist kept, and it stays up to date (moved and renamed files included)', pl === 'family_dinner.mp4,party night.mkv', pl);
      const mt = await tagsOf(exp.movedTo), sf = await tagsOf(exp.surf2);
      check('labels of moved and renamed files kept', mt?.labels.join() === 'Family' && sf?.stars === 2);
      await shot('01-after-restart');
    }
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e).split('\n').slice(0, 3).join(' | '));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, `results-${STEP}.json`), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
