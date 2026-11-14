// 1.0.7: PixHaven's Attic client against a real Attic server (from the attic repo next to this one, 0.14 or later):
// sign in, shares and folders, upload, ranged reads, FFprobe through the session cookie, move, trash, download.
// Skipped when the attic repo isn't there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { load } from './helper.mjs';
import { FFMPEG_DIR } from './make-media.mjs';

const SERVER = path.resolve('..', 'attic', 'server', 'server.js');
const have = fs.existsSync(SERVER) && fs.readFileSync(path.resolve('..', 'attic', 'server', 'files.js'), 'utf8').includes('trashItem');
const PORT = 22000 + Math.floor(Math.random() * 1000);
const A = await load('attic/client');
const F = await load('library/ffmpeg');
F.setFfmpegDir(FFMPEG_DIR);
let server, tmp, share, c;

test.before(async () => {
  if (!have) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-attic-'));
  share = path.join(tmp, 'Media');
  fs.mkdirSync(path.join(share, 'Videos'), { recursive: true });
  const ff = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  spawnSync(ff, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-c:v', 'mpeg4', '-y', path.join(share, 'Videos', 'clip.mp4')]);
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ host: '127.0.0.1', shares: [{ id: 'media', name: 'Media', rootPath: share }] }));
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ATTIC_CONFIG: path.join(tmp, 'config.json'), ATTIC_DATA: path.join(tmp, 'data'), ATTIC_PORT: String(PORT), ATTIC_DISCOVERY_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => { server.stdout.on('data', d => { if (String(d).includes('Shares:')) resolve(); }); server.on('exit', code => reject(new Error('server exited ' + code))); });
  const setup = new A.AtticClient({ address: '127.0.0.1', port: PORT });
  await setup.call('POST', '/api/setup', { displayName: 'Master', username: 'master', password: 'master-pass' });
  let saved = null;
  c = new A.AtticClient({ address: '127.0.0.1', port: PORT }, conn => { saved = { ...conn }; });
  c.savedRef = () => saved;
});
test.after(async () => {
  if (server && server.exitCode === null) await new Promise(r => { server.on('exit', r); server.kill(); });
  if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* still in use */ }
});

test('attic:// paths', () => {
  assert.deepEqual(A.parseAttic('attic://media/Videos/Goa trip/clip.mp4'), { share: 'media', rel: 'Videos/Goa trip/clip.mp4' });
  assert.deepEqual(A.parseAttic('attic://media'), { share: 'media', rel: '' });
  assert.equal(A.atticPath('media', ''), 'attic://media');
  assert.equal(A.atticPath('media', 'a/b.mp4'), 'attic://media/a/b.mp4');
  assert.ok(A.isAttic('attic://x/y') && !A.isAttic('C:\\x'));
});

test('signs in, keeps only the session (never the password), lists shares and folders', { skip: !have && 'no attic repo' }, async () => {
  const hello = await c.hello();
  assert.equal(hello.app, 'Attic');
  await assert.rejects(c.signIn('master', 'wrong', true), e => e instanceof A.AtticError && e.status === 401);
  const acc = await c.signIn('master', 'master-pass', true);
  assert.equal(acc.type, 'master');
  const saved = c.savedRef();
  assert.ok(saved.session && !JSON.stringify(saved).includes('master-pass'), 'session kept, password not');
  assert.equal((await c.whoami()).username, 'master');
  assert.deepEqual((await c.shares()).map(s => s.id), ['media']);
  assert.deepEqual((await c.folder('media', 'Videos')).items.map(i => i.name), ['clip.mp4']);
});

test('upload (never overwrites), ranged read, FFprobe over the network with the session cookie', { skip: !have && 'no attic repo' }, async () => {
  const local = path.join(tmp, 'from pc ಕನ್ನಡ.mp4');
  fs.copyFileSync(path.join(share, 'Videos', 'clip.mp4'), local);
  let sent = 0;
  const e = await c.upload(local, 'media', 'Videos', n => { sent += n; });
  assert.equal(e.name, 'from pc ಕನ್ನಡ.mp4');
  assert.equal(e.size, fs.statSync(local).size);
  assert.equal(sent, e.size);
  const again = await c.upload(local, 'media', 'Videos');
  assert.equal(again.name, 'from pc ಕನ್ನಡ (1).mp4');
  const head = await c.read('media', 'Videos/clip.mp4', [0, 11]);
  assert.equal(head.length, 12);
  assert.equal(head.subarray(4, 8).toString(), 'ftyp');
  F.setInputResolver(f => (A.isAttic(f) ? ['-headers', `Cookie: ${c.cookie()}\r\n`, '-i', c.fileUrl(A.parseAttic(f).share, A.parseAttic(f).rel)] : null));
  const v = await F.probeVideo('attic://media/Videos/from pc ಕನ್ನಡ.mp4');
  assert.deepEqual([v.width, v.height, v.hasVideo], [320, 240, true]);
  assert.ok(Math.abs(v.duration - 3) < 0.2);
  const frame = await F.videoFrame('attic://media/Videos/clip.mp4', 1, 160);
  assert.ok(frame.length > 500 && frame[0] === 0xff && frame[1] === 0xd8, 'a JPEG frame');
});

test('make a folder, move into it and rename, then trash; download with the size checked', { skip: !have && 'no attic repo' }, async () => {
  const made = await c.makeFolder('media', 'Videos', 'Goa');
  assert.equal(made.path, 'Videos/Goa');
  const m = await c.move('media', 'Videos/from pc ಕನ್ನಡ (1).mp4', { folder: 'Videos/Goa', name: 'beach.mp4' });
  assert.deepEqual(m, { share: 'media', path: 'Videos/Goa/beach.mp4' });
  const dest = path.join(tmp, 'down.mp4');
  const n = await c.download('media', 'Videos/Goa/beach.mp4', dest);
  assert.equal(n, fs.statSync(dest).size);
  assert.equal(n, fs.statSync(path.join(share, 'Videos', 'Goa', 'beach.mp4')).size);
  assert.ok(!fs.readdirSync(tmp).some(f => f.endsWith('.pixhaven-part')), 'no part file left');
  await c.trash('media', 'Videos/Goa/beach.mp4');
  assert.deepEqual((await c.folder('media', 'Videos/Goa')).items, []);
  await assert.rejects(c.download('media', 'Videos/Goa/beach.mp4', path.join(tmp, 'gone.mp4')), e => e.status === 404);
});

test('an Attic that is not answering says so plainly', async () => {
  const off = new A.AtticClient({ address: '127.0.0.1', port: 1 });
  await assert.rejects(off.hello(), e => e instanceof A.AtticError && e.code === 'OFFLINE' && /not answering/.test(e.message));
});
