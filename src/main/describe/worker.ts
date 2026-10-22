// v2.7 "Describe a picture" worker thread: keeps Florence-2 loaded between pictures (the service ends it after a few
// idle minutes), so describing never blocks the window.
import { parentPort, workerData } from 'node:worker_threads';
import { PictureDescriber } from './florence';
import { toPrompt } from './prompt';
import type { GenStyle } from '../../shared/types';

export interface DescribeWorkerInput { modelDir: string }
export type DescribeIn = { type: 'describe'; id: string; image: Uint8Array };
export type DescribeOut =
  | { type: 'result'; id: string; short: string; paragraph: string; prompt: string; style: GenStyle | null; ms: number }
  | { type: 'error'; id: string; message: string };

const input = workerData as DescribeWorkerInput;
let model: Promise<PictureDescriber> | null = null;
let chain: Promise<void> = Promise.resolve();

parentPort!.on('message', (m: DescribeIn) => {
  chain = chain.then(async () => {
    const t = Date.now();
    try {
      model ??= PictureDescriber.load(input.modelDir);
      const d = await model;
      const img = Buffer.from(m.image.buffer, m.image.byteOffset, m.image.byteLength);
      const short = (await d.describe(img, 'short', 40)) ?? '';
      const paragraph = (await d.describe(img, 'paragraph', 120)) ?? '';
      const { prompt, style } = toPrompt(short, paragraph);
      parentPort!.postMessage({ type: 'result', id: m.id, short, paragraph, prompt, style, ms: Date.now() - t } satisfies DescribeOut);
    } catch (e) {
      model = null;
      parentPort!.postMessage({ type: 'error', id: m.id, message: String((e as Error)?.message ?? e).split('\n')[0] } satisfies DescribeOut);
    }
  });
});
