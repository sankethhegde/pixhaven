// v2.10 Wallpaper recommended: photos that fit this computer's screen. The photos of the watched folders (from the
// index, no folder walk) or of any folder are measured once (size from the file header, sharpness from a 512 px
// copy) and remembered in userData/wallpaper-cache.json, so checking again is quick. Hidden items are left out.
// "Set as wallpaper" uses Windows' own setting (Fill), through PowerShell.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { app, screen } from 'electron';
import sharp from 'sharp';
import type { WallItem, WallProgress, WallResult, WallScreen } from '@shared/types';
import { IMAGE_EXTENSIONS } from '@shared/types';
import { openImage } from './image-io';
import { blurScore } from './tidy/inspect';
import { fit, rank, aspectName } from './wallpaper/fit';
import { getSettings } from './settings';
import * as watch from './watch-service';
import * as privacy from './privacy';
import { log } from './logger';

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();
const cacheFile = () => path.join(app.getPath('userData'), 'wallpaper-cache.json');

/** The screens, in physical pixels (a 1440 × 900 screen at 200% is 2880 × 1800); the main one first. */
export function screens(): WallScreen[] {
  const main = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => {
    const width = Math.round(d.size.width * d.scaleFactor), height = Math.round(d.size.height * d.scaleFactor);
    return { id: d.id, width, height, primary: d.id === main, label: `${d.id === main ? 'Main screen' : `Screen ${i + 1}`}: ${width} × ${height} (${aspectName(width, height)})` };
  }).sort((a, b) => Number(b.primary) - Number(a.primary));
}

// ---------- measuring (remembered between checks) ----------

interface Known { s: number; m: number; w: number; h: number; sharp?: number }
let cache: Record<string, Known> | null = null;
let dirty = false;
const known = () => (cache ??= (() => { try { return JSON.parse(fs.readFileSync(cacheFile(), 'utf8')) as Record<string, Known>; } catch { return {}; } })());
function saveCache(): void {
  if (!dirty || !cache) return;
  try { fs.writeFileSync(cacheFile(), JSON.stringify(cache)); dirty = false; } catch (e) { log('warn', 'Could not save the wallpaper list', e); }
}

async function measure(f: { path: string; size: number; mtime: number }): Promise<Known | null> {
  const k = known()[f.path];
  if (k && k.s === f.size && k.m === Math.round(f.mtime)) return k;
  const meta = await openImage(f.path).metadata().catch(() => null);
  if (!meta?.width || !meta.height) return null;
  const swap = (meta.orientation ?? 1) >= 5;
  const out: Known = { s: f.size, m: Math.round(f.mtime), w: swap ? meta.height : meta.width, h: swap ? meta.width : meta.height };
  known()[f.path] = out; dirty = true;
  return out;
}
async function sharpness(file: string, k: Known): Promise<number> {
  if (k.sharp != null) return k.sharp;
  const r = await openImage(file).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).grayscale().raw().toBuffer({ resolveWithObject: true }).catch(() => null);
  k.sharp = r ? blurScore(r.info.channels === 1 ? r.data : Buffer.from(r.data.filter((_, i) => i % r.info.channels === 0)), r.info.width, r.info.height) : 0;
  dirty = true;
  return k.sharp;
}

/** Photos of a folder and its subfolders (system and dot folders skipped), without blocking. */
async function walk(root: string): Promise<{ path: string; size: number; mtime: number }[]> {
  const out: { path: string; size: number; mtime: number }[] = [];
  const pending = [root];
  while (pending.length) {
    const batch = pending.splice(0, 16);
    const listed = await Promise.all(batch.map(d => fs.promises.readdir(d, { withFileTypes: true }).then(e => ({ d, e })).catch(() => null)));
    const files: string[] = [];
    for (const l of listed) {
      if (!l) continue;
      for (const e of l.e) {
        const p = path.join(l.d, e.name);
        if (e.isDirectory()) { if (!e.name.startsWith('.') && !e.name.startsWith('$') && e.name !== 'System Volume Information') pending.push(p); }
        else if (e.isFile() && IMAGE_EXTENSIONS.includes(ext(e.name))) files.push(p);
      }
    }
    const st = await Promise.all(files.map(p => fs.promises.stat(p).then(s => ({ path: p, size: s.size, mtime: s.mtimeMs })).catch(() => null)));
    for (const s of st) if (s) out.push(s);
  }
  return out;
}

// ---------- the check ----------

let running: { cancelled: boolean } | null = null;
export const cancel = () => { if (running) running.cancelled = true; };

