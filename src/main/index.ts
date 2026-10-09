// Electron main process: window, local-image protocol and IPC handlers.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, Notification, powerMonitor, protocol, shell } from 'electron';
import type { JobItem, ModelDownload, PlayerCaps, Settings, TagFilter, UpscaleOptions, WatchQuery } from '@shared/types';
import { IMAGE_EXTENSIONS } from '@shared/types';
import { getSettings, updateSettings } from './settings';
import { detectGpu, hasDedicatedGpu } from './gpu-detect';
import { cleanTemp, inspectImage, quickSize, saveResult, scanFolder, UpscaleJob, friendlyError, isImageFile, setGpuWorks } from './upscale-job';
import { log, logDir } from './logger';
import { resourcesDir } from './engine';
import { queue } from './queue';
import { modelStatus, downloadQualityModels, DOWNLOAD_MB } from './models';
import { initUpdater, checkForUpdates, updateStatus, installUpdate } from './updater';
import * as sort from './sort-service';
import * as tidy from './tidy-service';
import * as library from './library-service';
import * as player from './player-service';
import * as tags from './tags-service';
import * as watch from './watch-service';
import { SEARCH_LIMIT } from './library/browse';
import { mediaKind } from '@shared/types';
import { moveAppData } from './app-data-move';

protocol.registerSchemesAsPrivileged([{ scheme: 'clearup', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

// Dev/test only: a separate app-data folder, e.g. to act as a second laptop in the labels export/import test.
if (!app.isPackaged && process.env.CLEARUP_USER_DATA) app.setPath('userData', process.env.CLEARUP_USER_DATA);
// Renamed from ClearUp (0.6.0): its app data moves to the new name once (not for the self-test, which only checks).
else if (!process.argv.includes('--selftest')) {
  const old = path.join(app.getPath('appData'), 'ClearUp');
  const r = moveAppData(old, app.getPath('userData'));
  if (r.moved || r.error) log(r.error ? 'warn' : 'info', `App data from ${old}: ${r.error ?? `moved${r.left.length ? `, left behind: ${r.left.join(', ')}` : ''}`}`);
}

/** Command-line mode: "PixHaven.exe --cli <command> …" (the pixhaven.cmd launcher adds --cli). No window. */
const cliAt = process.argv.indexOf('--cli');
if (cliAt > 0) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('log-level', '3');       // keep Chromium's own messages out of the terminal
} else if (!app.requestSingleInstanceLock()) app.quit();

let win: BrowserWindow | null = null;
const jobs = new Map<string, { job: UpscaleJob; queueId: string }>();
const jobOpts = new Map<string, UpscaleOptions>();
const send = (channel: string, payload: unknown) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

/** "--sort <folder>" comes from the Explorer right-click menu (installed by the setup program). */
const sortArg = (argv: string[]) => { const i = argv.indexOf('--sort'); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
let pendingSort = sortArg(process.argv);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 920, minHeight: 640,
    title: 'PixHaven', show: false, autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    icon: path.join(resourcesDir(), 'icon.png'),
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win?.show());
  // Links open in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (!app.isPackaged) {
    win.webContents.on('before-input-event', (_e, input) => { if (input.key === 'F12') win?.webContents.toggleDevTools(); });
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
  // Dev-only: CLEARUP_E2E=<script> drives the UI for automated end-to-end checks (tests/e2e*.mjs).
  if (!app.isPackaged && process.env.CLEARUP_E2E) {
    const w = win;
    w.webContents.once('did-finish-load', () => {
      import(pathToFileURL(process.env.CLEARUP_E2E!).href).then(m => m.default(w, app)).catch(e => { log('error', 'e2e', e); app.exit(1); });
    });
  }
}

app.on('second-instance', (_e, argv) => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  const folder = sortArg(argv);
  if (folder) send('open:sort', folder);
});

