// End-to-end check of 1.0.7 in the built app, against a real Attic server (the attic repo next to this one, 0.14+)
// reached through this PC's network address (so pairing is needed, like from another PC): set up (address, 6-digit
// code, sign in), browse with thumbnails and details, play an Attic video in the watch page, stars on an Attic file,
// "Move to Attic" from the Library (grey until connected; labels follow), Attic videos in the Videos tab, rename and
// delete on Attic (its 30-day trash), and "Move to this PC". Run: npm run e2e:attic.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const HOME = path.join(OUT, 'HP share');
const LOCAL = path.join(OUT, 'This PC');
const BACK = path.join(OUT, 'Back from Attic');
const SERVER = path.resolve('..', 'attic', 'server', 'server.js');
const PORT = 23000 + Math.floor(Math.random() * 1000);
const WIN = process.platform === 'win32';
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lanIp = () => Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;

function clip(file, pattern, seconds) {
  const ff = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
  const r = spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', `${pattern}=size=480x270:rate=25:duration=${seconds}`, '-c:v', 'mpeg4', '-q:v', '6', '-y', file]);
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}
/** A cookie-keeping client for the test's own setup (as the HP itself: 127.0.0.1 is trusted). */
function hp() {
  let cookie = null;
  return async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return res.json().catch(() => null);
  };
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
  const nav = label => js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`).then(() => sleep(700));
  const attic = `document.querySelector('[data-testid=attic-page]')`;
  const setInput = (sel, v) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(v)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`).then(() => sleep(300));
  const clickText = async (label, scope = 'document') => {
    const ok = await js(`(() => { const b = [...${scope}.querySelectorAll('button')].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(400);
  };
  const tiles = scope => js(`[...${scope}.querySelectorAll('[role=option][data-path]')].map(e => e.dataset.path)`);
  const tile = (scope, endsWith, how = 'click', ctrl = false) => js(`(() => { const t = [...${scope}.querySelectorAll('[role=option][data-path]')].find(e => e.dataset.path.endsWith(${JSON.stringify(endsWith)})); if (!t) return false; t.dispatchEvent(new MouseEvent(${JSON.stringify(how)}, { bubbles: true, ctrlKey: ${ctrl} })); return true; })()`).then(async ok => { if (!ok) throw new Error(`No tile ${endsWith}`); await sleep(400); });
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`screenshot ${name} skipped: ${e.message}`); }
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const stars = async (p, size) => (await js(`window.clearup.tags.forFiles([${JSON.stringify({ path: p, size, mtime: 0 })}])`)).tags[p]?.stars ?? 0;
  let server;

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 880);
    win.webContents.setBackgroundThrottling(false);
    if (!fs.existsSync(SERVER)) throw new Error(`The attic repo is not next to this one (${SERVER}).`);
    process.env.PIXHAVEN_TEST_TRASH = path.join(OUT, 'test recycle bin');   // moves never touch the real Recycle Bin
    for (const d of [HOME, LOCAL, BACK, process.env.PIXHAVEN_TEST_TRASH]) fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(path.join(HOME, 'Videos'), { recursive: true }); fs.mkdirSync(path.join(HOME, 'Photos'), { recursive: true });
    fs.mkdirSync(LOCAL, { recursive: true }); fs.mkdirSync(BACK, { recursive: true });
    clip(path.join(HOME, 'Videos', 'hp clip.mp4'), 'testsrc', 6);
    clip(path.join(LOCAL, 'from pc.mp4'), 'testsrc2', 4);
    const sharp = (await import('sharp')).default;
    await sharp({ create: { width: 640, height: 480, channels: 3, background: '#c63' } }).jpeg().toFile(path.join(HOME, 'Photos', 'sunset.jpg'));
    const data = path.join(OUT, 'attic data');
    fs.rmSync(data, { recursive: true, force: true });
    fs.writeFileSync(path.join(OUT, 'attic-config.json'), JSON.stringify({ host: '0.0.0.0', shares: [{ id: 'home', name: 'Home Media', rootPath: HOME }] }));
    server = spawn(process.execPath.endsWith('electron.exe') ? 'node' : process.execPath, [SERVER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ATTIC_CONFIG: path.join(OUT, 'attic-config.json'), ATTIC_DATA: data, ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'], shell: false,
    });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); }); server.on('exit', c => reject(new Error('attic server exited ' + c))); setTimeout(() => reject(new Error('attic server did not start')), 20000); });
    const H = hp();
    await H('POST', '/api/setup', { displayName: 'Master', username: 'master', password: 'master-pass' });
    await H('POST', '/api/session', { mode: 'master', username: 'master', password: 'master-pass' });
    await H('POST', '/api/accounts', { displayName: 'Laptop', username: 'laptop', password: 'laptop-pass', deviceType: 'laptop' });
    const code = (await H('POST', '/api/pairing/codes', {})).code;
    const ip = lanIp();
    await js(`localStorage.clear()`);
    await js('window.clearup.attic.forget()');
    await waitFor('What would you like to do?');

    // ---- not connected: "Move to Attic" is grey ----
    await js(`window.__clearupLibrary(${JSON.stringify(LOCAL)})`);
    await waitFor(async () => (await tiles(`document.querySelector('[data-tab-panel]:not(.hidden)')`)).length === 1, 15000);
    await tile(`document.querySelector('[data-tab-panel]:not(.hidden)')`, 'from pc.mp4');
    const grey = await js(`(b => b && { disabled: b.disabled, title: b.title, bg: getComputedStyle(b).backgroundColor })(document.querySelector('[data-tab-panel]:not(.hidden) [data-testid=move-to-attic]'))`);
    check('"Move to Attic" is grey and says why while Attic is not set up', grey?.disabled === true && /Set up Attic/.test(grey.title), JSON.stringify(grey));

    // ---- set up: address → code → sign in ----
    await nav('Attic');
    await waitFor(async () => (await js(`${attic}?.dataset.atticState`)) === 'none', 10000);
    await setInput('input[aria-label="Attic address"]', `${ip}:${PORT}`);
    await clickText('Connect');
    await waitFor(async () => (await js(`${attic}.dataset.atticState`)) === 'unpaired', 15000);
    check('step 1: the address finds Attic, which asks for pairing', true, ip);
    await shot('01-pair');
    await setInput('input[aria-label="Pairing code"]', code);
    await clickText('Pair');
    await waitFor(async () => (await js(`${attic}.dataset.atticState`)) === 'signed-out', 15000);
    check('step 2: the 6-digit code pairs PixHaven', true);
    await setInput('input[aria-label="Attic username"]', 'laptop');
    await setInput('input[aria-label="Attic password"]', 'wrong-pass');
    await clickText('Sign in');
    await soft(waitFor(async () => /password/i.test(await js(`${attic}.innerText`)), 5000));
    const wrong = await js(`${attic}.dataset.atticState`);
    await setInput('input[aria-label="Attic password"]', 'laptop-pass');
    await clickText('Sign in');
    await waitFor(async () => (await js(`${attic}.dataset.atticState`)) === 'connected', 15000);
    const saved = fs.readFileSync(path.join(process.env.CLEARUP_USER_DATA, 'attic.json'), 'utf8');
    check('step 3: a wrong password is refused; the right one signs in, and the password is not kept', wrong === 'signed-out' && !saved.includes('laptop-pass') && !saved.includes('"session"'),
      await js(`document.querySelector('[data-testid=attic-account]').innerText`));
    await soft(waitFor(async () => !!(await js(`${attic}.querySelector('[data-testid=attic-empty]')`)), 10000));
    check('a device account sees only its own files, and the empty folder says why', /belong to the master/.test(await js(`${attic}.querySelector('[data-testid=attic-empty]')?.innerText ?? ''`)));
    // The files already on the HP are the master's: sign in as the master (from this paired PC).
    await clickText('Sign out');
    await waitFor(async () => (await js(`${attic}.dataset.atticState`)) === 'signed-out', 10000);
    await setInput('input[aria-label="Attic username"]', 'master');
    await setInput('input[aria-label="Attic password"]', 'master-pass');
    await js(`document.querySelector('input[aria-label="Master account"]').click()`);
    await clickText('Sign in');
    await waitFor(async () => (await js(`${attic}.dataset.atticState`)) === 'connected', 15000);
    check('the master signs in from the paired PC and sees the files on the HP', /master/.test(await js(`document.querySelector('[data-testid=attic-account]').innerText`)));

    // ---- browse: folders, thumbnails, details ----
    await waitFor(async () => (await tiles(attic)).some(p => p.endsWith('/Videos')), 15000);
    await tile(attic, '/Videos', 'dblclick');
    await waitFor(async () => (await tiles(attic)).some(p => p.endsWith('hp clip.mp4')), 10000);
    await soft(waitFor(async () => (await js(`[...${attic}.querySelectorAll('[role=option] img')].filter(i => i.complete && i.naturalWidth).length`)) >= 1, 20000));
    check('Attic folders open, and video thumbnails are made over the network', (await js(`[...${attic}.querySelectorAll('[role=option] img')].filter(i => i.complete && i.naturalWidth).length`)) >= 1);
    await tile(attic, 'hp clip.mp4');
    await soft(waitFor(async () => /Resolution\s+480 × 270/.test(await js(`${attic}.querySelector('[data-testid=details-card]')?.innerText ?? ''`)), 15000));
    const card = await js(`${attic}.querySelector('[data-testid=details-card]')?.innerText ?? ''`);
    check('the details card reads an Attic video (FFprobe over the network)', /Resolution\s+480 × 270/.test(card) && /Length\s+0:06/.test(card), card.replace(/\n/g, ' | ').slice(0, 200));
    await js(`${attic}.querySelector('[data-testid=details-tags] [aria-label="4 stars"]').click()`);
    const hpSize = fs.statSync(path.join(HOME, 'Videos', 'hp clip.mp4')).size;
    await soft(waitFor(async () => (await stars('attic://home/Videos/hp clip.mp4', hpSize)) === 4, 8000));
    check('stars on an Attic video are kept in PixHaven (the file on the HP is not changed)', (await stars('attic://home/Videos/hp clip.mp4', hpSize)) === 4 && fs.statSync(path.join(HOME, 'Videos', 'hp clip.mp4')).size === hpSize);
    await shot('02-attic-browse');

    // ---- the watch page plays it ----
    await tile(attic, 'hp clip.mp4', 'dblclick');
    await waitFor(async () => (await js(`document.querySelector('[data-testid=attic-page] [data-testid=watch-page] video')?.currentTime ?? 0`)) > 0.5, 25000);
    check('an Attic video plays in the watch page', true, await js(`document.querySelector('[data-testid=attic-page] [data-testid=player-mode]')?.innerText ?? ''`));
    await shot('03-attic-watch');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await sleep(600);

    // ---- "Move to Attic" from the Library: blue now; labels follow ----
    await js(`window.__clearupLibrary(${JSON.stringify(LOCAL)})`);
    await sleep(800);
    const lib = `document.querySelector('[data-tab-panel]:not(.hidden)')`;
    await tile(lib, 'from pc.mp4');
    const pcFile = path.join(LOCAL, 'from pc.mp4'), pcSize = fs.statSync(pcFile).size;
    await js(`${lib}.querySelector('[data-testid=details-tags] [aria-label="2 stars"]').click()`);
    await soft(waitFor(async () => (await stars(pcFile, pcSize)) === 2, 8000));
    const blue = await js(`(b => ({ disabled: b.disabled, bg: getComputedStyle(b).backgroundColor }))(${lib}.querySelector('[data-testid=move-to-attic]'))`);
    check('"Move to Attic" is blue once Attic is connected', blue.disabled === false && blue.bg !== grey.bg, `${grey.bg} → ${blue.bg}`);
    await js(`${lib}.querySelector('[data-testid=move-to-attic]').click()`);
    await waitFor(async () => !!(await js(`document.querySelector('[role=dialog][aria-label="Choose a folder on Attic"] [data-attic-folder="Videos"]')`)), 10000);
    await js(`document.querySelector('[role=dialog] [data-attic-folder="Videos"]').click()`);
    await soft(waitFor(async () => (await js(`document.querySelector('[data-testid=picker-at]')?.innerText ?? ''`)).includes('Videos'), 5000));
    await shot('04-move-to-attic');
    await clickText('Move here', `document.querySelector('[role=dialog]')`);
    await waitFor(async () => !!(await js(`document.querySelector('[data-transfer=done]')`)), 30000);
    const result = await js(`document.querySelector('[data-testid=transfer-result]').innerText`);
    const there = path.join(HOME, 'Videos', 'from pc.mp4');
    check('Move to Attic: on the HP, the same size, the original in the Recycle Bin', fs.existsSync(there) && fs.statSync(there).size === pcSize && !fs.existsSync(pcFile)
      && fs.existsSync(path.join(process.env.PIXHAVEN_TEST_TRASH, 'from pc.mp4')), result);
    check('Move to Attic: its stars went with it', (await stars('attic://home/Videos/from pc.mp4', pcSize)) === 2);
    await soft(waitFor(async () => (await tiles(lib)).length === 0, 8000));
    check('the Library folder no longer shows it', (await tiles(lib)).length === 0);

    // ---- the Videos tab includes Attic ----
    await nav('Videos');
    await soft(waitFor(async () => (await js(`[...document.querySelectorAll('[role=radiogroup][aria-label=Where] [role=radio]')].map(b => b.innerText)`)).some(x => x === 'Attic (2)'), 15000));
    const where = await js(`[...document.querySelectorAll('[role=radiogroup][aria-label=Where] [role=radio]')].map(b => b.innerText)`);
    check('Videos tab: Attic\'s videos are listed with the rest', where.includes('Attic (2)'), where.join(' | '));
    await shot('05-videos-attic');

    // ---- rename and delete on Attic ----
    await nav('Attic');
    await sleep(800);
    await tile(attic, 'from pc.mp4');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))`);
    await sleep(400);
    await setInput('[role=dialog] input[aria-label="New name"]', 'renamed on attic.mp4');
    await clickText('Rename', `document.querySelector('[role=dialog]')`);
    await soft(waitFor(async () => fs.existsSync(path.join(HOME, 'Videos', 'renamed on attic.mp4')), 8000));
    check('rename on Attic (F2); the stars follow', fs.existsSync(path.join(HOME, 'Videos', 'renamed on attic.mp4')) && (await stars('attic://home/Videos/renamed on attic.mp4', pcSize)) === 2);
    await tile(attic, 'renamed on attic.mp4');
    await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))`);
    await sleep(400);
    await clickText('Delete', `document.querySelector('[role=dialog]')`);
    await soft(waitFor(async () => !fs.existsSync(path.join(HOME, 'Videos', 'renamed on attic.mp4')), 8000));
    const day = new Date().toISOString().slice(0, 10);
    check('Delete on Attic goes to its 30-day trash', fs.existsSync(path.join(HOME, '~attic-trash', day, 'Videos', 'renamed on attic.mp4')),
      await js(`document.querySelector('[data-testid=attic-note]')?.innerText ?? ''`));

    // ---- Move to this PC (the folder is picked in a Windows dialog: here the same call it makes) ----
    await tile(attic, 'hp clip.mp4');
    check('"Move to this PC…" is offered for a selection', !!(await js(`${attic}.querySelector('[data-testid=move-from-attic]')`)));
    await js(`window.clearup.attic.fromAttic([{ path: 'attic://home/Videos/hp clip.mp4', kind: 'video', size: ${hpSize} }], ${JSON.stringify(BACK)}, true)`);
    await waitFor(async () => (await js(`[...document.querySelectorAll('[data-transfer=done]')].length`)) >= 1 && fs.existsSync(path.join(BACK, 'hp clip.mp4')), 30000);
    await soft(waitFor(async () => !fs.existsSync(path.join(HOME, 'Videos', 'hp clip.mp4')), 8000));
    check('Move to this PC: here, the same size, removed from Attic (into its trash)', fs.statSync(path.join(BACK, 'hp clip.mp4')).size === hpSize && !fs.existsSync(path.join(HOME, 'Videos', 'hp clip.mp4'))
      && fs.existsSync(path.join(HOME, '~attic-trash', day, 'Videos', 'hp clip.mp4')));
    check('Move to this PC: its stars came with it', (await stars(path.join(BACK, 'hp clip.mp4'), hpSize)) === 4);
    await shot('06-moved-back');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  } finally {
    if (server && server.exitCode === null) server.kill();
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
