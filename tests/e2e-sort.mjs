// End-to-end check of Sort by person in the built app: scan → review → dry run → apply → tags → undo.
// v2.2: people are "Person 1", "Person 2"…; group photos are moved once and tagged, never copied.
// Run: npm run e2e:sort. Test photos: phase0/fetch-test-photos.mjs (or CLEARUP_TESTPHOTOS pointing at its output).
// Screenshots + results.json land in e2e-output/sort/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const OUT = process.env.CLEARUP_E2E_DIR;
const SRC = path.resolve(process.env.CLEARUP_TESTPHOTOS ?? 'phase0/testphotos');
const ROOT = path.join(OUT, 'Photos');
const PEOPLE = ['Barack Obama', 'Angela Merkel', 'Narendra Modi', 'Emmanuel Macron', 'Jacinda Ardern'];
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Who a test photo shows, from its Wikimedia file name; null for group shots and anything unclear. */
export function whoIs(file) {
  const n = file.toLowerCase();
  const hits = PEOPLE.filter(p => n.includes(p.toLowerCase()) || n.includes(p.split(' ')[1].toLowerCase()));
  if (hits.length !== 1 || /\b(and|with|meets?|meeting|family|summit|brics|g20|g7|leaders|guards?|visit|delegation|bilateral|cabinet|boy|ceremony|business|signing|party|gymnastic)\b/.test(n)) return null;
  return hits[0];
}

function makeFixtures() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const f of fs.readdirSync(SRC)) if (/\.(jpe?g|png)$/i.test(f)) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  // A read-only photo must stay put.
  const ro = fs.readdirSync(ROOT).find(f => whoIs(f) === 'Angela Merkel');
  fs.chmodSync(path.join(ROOT, ro), 0o444);
  return ro;
}