/** "PixHaven.exe --selftest <out.json>": GPU check + one real upscale, no window. For install checks and support. */
async function selfTest(outFile: string): Promise<void> {
  const report: Record<string, unknown> = { version: app.getVersion() };
  try {
    const sharp = (await import('sharp')).default;
    report.gpu = await detectGpu();
    if (process.argv.includes('--with-download')) {
      const t0 = Date.now();
      await downloadQualityModels(() => {});
      report.download = { seconds: (Date.now() - t0) / 1000 };
    }
    report.models = modelStatus();
    const input = path.join(app.getPath('temp'), 'clearup-selftest.png');
    await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3a6' } }).png().toFile(input);
    const settings = { ...getSettings(), cpuOnly: process.argv.includes('--cpu') };
    const job = new UpscaleJob([{ path: input, width: 64, height: 48 }],
      { size: { kind: 'scale', factor: 2 }, model: 'fast', format: 'png', jpgQuality: 90 }, settings, 'single', () => {});
    await job.run();
    const item = job.items[0];
    report.upscale = { cpu: settings.cpuOnly, state: item.state, error: item.error, size: `${item.outWidth}x${item.outHeight}`, seconds: item.seconds };
    // Face scan worker (ONNX models) on a folder with one generated photo.
    const dir = path.join(app.getPath('temp'), 'clearup-selftest-sort');
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    await sharp({ create: { width: 320, height: 240, channels: 3, background: '#89a' } }).jpeg().toFile(path.join(dir, 'test.jpg'));
    const t = Date.now();
    const scan = sort.scanFolder(dir, { scan: () => {} });
    const r = await scan.done;
    const st = sort.folderStatus(dir);
    report.faceScan = { ok: st.scannedImages === 1, scanned: st.scannedImages, seconds: (Date.now() - t) / 1000, folderId: r.folderId };
    // Offline OCR with the bundled language file.
    const { NameReader } = await import('./faces/names-ocr');
    const { readImageBuffer } = await import('./image-io');
    const ocrImg = path.join(dir, 'name.png');
    await sharp(Buffer.from('<svg width="600" height="200"><rect width="600" height="200" fill="white"/><text x="40" y="130" font-size="90" font-family="Arial" font-weight="bold">ASHA</text></svg>')).png().toFile(ocrImg);
    const reader = new NameReader(path.join(resourcesDir(), 'ocr'), path.join(app.getPath('temp'), 'clearup-selftest-ocr'));
    report.ocr = await reader.read(ocrImg, readImageBuffer);
    await reader.close();
    // Media library: the bundled FFmpeg makes a short video, and the thumbnail cache reads it back.
    library.init(() => {});
    const { execFileSync } = await import('node:child_process');
    const { ThumbCache } = await import('./library/thumbs');
    const clip = path.join(dir, 'clip.mp4');
    const ff = path.join(resourcesDir(), 'bin', process.platform === 'win32' ? 'win' : 'linux', 'ffmpeg', ...(process.platform === 'win32' ? ['ffmpeg.exe'] : ['bin', 'ffmpeg']));
    execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2', '-c:v', 'mpeg4', clip], { windowsHide: true });
    const cs = fs.statSync(clip);
    const info = await new ThumbCache(path.join(dir, 'library-cache')).make({ path: clip, size: cs.size, mtime: cs.mtimeMs });
    report.library = { ok: !!info.thumb && Math.round(info.duration ?? 0) === 2, size: `${info.width}x${info.height}`, error: info.error };
    // Video player: the on-the-fly conversion path (MPEG-4 Part 2 is not played directly) with this machine's encoder.
    const P = await import('./library/player');
    const probe = await P.probeMedia(clip);
    const plan = P.planPlayback(probe, { hevc: true, av1: true, mkv: true }, 0, 'mp4');
    const encoder = await P.pickEncoder();
    const converted = path.join(dir, 'converted.mp4');
    const args = P.streamArgs(clip, probe, 'transcode', 0.5, 0, encoder);
    args[args.length - 1] = converted;
    execFileSync(ff, ['-y', ...args], { windowsHide: true });
    const out = await P.probeMedia(converted);
    report.player = { ok: plan.mode === 'transcode' && out.video?.codec === 'h264' && Math.abs(out.duration - 1.5) < 0.3, encoder, mode: plan.mode };
    // Labels and stars: tag the clip in a scratch database, export, import into a fresh one.
    const { TagStore } = await import('./library/tags');
    const a = new TagStore(path.join(dir, 'labels-a.db')), b = new TagStore(path.join(dir, 'labels-b.db'));
    await a.addLabel([{ path: clip, size: cs.size, mtime: cs.mtimeMs }], 'Self-test');
    await a.setStars([{ path: clip, size: cs.size, mtime: cs.mtimeMs }], 4);
    const imp = await b.importData(a.exportData());
    const back = b.tagsFor([clip])[clip];
    report.labels = { ok: imp.applied === 1 && back?.stars === 4 && back.labels.length === 1 };
    a.close(); b.close();
    // v2.1: ExifTool writes stars and a label into a copy of the clip (TAG-08); the watched-folder index finds it.
    const { writeTags, readTags } = await import('./library/xmp');
    const tagged = path.join(dir, 'tagged.mp4');
    fs.copyFileSync(clip, tagged);
    const w = await writeTags(tags.exiftool(), [{ file: tagged, stars: 4, labels: ['Self-test'], previous: [] }]);
    const rt = await readTags(tags.exiftool(), tagged).catch(() => ({ rating: 0, subject: [] as string[] }));
    report.writeFiles = { ok: w[0].ok && rt.rating === 4 && rt.subject.includes('Self-test'), error: w[0].error };
    const { MediaIndex } = await import('./library/media-index');
    const ix = new MediaIndex(path.join(dir, 'index.db'));
    await ix.scan(ix.addRoot(dir));
    report.index = { ok: ix.query({ text: 'tagged' }).total === 1 };
    ix.close();
    report.ok = item.state === 'done' && item.outWidth === 128 && st.scannedImages === 1 && report.ocr === 'Asha'
      && (report.library as { ok: boolean }).ok && (report.player as { ok: boolean }).ok && (report.labels as { ok: boolean }).ok
      && (report.writeFiles as { ok: boolean }).ok && (report.index as { ok: boolean }).ok;
  } catch (e) {
    report.ok = false; report.error = String((e as Error).stack ?? e);
  }
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
}

