// End-to-end check of 1.1.0 Duplicate videos (Tidy up) in the built app, with a real Attic server (the attic repo next
// to this one): an exact copy, a renamed lower-quality copy, a faster copy, a cropped copy, a copy on Attic, a cut-out
// piece and two overlapping parts are found; you choose the copy to keep; applying moves the others into
// "Removed duplicates" (labels and stars go to the copy kept) and puts the two parts together.
// Run: npm run e2e:dupes. Screenshots + results.json land in e2e-output/dupes/.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { FFMPEG_DIR } from './make-media.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const V = path.join(OUT, 'My videos');
const REMOVED_ROOT = path.join(OUT, 'drive-top');
const HOME = path.join(OUT, 'Attic share');
const SERVER = path.resolve('..', 'attic', 'server', 'server.js');
const PORT = 23000 + Math.floor(Math.random() * 1000);
const lanIp = () => Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal)?.address;
process.env.CLEARUP_REMOVED_ROOT = REMOVED_ROOT;     // never the top of a real drive
const WIN = process.platform === 'win32';
const FF = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');
const FFPROBE = path.join(FFMPEG_DIR, WIN ? 'ffprobe.exe' : 'ffprobe');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ff = (...args) => { const r = spawnSync(FF, ['-v', 'error', '-y', ...args]); if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')}: ${r.stderr}`); };
const master = (out, at) => ff('-f', 'lavfi', '-i', `mandelbrot=size=320x240:rate=10:start_x=${at[0]}:start_y=${at[1]}:start_scale=3:end_scale=0.3:end_pts=90`,
  '-vf', 'rotate=a=t*0.06', '-t', '90', '-c:v', 'mpeg4', '-q:v', '4', out);
const cut = (from, to, src, out, extra = []) => ff('-ss', String(from), '-to', String(to), '-i', src, ...extra, '-c:v', 'mpeg4', '-q:v', '4', out);
const duration = f => Number(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout.toString().trim());

function makeFixture() {
  for (const d of [V, REMOVED_ROOT, HOME]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'Videos'), { recursive: true });
  fs.mkdirSync(path.join(V, 'Phone'), { recursive: true }); fs.mkdirSync(path.join(V, 'Old'), { recursive: true });
  master(path.join(V, 'Beach day.mp4'), [-0.743643887, 0.131825904]);
  fs.copyFileSync(path.join(V, 'Beach day.mp4'), path.join(V, 'Old', 'VID_2024_0611.mp4'));            // exact copy, another name
  cut(0, 90, path.join(V, 'Beach day.mp4'), path.join(V, 'Phone', 'Beach day (small).mp4'), ['-vf', 'scale=160:120']);   // lower quality
  cut(20, 50, path.join(V, 'Beach day.mp4'), path.join(V, 'Phone', 'Beach clip.mp4'));                 // a piece of it
  cut(0, 90, path.join(V, 'Beach day.mp4'), path.join(V, 'Phone', 'Beach fast.mp4'), ['-vf', 'setpts=PTS/1.5', '-r', '10']);          // 1.5× faster
  cut(0, 90, path.join(V, 'Beach day.mp4'), path.join(V, 'Old', 'Beach zoomed.mp4'), ['-vf', 'crop=iw*0.75:ih*0.75,scale=320:240']); // cropped
  ff('-i', path.join(V, 'Beach day.mp4'), '-c', 'copy', '-map_metadata', '-1', path.join(HOME, 'Videos', 'Beach on Attic.mp4'));     // on Attic
  const party = path.join(OUT, 'party-full.mp4');
  master(party, [-1.25066, 0.02012]);
  cut(0, 60, party, path.join(V, 'Party part 1.mp4'));
  cut(25, 90, party, path.join(V, 'Party part 2.mp4'));
  fs.rmSync(party);
  ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10', '-t', '30', '-c:v', 'mpeg4', path.join(V, 'Other.mp4'));
}

