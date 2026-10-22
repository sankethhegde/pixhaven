// v2.7 "Describe a picture", main-process side: the model download, the worker (loaded on demand, ended after 5 idle
// minutes) and turning any picture the library can show (RAW, HEIC, BMP… through its preview) into a prompt.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import workerPath from './describe/worker?modulePath';
import type { DescribeOut, DescribeWorkerInput } from './describe/worker';
import type { DescribeResult, DescribeStatus } from '@shared/types';
import { DESCRIBER_BYTES, DESCRIBER_NAME, DESCRIBER_SOURCE, describerDir, describerInstalled, downloadDescriber, removeDescriber } from './describe/model';
import * as library from './library-service';
import { readImageBuffer } from './image-io';
import { log } from './logger';

const IDLE_MS = 5 * 60_000;
let worker: Worker | null = null;
let idle: NodeJS.Timeout | null = null;
const waiting = new Map<string, { resolve: (r: DescribeResult) => void; reject: (e: Error) => void }>();

function startWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(workerPath, { workerData: { modelDir: describerDir() } satisfies DescribeWorkerInput });
  w.on('message', (m: DescribeOut) => {
    const p = waiting.get(m.id);
    if (!p) return;
    waiting.delete(m.id);
    if (m.type === 'result') p.resolve({ prompt: m.prompt, style: m.style, short: m.short, paragraph: m.paragraph, ms: m.ms });
    else p.reject(new Error(m.message));
  });
  const fail = (e: Error) => { for (const p of waiting.values()) p.reject(e); waiting.clear(); };
  w.on('error', e => { log('error', 'Describe worker crashed', e); fail(e); });
  w.on('exit', () => { if (worker === w) worker = null; fail(new Error('The describer stopped. Please try again.')); });
  worker = w;
  return w;
}
function keepAlive(): void {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => { void worker?.terminate(); worker = null; }, IDLE_MS);
}

// ---------- status / download ----------
let dl: DescribeStatus['download'] = { state: 'idle', got: 0, total: DESCRIBER_BYTES };
let dlAbort: AbortController | null = null;

export const status = (): DescribeStatus => ({ installed: describerInstalled(), bytes: DESCRIBER_BYTES, download: dl, modelName: DESCRIBER_NAME, source: DESCRIBER_SOURCE });

export async function download(onUpdate: (s: DescribeStatus) => void): Promise<void> {
  if (dl.state === 'downloading') return;
  dlAbort = new AbortController();
  dl = { state: 'downloading', got: 0, total: DESCRIBER_BYTES };
  onUpdate(status());
  let last = 0;
  try {
    await downloadDescriber((got, total) => {
      dl = { state: 'downloading', got, total };
      if (Date.now() - last > 250) { last = Date.now(); onUpdate(status()); }
    }, dlAbort.signal);
    dl = { state: 'idle', got: DESCRIBER_BYTES, total: DESCRIBER_BYTES };
  } catch (e) {
    dl = { state: 'error', got: dl.got, total: DESCRIBER_BYTES, error: (e as Error).message };
    log('warn', 'Describe model download failed', e);
  } finally { dlAbort = null; onUpdate(status()); }
}
export const cancelDownload = () => dlAbort?.abort();
export async function remove(): Promise<void> { await worker?.terminate(); worker = null; removeDescriber(); }

// ---------- describing ----------
/** The picture as bytes the describer can read: as it is, or the library's JPEG preview (RAW, HEIC, video stills…). */
async function pictureBytes(file: string): Promise<Buffer> {
  const pv = await library.preview(file);
  if (pv.converted) {
    const cached = library.cacheFile('preview', pv.url.replace('clearup://preview/', ''));
    if (cached && fs.existsSync(cached)) return fs.promises.readFile(cached);
  }
  return readImageBuffer(file);
}

export async function describe(file: string): Promise<DescribeResult> {
  if (!describerInstalled()) throw new Error('Download the picture describer first.');
  const bytes = await pictureBytes(file);
  const id = crypto.randomUUID();
  if (idle) clearTimeout(idle);
  try {
    return await new Promise<DescribeResult>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      const image = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      startWorker().postMessage({ type: 'describe', id, image }, [image.buffer as ArrayBuffer]);
    });
  } catch (e) {
    throw new Error(/unsupported image format|corrupt/i.test((e as Error).message) ? 'This picture could not be read.' : (e as Error).message);
  } finally { keepAlive(); }
}

export function close(): void { void worker?.terminate(); }