/** First run (installer section of the doc): a 2-second test upscale decides GPU vs CPU and low-spec mode. */
async function firstRunCheck(gpu: Awaited<ReturnType<typeof detectGpu>>): Promise<void> {
  if (!gpu.ok) { setGpuWorks(false); log('warn', 'No Vulkan GPU: upscaling will run on the CPU'); }
  if (getSettings().firstRunDone || !gpu.ok) { if (!getSettings().firstRunDone) updateSettings({ firstRunDone: true }); return; }
  const sharp = (await import('sharp')).default;
  const input = path.join(app.getPath('temp'), 'clearup-firstrun.png');
  await sharp({ create: { width: 256, height: 256, channels: 3, background: '#7a9' } }).png().toFile(input);
  const job = new UpscaleJob([{ path: input, width: 256, height: 256 }],
    { size: { kind: 'scale', factor: 4 }, model: 'fast', format: 'png', jpgQuality: 90 }, getSettings(), 'single', () => {});
  await job.run();
  const it = job.items[0];
  const slow = (it.seconds ?? 99) > 2;
  log('info', `First-run test: ${it.state} in ${it.seconds?.toFixed(2)} s`);
  if (it.state !== 'done') { setGpuWorks(false); updateSettings({ cpuOnly: true }); }
  const s = getSettings();
  if (s.lowSpecAuto && slow && !s.lowSpec) updateSettings({ lowSpec: true, tileSize: 192 });
  updateSettings({ firstRunDone: true });
}

