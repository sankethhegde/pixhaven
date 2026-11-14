// End-to-end check of v2.11 in the built app: the Video editor tab converts real files made here with the bundled
// FFmpeg (an HEVC .mkv with sound, an H.264 .mp4, an iPhone-style HEIC photo) — H.264, copy without converting, fit
// under a size, sound only, GIF, HEIC → JPG, Stop — and the player's new top bar (← back, X close) and full screen
// without the Labels button. Run: npm run e2e:editor. Screenshots + results.json land in e2e-output/editor/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { makeHeic } from './make-heic.mjs';

const OUT = process.env.CLEARUP_E2E_DIR;
const ROOT = path.join(OUT, 'Clips');
const FF = path.resolve(process.platform === 'win32' ? 'resources/bin/win/ffmpeg/ffmpeg.exe' : 'resources/bin/linux/ffmpeg/ffmpeg');
const FP = FF.replace(/ffmpeg(\.exe)?$/, m => m.replace('ffmpeg', 'ffprobe'));
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const probe = f => JSON.parse(execFileSync(FP, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', f]).toString());

function makeMedia() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  const src = ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
  execFileSync(FF, ['-v', 'error', ...src, '-t', '8', '-c:v', 'libkvazaar', '-kvazaar-params', 'preset=ultrafast,qp=30', '-c:a', 'aac', '-shortest', path.join(ROOT, 'phone video.mkv')]);
  execFileSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=660', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-c:a', 'aac', '-shortest', path.join(ROOT, 'short.mp4')]);
  // Phase 2: a 12 s clip with a keyframe every second (like a phone video), so cuts can be made without converting.
  execFileSync(FF, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=520', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-g', '30', '-c:a', 'aac', '-shortest', path.join(ROOT, 'trip.mp4')]);
}
const dur = f => Number(probe(f).format.duration);
const vsize = f => { const v = probe(f).streams.find(s => s.codec_type === 'video'); return `${v.width}x${v.height}`; };

