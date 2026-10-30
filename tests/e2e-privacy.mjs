// End-to-end check of v2.10 in the built app: hidden folders, photos, videos and labels (password, lock, unlock,
// search, labels) and the Library's Cut / Copy / Paste, New folder and Copy to.
// Run: npm run e2e:privacy. Screenshots + results.json land in e2e-output/privacy/.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
sharp.cache(false);

const OUT = process.env.CLEARUP_E2E_DIR;
const ROOT = path.join(OUT, 'Private');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function makeFiles() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  for (const [i, f] of ['beach.jpg', 'party.jpg', 'secret-photo.jpg', 'Diary/page1.jpg', 'Diary/page2.jpg', 'Trip/hill.jpg'].entries()) {
    const p = path.join(ROOT, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    await sharp({ create: { width: 120, height: 90, channels: 3, background: { r: 40 * i, g: 120, b: 160 } } }).jpeg().toFile(p);
  }
  fs.writeFileSync(path.join(ROOT, 'clip.mp4'), Buffer.alloc(2048));   // listed by name; never played here
}

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(250); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label, scope = 'main button, [role=dialog] button, nav button') {
    const ok = await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(400);
  }
  const type = async (sel, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const pick = async (p, ctrl = false) => { await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path.toLowerCase() === ${JSON.stringify(p.toLowerCase())}).dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: ${ctrl} }))`); await sleep(250); };
  const shown = () => js(`[...document.querySelectorAll('[data-path]')].map(b => b.dataset.path.split(/[\\\\/]/).pop())`);
  async function shot(name) { win.webContents.invalidate(); await sleep(600); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const open = async dir => { await js(`window.__clearupLibrary(${JSON.stringify(dir)})`); await sleep(1200); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await makeFiles();
    await waitFor('What would you like to do?');
    await open(ROOT);
    await waitFor('beach.jpg');
    check('no lock button before a password exists', !(await js(`!!document.querySelector('[data-testid=lock-button]')`)));

    // ---- Library: Copy, New folder, Paste; Copy to ----
    await pick(path.join(ROOT, 'beach.jpg'));
    await click('Copy');
    await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.trim() === 'Clear')?.click()`);
    await sleep(300);
    await click('New folder', 'main button');
    await type('[aria-label="Folder name"]', 'Copies');
    await click('Create');
    await sleep(800);
    check('New folder made', fs.existsSync(path.join(ROOT, 'Copies')));
    await open(path.join(ROOT, 'Copies'));
    await click('Paste 1');
    await sleep(800);
    check('Copy + Paste: a copy in the new folder, the original stays', fs.existsSync(path.join(ROOT, 'Copies', 'beach.jpg')) && fs.existsSync(path.join(ROOT, 'beach.jpg')));
    await open(ROOT);
    await pick(path.join(ROOT, 'party.jpg'));
    await click('Copy to…');
    await js(`[...document.querySelectorAll('[data-move-folder]')].find(r => r.dataset.moveFolder === 'Trip').querySelector('button:last-child').click()`);
    await sleep(1000);
    check('Copy to…: copied into the chosen folder', fs.existsSync(path.join(ROOT, 'Trip', 'party.jpg')) && fs.existsSync(path.join(ROOT, 'party.jpg')));
    await js(`[...document.querySelectorAll('main button')].find(b => b.innerText.trim() === 'Clear')?.click()`);

    // ---- hide a photo, a video and a folder: a password is asked for the first time ----
    await pick(path.join(ROOT, 'secret-photo.jpg'));
    await pick(path.join(ROOT, 'clip.mp4'), true);
    await pick(path.join(ROOT, 'Diary'), true);
    await click('Hide');
    await waitFor('Set a password for hidden items');
    await shot('01-create-password');
    await type('[aria-label="New password"]', 'pix1234');
    await type('[aria-label="New password again"]', 'pix1234');
    await click('Save');
    await sleep(1500);
    let names = await shown();
    check('hidden photo, video and folder leave the Library', !names.includes('secret-photo.jpg') && !names.includes('clip.mp4') && !names.includes('Diary') && names.includes('beach.jpg'), names.join(', '));
    check('the lock button appears, locked', (await js(`document.querySelector('[data-testid=lock-button]')?.innerText ?? ''`)).includes('locked'));
    await shot('02-hidden');
    // A hidden folder can't be opened by its path either, and search does not find hidden files.
    const inside = await js(`window.clearup.lib.list(${JSON.stringify(path.join(ROOT, 'Diary'))})`);
    check('a hidden folder opened by path shows nothing', inside.entries.length === 0 && /hidden/i.test(inside.error ?? ''), inside.error ?? '');

    // ---- hide a label: the label and its files go ----
    const ref = await js(`window.clearup.lib.list(${JSON.stringify(ROOT)}).then(l => l.entries.find(e => e.name === 'party.jpg'))`);
    await js(`window.clearup.tags.addLabel([{ path: ${JSON.stringify(ref.path)}, size: ${ref.size}, mtime: ${ref.mtime} }], 'Private', null)`);
    const labels = await js('window.clearup.tags.labels()');
    await js(`window.clearup.privacy.hideLabel(${labels.find(l => l.name === 'Private').id}, true)`);
    await sleep(1500);
    names = await shown();
    const labelsNow = (await js('window.clearup.tags.labels()')).map(l => l.name);
    check('a hidden label and its files leave every list', !names.includes('party.jpg') && !labelsNow.includes('Private'), `${names.join(', ')} | labels: ${labelsNow.join(', ') || 'none'}`);
    const q = await js(`window.clearup.tags.query({ labels: [${labels.find(l => l.name === 'Private').id}], mode: 'any', minStars: 0 }, '')`);
    check('filtering by the hidden label finds nothing while locked', q.length === 0);

    // ---- unlock: a wrong password is refused; the right one shows everything, marked ----
    await js(`document.querySelector('[data-testid=lock-button]').click()`);
    await waitFor('Show hidden items');
    await type('[aria-label="Password"]', 'wrong');
    await click('Show');
    await waitFor('That password is not right');
    check('a wrong password is refused', true);
    await type('[aria-label="Password"]', 'pix1234');
    await click('Show');
    await sleep(1500);
    names = await shown();
    const badges = await js(`document.querySelectorAll('[data-testid=hidden-badge]').length`);
    check('unlocked: hidden items show again, marked Hidden', ['secret-photo.jpg', 'clip.mp4', 'Diary', 'party.jpg'].every(n => names.includes(n)) && badges >= 3, `${badges} marked`);
    check('unlocked: the hidden label is listed', (await js('window.clearup.tags.labels()')).some(l => l.name === 'Private' && l.hidden));
    await shot('03-unlocked');

    // ---- unhide one, lock again ----
    await pick(path.join(ROOT, 'secret-photo.jpg'));
    await click('Unhide');
    await sleep(800);
    await js(`document.querySelector('[data-testid=lock-button]').click()`);
    await sleep(1500);
    names = await shown();
    check('locked again: the unhidden photo stays, the rest go', names.includes('secret-photo.jpg') && !names.includes('clip.mp4') && !names.includes('Diary'), names.join(', '));
    const st = await js('window.clearup.privacy.status()');
    check('status counts what is hidden', st.hasPassword && !st.unlocked && st.items === 2 && st.labels === 1, JSON.stringify(st));
    check('files on disk are not touched', fs.existsSync(path.join(ROOT, 'clip.mp4')) && fs.existsSync(path.join(ROOT, 'Diary', 'page1.jpg')));

    // A hidden folder renamed in PixHaven stays hidden under its new name.
    await js(`window.clearup.privacy.unlock('pix1234')`);
    await js(`window.clearup.files.rename(${JSON.stringify(path.join(ROOT, 'Diary'))}, 'Journal')`);
    await js('window.clearup.privacy.lock()');
    await sleep(800);
    const renamed = await js(`window.clearup.lib.list(${JSON.stringify(ROOT)}).then(l => l.entries.map(e => e.name))`);
    check('a hidden folder renamed in the app stays hidden', fs.existsSync(path.join(ROOT, 'Journal')) && !renamed.includes('Journal') && !renamed.includes('Diary'), renamed.join(', '));
    await sleep(1000);
    check('the folder tree leaves hidden folders out too', !(await text()).includes('Journal') && !(await text()).includes('Diary'));

    // Settings: change the password; the old one no longer works.
    await js(`window.clearup.privacy.setPassword('pix1234', 'newpass')`);
    const oldWorks = await js(`window.clearup.privacy.unlock('pix1234').then(() => true, () => false)`);
    const newWorks = await js(`window.clearup.privacy.unlock('newpass').then(() => true, () => false)`);
    check('changing the password: only the new one unlocks', !oldWorks && newWorks);
    await js(`window.__clearupPage('settings')`);
    await waitFor('Hidden items');
    await shot('04-settings');
  } catch (e) {
    check('run', false, String(e?.stack ?? e));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}