app.whenReady().then(async () => {
  log('info', `PixHaven ${app.getVersion()} starting (${process.platform} ${process.arch}, packaged=${app.isPackaged})`);
  if (cliAt > 0) {
    const { runCli } = await import('./cli');
    const code = await runCli(process.argv.slice(cliAt + 1));
    cleanTemp(true);
    app.exit(code);
    return;
  }
  const st = process.argv.indexOf('--selftest');
  if (st > 0) { await selfTest(process.argv[st + 1] ?? path.join(app.getPath('temp'), 'clearup-selftest.json')); cleanTemp(true); app.exit(0); return; }
  cleanTemp();
  nativeTheme.themeSource = getSettings().theme;

  // clearup://img/<encoded path> serves local photos to the UI (images only);
  // clearup://thumb/… and clearup://preview/… serve the media library's cached thumbnails and viewer pictures.
  protocol.handle('clearup', req => {
    const url = new URL(req.url);
    // Video player: the file itself (with byte ranges for seeking), or an FFmpeg stream for other formats.
    if (url.host === 'media') {
      const p = decodeURIComponent(url.pathname.slice(1));
      return mediaKind(p) === 'video' && path.isAbsolute(p) ? player.serveFile(req, p) : new Response('Not found', { status: 404 });
    }
    if (url.host === 'stream') return player.serveStream(url);
    if (url.host === 'thumb' || url.host === 'preview') {
      const f = library.cacheFile(url.host, url.pathname.slice(1));
      return f ? net.fetch(pathToFileURL(f).toString()) : new Response('Not found', { status: 404 });
    }
    const p = decodeURIComponent(url.pathname.slice(1));
    if (!(isImageFile(p) || mediaKind(p) === 'image') || !path.isAbsolute(p)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(p).toString());
  });
  library.init(info => send('lib:thumb', info));
  // v2.1: watched folders, labels following files moved inside them, and (optionally) writing labels into files.
  tags.setOnMoved((from, to) => watch.moved(from, to));
  tags.setWriteHooks(p => player.isOpen(p), s => send('tags:writeStatus', s));
  tags.setAfterImport(() => void tags.relinkFromIndex(s => watch.bySize(s)).then(n => { if (n) send('watch:changed', { dirs: [], added: 0, removed: 0, relinked: n }); }));
  watch.init(s => send('watch:status', s), c => send('watch:changed', c));

  createWindow();
  queue.onChange(items => send('queue:update', items));
  powerMonitor.on('on-battery', () => send('power:update', { onBattery: true }));
  powerMonitor.on('on-ac', () => send('power:update', { onBattery: false }));
  initUpdater(s => send('update:status', s));
  // Phase C: one backup of library.db a day (last 7 kept).
  setTimeout(() => tags.dailyBackup(), 20_000);
  setInterval(() => tags.dailyBackup(), 6 * 3600_000);
  detectGpu().then(async gpu => { applyAutoLowSpec(gpu); await firstRunCheck(gpu); })
    .catch(e => log('error', 'GPU detection failed', e));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { for (const j of jobs.values()) j.job.cancel(); sort.cancelScan(); });
app.on('quit', () => { cleanTemp(true); watch.close(); tags.close(); });

/** GEN-04: low-spec mode follows the GPU until the user sets it themselves. */
function applyAutoLowSpec(gpu: Awaited<ReturnType<typeof detectGpu>>): void {
  const s = getSettings();
  const want = !hasDedicatedGpu(gpu);
  if (s.lowSpecAuto && s.lowSpec !== want) updateSettings({ lowSpec: want, tileSize: want ? 192 : 0 });
  setGpuWorks(gpu.ok);
}

const notifyDone = (title: string, body: string) => {
  // GEN-10: tell the user when a long job ends while the window is in the background.
  if (!win?.isFocused() && Notification.isSupported()) new Notification({ title, body }).show();
};

// ---------- IPC ----------
const handle = (channel: string, fn: (...args: any[]) => unknown) =>
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return await fn(...args); } catch (e) { log('error', `${channel} failed`, e); throw new Error(friendlyError(e)); }
  });