export default async function run(win, app) {
  const js = (code, gesture = false) => win.webContents.executeJavaScript(code, gesture);
  const text = () => js('document.body.innerText');
  async function waitFor(t, ms = 120000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if ((await text()).includes(t)) return; await sleep(300); }
    throw new Error(`Timed out waiting for "${t}"`);
  }
  async function click(label) {
    const ok = await js(`(() => { const b = [...document.querySelectorAll('main button')].find(b => b.offsetParent && b.innerText.trim().startsWith(${JSON.stringify(label)}));
      if (!b || b.disabled) return false; b.click(); return true; })()`);
    if (!ok) throw new Error(`No enabled button "${label}"`);
    await sleep(400);
  }
  const target = async id => { await js(`document.querySelector('[data-conv-target="${id}"]').click()`); await sleep(300); };
  const states = () => js(`Object.fromEntries([...document.querySelectorAll('[data-conv-file]')].map(r => [r.dataset.convFile, r.querySelector('[data-conv-state]').dataset.convState]))`);
  /** Start, then wait until every file that can be converted has an end state. */
  async function convert(expectDone) {
    await click('Convert ');
    const end = Date.now() + 300000;
    while (Date.now() < end) {
      const st = await states();
      if (Object.values(st).filter(s => ['done', 'failed', 'skipped', 'cancelled'].includes(s)).length >= expectDone && !(await text()).includes('Stop')) return st;
      await sleep(500);
    }
    throw new Error('Conversion did not finish');
  }
  async function shot(name) { win.webContents.invalidate(); await sleep(600); fs.writeFileSync(path.join(OUT, `${name}.png`), (await win.webContents.capturePage()).toPNG()); }
  const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`); };

  try {
    while (!win.isVisible()) await sleep(100);
    win.setSize(1280, 900);
    win.webContents.setBackgroundThrottling(false);
    fs.mkdirSync(OUT, { recursive: true });
    makeMedia();
    const photoSrc = path.join(ROOT, 'src.png');
    await sharp({ create: { width: 1400, height: 1000, channels: 3, background: '#4a7' } }).png().toFile(photoSrc);
    makeHeic(FF, photoSrc, path.join(ROOT, 'IMG_0001.heic'));
    fs.rmSync(photoSrc);
    const before = { mkv: sha(path.join(ROOT, 'phone video.mkv')), mp4: sha(path.join(ROOT, 'short.mp4')) };
    await waitFor('What would you like to do?');
    const caps = await js('window.clearup.conv.caps()');
    console.log('encoders', JSON.stringify(Object.fromEntries(Object.entries(caps.targets).map(([k, v]) => [k, v.encoder ?? (v.ok ? '-' : 'none')]))));
    check('H.264, HEVC, AV1, VP9 and ProRes can be made here', ['mp4-h264', 'mp4-hevc', 'mp4-av1', 'webm-vp9', 'mov-prores'].every(t => caps.targets[t].ok));

    // ---- the tab gets the files (as from the Library's Convert…) ----
    await js(`window.__clearupConvert(${JSON.stringify([path.join(ROOT, 'phone video.mkv'), path.join(ROOT, 'short.mp4')])})`);
    await waitFor('2 files');
    const info = await js(`[...document.querySelectorAll('[data-conv-file]')].map(r => r.innerText.replace(/\\n/g, ' '))`);
    check('files listed with format, size and length', info[0].includes('HEVC') && info[0].includes('1280×720') && info[1].includes('H264'), info.join(' | '));

    // ---- HEVC → MP4 H.264 ----
    await target('mp4-h264');
    await js(`(() => { const s = [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === 'Balanced'); s.click(); })()`);
    await shot('01-editor');
    let t = Date.now();
    let st = await convert(2);
    const h264 = path.join(ROOT, 'phone video.mp4');
    const p1 = fs.existsSync(h264) ? probe(h264) : null;
    check('HEVC .mkv → MP4 H.264 with sound, same length', p1?.streams.find(s => s.codec_type === 'video')?.codec_name === 'h264' && p1.streams.some(s => s.codec_type === 'audio') && Math.abs(Number(p1.format.duration) - 8) < 0.5,
      `${((Date.now() - t) / 1000).toFixed(1)} s; ${JSON.stringify(st)}`);
    check('an MP4 that already is H.264 becomes "short (converted).mp4", copied', fs.existsSync(path.join(ROOT, 'short (converted).mp4')) && (await text()).includes('short (converted).mp4'));
    check('originals untouched', sha(path.join(ROOT, 'phone video.mkv')) === before.mkv && sha(path.join(ROOT, 'short.mp4')) === before.mp4);
    await shot('02-converted');

    // ---- fit under 1 MB (HEVC), then sound only, then GIF ----
    await target('mp4-hevc');
    await js(`(() => { const s = document.querySelector('[aria-label="Fit under a size"]'); if (s.getAttribute('aria-checked') !== 'true') s.click(); })()`);
    await sleep(200);
    await js(`(() => { const i = document.querySelector('[aria-label="Size in MB"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '1'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(200);
    st = await convert(2);
    const small = path.join(ROOT, 'phone video (converted).mp4');
    const sz = fs.existsSync(small) ? fs.statSync(small).size : 0;
    const p2 = sz ? probe(small) : null;
    check('fit under 1 MB: HEVC, under the limit', sz > 0 && sz <= 1_050_000 && p2?.streams.find(s => s.codec_type === 'video')?.codec_name === 'hevc', `${(sz / 1e6).toFixed(2)} MB`);
    await js(`(() => { const s = document.querySelector('[aria-label="Fit under a size"]'); if (s.getAttribute('aria-checked') === 'true') s.click(); })()`);

    await target('mp3');
    st = await convert(2);
    const mp3 = path.join(ROOT, 'phone video.mp3');
    check('sound only: MP3', fs.existsSync(mp3) && probe(mp3).streams.every(s => s.codec_type === 'audio'));
    await target('gif');
    st = await convert(2);
    const gif = path.join(ROOT, 'short.gif');
    const gm = fs.existsSync(gif) ? await sharp(gif, { animated: true }).metadata() : null;
    check('GIF: animated, 480 px wide', !!gm && (gm.pages ?? 1) > 10 && gm.width === 480, gm ? `${gm.width}×${gm.pageHeight} ${gm.pages} frames` : 'none');

    // ---- HEIC → JPG (videos in the list are left out, saying why) ----
    await js(`window.__clearupConvert(${JSON.stringify([path.join(ROOT, 'IMG_0001.heic')])})`);
    await waitFor('IMG_0001.heic');
    await target('jpg');
    st = await convert(1);
    const jpg = path.join(ROOT, 'IMG_0001.jpg');
    const jm = fs.existsSync(jpg) ? await sharp(jpg).metadata() : null;
    check('HEIC photo → JPG at full size', jm?.format === 'jpeg' && jm.width === 1400 && jm.height === 1000, jm ? `${jm.width}×${jm.height}` : JSON.stringify(st));
    check('videos are left out of a photo format, saying why', !st['phone video.mkv'] && (await js(`document.querySelector('[data-conv-file="phone video.mkv"]').innerText`)).includes('not a photo'));

    // ---- Stop: nothing half-written stays ----
    await click('Clear list');
    await js(`window.__clearupConvert(${JSON.stringify([path.join(ROOT, 'phone video.mkv')])})`);
    await waitFor('1 file');
    await target('mov-prores');
    await js(`(() => { const s = [...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === 'Best'); s.click(); })()`);
    await click('Convert ');
    await sleep(1500);
    await click('Stop');
    await sleep(2500);
    const left = fs.readdirSync(ROOT).filter(f => f.endsWith('.mov') || f.includes('.part.'));
    check('Stop: the half-made file is removed', left.length === 0, left.join(', '));

    // ---- phase 2: Edit ----
    await click('Clear list');
    await js(`window.__clearupConvert(${JSON.stringify([path.join(ROOT, 'trip.mp4'), path.join(ROOT, 'short.mp4')])})`);
    await waitFor('2 files');
    await js(`[...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === 'Edit').click()`);
    await sleep(300);
    await js(`document.querySelector('[data-edit="trip.mp4"]').click()`);
    await waitFor('Save this frame (JPG)');
    const ok = async () => { for (let i = 0; i < 60; i++) { if (await js(`(document.querySelector('[data-testid=edit-video]')?.readyState ?? 0) >= 1`)) return true; await sleep(250); } return false; };
    check('Edit: the video plays in the preview', await ok());
    const at = async s => { await js(`(() => { const v = document.querySelector('[data-testid=edit-video]'); v.currentTime = ${s}; })()`); await sleep(600); };
    const button = async label => { const okB = await js(`(() => { const b = [...document.querySelectorAll('[data-testid=edit-panel] button')].find(b => b.offsetParent && b.innerText.trim() === ${JSON.stringify(label)}); if (!b || b.disabled) return false; b.click(); return true; })()`); if (!okB) throw new Error(`No "${label}"`); await sleep(300); };
    const exportAndWait = async () => {
      await button('Export') .catch(() => js(`[...document.querySelectorAll('[data-testid=edit-panel] button')].find(b => b.innerText.trim().startsWith('Export')).click()`));
      const end = Date.now() + 180000;
      while (Date.now() < end && !(await js(`!!document.querySelector('[data-testid=edit-result]')`))) await sleep(500);
      return js(`document.querySelector('[data-testid=edit-result]')?.innerText ?? ''`);
    };
    // Trim 2–10 s: saved without converting.
    await at(2); await button('Start here');
    await at(10); await button('End here');
    let res = await exportAndWait();
    const trimmed = path.join(ROOT, 'trip (edited).mp4');
    check('Edit: trim 2–10 s saved without converting', fs.existsSync(trimmed) && Math.abs(dur(trimmed) - 8) < 1.1 && res.includes('without converting'), `${fs.existsSync(trimmed) ? dur(trimmed).toFixed(2) : '-'} s · ${res}`);
    // Split at 6 s: two files.
    await button('Start over');
    await at(6); await button('Split here');
    res = await exportAndWait();
    const part1 = path.join(ROOT, 'trip (part 1).mp4'), part2 = path.join(ROOT, 'trip (part 2).mp4');
    check('Edit: split at 6 s makes two files', fs.existsSync(part1) && fs.existsSync(part2) && Math.abs(dur(part1) - 6) < 1.1 && Math.abs(dur(part2) - 6) < 1.1, fs.existsSync(part2) ? `${dur(part1).toFixed(2)} s + ${dur(part2).toFixed(2)} s` : res);
    // A real edit: cut out 2–4 s, crop 9:16, 2× speed, no sound, text, fade in.
    await button('Start over');
    await at(2); await button('Cut out from here…');
    await at(4); await button('…to here');
    await button('9:16');
    await js(`(() => { const s = document.querySelector('[aria-label="Speed"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, '2'); s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await js(`(() => { const set = (sel, v) => { const i = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); }; set('[aria-label="Volume"]', '0'); set('[aria-label="Text on the video"]', 'Trip 100% fun'); set('[aria-label="Fade in"]', '1'); })()`);
    await sleep(500);
    check('Edit: the crop box and the text show on the preview', await js(`!!document.querySelector('[data-testid=crop-box]')`) && (await text()).includes('Trip 100% fun'));
    const summary = await js(`document.querySelector('[data-testid=edit-summary]').innerText`);
    check('Edit: the summary counts the length after edits', summary.includes('cut 0:02') && summary.includes('5 s long'), summary.replace(/\n/g, ' '));
    await shot('04-edit');
    res = await exportAndWait();
    const edited2 = path.join(ROOT, 'trip (edited 2).mp4');
    const e2 = fs.existsSync(edited2) ? probe(edited2) : null;
    check('Edit: cut out, 9:16, 2×, no sound, text, fade → 5 s, 404×720, silent', !!e2 && Math.abs(Number(e2.format.duration) - 5) < 0.4 && vsize(edited2) === '404x720' && !e2.streams.some(s => s.codec_type === 'audio'),
      e2 ? `${Number(e2.format.duration).toFixed(2)} s, ${vsize(edited2)}, ${e2.streams.map(s => s.codec_type).join('+')}` : res);
    // A frame as a photo.
    await at(4); await button('Save this frame (JPG)');
    await sleep(1500);
    const frame = fs.readdirSync(ROOT).find(f => /^trip at 0m0[34]s\.jpg$/.test(f));
    check('Edit: save this frame as a JPG', !!frame && (await sharp(path.join(ROOT, frame)).metadata()).width === 1280, frame ?? fs.readdirSync(ROOT).join(', '));
    await button('Files');

    // ---- phase 2: Join ----
    await js(`[...document.querySelectorAll('[role=radio]')].find(b => b.innerText.trim() === 'Join').click()`);
    await sleep(300);
    await js(`document.querySelector('[aria-label="Join trip.mp4"]').click()`);
    await js(`document.querySelector('[aria-label="Join short.mp4"]').click()`);
    await sleep(300);
    await click('Join 2 videos');
    const endJ = Date.now() + 180000;
    const joined = path.join(ROOT, 'trip (joined).mp4');
    while (Date.now() < endJ && !(fs.existsSync(joined) && !(await text()).includes('Stop'))) await sleep(500);
    check('Join: 12 s + 4 s → 16 s at the first video\'s size, with sound', fs.existsSync(joined) && Math.abs(dur(joined) - 16) < 0.6 && vsize(joined) === '1280x720' && probe(joined).streams.some(s => s.codec_type === 'audio'),
      fs.existsSync(joined) ? `${dur(joined).toFixed(2)} s, ${vsize(joined)}` : 'none');
    await shot('05-join');

    // ---- the player: ← back on the left, X on the right, no Labels in full screen ----
    await js(`window.__clearupLibrary(${JSON.stringify(ROOT)})`);
    await sleep(1500);
    await js(`[...document.querySelectorAll('[data-path]')].find(b => b.dataset.path.endsWith('short.mp4')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
    await sleep(2500);
    const bar = await js(`(() => { const back = document.querySelector('[aria-label="Back to the list"]'), x = document.querySelector('[aria-label="Close player"]');
      const p = back?.closest('[aria-label^="Player"]')?.getBoundingClientRect();   // 1.0.5: the player sits in the Library's watch page
      return back && x && p ? { back: back.getBoundingClientRect().left - p.left, x: x.getBoundingClientRect().left - p.left, w: p.width } : null; })()`);
    check('player: ← back at the left, X at the right', !!bar && bar.back < 100 && bar.x > bar.w - 100, JSON.stringify(bar));
    check('player: stars and labels shown with the video (watch page)', await js(`!!document.querySelector('[data-testid=watch-tags] [data-testid=tag-editor]')`));
    await js(`document.querySelector('[aria-label^="Player"] [aria-label="Full screen"]').click()`, true);
    await sleep(1500);
    await sleep(300);
    const fullLabels = await js(`!!document.fullscreenElement?.querySelector('[aria-label="Labels and stars"]')`);
    check('player: full screen has the Labels button (back in 1.0.6)', fullLabels);
    await shot('03-fullscreen');
    await js(`document.querySelector('[aria-label="Back to the list"]').click()`, true);
    await sleep(1200);
    check('player: ← leaves full screen first, the player stays', await js(`!document.fullscreenElement && !!document.querySelector('[aria-label="Close player"]')`));
    await js(`document.querySelector('[aria-label="Close player"]').click()`);
    await sleep(800);
    check('player: X closes it', !(await js(`!!document.querySelector('[aria-label="Close player"]')`)));
  } catch (e) {
    check('run', false, String(e?.stack ?? e));
    await shot('error').catch(() => {});
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
}
