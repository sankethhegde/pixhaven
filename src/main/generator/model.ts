// v2.6 Image Generator model: LCM Dreamshaper v7 (Stable Diffusion 1.5, ONNX for DirectML), downloaded once on first
// use from a pinned Hugging Face revision, every file checked against its SHA-256. Resumes after a dropped connection.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, net } from 'electron';
import { log } from '../logger';

export const MODEL_NAME = 'LCM Dreamshaper v7';
export const MODEL_SOURCE = 'https://huggingface.co/softwareweaver/LCM_Dreamshaper_v7_Olive_Onnx';
export const MODEL_LICENCE = 'https://huggingface.co/spaces/CompVis/stable-diffusion-license';
const REVISION = '25bf953af1ff2d6761da8d94bd4e0698f3b54a07';
const FILES: { path: string; size: number; sha256: string }[] = [
  { path: 'tokenizer/vocab.json', size: 1059962, sha256: 'e089ad92ba36837a0d31433e555c8f45fe601ab5c221d4f607ded32d9f7a4349' },
  { path: 'tokenizer/merges.txt', size: 524619, sha256: '9fd691f7c8039210e0fced15865466c65820d09b63988b0174bfe25de299051a' },
  { path: 'scheduler/scheduler_config.json', size: 562, sha256: 'a77c4528b35ce85b2ccc82f18310cb572aac7f8ff3b3b669ad5176f24dab876d' },
  { path: 'text_encoder/model.onnx', size: 246480937, sha256: 'c2ab90bfc60c33ae8bb64c49710a2add6f2e89145b7651f701e18de0ad42cb06' },
  { path: 'vae_decoder/model.onnx', size: 99039201, sha256: '0a3cc8fb9cb472a6a50ceacafb56cfd5b39c1557a8befd1dbfb6c365eec85e86' },
  { path: 'safety_checker/model.onnx', size: 608677792, sha256: '5ff5778c6f8af616037810e58193dc4a712ae140856fb11abb35740dd5dc94cc' },
  { path: 'unet/model.onnx', size: 1719658983, sha256: '1b8ddc68aae1cd332608f829fb5c399f70808cf95e048812bdf37a58d345fcea' },
];
/** PIXHAVEN_GEN_DL_TEST: only the small files (the download test checks resuming and checksums without 2.7 GB). */
const files = () => (process.env.PIXHAVEN_GEN_DL_TEST ? FILES.filter(f => f.size < 2e6) : FILES);
export const MODEL_BYTES = FILES.reduce((a, f) => a + f.size, 0);
const total = () => files().reduce((a, f) => a + f.size, 0);

/** Where the model lives. PIXHAVEN_GEN_MODEL points tests (and developers) at a copy elsewhere. */
export const generatorDir = () => process.env.PIXHAVEN_GEN_MODEL ?? path.join(app.getPath('userData'), 'models', 'generator', 'lcm-dreamshaper-v7');
const okMark = () => path.join(generatorDir(), '.verified');

/** Installed = every file there with the right size (their checksums were checked when they were downloaded). */
export function generatorInstalled(): boolean {
  const dir = generatorDir();
  return files().every(f => { try { return fs.statSync(path.join(dir, f.path)).size === f.size; } catch { return false; } })
    && ((!!process.env.PIXHAVEN_GEN_MODEL && !process.env.PIXHAVEN_GEN_DL_TEST) || fs.existsSync(okMark()));
}

async function sha256(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 4 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

let running: Promise<void> | null = null;

/** Download what is missing (resuming partial files), check every file, then mark the model as ready. */
export function downloadGenerator(onProgress: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  running ??= (async () => {
    const dir = generatorDir();
    fs.mkdirSync(dir, { recursive: true });
    const sizeOf = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
    let base = 0;
    try {
      for (const f of files()) {
        const dest = path.join(dir, f.path), part = `${dest}.part`;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (sizeOf(dest) === f.size) { base += f.size; onProgress(base, total()); continue; }
        for (let attempt = 0; ; attempt++) {
          try {
            const have = sizeOf(part);
            if (have < f.size) {
              const res = await net.fetch(`${MODEL_SOURCE}/resolve/${REVISION}/${f.path}`, { signal, headers: have ? { Range: `bytes=${have}-` } : {} });
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
                  onProgress(base + got, total());
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
            log('warn', `Image Generator model: ${f.path}, attempt ${attempt + 1} failed`, e);
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
          }
        }
        base += f.size;
        onProgress(base, total());
      }
      fs.writeFileSync(okMark(), new Date().toISOString());
      log('info', `Image Generator model installed in ${dir}`);
    } finally { running = null; }
  })();
  return running;
}

/** Settings → free the space again. */
export function removeGenerator(): void {
  if (process.env.PIXHAVEN_GEN_MODEL && !process.env.PIXHAVEN_GEN_DL_TEST) return;
  fs.rmSync(generatorDir(), { recursive: true, force: true });
}