handle('app:info', async () => {
  const gpu = await detectGpu();
  applyAutoLowSpec(gpu);
  return { version: app.getVersion(), gpu, dedicated: hasDedicatedGpu(gpu), settings: getSettings(), onBattery: powerMonitor.isOnBatteryPower(), pendingSort };
});
handle('app:takePendingSort', () => { const p = pendingSort; pendingSort = null; return p; });
handle('gpu:detect', async () => {
  const gpu = await detectGpu(true);
  applyAutoLowSpec(gpu);
  return { gpu, dedicated: hasDedicatedGpu(gpu) };
});
handle('settings:get', () => getSettings());
handle('settings:set', (patch: Partial<Settings>) => {
  if (patch.theme) nativeTheme.themeSource = patch.theme;
  // These are changed only through their own actions (location, watched folders, write-into-files); the UI's copy of
  // the library settings may be older, so it must never put back an old value.
  if (patch.library) {
    const cur = getSettings().library;
    patch = { ...patch, library: { ...patch.library, dbPath: cur.dbPath, watched: cur.watched, writeToFiles: cur.writeToFiles } };
  }
  return updateSettings(patch);
});
handle('power:get', () => ({ onBattery: powerMonitor.isOnBatteryPower() }));

const imageFilter = { name: 'Images', extensions: IMAGE_EXTENSIONS };
handle('dialog:openImages', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile', 'multiSelections'], filters: [imageFilter] });
  return r.canceled ? [] : r.filePaths;
});
handle('dialog:openFolder', async (title?: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('path:kind', (p: string) => {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() ? 'folder' : isImageFile(p) ? 'image' : 'other';
  } catch { return 'missing'; }
});
handle('image:inspect', (p: string) => inspectImage(p));
handle('image:size', (p: string) => quickSize(p));
handle('folder:scan', (p: string) => scanFolder(p));

// ---- upscaling, through the job queue ----
handle('job:start', async (req: { files: { path: string; width: number; height: number }[]; opts: UpscaleOptions; mode: 'single' | 'folder' }) => {
  updateSettings({ last: req.opts });
  const job = new UpscaleJob(req.files, req.opts, getSettings(), req.mode, u => {
    send('job:update', u);
    if (u.finished) {
      jobs.delete(u.jobId);
      if (req.mode === 'folder') notifyDone('PixHaven: folder finished', `${u.items.filter(i => i.state === 'done').length} of ${u.total} images upscaled.`);
    }
  });
  const label = req.mode === 'single' ? `Upscale ${path.basename(req.files[0].path)}` : `Upscale ${req.files.length} images`;
  job.announce(); // before queuing: a job with nothing to do can finish immediately
  jobOpts.set(job.id, req.opts);
  const q = queue.add('upscale', label, () => job.run(), () => job.cancel());
  jobs.set(job.id, { job, queueId: q.id });
  return job.id;
});
handle('job:cancel', (jobId: string) => {
  const j = jobs.get(jobId);
  if (!j) return;
  j.job.cancel();
  if (queue.position(j.queueId) > 0) { queue.cancel(j.queueId); void j.job.run(); } // still waiting: finish it as cancelled now
});

handle('result:save', async (req: { jobId: string; itemId: string; item: JobItem; saveAs: boolean }) => {
  const opts = jobOpts.get(req.jobId) ?? getSettings().last;
  let chosen: string | undefined;
  if (req.saveAs) {
    const ext = opts.format === 'jpg' ? 'jpg' : opts.format;
    const base = path.basename(req.item.input, path.extname(req.item.input));
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: path.join(getSettings().outputDir ?? path.dirname(req.item.input), `${base}_upscaled.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    chosen = r.filePath;
  }
  return { ok: true, path: saveResult(req.item, opts, getSettings(), chosen) };
});

// ---- job queue ----
handle('queue:list', () => queue.list());
handle('queue:cancel', (id: string) => {
  const j = [...jobs.values()].find(x => x.queueId === id);
  if (j) { j.job.cancel(); if (queue.position(id) > 0) { queue.cancel(id); void j.job.run(); } return; }
  queue.cancel(id);
});

// ---- quality models (download on first use) ----
let modelDl: ModelDownload = { state: 'idle', progress: 0 };
handle('models:status', () => ({ installed: modelStatus(), download: modelDl, sizeMb: DOWNLOAD_MB }));
handle('models:download', async () => {
  if (modelDl.state === 'downloading') return;
  const abort = new AbortController();
  const update = (d: ModelDownload) => { modelDl = d; send('models:progress', d); };
  update({ state: 'downloading', progress: 0 });
  await queue.add('download', `Download quality models (${DOWNLOAD_MB} MB)`, async () => {
    try {
      await downloadQualityModels(p => update({ state: 'downloading', progress: p }), abort.signal);
      update({ state: 'done', progress: 1 });
    } catch (e) {
      update({ state: 'error', progress: 0, error: abort.signal.aborted ? 'Download cancelled.' : friendlyError(e) });
    }
  }, () => abort.abort()).done;
  return modelDl;
});

// ---- updates ----
handle('update:get', () => updateStatus());
handle('update:check', () => checkForUpdates());
handle('update:install', () => installUpdate());

// ---- sort by person ----
handle('sort:status', (root: string) => sort.folderStatus(root));
handle('sort:scan', (root: string) => {
  const { queueId, done } = sort.scanFolder(root, { scan: p => send('sort:progress', p) });
  done.then(r => {
    send('sort:scanned', r);
    if (!r.cancelled) notifyDone('PixHaven: scan finished', `${path.basename(root)} is ready to review.`);
  }).catch(e => send('sort:progress', { folder: root, phase: 'error', done: 0, total: 0, faces: 0, people: 0, error: friendlyError(e) }));
  return queueId;
});
handle('sort:pause', (paused: boolean) => sort.pauseScan(paused));
handle('sort:cancel', () => sort.cancelScan());
handle('sort:regroup', (fid: number) => sort.regroup(fid, { scan: p => send('sort:progress', p) }));
handle('sort:review', (fid: number) => sort.review(fid));
handle('sort:person', (pid: number) => sort.personPhotos(pid));
handle('sort:rename', (pid: number, name: string, allowClash?: boolean) => sort.renamePerson(pid, name, allowClash));
handle('sort:merge', (from: number, into: number) => sort.mergePeople(from, into));
handle('sort:removeFace', (faceId: number) => sort.removeFace(faceId));
handle('sort:split', (pid: number, faceIds: number[]) => sort.splitPerson(pid, faceIds));
handle('sort:plan', (fid: number) => sort.makePlan(fid));
handle('sort:apply', async (fid: number) => {
  const r = await sort.applySort(fid, { apply: p => send('sort:apply-progress', p) });
  notifyDone('PixHaven: photos sorted', `${r.moved + r.groupMoved} moved, ${r.copied} copied.`);
  return r;
});
handle('sort:finish', (sortId: number) => sort.finishSort(sortId, { apply: p => send('sort:apply-progress', p) }));
handle('sort:undo', (sortId: number) => sort.undoSortJob(sortId, { apply: p => send('sort:apply-progress', p) }));
handle('sort:personFiles', (pid: number) => sort.personImagePaths(pid));
handle('sort:dataSize', () => sort.faceDataSize());
handle('sort:deleteData', () => sort.deleteFaceData());

// ---- tidy up: duplicates, blurry, by date or place ----
handle('tidy:status', (root: string) => tidy.tidyStatus(root));
handle('tidy:scan', (root: string) => {
  const { queueId, done } = tidy.scanTidy(root, { scan: p => send('tidy:progress', p) });
  done.then(r => send('tidy:scanned', r))
    .catch(e => send('tidy:progress', { folder: root, phase: 'error', done: 0, total: 0, faces: 0, people: 0, error: friendlyError(e) }));
  return queueId;
});
handle('tidy:results', (fid: number) => tidy.tidyResults(fid));
handle('tidy:organizePlan', (fid: number) => tidy.organizePlan(fid));
handle('tidy:setAsidePlan', (fid: number, kind: 'duplicates' | 'blurry', ids: number[]) => tidy.setAsidePlan(fid, kind, ids));
handle('tidy:apply', (fid: number) => tidy.applyTidy(fid, { apply: p => send('tidy:apply-progress', p) }));
handle('tidy:undo', (sortId: number) => sort.undoSortJob(sortId, { apply: p => send('tidy:apply-progress', p) }));
handle('tidy:trash', (fid: number, ids: number[]) => tidy.trashPhotos(fid, ids));

// ---- media library (v2.0 Phase A) ----
handle('lib:drives', () => library.drives());
handle('lib:list', (dir: string) => library.list(dir));
handle('lib:hasMedia', (dirs: string[]) => library.hasMedia(dirs));
handle('lib:thumbs', (files: { path: string; size: number; mtime: number }[]) => library.thumbs(files));
handle('lib:pauseThumbs', (p: boolean) => library.pauseThumbs(p));
handle('lib:preview', (p: string) => library.preview(p));
handle('lib:search', (root: string, q: string) => library.search(root, q, u => send('lib:search', u),
  (r, text) => (watch.indexedFor(r) ? watch.searchIndex(r, text, SEARCH_LIMIT) : null)));
handle('lib:cancelSearch', () => library.cancelSearch());
handle('lib:cacheSize', () => library.cacheSize());
handle('lib:clearCache', () => library.clearCache());

// ---- video player (v2.0 Phase B) ----
handle('player:open', (p: string, caps: PlayerCaps) => player.open(p, caps));
handle('player:seek', (id: string, t: number, opts?: { audio?: number; fallback?: boolean }) => player.seek(id, t, opts));
handle('player:close', (id: string) => { player.close(id); watch.pause('player', false); });
handle('player:subtitles', (id: string, track: string) => player.subtitles(id, track));
handle('player:loadSubtitle', async (id: string) => {
  const r = await dialog.showOpenDialog(win!, { title: 'Choose a subtitle file', properties: ['openFile'], filters: [{ name: 'Subtitles', extensions: ['srt', 'ass', 'ssa', 'vtt'] }] });
  if (r.canceled) return null;
  const tracks = player.addSubtitleFile(id, r.filePaths[0]);
  return { tracks, id: player.subtitleTrackId(id, r.filePaths[0]) };
});
handle('player:frame', (p: string, t: number) => player.frame(p, t));
handle('player:position', (p: string, t: number, d: number) => player.savePosition(p, t, d));
handle('player:playing', (b: boolean) => { player.playing(b); watch.pause('player', b); });
handle('player:recent', () => player.recent());

// ---- labels and stars (v2.0 Phase C) ----
type Ref = { path: string; size: number; mtime: number };
handle('tags:labels', () => tags.labels());
handle('tags:forFiles', (files: Ref[]) => tags.forFiles(files));
handle('tags:setStars', (files: Ref[], stars: number) => tags.setStars(files, stars));
handle('tags:addLabel', (files: Ref[], name: string, color: string | null) => tags.addLabel(files, name, color));
handle('tags:removeLabel', (paths: string[], id: number) => tags.removeLabel(paths, id));
handle('tags:renameLabel', (id: number, name: string) => tags.renameLabel(id, name));
handle('tags:setColor', (id: number, color: string | null) => tags.setColor(id, color));
handle('tags:deleteLabel', (id: number) => tags.deleteLabel(id));
handle('tags:query', (filter: TagFilter, text: string) => tags.query(filter, text));
handle('tags:renameFile', (p: string, name: string) => tags.renameFile(p, name));
handle('tags:moveFiles', async (paths: string[]) => {
  const r = await dialog.showOpenDialog(win!, { title: `Move ${paths.length} file${paths.length > 1 ? 's' : ''} to…`, properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : tags.moveFiles(paths, r.filePaths[0]);
});
handle('tags:export', async (format: 'json' | 'csv') => {
  const r = await dialog.showSaveDialog(win!, {
    title: 'Export labels and stars', defaultPath: path.join(app.getPath('documents'), `PixHaven labels ${new Date().toISOString().slice(0, 10)}.${format}`),
    filters: [format === 'csv' ? { name: 'CSV (Excel)', extensions: ['csv'] } : { name: 'PixHaven labels (JSON)', extensions: ['json'] }],
  });
  return r.canceled || !r.filePath ? null : { file: r.filePath, count: tags.exportTo(r.filePath) };
});
handle('tags:import', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Import labels and stars', properties: ['openFile'], filters: [{ name: 'PixHaven labels', extensions: ['json', 'csv'] }] });
  return r.canceled ? null : tags.importFrom(r.filePaths[0]);
});
handle('tags:findMoved', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Look for moved photos and videos in…', properties: ['openDirectory'] });
  return r.canceled ? null : tags.findMoved(r.filePaths[0]);
});
handle('tags:missing', () => tags.missingCount());
handle('tags:backups', () => tags.backups());
handle('tags:backupNow', () => tags.backupNow());
handle('tags:restore', (file: string) => tags.restore(file));
handle('tags:location', () => ({ path: tags.dbPath(), isDefault: tags.dbPath() === tags.defaultDbPath() }));
handle('tags:chooseLocation', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Keep the labels database in…', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : { dir: r.filePaths[0], taken: tags.locationTaken(r.filePaths[0]) };
});
handle('tags:setLocation', (dir: string, mode: 'move' | 'use') => tags.setLocation(dir, mode));
handle('tags:playlists', () => tags.playlists());
handle('tags:savePlaylist', (name: string, filter: TagFilter, id?: number) => tags.savePlaylist(name, filter, id));
handle('tags:deletePlaylist', (id: number) => tags.deletePlaylist(id));
handle('tags:writeStatus', () => tags.writeStatus());
handle('tags:setWriteToFiles', (on: boolean) => tags.setWriteToFiles(on));

// ---- watched folders (v2.1) ----
handle('watch:list', () => watch.status());
handle('watch:choose', async () => {
  const r = await dialog.showOpenDialog(win!, { title: 'Watch a folder', properties: ['openDirectory'] });
  return r.canceled ? null : watch.add(r.filePaths[0]);
});
handle('watch:add', (dir: string) => watch.add(dir));
handle('watch:remove', (dir: string) => watch.remove(dir));
handle('watch:reindex', (dir: string) => watch.reindex(dir));
handle('watch:query', (q: WatchQuery) => watch.query(q));

// Test hooks (dev only): export/import without the file dialogs.
if (!app.isPackaged) {
  handle('tags:testExport', (file: string) => tags.exportTo(file));
  handle('tags:testImport', (file: string) => tags.importFrom(file));
}

handle('shell:showItem', (p: string) => shell.showItemInFolder(p));
handle('shell:openPath', (p: string) => shell.openPath(p));
handle('logs:open', () => { fs.mkdirSync(logDir(), { recursive: true }); return shell.openPath(logDir()); });
handle('licences:get', () => {
  const dir = path.join(resourcesDir(), 'licences');
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => ({ name: f.replace(/\.txt$/, ''), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  } catch { return []; }
});
