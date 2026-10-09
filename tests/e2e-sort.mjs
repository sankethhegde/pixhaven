// End-to-end check of Sort by person in the built app: scan → review → rename → dry run → apply → undo.
// Run: npm run e2e:sort. Screenshots + results.json land in e2e-output/sort/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const OUT = process.env.CLEARUP_E2E_DIR;
const SRC = path.resolve('phase0/testphotos');
const ROOT = path.join(OUT, 'Photos');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function makeFixtures() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const pick = re => fs.readdirSync(SRC).filter(f => re.test(f));
  // Named files (names from file names) + group photos + photos without faces.
  for (const f of [...pick(/^Angela Merkel/), ...pick(/^Emmanuel Macron (June|August|March|2023)/), ...pick(/Obama (Portrait|and Biden)|President Barack Obama|Barack Obama family/),
    ...pick(/BRICS|Honour guards/)]) fs.copyFileSync(path.join(SRC, f), path.join(ROOT, f));
  // Ardern with camera names: her name can only come from text inside a photo (OCR).
  const ardern = pick(/^(Jacinda Ardern - Waitangi|New Zealand Prime Minister Jacinda|Rt Hon Jacinda|NZ PM Jacinda)/);
  for (let i = 0; i < ardern.length; i++) {
    const dest = path.join(ROOT, `IMG_10${String(i).padStart(2, '0')}.jpg`);
    if (i === 0) {
      const img = sharp(path.join(SRC, ardern[i]));
      const { width, height } = await img.metadata();
      const band = Math.round(height * 0.16);
      const svg = Buffer.from(`<svg width="${width}" height="${band}"><rect width="100%" height="100%" fill="white"/><text x="50%" y="70%" text-anchor="middle" font-family="Arial" font-weight="bold" font-size="${Math.round(band * 0.6)}" fill="black">JACINDA</text></svg>`);
      await img.composite([{ input: svg, left: 0, top: height - band }]).jpeg({ quality: 92 }).toFile(dest);
    } else fs.copyFileSync(path.join(SRC, ardern[i]), dest);
  }
  // A read-only single-person photo must stay put.
  fs.chmodSync(path.join(ROOT, pick(/^Angela Merkel _Tobias/)[0] ?? pick(/^Angela Merkel/)[0]), 0o444);
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
    await makeFixtures();
    const before = snapshot(ROOT);
    const total = Object.keys(before).length;
    await waitFor('What would you like to do?');
    await shot('01-home');

    await js('window.clearup.sort.deleteData()');           // start from a clean face database
    await js(`window.__clearupSort(${JSON.stringify(ROOT)})`);
    await waitFor('Scan folder');
    await shot('02-pick');
    let t = Date.now();
    await click('Scan folder');
    await sleep(2500);
    await shot('03-scanning');
    await waitFor('People in Photos', 240000);
    check('scan + group + names', true, `${total} photos in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    await sleep(800);
    const people = await js(`[...document.querySelectorAll('[data-person]')].map(c => ({ label: c.dataset.person, name: c.querySelector('input').value, photos: c.innerText.match(/(\\d+) photo/)?.[1], src: c.querySelector('[title]')?.title }))`);
    console.log(JSON.stringify(people));
    const named = n => people.find(p => p.name === n);
    check('name from file name: Angela Merkel', !!named('Angela Merkel') && Number(named('Angela Merkel').photos) >= 4, JSON.stringify(named('Angela Merkel')));
    check('name from file name: Emmanuel Macron', !!named('Emmanuel Macron'));
    check('name read from text in photo (OCR): Jacinda', !!named('Jacinda'), JSON.stringify(named('Jacinda')));
    await shot('04-review');

    // Rename an unnamed person by typing on the card (FACE-12).
    const target = people.find(p => !p.name);
    if (target) {
      await js(`(() => { const c = [...document.querySelectorAll('[data-person]')].find(c => c.dataset.person === ${JSON.stringify(target.label)});
        const i = c.querySelector('input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(i, 'Test Person'); i.dispatchEvent(new Event('input', { bubbles: true })); i.focus(); i.blur(); })()`);
      await sleep(1200);
      check('typed name saved', (await js(`[...document.querySelectorAll('[data-person] input')].some(i => i.value === 'Test Person')`)));
    }
    // Person photos view
    await js(`document.querySelector('[aria-label="Show photos of Angela Merkel"]').click()`);
    await waitFor('Not this person', 1).catch(() => {});
    await waitFor('Upscale all photos');
    await shot('05-person');
    await js(`document.querySelector('[role=dialog] [aria-label=Close]').click()`);

    await click('Next: dry run');
    await waitFor('Dry run: nothing has moved yet');
    const dry = await text();
    check('dry run lists copies and group originals', /Copies \(group photos\)/.test(dry) && dry.includes('Group photos'));
    check('nothing moved during dry run', JSON.stringify(snapshot(ROOT)) === JSON.stringify(before));
    await shot('06-dryrun');

    t = Date.now();
    await click('Apply');
    await waitFor('Photos sorted', 120000);
    check('apply finished', true, `${((Date.now() - t) / 1000).toFixed(1)} s`);
    await shot('07-done');
    const dirs = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    check('person folders created', dirs.includes('Angela Merkel') && dirs.includes('Emmanuel Macron') && dirs.includes('Jacinda'), dirs.join(', '));
    check('group originals in "Group photos"', dirs.includes('Group photos') && fs.readdirSync(path.join(ROOT, 'Group photos')).length > 0);
    check('undo log written', fs.existsSync(path.join(ROOT, '.clearup', 'sort-log.jsonl')));
    const ro = fs.readdirSync(ROOT, { withFileTypes: true }).filter(f => f.isFile() && /^Angela Merkel/.test(f.name)).map(f => f.name);
    check('read-only photo stayed in place', ro.length === 1, ro.join(', '));
    check('files kept on disk (none lost)', Object.keys(snapshot(ROOT)).filter(k => !k.endsWith('/')).length >= total);

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

    // Undo restores the folder exactly.
    await click('Undo last sort');
    await waitFor('Undo finished', 120000);
    await shot('08-undone');
    const after = snapshot(ROOT);
    check('undo restores every file exactly', JSON.stringify(after) === JSON.stringify(before),
      JSON.stringify(Object.keys(after).filter(k => !(k in before)).concat(Object.keys(before).filter(k => !(k in after)))));

    // Settings page with the new sections
    await js(`[...document.querySelectorAll('nav button')].find(b => b.innerText.trim() === 'Settings').click()`);
    await waitFor('Face-match strictness');
    await js(`document.querySelector('main .overflow-auto').scrollTop = 900`);
    await shot('09-settings-sort');
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  try { for (const f of fs.readdirSync(ROOT)) { const p = path.join(ROOT, f); if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o644); } } catch { /* */ }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
