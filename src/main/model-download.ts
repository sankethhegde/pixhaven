// Downloads an AI model once from a pinned Hugging Face revision: every file checked against its SHA-256, partial files
// resumed (HTTP ranges) after a dropped connection, a ".verified" mark when all is there. Used by the Image Generator
// (v2.6) and "Describe a picture" (v2.7).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { net } from 'electron';
import { log } from './logger';

export interface ModelFile { path: string; size: number; sha256: string }
export interface ModelSpec { name: string; repo: string; revision: string; files: ModelFile[] }

export const modelBytes = (files: ModelFile[]) => files.reduce((a, f) => a + f.size, 0);
const okMark = (dir: string) => path.join(dir, '.verified');

/** Every file there with the right size and the model marked as checked (or `trusted`: a developer's copy). */
export function modelInstalled(dir: string, files: ModelFile[], trusted = false): boolean {
  return files.every(f => { try { return fs.statSync(path.join(dir, f.path)).size === f.size; } catch { return false; } })
    && (trusted || fs.existsSync(okMark(dir)));
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

const running = new Map<string, Promise<void>>();

/** Download what is missing (resuming partial files), check every file, then mark the model as ready. */
export function downloadModel(spec: ModelSpec, dir: string, onProgress: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  const busy = running.get(dir);
  if (busy) return busy;
  const total = modelBytes(spec.files);
  const job = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const sizeOf = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
    let base = 0;
    try {
      for (const f of spec.files) {
        const dest = path.join(dir, f.path), part = `${dest}.part`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (sizeOf(dest) === f.size) { base += f.size; onProgress(base, total); continue; }
        for (let attempt = 0; ; attempt++) {
          try {
            const have = sizeOf(part);
            if (have < f.size) {
              const res = await net.fetch(`https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${f.path}`, { signal, headers: have ? { Range: `bytes=${have}-` } : {} });
              if (!(res.ok || res.status === 206) || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
              const append = res.status === 206 && have > 0;
              const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
              let got = append ? have : 0;
              const reader = res.body.getReader();
              try {
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()));
                  got += value.length;
                  onProgress(base + got, total);
                }
              } finally { await new Promise<void>(r => out.end(() => r())); }
            }
            if (sizeOf(part) !== f.size || (await sha256(part)) !== f.sha256) {
              fs.rmSync(part, { force: true });
              throw new Error(`${f.path} did not pass the safety check`);
            }
            fs.renameSync(part, dest);
            break;
          } catch (e) {
            if (signal.aborted) throw new Error('Download stopped. It continues where it stopped next time.');
            if (attempt >= 4) throw new Error(`The download failed (${(e as Error).message}). Check the internet connection and try again: it continues where it stopped.`);
            log('warn', `${spec.name} model: ${f.path}, attempt ${attempt + 1} failed`, e);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
        base += f.size;
        onProgress(base, total);
      }
      fs.writeFileSync(okMark(dir), new Date().toISOString());
      log('info', `${spec.name} model installed in ${dir}`);
    } finally { running.delete(dir); }
  })();
  running.set(dir, job);
  return job;
}
