// Runs the bundled realesrgan-ncnn-vulkan executable and reports tile progress.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { app } from 'electron';
import { log } from './logger';

import type { EngineModel } from './plan';

/** resources/ in dev, <install>/resources in the packaged app (electron-builder extraResources). */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
}
const IS_WIN = process.platform === 'win32';
export function enginePath(): string {
  const p = path.join(resourcesDir(), 'bin', IS_WIN ? 'win' : 'linux', IS_WIN ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan');
  // Linux: zip extraction can drop the executable bit (read-only inside an AppImage, where it is already set).
  if (!IS_WIN) { try { fs.accessSync(p, fs.constants.X_OK); } catch { try { fs.chmodSync(p, 0o755); } catch { /* read-only */ } } }
  return p;
}
export const modelsDir = () => path.join(resourcesDir(), 'models');

/** GEN-03 CPU fallback: Electron ships SwiftShader, a CPU Vulkan driver. Pointing the engine at it runs the
 *  same models on the processor — about 20× slower, but it works without a usable graphics card. */
export const swiftShaderIcd = () => path.join(path.dirname(process.execPath), 'vk_swiftshader_icd.json');

export interface EngineRun {
  input: string;
  output: string;
  model: EngineModel;
  scale: number;
  tileSize: number;
  threads: string;
  gpuId: number | null;
  cpu: boolean;               // run on SwiftShader instead of the GPU
  modelDir: string;           // folder holding this model's .param/.bin
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export class EngineError extends Error {
  constructor(message: string, readonly outOfMemory = false) { super(message); }
}

export function runEngine(o: EngineRun): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(enginePath())) return reject(new EngineError('The upscaling engine is missing. Please reinstall PixHaven.'));
    const args = ['-i', o.input, '-o', o.output, '-n', o.model, '-s', String(o.scale), '-m', o.modelDir,
      '-t', String(o.tileSize), '-j', o.threads, '-f', 'png'];
    if (o.gpuId !== null && !o.cpu) args.push('-g', String(o.gpuId));
    log('info', `engine${o.cpu ? ' (CPU)' : ''}`, args.join(' '));

    const env = o.cpu ? { ...process.env, VK_ICD_FILENAMES: swiftShaderIcd(), VK_DRIVER_FILES: swiftShaderIcd() } : process.env;
    const child: ChildProcess = spawn(enginePath(), args, { windowsHide: true, env });
    let stderr = '';
    const onAbort = () => child.kill();
    o.signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
      // The engine prints "NN.NN%" once per finished tile.
      const matches = [...chunk.matchAll(/(\d+(?:\.\d+)?)%/g)];
      if (matches.length && o.onProgress) o.onProgress(Math.min(1, parseFloat(matches[matches.length - 1][1]) / 100));
    });
    child.on('error', e => reject(new EngineError(`Could not start the upscaling engine: ${e.message}`)));
    child.on('close', code => {
      o.signal?.removeEventListener('abort', onAbort);
      if (o.signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
      const produced = fs.existsSync(o.output) && fs.statSync(o.output).size > 0;
      if (code === 0 && produced) return resolve();
      const oom = /out of memory|vkAllocateMemory|VK_ERROR_OUT_OF/i.test(stderr);
      const noGpu = /invalid gpu device|no vulkan|vkCreateInstance failed/i.test(stderr) || !/\[\d+ .*\]/.test(stderr);
      log('error', `engine exit ${code}`, stderr.slice(-800));
      if (oom) return reject(new EngineError('The graphics card ran out of memory.', true));
      if (noGpu) return reject(new EngineError('No compatible graphics (Vulkan) device was found. Update your graphics driver and try again.'));
      reject(new EngineError(`Upscaling failed (engine exit code ${code}). See the log for details.`, code !== 0));
    });
  });
}

/** Lists Vulkan devices the engine can see, by running it once on a 1×1 image. */
export async function listVulkanDevices(probeImage: string, outDir: string): Promise<string[]> {
  return new Promise(resolve => {
    if (!fs.existsSync(enginePath())) return resolve([]);
    const out = path.join(outDir, 'probe-out.png');
    const child = spawn(enginePath(), ['-i', probeImage, '-o', out, '-n', 'realesr-animevideov3', '-s', '2', '-m', modelsDir()], { windowsHide: true });
    let text = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { text += c; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const names = new Set<string>();
      for (const m of text.matchAll(/^\[(\d+) (.+?)\]\s+queueC/gm)) names.add(m[2]);
      resolve([...names]);
    });
  });
}
