// Quality models (x4plus, x4plus-anime) are not in the installer: they download once, on first use,
// from the official Real-ESRGAN release, are checked against a pinned SHA-256, then work offline.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { app, net } from 'electron';
import type { ModelId } from '@shared/types';
import { ENGINE_MODEL, type EngineModel } from './plan';
import { resourcesDir } from './engine';
import { log } from './logger';

const ZIP_URL = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip';
const ZIP_SHA256 = 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d';
export const DOWNLOAD_MB = 45;

const userModels = () => path.join(app.getPath('userData'), 'models');
const has = (dir: string, m: EngineModel) =>
  fs.readdirSync(dir, { withFileTypes: true }).some(f => f.name.startsWith(m) && f.name.endsWith('.bin'));
const candidates = () => [path.join(resourcesDir(), 'models'), path.join(resourcesDir(), 'models-quality'), userModels()];

/** Folder holding this model, or null if it still has to be downloaded. */
export function modelDir(model: EngineModel): string | null {
  for (const d of candidates()) {
    try { if (has(d, model)) return d; } catch { /* folder missing */ }
  }
  return null;
}

export function modelStatus(): Record<ModelId, boolean> {
  return { fast: !!modelDir(ENGINE_MODEL.fast), photo: !!modelDir(ENGINE_MODEL.photo), anime: !!modelDir(ENGINE_MODEL.anime) };
}

let downloading: Promise<void> | null = null;

export function downloadQualityModels(onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  downloading ??= (async () => {
    const tmp = path.join(app.getPath('temp'), `clearup-models-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const zip = path.join(tmp, 'models.zip');
      const res = await net.fetch(ZIP_URL, { signal });
      if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}). Check the internet connection and try again.`);
      const total = Number(res.headers.get('content-length')) || DOWNLOAD_MB * 1e6;
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(zip);
      let got = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value); out.write(value);
        got += value.length;
        onProgress(Math.min(0.99, got / total));
      }
      await new Promise<void>((ok, bad) => out.end((e?: Error | null) => (e ? bad(e) : ok())));
      if (hash.digest('hex') !== ZIP_SHA256) throw new Error('The downloaded file did not pass the safety check. Please try again.');
      // Windows' own bsdtar (System32) reads zip files; a Git/GNU tar earlier on PATH would not.
      if (process.platform === 'win32') {
        const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        execFileSync(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', tmp, 'models'], { windowsHide: true });
      } else {
        try { execFileSync('unzip', ['-o', '-q', zip, 'models/*', '-d', tmp]); }
        catch { throw new Error('Unpacking the models needs the "unzip" tool. Install it (for example: sudo apt install unzip) and try again.'); }
      }
      fs.mkdirSync(userModels(), { recursive: true });
      for (const f of fs.readdirSync(path.join(tmp, 'models'))) {
        if (/^realesrgan-x4plus(-anime)?\.(param|bin)$/.test(f)) fs.copyFileSync(path.join(tmp, 'models', f), path.join(userModels(), f));
      }
      log('info', 'Quality models installed in', userModels());
      onProgress(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      downloading = null;
    }
  })();
  return downloading;
}
