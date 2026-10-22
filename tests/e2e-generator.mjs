// End-to-end check of the Image Generator in the built app.
//   PIXHAVEN_GEN_DL_TEST=1: the download (small files only): resumes a partial file, checks checksums, then shows the tab.
//   otherwise: PIXHAVEN_GEN_MODEL = a downloaded model folder; makes images, checks files, prompt inside, same seed.
// Run: scripts/run-e2e-generator.mjs. Screenshots + results.json land in e2e-output/generator/.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
sharp.cache(false);

const OUT = process.env.CLEARUP_E2E_DIR;
const DL_TEST = !!process.env.PIXHAVEN_GEN_DL_TEST;
const MODEL = process.env.PIXHAVEN_GEN_MODEL;
const PICS = path.join(OUT, 'generated');
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function run(win, app) {
  const js = code => win.webContents.executeJavaScript(code);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 60000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (typeof t === 'function' ? await t() : (await text()).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for ${typeof t === 'function' ? 'a condition' : `"${t}"`}`);
  }
  async function click(label, exact = true) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button, [role=dialog] button')].find(b => b.offsetParent && ${exact ? `b.innerText.trim() === ${JSON.stringify(label)}` : `b.innerText.includes(${JSON.stringify(label)})`});
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(250);
  }
  const radio = (group, label) => js(`[...document.querySelectorAll('[role=radiogroup][aria-label="${group}"] [role=radio]')].find(b => b.innerText.trim() === ${JSON.stringify(label)}).click()`);
  const typeInto = (sel, value) => js(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, ${JSON.stringify(value)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  async function shot(name) {
    win.webContents.invalidate();
    await sleep(700);
    fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
  const shown = () => js(`[...document.querySelectorAll('[data-gen-image]')].map(f => f.dataset.genImage)`);

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 860);
    win.setAlwaysOnTop(true);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    await waitFor('What would you like to do?');
    // Never the user's real Pictures folder.
    fs.rmSync(PICS, { recursive: true, force: true });
    const s = await js('window.clearup.getSettings()');
    await js(`window.clearup.setSettings(${JSON.stringify({ generator: { ...s.generator, outputDir: PICS, count: 2, quality: 'fast', style: 'photo', size: 'square', format: 'png' } })})`);
    await js(`window.__clearupPage('generator')`);

    if (process.env.PIXHAVEN_GEN_FAKE_BLOCK) {
      // ---- v2.7.1: a picture the safety filter stops is made again with new seeds (seeds 42, 43 "blocked"; 100–102 all) ----
      await waitFor('Describe the picture', 15000);
      await typeInto('#gen-prompt', 'a red apple on a wooden table');
      await radio('Images', '1');
      await typeInto('[aria-label=Seed]', '42');
      await sleep(300);
      await click('Generate 1 image');
      await waitFor(async () => !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)) && (await shown()).length >= 1, 180000);
      const files = fs.existsSync(PICS) ? fs.readdirSync(PICS) : [];
      check('blocked picture retried: saved with the next free seed, nothing blurred', files.length === 1 && files[0].includes('(seed 44)') && !(await shown()).includes('hidden'),
        files.join(', '));
      await typeInto('[aria-label=Seed]', '100');
      await sleep(300);
      await click('Generate 1 image');
      await waitFor(async () => !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)) && (await shown()).includes('hidden'), 180000);
      check('after 3 blocked tries: a blurred tile, nothing saved', fs.readdirSync(PICS).length === 1, fs.readdirSync(PICS).join(', '));
      await shot('06-blocked');
    } else if (DL_TEST) {
      // ---- download: a partial file is resumed (HTTP range through the redirect), every file checked ----
      fs.rmSync(MODEL, { recursive: true, force: true });
      fs.mkdirSync(path.join(MODEL, 'tokenizer'), { recursive: true });
      const vocabUrl = 'https://huggingface.co/softwareweaver/LCM_Dreamshaper_v7_Olive_Onnx/resolve/25bf953af1ff2d6761da8d94bd4e0698f3b54a07/tokenizer/vocab.json';
      const head = Buffer.from(await (await fetch(vocabUrl, { headers: { Range: 'bytes=0-299999' } })).arrayBuffer());
      fs.writeFileSync(path.join(MODEL, 'tokenizer', 'vocab.json.part'), head);
      await waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=gen-download]')`)), 15000);
      const card = await js(`document.querySelector('[data-testid=gen-download]').innerText`);
      check('download card: size, offline, licence rules', /2\.\d GB|2\.7 GB|2,7/.test(card) && card.includes('OpenRAIL-M') && card.includes('Read the full licence'), card.slice(0, 120).replace(/\n/g, ' | '));
      await shot('01-download-card');
      await click('Agree and download', false).catch(() => click('Continue the download', false));
      await waitFor(async () => (await js('window.clearup.gen.status()')).installed, 120000);
      const files = ['tokenizer/vocab.json', 'tokenizer/merges.txt', 'scheduler/scheduler_config.json'].map(f => path.join(MODEL, f));
      check('download: resumed and verified (files complete, no .part left, marked ready)',
        files.every(f => fs.existsSync(f)) && fs.statSync(files[0]).size === 1059962 && !fs.existsSync(files[0] + '.part') && fs.existsSync(path.join(MODEL, '.verified')),
        files.map(f => `${path.basename(f)} ${fs.existsSync(f) ? fs.statSync(f).size : 'missing'}`).join(', '));
      await waitFor('Describe the picture', 15000);
      check('after the download the generator opens', true);
      await shot('02-after-download');
    } else {
      // ---- generating ----
      await waitFor('Describe the picture', 15000);
      const prompt = 'a lighthouse on a cliff at sunset';
      await typeInto('#gen-prompt', prompt);
      await typeInto('[aria-label=Seed]', '42');
      await sleep(300);
      await shot('01-ready');
      let t = Date.now();
      await click('Generate 2 images');
      await waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 10000);
      await sleep(1500);
      await shot('02-working');
      await waitFor(async () => (await shown()).length >= 2 && !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 300000);
      const first = (Date.now() - t) / 1000;
      const pngs = fs.readdirSync(PICS).filter(f => f.endsWith('.png'));
      check('2 images made and saved as PNG in the chosen folder', pngs.length === 2 && pngs.every(f => / a lighthouse on a cliff at \(seed 4[23]\)\.png$/.test(f)), `${pngs.join(', ')} · ${first.toFixed(1)} s (includes loading the model)`);
      const meta = await sharp(path.join(PICS, pngs[0])).metadata();
      const xmp = meta.xmp?.toString() ?? '';
      check('the prompt and settings are inside the PNG', meta.width === 512 && meta.height === 512 && xmp.includes(prompt) && /seed 4[23]/.test(xmp) && xmp.includes('PixHaven Image Generator'), `${meta.width}×${meta.height}`);
      await shot('03-results');

      // v2.7 Describe a picture: one of the lighthouse pictures → a description in the prompt box; Undo puts it back.
      if (process.env.PIXHAVEN_DESCRIBE_MODEL) {
        await typeInto('#gen-prompt', 'my own words');
        await sleep(300);
        t = Date.now();
        await js(`window.__clearupDescribe(${JSON.stringify(path.join(PICS, pngs[0]))})`);
        await waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=described]')`)), 120000);
        const described = await js(`document.querySelector('#gen-prompt').value`);
        check('Describe a picture: its description lands in the prompt box', /lighthouse|tower/i.test(described) && described.split(/s+/).length >= 4,
          `${((Date.now() - t) / 1000).toFixed(1)} s: "${described}"`);
        await shot('02b-described');
        await click('Undo');
        await sleep(300);
        check('Undo puts the previous description back', (await js(`document.querySelector('#gen-prompt').value`)) === 'my own words');
        await typeInto('#gen-prompt', prompt);
        await typeInto('[aria-label=Seed]', '42');   // describing clears the seed (a new picture)
        await sleep(300);
      }

      // Same seed → same picture; Portrait → 512×768; one image is quick once loaded.
      const seed42 = pngs.find(f => f.includes('(seed 42)'));
      const px42 = await sharp(path.join(PICS, seed42)).raw().toBuffer();
      await js(`window.clearup.setSettings(${JSON.stringify({ generator: { ...(await js('window.clearup.getSettings()')).generator, count: 1 } })})`);
      await js(`window.__clearupPage('home')`); await sleep(300); await js(`window.__clearupPage('generator')`);
      await radio('Images', '1');
      await sleep(300);
      t = Date.now();
      await click('Generate 1 image');
      await waitFor(async () => fs.readdirSync(PICS).filter(f => f.endsWith('.png')).length >= 3 && !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 120000);
      const again = fs.readdirSync(PICS).filter(f => f.endsWith('.png') && f.includes('(seed 42)') && f !== seed42)[0];
      const same = again && (await sharp(path.join(PICS, again)).raw().toBuffer()).equals(px42);
      check('same description, style and seed: the same picture', !!same, `${((Date.now() - t) / 1000).toFixed(1)} s for one image`);
      await radio('Shape', 'Portrait');
      await typeInto('[aria-label=Seed]', '');
      await sleep(300);
      await click('Generate 1 image');
      await waitFor(async () => fs.readdirSync(PICS).filter(f => f.endsWith('.png')).length >= 4 && !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 120000);
      const newest = fs.readdirSync(PICS).filter(f => f.endsWith('.png')).map(f => path.join(PICS, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      const pm = await sharp(newest).metadata();
      check('Portrait: 512 × 768', pm.width === 512 && pm.height === 768, `${pm.width}×${pm.height}`);

      // JPG: smaller file, prompt still inside.
      await radio('Format', 'JPG');
      await sleep(300);
      await click('Generate 1 image');
      await waitFor(async () => fs.readdirSync(PICS).some(f => f.endsWith('.jpg')) && !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 120000);
      const jpg = path.join(PICS, fs.readdirSync(PICS).find(f => f.endsWith('.jpg')));
      const jm = await sharp(jpg).metadata();
      check('JPG: saved as JPEG with the prompt inside, smaller than the PNGs', jm.format === 'jpeg' && (jm.xmp?.toString() ?? '').includes(prompt)
        && fs.statSync(jpg).size < fs.statSync(newest).size / 2, `${(fs.statSync(jpg).size / 1024).toFixed(0)} KB vs PNG ${(fs.statSync(newest).size / 1024).toFixed(0)} KB`);
      await radio('Format', 'PNG');

      // Stop while working.
      await radio('Images', '4');
      await sleep(300);
      const before = fs.readdirSync(PICS).length;
      await click('Generate 4 images');
      await waitFor(async () => !!(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 10000);
      await sleep(2500);
      await click('Stop');
      await waitFor(async () => !(await js(`!!document.querySelector('[data-testid=gen-progress]')`)), 60000);
      const made = fs.readdirSync(PICS).length - before;
      check('Stop: the request ends early', made < 4, `${made} of 4 made`);

      // History survives a page reload; Upscale takes an image to the Upscale tab.
      const hist = await js('window.clearup.gen.history()');
      check('earlier images are kept in the history (read back from disk)', hist.length >= 4 && hist.every(h => fs.existsSync(h.path)), `${hist.length} images`);
      await js(`document.querySelector('[data-gen-image=shown] button').click()`);
      await sleep(500);
      await shot('04-details');
      await click('Upscale');
      await waitFor('512 ×', 15000).then(() => check('Upscale opens the image in the Upscale tab', true), e => check('Upscale opens the image in the Upscale tab', false, String(e)));
      await shot('05-to-upscale');
    }
  } catch (e) {
    check('e2e run', false, String(e?.stack ?? e));
    await shot('zz-failure').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
  app.exit(results.every(r => r.pass) ? 0 : 1);
}