/** source: 'watched' (all watched folders) or a folder. */
export async function scan(source: string, screenId: number | null, onProgress: (p: WallProgress) => void): Promise<WallResult> {
  if (running) running.cancelled = true;
  const me = { cancelled: false };
  running = me;
  const all = screens();
  const scr = all.find(s => s.id === screenId) ?? all[0];
  const minSharp = getSettings().tidy.blurThreshold;
  onProgress({ phase: 'listing', done: 0, total: 0 });
  let files = source === 'watched'
    ? watch.query({ text: '', type: 'image', filter: { labels: [], mode: 'all', minStars: 0 }, root: null, limit: 2_000_000 }).items
      .filter(e => IMAGE_EXTENSIONS.includes(ext(e.path))).map(e => ({ path: e.path, size: e.size, mtime: e.mtime }))
    : await walk(source);
  files = privacy.paths(files, f => f.path);
  const ready: WallItem[] = [], upscale: WallItem[] = [];
  let blurry = 0, last = 0;
  const t0 = Date.now();
  for (let i = 0; i < files.length && !me.cancelled; i += 16) {
    const part = files.slice(i, i + 16);
    await Promise.all(part.map(async f => {
      const k = await measure(f);
      if (!k) return;
      const ft = fit(k.w, k.h, scr);
      if (!ft) return;
      const sharpN = await sharpness(f.path, k);
      if (sharpN < minSharp) { blurry++; return; }
      const item: WallItem = { name: path.basename(f.path), path: f.path, kind: 'image', size: f.size, mtime: f.mtime, width: k.w, height: k.h, crop: ft.crop, upscale: ft.upscale, sharp: sharpN };
      (ft.kind === 'ready' ? ready : upscale).push(item);
    }));
    if (Date.now() - last > 250) { last = Date.now(); onProgress({ phase: 'checking', done: Math.min(i + 16, files.length), total: files.length, found: ready.length + upscale.length }); }
  }
  saveCache();
  if (running === me) running = null;
  const order = (l: WallItem[]) => rank(l.map(x => ({ ...x, fit: { kind: 'ready' as const, crop: x.crop, scale: 1, upscale: x.upscale }, sharp: x.sharp }))).map(({ fit: _f, ...x }) => x as WallItem);
  const r: WallResult = { screen: scr, ready: order(ready), upscale: order(upscale), checked: files.length, blurry, cancelled: me.cancelled, seconds: (Date.now() - t0) / 1000 };
  onProgress({ phase: 'done', done: files.length, total: files.length, found: ready.length + upscale.length });
  log('info', `Wallpapers for ${scr.width}×${scr.height} in ${source}: ${r.ready.length} ready, ${r.upscale.length} to upscale, ${blurry} blurry, of ${files.length} (${r.seconds.toFixed(1)} s)`);
  return r;
}

// ---------- set as wallpaper ----------

const SET_WALLPAPER = `
$ErrorActionPreference = 'Stop'
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value '10'
Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value '0'
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class PixWall { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool SystemParametersInfo(int a, int b, string c, int d); }'
if (-not [PixWall]::SystemParametersInfo(20, 0, $env:PIXHAVEN_WALLPAPER, 3)) { throw 'Windows did not accept the picture' }
`;

/** Windows wallpaper (Fill, every screen). Formats Windows can't show are saved as a JPG copy first. */
export async function setWallpaper(file: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Setting the wallpaper works on Windows only.');
  let use = file;
  if (!['jpg', 'jpeg', 'png', 'bmp'].includes(ext(file))) {
    const dir = path.join(app.getPath('userData'), 'wallpaper');
    fs.mkdirSync(dir, { recursive: true });
    use = path.join(dir, `${path.basename(file, path.extname(file))}.jpg`);
    await sharp(await fs.promises.readFile(file)).rotate().jpeg({ quality: 95 }).toFile(use);
  }
  // Tests: never change the real desktop; the picture that would be used is written to this file instead.
  if (!app.isPackaged && process.env.PIXHAVEN_WALL_FAKE) { fs.writeFileSync(process.env.PIXHAVEN_WALL_FAKE, use); return; }
  await new Promise<void>((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SET_WALLPAPER],
    { windowsHide: true, timeout: 30000, env: { ...process.env, PIXHAVEN_WALLPAPER: use } },
    err => (err ? reject(new Error(`Could not set the wallpaper: ${err.message.split('\n')[0]}`)) : resolve())));
  log('info', `Wallpaper set: ${use}`);
}