function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.clearup') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = 'dir'; walk(p); }
    else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
  } };
  walk(dir);
  return out;
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label, exact = true) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button, [role=dialog] button')].find(b => b.offsetParent && ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(250);
  }
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(700);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    const readOnly = makeFixtures();
    const before = snapshot(ROOT);
    const total = Object.keys(before).length;
    await waitFor('What would you like to do?');

    await js('window.clearup.sort.deleteData()');           // start from a clean face database
    await js(`window.__clearupSort(${JSON.stringify(ROOT)})`);
    await waitFor('Scan folder');
    await sleep(1500);
    let t = Date.now();
    await click('Scan folder');
    await sleep(2500);
    await shot('01-scanning');
    await waitFor('People in Photos', 300000);
    check('scan + group', true, `${total} photos in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    await sleep(800);
    const people = await js(`[...document.querySelectorAll('[data-person]')].map(c => ({ label: c.dataset.person, photos: Number(c.innerText.match(/(\\d+) photo/)?.[1]) }))`);
    console.log(JSON.stringify(people));
    check('people are "Person N", no names guessed or typed', people.length > 0 && people.every(p => /^Person \d+$/.test(p.label))
      && (await js(`document.querySelectorAll('[data-person] input').length`)) === 0, people.map(p => p.label).join(', '));
    await shot('02-review');

    await click('Next: dry run');
    await waitFor('Dry run: nothing has moved yet');
    const dry = await text();
    check('dry run: group photos tagged, not copied', dry.includes('Group photos (tagged, not copied)') && !/Copies|“Group photos”/.test(dry));
    check('nothing moved during dry run', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));
    await shot('03-dryrun');

    t = Date.now();
    await click('Apply');
    await waitFor('Photos sorted', 180000);
    check('apply finished', true, `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await shot('04-done');
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== '.clearup').map(d => d.name);
    check('folders are "Person N" (no "Group photos")', dirs.length > 0 && dirs.every(d => /^Person \d+$/.test(d) || d === 'Unsorted'), dirs.join(', '));
    const files = Object.keys(snapshot(ROOT)).filter(k => !k.endsWith('/'));
    check('no copies: same number of files as before', files.length === total, `${files.length} vs ${total}`);
    check('read-only photo stayed in place', fs.existsSync(path.join(ROOT, readOnly)));

    // Grouping quality on real photos (ground truth from the file names).
    const byDir = new Map();
    for (const f of files) {
      const who = whoIs(path.basename(f));
      if (!who || !f.includes(path.sep)) continue;
      const d = f.split(path.sep)[0];
      if (d === 'Unsorted') continue;
      byDir.set(d, [...(byDir.get(d) ?? []), who]);
    }
    const mixed = [...byDir].filter(([, w]) => new Set(w).size > 1).map(([d, w]) => `${d}: ${[...new Set(w)].join(' + ')}`);
    check('no folder mixes two people', mixed.length === 0, mixed.join('; '));
    const split = [];
    for (const p of PEOPLE) {
      const where = [...byDir].map(([d, w]) => [d, w.filter(x => x === p).length]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      const n = where.reduce((s, [, k]) => s + k, 0);
      if (n >= 3 && where[0][1] / n < 0.75) split.push(`${p}: ${where.map(([d, k]) => `${d}=${k}`).join(', ')}`);
    }
    check('each person stays together (75%+ of their photos in one folder)', split.length === 0, split.join('; ') || [...byDir].map(([d, w]) => `${d}=${w[0]}×${w.length}`).join(', '));

    // Group photos: kept in one folder, shown in the others (from .clearup/people.json), people written into the file.
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.clearup', 'people.json'), 'utf8'));
    const [shownDir, shownList] = Object.entries(manifest.folders)[0] ?? [];
    check('group photos listed for the other people', !!shownList?.length, `${Object.keys(manifest.folders).length} folders`);
    if (shownList?.length) {
      const listing = await js(`window.clearup.lib.list(${JSON.stringify(path.join(ROOT, shownDir))})`);
      const tagged = listing.entries.filter(e => e.taggedFrom);
      check('Library shows them in the other person\'s folder', tagged.length === shownList.length, tagged.map(e => `${e.name} (kept in ${e.taggedFrom})`).join(', '));
      const file = path.join(ROOT, ...shownList[0].file.split('/'));
      const names = await js(`window.clearup.tags.peopleIn(${JSON.stringify(file)})`);
      check('people are written into the photo', names.length >= 2 && names.includes(shownDir), names.join(', '));
    }
    check('undo log written', fs.existsSync(path.join(ROOT, '.clearup', 'sort-log.jsonl')));

    // Re-run: nothing new to scan, nothing left to move.
    await click('Done');
    await waitFor('Scan for new photos');
    t = Date.now();
    await click('Scan for new photos');
    await waitFor('People in Photos', 120000);
    check('re-scan of sorted folder is quick', true, `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await click('Next: dry run');
    await waitFor('Everything is already sorted');
    check('re-run finds nothing to move', true);
    await click('Back');
    await click('Back');

    // Undo restores the folder exactly (people taken out of the photos again).
    await click('Undo last sort');
    await waitFor('Undo finished', 120000);
    await shot('05-undone');
    const after = snapshot(ROOT);
    check('undo puts every file back where it was', JSON.stringify(Object.keys(after).sort()) === JSON.stringify(Object.keys(before).sort()),
      JSON.stringify(Object.keys(before).filter(k => !(k in after))));
    // Photos without metadata of their own are byte-for-byte the same again; photos that had some keep it (the XMP
    // block is rewritten without the people), with the picture itself untouched.
    const changed = Object.keys(after).filter(k => after[k] !== before[k]);
    const pixelsSame = [], peopleLeft = [];
    for (const k of changed) {
      const p = path.join(ROOT, k);
      const a = await sharp(path.join(SRC, path.basename(k))).raw().toBuffer().catch(() => null);
      const b = await sharp(p).raw().toBuffer().catch(() => null);
      if (a && b && a.equals(b)) pixelsSame.push(k);
      const left = await js(`window.clearup.tags.peopleIn(${JSON.stringify(p)})`);
      if (left.some(n => /^Person \d+$/.test(n))) peopleLeft.push(k);
    }
    check('undo: pictures untouched, people taken out of the files', pixelsSame.length === changed.length && peopleLeft.length === 0,
      `${Object.keys(after).length - changed.length} identical, ${changed.length} with their own metadata rewritten${peopleLeft.length ? `; people left in ${peopleLeft.join(', ')}` : ''}`);

    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Settings').click()`);
    await waitFor('Face-match strictness');
    await js(`document.querySelector('main .overflow-auto').scrollTop = 900`);
    await shot('06-settings-sort');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  try { for (const f of fs.readdirSync(ROOT)) { const p = path.join(ROOT, f); if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o644); } } catch { /* */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
