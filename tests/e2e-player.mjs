// End-to-end check of v2.0 Phase B in the built app: every video in the test folder plays (directly, repackaged or
// converted), 4K HEVC/AV1 smoothly on the hardware decoder, seeking, sound tracks, subtitles, speed, mute, full screen,
// seek preview, resume, next video, and Home's recently played row.
// Run: npm run e2e:player. Screenshots + results.json land in e2e-output/player/.
import fs from 'node:fs';
import path from 'node:path';
import { makePlayerFolder } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const ROOT = path.join(OUT, 'Videos');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(150); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 100) : `"${t}"`}`);
  }
  const clickSel = async sel => { if (!await js(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`)) throw new Error(`No ${sel}`); await sleep(250); };
  const menuItem = async label => { if (!await js(`(() => { const b = [...document.querySelectorAll('[role=menu] button')].find(b => b.innerText.includes(${JSON.stringify(label)})); if (!b || b.disabled) return false; b.click(); return true; })()`)) throw new Error(`No menu item ${label}`); await sleep(300); };
  const key = async k => { await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(k)}, bubbles: true }))`); await sleep(250); };
  const dbl = async (name, startOver = true) => {
    const ok = await js(`(async () => { const box = document.querySelector('[role=listbox]');
      const find = () => [...document.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith(${JSON.stringify(path.sep + name)}));
      for (let y = 0; !find() && y <= box.scrollHeight; y += 250) { box.scrollTop = y; await new Promise(r => setTimeout(r, 60)); }
      const t = find(); if (!t) return false; t.scrollIntoView({ block: 'center' }); t.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error(`No tile ${name}`);
    // A position saved by an earlier run makes the player ask first: start from the beginning.
    if (startOver) {
      await sleep(700);
      await js(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText === 'Start over')?.click()`);
    }
  };
  const vid = () => js(`(() => { const v = document.querySelector('[data-testid=player-video]'); if (!v) return null;
    const q = v.getVideoPlaybackQuality(); return { t: v.currentTime, w: v.videoWidth, h: v.videoHeight, paused: v.paused, rate: v.playbackRate, muted: v.muted,
    err: v.error?.code ?? 0, dropped: q.droppedVideoFrames, total: q.totalVideoFrames, src: v.src }; })()`);
  const clock = async () => { const s = await js(`document.querySelector('[data-testid=player-time]')?.innerText ?? ''`); const [a] = s.split(' / '); const p = a.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const mode = () => js(`document.querySelector('[data-testid=player-mode]')?.innerText ?? ''`);
  async function shot(name) { win.webContents.invalidate(); await sleep(500); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const closePlayer = async () => { if (await js(`!!document.querySelector('[aria-label="Close player"]')`)) await clickSel('[aria-label="Close player"]'); await sleep(300); };

  // Chromium's media log tells which decoder each player uses (hardware = "platform" decoder).
  const decoders = [];
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  dbg.on('message', (_e, method, params) => {
    if (method !== 'Media.playerPropertiesChanged') return;
    const p = Object.fromEntries(params.properties.map(x => [x.name, x.value]));
    if (p.kVideoDecoderName) decoders.push({ name: p.kVideoDecoderName, platform: String(p.kIsPlatformVideoDecoder) === 'true' });
  });
  await dbg.sendCommand('Media.enable');

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 820);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    const files = await makePlayerFolder(ROOT);
    const videos = files.filter(f => /\.(mp4|m4v|mkv|avi|mov|wmv|flv|webm|3gp|mpg|ts|mts|m2ts|vob|ogv)$/.test(f));
    await js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, type: 'video', sortBy: 'name', sortDesc: false } }); })()`);
    await waitFor('What would you like to do?');
    await js(`window.__clearupLibrary(${JSON.stringify(ROOT)})`);
    await waitFor(async () => (await js(`document.querySelectorAll('[role=option]').length`)) > 5);

    // ---- every video plays (Phase B done-when) ----
    const slow = [];
    for (const f of videos) {
      await dbl(f);
      const t0 = Date.now();
      let ok = false, info = null;
      try {
        await waitFor(async () => { info = await vid(); return info && info.w > 0 && info.t > 0.4 && !info.err; }, 15000);
        ok = true;
      } catch { /* reported below */ }
      const ms = Date.now() - t0;
      const m = await mode();
      const how = /directly/.test(m) ? 'direct' : /converted/.test(m) && !/sound/.test(m) ? 'converted' : 'repackaged';
      check(`plays ${f}`, ok && ms < 4000, `${how}, ${info?.w}×${info?.h}, started in ${(ms / 1000).toFixed(1)} s`);
      if (ms > 3000) slow.push(f);
      if (f === 'clip.wmv') await shot('01-wmv-converted');
      await closePlayer();
    }

    // ---- 4K HEVC and AV1: smooth, on the hardware decoder (PLAY-06) ----
    for (const f of ['4k hevc.mp4', '4k av1.mp4']) {
      decoders.length = 0;
      await dbl(f);
      await waitFor(async () => ((await vid())?.t ?? 0) > 0.5, 15000);
      await sleep(6000);
      const q = await vid();
      const dec = decoders.at(-1);
      check(`${f} plays smoothly`, q.total > 120 && q.dropped / q.total < 0.02, `${q.dropped} of ${q.total} frames dropped`);
      check(`${f} uses the hardware decoder`, !!dec?.platform, dec ? `${dec.name}` : 'no decoder reported');
      if (f === '4k hevc.mp4') await shot('02-4k-hevc');
      await closePlayer();
    }

    // ---- two sound tracks + embedded subtitles + seeking a repackaged stream ----
    await dbl('two tracks.mkv');
    await waitFor(async () => ((await vid())?.t ?? 0) > 0.3, 15000);
    await clickSel('[aria-label="Subtitles"]');
    await menuItem('English');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-subtitle]')?.innerText ?? ''`)) === 'Embedded subtitle line', 8000)
      .then(() => check('embedded subtitles shown', true), () => check('embedded subtitles shown', false));
    await waitFor(async () => (await clock()) >= 3, 8000);
    const beforeSwitch = await clock();
    await clickSel('[aria-label="Sound track"]');
    await menuItem('Hindi');
    await waitFor(async () => /sound track/i.test(await mode()), 8000);
    await waitFor(async () => ((await vid())?.t ?? 0) > 0.2 && !(await vid()).paused, 8000);
    const afterSwitch = await clock();
    check('switch to the second sound track, same place', /Switched sound track/.test(await mode()) && afterSwitch >= beforeSwitch - 0.5 && afterSwitch <= beforeSwitch + 3, `${await mode()}: ${beforeSwitch} s → ${afterSwitch} s`);
    await shot('03-tracks-subtitles');
    // Click the seek bar at 62% of 20 s ≈ 12.4 s: the stream restarts on the keyframe at 12 s.
    await js(`(() => { const b = document.querySelector('[data-testid=player-seek]'); const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.62, clientY: r.top + r.height / 2 })); })()`);
    await waitFor(async () => { const c = await clock(); return c >= 12 && c <= 15; }, 10000)
      .then(async () => check('seek in a repackaged stream keeps the clock right', true, `${await clock()} s`), async () => check('seek in a repackaged stream keeps the clock right', false, `${await clock()} s`));
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-subtitle]')?.innerText ?? ''`)) === 'Second embedded line', 6000)
      .then(() => check('subtitles follow the seek', true), () => check('subtitles follow the seek', false));

    // ---- seek preview, speed, mute, full screen (paused, so the clip doesn't run out) ----
    await key(' ');
    await js(`(() => { const b = document.querySelector('[data-testid=player-seek]'); const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + r.width * 0.3, clientY: r.top + 5 })); })()`);
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-preview]')?.naturalWidth ?? 0`)) > 0, 8000)
      .then(() => check('seek bar shows a preview frame', true), () => check('seek bar shows a preview frame', false));
    await shot('04-seek-preview');
    await js(`document.querySelector('[data-testid=player-seek]').dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))`);
    await clickSel('[aria-label="Speed"]');
    await menuItem('2×');
    check('speed 2×', (await vid()).rate === 2);
    await clickSel('[aria-label="Speed"]');
    await menuItem('Normal');
    await key('m');
    check('mute (M key)', (await vid()).muted === true);
    await key('m');
    await key('f');
    await sleep(600);
    check('full screen (F key)', await js(`!!document.fullscreenElement`));
    await key('Escape');
    await sleep(600);
    check('Esc leaves full screen first', await js(`!document.fullscreenElement && !!document.querySelector('[data-testid=player-video]')`));

    // ---- resume where you stopped (PLAY-05) ----
    await js(`(() => { const b = document.querySelector('[data-testid=player-seek]'); const r = b.getBoundingClientRect();
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width * 0.45, clientY: r.top + r.height / 2 })); })()`);
    await waitFor(async () => { const c = await clock(); return c >= 8 && c <= 11; }, 10000);
    await sleep(1200);
    const stoppedAt = await clock();
    await closePlayer();
    await dbl('two tracks.mkv', false);
    const saved = JSON.stringify((await js('window.clearup.player.recent()')).find(r => r.path.endsWith('two tracks.mkv')));
    await waitFor('You stopped at', 10000).then(() => check('offers to resume', true), async () => check('offers to resume', false, `stopped at ${stoppedAt} s, saved ${saved}, video ${JSON.stringify(await vid())}`));
    await shot('05-resume');
    await js(`[...document.querySelectorAll('[role=alertdialog] button')].find(b => b.innerText.startsWith('Resume')).click()`);
    await waitFor(async () => { const v = await vid(); return v && !v.paused && v.t > 0; }, 10000);
    await sleep(800);
    const resumed = await clock();
    check('resumes where it stopped', Math.abs(resumed - stoppedAt) <= 3, `stopped ${stoppedAt} s, resumed ${resumed} s`);

    // ---- previous video (P); "two tracks.mkv" is the last one by name ----
    await key('p');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-name]')?.innerText`)) !== 'two tracks.mkv', 5000);
    check('previous video in the folder (P key)', true, await js(`document.querySelector('[data-testid=player-name]').innerText`));
    await closePlayer();

    // ---- subtitle file next to the video ----
    await dbl('clip h264.mp4');
    await waitFor(async () => ((await vid())?.t ?? 0) > 0.1, 10000);
    await clickSel('[aria-label="Subtitles"]');
    await menuItem('clip h264.srt');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-subtitle]')?.innerText ?? ''`)) === 'Hello from the subtitle file', 8000)
      .then(() => check('subtitle file next to the video', true), () => check('subtitle file next to the video', false));
    await closePlayer();

    // ---- Home: recently played ----
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText === 'Home').click()`);
    await waitFor('Recently played', 8000);
    const recent = await js(`[...document.querySelectorAll('[aria-label="Recently played"] button')].map(b => b.title.split(/[\\\\/]/).pop())`);
    check('Home lists recently played videos', recent.includes('two tracks.mkv') && recent.includes('clip h264.mp4'), recent.join(', '));
    await shot('06-home-recent');
    await js(`[...document.querySelectorAll('[aria-label="Recently played"] button')].find(b => b.title.endsWith('two tracks.mkv')).click()`);
    await waitFor(async () => (await js(`document.querySelector('[data-testid=player-name]')?.innerText`)) === 'two tracks.mkv', 10000)
      .then(() => check('recently played opens the player', true), () => check('recently played opens the player', false));
    await closePlayer();
    await js(`(async () => { const s = await window.clearup.getSettings(); await window.clearup.setSettings({ library: { ...s.library, type: 'all', lastDir: null } }); })()`);
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  try { dbg.detach(); } catch { /* closed */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
