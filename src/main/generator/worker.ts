// v2.6 Image Generator worker thread: keeps the model loaded between requests (about 5 GB of memory; the service ends
// the worker after a few idle minutes) so the window stays responsive while images are made.
import { parentPort, workerData } from 'node:worker_threads';
import { ImageGenerator, type GenerateOptions } from './pipeline';

export interface GenWorkerInput { modelDir: string; preferGpu: boolean }
export type GenWorkerIn =
  | { type: 'generate'; id: string; images: GenerateOptions[]; init?: Uint8Array; strength?: number }
  | { type: 'tokens'; id: string; prompt: string }
  | { type: 'cancel' };
export type GenWorkerOut =
  | { type: 'ready'; device: 'dml' | 'cpu'; ms: number }
  | { type: 'step'; id: string; index: number; done: number; total: number }
  | { type: 'image'; id: string; index: number; rgb: Uint8Array; width: number; height: number; nsfw: boolean | null; ms: number }
  | { type: 'done'; id: string; cancelled: boolean }
  | { type: 'tokens'; id: string; count: number }
  | { type: 'error'; id?: string; message: string };

const input = workerData as GenWorkerInput;
const post = (m: GenWorkerOut, transfer: ArrayBuffer[] = []) => parentPort!.postMessage(m, transfer);
let gen: Promise<ImageGenerator> | null = null;
let cancelled = false;
let chain: Promise<void> = Promise.resolve();

function engine(): Promise<ImageGenerator> {
  if (!gen) {
    const t = Date.now();
    gen = ImageGenerator.load(input.modelDir, input.preferGpu);
    gen.then(g => post({ type: 'ready', device: g.device, ms: Date.now() - t }), () => { gen = null; });
  }
  return gen;
}

parentPort!.on('message', (m: GenWorkerIn) => {
  if (m.type === 'cancel') { cancelled = true; return; }
  // One request at a time, in order.
  chain = chain.then(async () => {
    try {
      const g = await engine();
      if (m.type === 'tokens') { post({ type: 'tokens', id: m.id, count: g.tokens(m.prompt) }); return; }
      cancelled = false;
      for (let i = 0; i < m.images.length && !cancelled; i++) {
        const opts = m.init ? { ...m.images[i], init: Buffer.from(m.init.buffer, m.init.byteOffset, m.init.byteLength), strength: m.strength } : m.images[i];
        const r = await g.generate(opts, (done, total) => post({ type: 'step', id: m.id, index: i, done, total }), () => cancelled);
        if (!r) break;
        const rgb = new Uint8Array(r.rgb.buffer, r.rgb.byteOffset, r.rgb.length);
        post({ type: 'image', id: m.id, index: i, rgb, width: r.width, height: r.height, nsfw: r.nsfw, ms: r.ms }, [rgb.buffer as ArrayBuffer]);
      }
      post({ type: 'done', id: m.id, cancelled });
    } catch (e) {
      post({ type: 'error', id: m.id, message: String((e as Error)?.message ?? e).split('\n')[0] });
    }
  });
});
