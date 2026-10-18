// End-to-end check of Sort by person in the built app: scan → review → dry run → apply → tags → undo.
// v2.2: people are "Person 1", "Person 2"…; group photos are moved once and tagged, never copied.
// Run: npm run e2e:sort. Test photos: phase0/fetch-test-photos.mjs (or CLEARUP_TESTPHOTOS pointing at its output).
// Screenshots + results.json land in e2e-output/sort/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
sharp.cache(false);

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

async function makeFixtures() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  for (const f of fs.readdirSync(SRC)) if (/\.(jpe?g|png)$/i.test(f)) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  // v2.5: a group photo of two people who each get a folder (two portraits side by side).
  const pick = async who => {
    for (const f of fs.readdirSync(SRC).filter(x => whoIs(x) === who).sort()) {
      const b = await sharp(path.join(SRC, f)).rotate().resize(700, 800, { fit: 'cover', position: 'attention' }).toBuffer().catch(() => null);
      if (b) return b;
    }
    throw new Error(`No readable photo of ${who}`);
  };
  const halves = [await pick('Barack Obama'), await pick('Emmanuel Macron')];
  await sharp({ create: { width: 1400, height: 800, channels: 3, background: '#888' } })
    .composite([{ input: halves[0], left: 0, top: 0 }, { input: halves[1], left: 700, top: 0 }]).jpeg({ quality: 90 }).toFile(path.join(ROOT, 'Two leaders side by side.jpg'));
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
    const readOnly = await makeFixtures();
    let before = snapshot(ROOT);
    let upscaled = null;   // the photo upscaled in place: compared with itself after the upscale, not the original
    const total = Object.keys(before).length;
    await waitFor('What would you like to do?');

    await js('window.clearup.sort.deleteData()');           // start from a clean face database
    await js(`window.__clearupSort(${JSON.stringify(ROOT)})`);
    await waitFor('Scan folder');
    await sleep(1500);
    // v2.4: low-resolution recommendations are opt-in.
    await js(`(() => { const s = document.querySelector('[aria-label="Recommend low-resolution photos for upscaling"]'); if (s.getAttribute('aria-checked') !== 'true') s.click(); })()`);
    await sleep(500);
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

    // v2.3, optional: upscale one low-resolution photo in place.
    const lowTitle = await js(`[...document.querySelectorAll('section button')].map(b => b.innerText).find(t => t.startsWith('Low resolution')) ?? ''`);
    const lowCount = Number(lowTitle.match(/\((\d+)\)/)?.[1] ?? 0);
    check('low-resolution photos are listed', lowCount > 0, lowTitle);
    if (lowCount > 0) {
      await js(`[...document.querySelectorAll('section button')].find(b => b.innerText.startsWith('Low resolution')).click()`);
      await sleep(400);
      await click('Select none');
      const target = await js(`(() => { const l = document.querySelector('[data-testid=lowres] ~ div label'); l.querySelector('input').click(); return l.title; })()`);
      const was = await sharp(target).metadata(), wasTime = fs.statSync(target).mtimeMs;
      await sleep(300);
      await shot('02b-lowres');
      await click('Upscale 1 and replace');
      await click('Upscale and replace');
      const end = Date.now() + 180000;
      while (Date.now() < end && (await sharp(target).metadata().catch(() => was)).width === was.width) await sleep(1000);
      await sleep(2000);
      const now = await sharp(target).metadata();
      check('upscaled in place: same name and format, 2× or 4× bigger, same date', now.format === was.format && now.width >= was.width * 2 && Math.abs(fs.statSync(target).mtimeMs - wasTime) < 2000,
        `${was.width}×${was.height} → ${now.width}×${now.height}`);
      check('no extra files left beside it', fs.readdirSync(ROOT).filter(f => /pixhaven-upscale|_upscaled/.test(f)).length === 0);
      const after = Number((await js(`[...document.querySelectorAll('section button')].map(b => b.innerText).find(t => t.startsWith('Low resolution')) ?? '(0)'`)).match(/\((\d+)\)/)?.[1] ?? 0);
      check('it leaves the list', after === lowCount - 1, `${lowCount} → ${after}`);
      before = snapshot(ROOT);
      upscaled = { name: path.basename(target), pixels: await sharp(target).raw().toBuffer() };
    }

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
    const files = Object.keys(snapshot(ROOT)).filter(k => !k.endsWith('/') && !k.endsWith('.lnk'));
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
    const mf = path.join(ROOT, '.clearup', 'people.json');
    const manifest = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : { folders: {} };
    const [shownDir, shownList] = Object.entries(manifest.folders)[0] ?? [];
    check('group photos listed for the other people', !!shownList?.length, `${Object.keys(manifest.folders).length} folders`);
    if (shownList?.length) {
      const listing = await js(`window.clearup.lib.list(${JSON.stringify(path.join(ROOT, shownDir))})`);
      const tagged = listing.entries.filter(e => e.taggedFrom);
      check('Library shows them in the other person\'s folder', tagged.length === shownList.length, tagged.map(e => `${e.name} (kept in ${e.taggedFrom})`).join(', '));
      const file = path.join(ROOT, ...shownList[0].file.split('/'));
      const keptIn = path.basename(path.dirname(file));
      const names = await js(`window.clearup.tags.peopleIn(${JSON.stringify(file)})`);
      check('people are written into the photo', names.length >= 2 && names.includes(shownDir), names.join(', '));
      // v2.5: the folder keeping it says which other folders show it.
      const own = await js(`window.clearup.lib.list(${JSON.stringify(path.dirname(file))})`);
      const also = own.entries.find(e => e.path.toLowerCase() === file.toLowerCase())?.alsoIn ?? [];
      check('the folder keeping a group photo lists where else it is shown', also.includes(shownDir), `${path.basename(file)} in ${keptIn}: also in ${also.join(', ')}`);
      // v2.5: File Explorer shows it too, through a shortcut.
      const { shell } = await import('electron');
      const lnks = fs.readdirSync(path.join(ROOT, shownDir)).filter(f => f.endsWith('.lnk')).map(f => path.join(ROOT, shownDir, f));
      const targets = lnks.map(l => { try { return shell.readShortcutLink(l); } catch { return null; } }).filter(Boolean);
      check('Explorer: a shortcut to the group photo in the other person\'s folder', targets.some(t => t.target.toLowerCase() === file.toLowerCase() && t.description === 'PixHaven group photo'),
        lnks.map(l => `${path.basename(l)} (${fs.statSync(l).size} bytes)`).join(', '));

      // v2.5: the Photos tab opens this folder on its people; group photos say where they are kept / also shown.
      await js(`window.__clearupPage('photos')`);
      for (let i = 0; i < 50 && !(await js('!!document.querySelector("[data-known]")')); i++) await sleep(200);
      await js(`[...document.querySelectorAll('[data-known]')].find(b => b.dataset.known === ${JSON.stringify(ROOT)}).click()`);
      await waitFor('People (', 30000);
      await sleep(800);
      const cards = await js(`[...document.querySelectorAll('[data-photos-person]')].map(c => c.dataset.photosPerson)`);
      check('Photos tab: sorted folder opens on its people', cards.includes(keptIn) && cards.includes(shownDir), cards.join(', '));
      await js(`document.querySelector('[data-photos-person="${keptIn}"]').click()`);
      await waitFor(`Also in · ${shownDir}`, 15000).then(() => check('Photos tab: kept group photo says "Also in"', true), e => check('Photos tab: kept group photo says "Also in"', false, String(e)));
      await shot('04a-photos-also-in');
      await click('People');
      await js(`document.querySelector('[data-photos-person="${shownDir}"]').click()`);
      await waitFor(`Kept in · ${keptIn}`, 15000).then(() => check('Photos tab: shown group photo says "Kept in"', true), e => check('Photos tab: shown group photo says "Kept in"', false, String(e)));
      await shot('04b-photos-kept-in');
      await click('People');

      // Folders view: new folder, copy a photo, paste it there; then cut it back out.
      await js(`[...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === 'Folders').click()`);
      await sleep(600);
      await click('New folder');
      await sleep(300);
      await click('Create');
      await sleep(800);
      const made = path.join(ROOT, 'New folder');
      check('Photos tab: New folder', fs.existsSync(made) && fs.statSync(made).isDirectory());
      const loose = fs.readdirSync(ROOT).find(f => /\.(jpe?g|png)$/i.test(f) && fs.statSync(path.join(ROOT, f)).isFile());
      if (loose) {
        await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path === ${JSON.stringify(path.join(ROOT, loose))}).click()`);
        await sleep(200);
        await click('Copy');
        await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path === ${JSON.stringify(made)}).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
        await sleep(800);
        await click('Paste (1)');
        await sleep(1200);
        const copied = path.join(made, loose);
        check('Photos tab: copy and paste', fs.existsSync(copied) && fs.existsSync(path.join(ROOT, loose))
          && fs.readFileSync(copied).equals(fs.readFileSync(path.join(ROOT, loose))), copied);
        await shot('04c-photos-pasted');
      }
      fs.rmSync(made, { recursive: true, force: true });   // so Undo can be compared with the start
      await js(`window.__clearupPage('sort')`);
      await sleep(500);
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

    // v2.4: a person folder renamed in Explorer is recognised; the folder opens straight on its people.
    const renameFrom = dirs.find(d => /^Person \d+$/.test(d));
    if (renameFrom) {
      fs.renameSync(path.join(ROOT, renameFrom), path.join(ROOT, 'Renamed in Explorer'));
      await js(`window.__clearupSort(${JSON.stringify(path.join(ROOT, '..'))})`);
      await sleep(1500);
      await js(`window.__clearupSort(${JSON.stringify(ROOT)})`);
      await waitFor('Renamed person folders were recognised', 60000);
      const labels = await js(`[...document.querySelectorAll('[data-person]')].map(c => c.dataset.person)`);
      check('reopening shows the people as they were, renamed folder recognised', labels.includes('Renamed in Explorer') && !labels.includes(renameFrom), labels.join(', '));
      await shot('04b-reopened');
      await click('Next: dry run');
      await waitFor('Everything is already sorted');
      check('renamed folder is not sorted again', true);
      // The name inside its photos follows the folder (in the background).
      const inRenamed = fs.readdirSync(path.join(ROOT, 'Renamed in Explorer')).filter(f => /\.(jpe?g|png)$/i.test(f)).map(f => path.join(ROOT, 'Renamed in Explorer', f));
      let names = [];
      for (let i = 0; i < 60; i++) {
        names = await Promise.all(inRenamed.map(f => js(`window.clearup.tags.peopleIn(${JSON.stringify(f)})`)));
        if (names.every(n => n.includes('Renamed in Explorer') && !n.includes(renameFrom))) break;
        await sleep(1000);
      }
      check('names inside the photos follow the renamed folder', names.length > 0 && names.every(n => n.includes('Renamed in Explorer') && !n.includes(renameFrom)),
        `${inRenamed.length} photos: ${names.map(n => n.join('+')).join(', ')}`);
      await click('Back');
    }
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
      const a = upscaled?.name === path.basename(k) ? upscaled.pixels : await sharp(path.join(SRC, path.basename(k))).raw().toBuffer().catch(() => null);
      const b = await sharp(p).raw().toBuffer().catch(() => null);
      if (a && b && a.equals(b)) pixelsSame.push(k);
      const left = await js(`window.clearup.tags.peopleIn(${JSON.stringify(p)})`);
      if (left.some(n => /^Person \d+$/.test(n) || n === 'Renamed in Explorer')) peopleLeft.push(k);
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