export default async function run(win, app) {
  let server;
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return true; await sleep(250); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? t.toString().slice(0, 100) : `"${t}"`}`);
  }
  const soft = p => p.then(() => true, () => false);
  const nav = label => js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === ${JSON.stringify(label)})?.click()`).then(() => sleep(600));
  const page = `document.querySelector('[data-testid=video-dupes]')`;
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(600);
    try { fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log(`screenshot ${name} skipped: ${e.message}`); }
  }
  const cards = sel => js(`[...${page}.querySelectorAll('[data-testid=${sel}] [data-dupe-card]')].map(c => [...c.querySelectorAll('[data-dupe-video]')].map(r => r.dataset.dupeVideo + (r.dataset.tone ? ':' + r.dataset.tone : '')))`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1400, 900);
    win.webContents.setBackgroundThrottling(false);
    makeFixture();
    for (const w of await js('window.clearup.watch.list()')) await js(`window.clearup.watch.remove(${JSON.stringify(w.path)})`);
    // ---- a real Attic server with a copy on it ----
    if (!fs.existsSync(SERVER)) throw new Error(`The attic repo is not next to this one (${SERVER}).`);
    const data = path.join(OUT, 'attic data');
    fs.rmSync(data, { recursive: true, force: true });
    fs.writeFileSync(path.join(OUT, 'attic-config.json'), JSON.stringify({ host: '0.0.0.0', shares: [{ id: 'home', name: 'Home Media', rootPath: HOME }] }));
    server = spawn(process.execPath.endsWith('electron.exe') ? 'node' : process.execPath, [SERVER], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ATTIC_CONFIG: path.join(OUT, 'attic-config.json'), ATTIC_DATA: data, ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' },
      stdio: ['ignore', 'pipe', 'inherit'], shell: false,
    });
    await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); }); server.on('exit', c => reject(new Error('attic server exited ' + c))); setTimeout(() => reject(new Error('attic server did not start')), 20000); });
    let cookie = null;
    const H = async (method, url, body) => {
      const res = await fetch(`http://127.0.0.1:${PORT}${url}`, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
      return res.json().catch(() => null);
    };
    await H('POST', '/api/setup', { displayName: 'Master', username: 'master', password: 'master-pass' });
    await H('POST', '/api/session', { mode: 'master', username: 'master', password: 'master-pass' });
    await H('POST', '/api/accounts', { displayName: 'Laptop', username: 'laptop', password: 'laptop-pass', deviceType: 'laptop' });
    const code = (await H('POST', '/api/pairing/codes', {})).code;
    await js('window.clearup.attic.forget()');
    await js(`window.clearup.attic.connect(${JSON.stringify(lanIp())}, ${PORT})`);
    await js(`window.clearup.attic.pair(${JSON.stringify(code)})`);
    const signedIn = await js("window.clearup.attic.signIn('master', 'master-pass', true)");   // files already on the server are the master's
    await waitFor(async () => (await js('window.clearup.attic.videos(true)')).length === 1, 20000);
    check('Attic is connected, with one video on it', signedIn.state === 'connected', signedIn.state);
    await waitFor('What would you like to do?');
    await js(`window.clearup.watch.add(${JSON.stringify(V)})`);
    await waitFor(async () => (await js(`window.clearup.watch.query({ text: '', type: 'video', filter: { labels: [], mode: 'any', minStars: 0 }, root: null, limit: 100 })`)).items.length === 9, 30000);
    // A label and stars on a copy that will be moved: they must end up on the copy kept.
    const copy = path.join(V, 'Old', 'VID_2024_0611.mp4');
    const st = fs.statSync(copy);
    await js(`window.clearup.tags.addLabel([${JSON.stringify({ path: copy, size: st.size, mtime: st.mtimeMs })}], 'Holiday', null)`);
    await js(`window.clearup.tags.setStars([${JSON.stringify({ path: copy, size: st.size, mtime: st.mtimeMs })}], 4)`);

    // ---- Tidy up → Duplicate videos: check ----
    await nav('Tidy up');
    await js(`[...document.querySelectorAll('[role=radiogroup][aria-label=Tool] [role=radio]')].find(b => b.innerText.includes('Duplicate videos'))?.click()`);
    await waitFor(async () => !!(await js(`!!${page}`)), 10000);
    check('Tidy up has a "Duplicate videos" tool', true);
    const t0 = Date.now();
    await js(`${page}.querySelector('[data-testid=dupes-check]').click()`);
    await waitFor(async () => !!(await js(`!!${page}.querySelector('[data-testid=dupes-summary]')`)), 120000);
    const took = Date.now() - t0;
    const summary = await js(`${page}.querySelector('[data-testid=dupes-summary]').innerText`);
    await soft(waitFor(async () => (await js(`${page}.querySelectorAll('[data-dupe-video] img').length`)) >= 3, 15000));
    await shot('01-found');
    const same = await cards('dupes-same');
    check('finds the same video 6 times: original, exact copy renamed, smaller, faster, cropped, and the copy on Attic', same.length === 1 && same[0].length === 6
      && ['Beach day.mp4', 'VID_2024_0611.mp4', 'Beach day (small).mp4', 'Beach fast.mp4', 'Beach zoomed.mp4', 'Beach on Attic.mp4'].every(n => same[0].some(r => r.startsWith(n))), `${JSON.stringify(same)} · ${took} ms`);
    const notes = await js(`Object.fromEntries([...${page}.querySelectorAll('[data-testid=dupes-same] [data-dupe-video]')].map(r => [r.dataset.dupeVideo, [...r.querySelectorAll('[data-dupe-note]')].map(n => n.dataset.dupeNote)]))`);
    check('the faster and the cropped copies say so', notes['Beach fast.mp4']?.includes('1.5× speed') && notes['Beach zoomed.mp4']?.includes('Cropped'), JSON.stringify(notes));
    check('you choose which to keep (none chosen yet)', same[0]?.every(r => !r.includes(':keep')) && /choose the one to keep/.test(await js(`${page}.innerText`)));
    const longer = await cards('dupes-longer');
    check('finds the longer version holding the clip', longer.length === 1 && longer[0][1] === 'Beach clip.mp4:remove', JSON.stringify(longer));
    const comb = await cards('dupes-combine');
    check('finds the two overlapping parts to put together', comb.length === 1 && comb[0][0].startsWith('Party part 1') && comb[0][1].startsWith('Party part 2'), JSON.stringify(comb));
    check('an unrelated video is left alone', !(await js(`${page}.innerText`)).includes('Other.mp4'), summary);

    // ---- choose and apply ----
    await js(`${page}.querySelector('input[type=radio][aria-label="Keep Beach day.mp4"]').click()`);
    await sleep(300);
    const after = await cards('dupes-same');
    const bar = await js(`${page}.querySelector('[data-testid=dupes-apply-bar]').innerText`);
    check('choosing the one to keep marks the others to move', after[0].filter(r => r.endsWith(':remove')).length === 5 && after[0].some(r => r === 'Beach day.mp4:keep') && /6 videos moved, 1 pair combined/.test(bar), bar.replace(/\n/g, ' '));
    await js(`${page}.querySelector('[data-testid=dupes-apply]').click()`);
    await sleep(200);
    await js(`${page}.querySelector('[data-testid=dupes-confirm]').click()`);
    await waitFor(async () => !!(await js(`!!${page}.querySelector('[data-testid=dupes-result]')`)), 300000);
    const res = await js(`${page}.querySelector('[data-testid=dupes-result]').innerText`);
    await shot('02-applied');
    const R = path.join(REMOVED_ROOT, 'Removed duplicates');
    const rel = p => path.join(R, path.relative(path.parse(p).root, p));
    const movedOk = ['Old/VID_2024_0611.mp4', 'Phone/Beach day (small).mp4', 'Phone/Beach fast.mp4', 'Old/Beach zoomed.mp4', 'Phone/Beach clip.mp4', 'Party part 1.mp4', 'Party part 2.mp4']
      .every(n => fs.existsSync(rel(path.join(V, n))) && !fs.existsSync(path.join(V, n)));
    check('applying moves the copies, the clip and both parts into "Removed duplicates", keeping their folders', movedOk && fs.existsSync(path.join(V, 'Beach day.mp4')), res.replace(/\n/g, ' '));
    const onAttic = path.join(HOME, 'Removed duplicates', 'Videos', 'Beach on Attic.mp4');
    check('the copy on Attic is moved on Attic, into its own "Removed duplicates" folder', fs.existsSync(onAttic) && !fs.existsSync(path.join(HOME, 'Videos', 'Beach on Attic.mp4')), onAttic);
    check("Attic's set-aside copy is not listed in Videos", (await js('window.clearup.attic.videos(true)')).length === 0);
    const combined = path.join(V, 'Party part 1 (combined).mp4');
    const d = fs.existsSync(combined) ? duration(combined) : 0;
    check('the two parts become one video as long as the whole (90 s, not 60 + 65)', Math.abs(d - 90) <= 1.5, `${combined}: ${d.toFixed(2)} s`);
    const kept = path.join(V, 'Beach day.mp4');
    const ks = fs.statSync(kept);
    const tags = (await js(`window.clearup.tags.forFiles([${JSON.stringify({ path: kept, size: ks.size, mtime: ks.mtimeMs })}])`)).tags[kept];
    const names = (await js('window.clearup.tags.labels()')).filter(l => tags?.labels.includes(l.id)).map(l => l.name);
    check('the label and stars of a moved copy go to the copy kept', tags?.stars === 4 && names.includes('Holiday'), JSON.stringify({ stars: tags?.stars, names }));
    await soft(waitFor(async () => (await js(`window.clearup.watch.query({ text: '', type: 'video', filter: { labels: [], mode: 'any', minStars: 0 }, root: null, limit: 100 })`)).items.length === 3, 20000));
    const left = (await js(`window.clearup.watch.query({ text: '', type: 'video', filter: { labels: [], mode: 'any', minStars: 0 }, root: null, limit: 100 })`)).items.map(e => e.name).sort();
    check('Videos now lists only what stays (the moved ones are not indexed again)', JSON.stringify(left) === JSON.stringify(['Beach day.mp4', 'Other.mp4', 'Party part 1 (combined).mp4']), left.join(', '));

    // ---- check again: only new videos are read; the combined video matches nothing now ----
    const t1 = Date.now();
    await js(`${page}.querySelector('[data-testid=dupes-check]').click()`);
    await sleep(500);
    await waitFor(async () => /No duplicate videos found/.test(await js(`${page}.querySelector('[data-testid=dupes-summary]')?.innerText ?? ''`)), 60000);
    check('checking again finds nothing left, and is quick', Date.now() - t1 < 20000, `${Date.now() - t1} ms`);
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  try { server?.kill(); } catch { /* gone */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
