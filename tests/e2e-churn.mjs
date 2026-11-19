// 1.0.9: a whole drive watched while its AppData changes all the time (a browser's cache, Temp): PixHaven must stay
// responsive, open tabs quickly, and index nothing from there. Plus Home's Recently played: remove one, Clear all.
// Run: npm run e2e:churn. Results in e2e-output/churn/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const DRIVE = path.join(OUT, 'Drive');
const VIDS = path.join(DRIVE, 'Users', 'Me', 'Videos');
const CACHE = path.join(DRIVE, 'Users', 'Me', 'AppData', 'Local', 'Browser', 'Cache');
const WIN = process.platform === 'win32';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(200); } return false; }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  async function shot(name) { win.webContents.invalidate(); await sleep(500); try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch { /* skipped */ } }
  const nav = label => js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`);
  const logText = () => { try { return fs.readFileSync(path.join(process.env.CLEARUP_USER_DATA, 'logs', 'clearup.log'), 'utf8'); } catch { return ''; } };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1300, 860);
    win.webContents.setBackgroundThrottling(false);
    fs.rmSync(DRIVE, { recursive: true, force: true });
    fs.mkdirSync(VIDS, { recursive: true }); fs.mkdirSync(CACHE, { recursive: true });
    const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
    for (const n of ['one', 'two', 'three']) spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'mpeg4', '-y', path.join(VIDS, `${n}.mp4`)]);
    for (const w of await js('window.clearup.watch.list()')) await js(`window.clearup.watch.remove(${JSON.stringify(w.path)})`);
    await js(`window.clearup.watch.add(${JSON.stringify(DRIVE)})`);
    await waitFor(async () => (await js('window.clearup.watch.list()'))[0]?.state === 'ready', 60000);
    const before = (logText().match(/Indexed .*Drive/g) ?? []).length;

    // ---- 20 s of a busy cache: new folders and video files, made and deleted, every 30 ms ----
    let stop = false, made = 0;
    const churn = (async () => {
      while (!stop) {
        const d = path.join(CACHE, `c${made % 40}`, `sub${made}`);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, `clip${made}.mp4`), Buffer.alloc(4096));
        if (made > 40) fs.rmSync(path.join(CACHE, `c${(made - 40) % 40}`, `sub${made - 40}`), { recursive: true, force: true });
        made++;
        await sleep(30);
      }
    })();
    // the window asks the main process something every 150 ms: how long does it wait?
    const waits = [];
    const pinger = (async () => { while (!stop) { const t = Date.now(); await js('window.clearup.watch.list()'); waits.push(Date.now() - t); await sleep(150); } })();
    // and opens tabs meanwhile
    const tabTimes = [];
    for (const [label, ready] of [['Videos', "!!document.querySelector('[data-testid=videos-count]')"], ['Library', "!!document.querySelector('[data-tab-panel]')"], ['Photos', 'true'], ['Home', "document.body.innerText.includes('What would you like to do?')"], ['Videos', "/3 videos/.test(document.querySelector('[data-testid=videos-count]')?.innerText ?? '')"]]) {
      const t = Date.now();
      await nav(label);
      await waitFor(async () => js(ready), 10000);
      tabTimes.push(`${label} ${Date.now() - t} ms`);
      await sleep(1500);
    }
    await sleep(Math.max(0, 20000 - tabTimes.length * 1700));
    stop = true;
    await churn; await pinger;
    await sleep(2500);
    const worst = Math.max(...waits), avg = waits.reduce((a, b) => a + b, 0) / waits.length;
    check('a busy AppData never holds PixHaven up (the window gets its answers)', worst < 500, `worst ${worst} ms, average ${avg.toFixed(0)} ms over ${waits.length} asks; ${made} cache files made`);
    check('tabs open quickly meanwhile', tabTimes.every(t => Number(t.split(' ')[1]) < 1500), tabTimes.join(' · '));
    const listed = await js(`window.clearup.watch.query({ text: '', type: 'video', filter: { labels: [], mode: 'all', minStars: 0 }, root: null })`);
    check('nothing from AppData is indexed', listed.items.length === 3 && listed.items.every(i => !/AppData/i.test(i.path)), `${listed.items.length} indexed: ${listed.items.map(i => path.basename(i.path)).join(', ')}`);
    const after = (logText().match(/Indexed .*Drive/g) ?? []).length;
    check('the drive is not indexed again and again', after === before, `${after - before} extra full passes`);
    check('no "call stack" or crash while re-reading', !/Maximum call stack|database is not open/.test(logText()));
    await shot('01-after-churn');

    // ---- Home: Recently played — remove one, then Clear all ----
    for (const [n, at] of [['one', 1.5], ['two', 1.2], ['three', 1.0]]) await js(`window.clearup.player.position(${JSON.stringify(path.join(VIDS, `${n}.mp4`))}, ${at}, 3)`);
    // positions under 5 s are not "stopped at"; make one look half watched for the line
    await js(`window.clearup.player.position(${JSON.stringify(path.join(VIDS, 'one.mp4'))}, 1.5, 3)`);
    await nav('Library'); await sleep(300); await nav('Home');
    await waitFor(async () => (await js(`document.querySelectorAll('[data-recent]').length`)) === 3, 10000);
    const shown = await js(`[...document.querySelectorAll('[data-recent]')].map(b => b.dataset.recent)`);
    await js(`document.querySelector('[data-recent="two.mp4"] [role=button][aria-label^="Remove"]').click()`);
    await waitFor(async () => (await js(`document.querySelectorAll('[data-recent]').length`)) === 2, 5000);
    const afterOne = await js(`[...document.querySelectorAll('[data-recent]')].map(b => b.dataset.recent)`);
    check('Recently played: × removes one video', shown.length === 3 && JSON.stringify(afterOne.sort()) === JSON.stringify(['one.mp4', 'three.mp4']), `${shown.join(', ')} → ${afterOne.join(', ')}`);
    await shot('02-recent');
    await js(`document.querySelector('[data-testid=clear-recent]').click()`);
    await waitFor(async () => !(await js(`!!document.querySelector('[aria-label="Recently played"]')`)), 5000);
    await nav('Library'); await sleep(300); await nav('Home'); await sleep(1200);
    check('"Clear all" empties it, and it stays empty', !(await js(`!!document.querySelector('[aria-label="Recently played"]')`)) && (await js('window.clearup.player.recent()')).length === 0);
    const kept = await js(`window.clearup.player.positions([${JSON.stringify(path.join(VIDS, 'one.mp4'))}])`);
    await js(`window.clearup.player.position(${JSON.stringify(path.join(VIDS, 'three.mp4'))}, 2, 3)`);
    const back = (await js('window.clearup.player.recent()')).map(r => path.basename(r.path));
    check('playing a video again puts it back (and the places are kept)', JSON.stringify(back) === JSON.stringify(['three.mp4']), `${back.join(', ')}; one.mp4 kept: ${JSON.stringify(kept)}`);
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
