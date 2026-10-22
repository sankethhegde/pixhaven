// v2.7 "Describe a picture" model: Florence-2 base (Microsoft, MIT licence), ONNX 8-bit from onnx-community, pinned
// revision, about 275 MB, downloaded once on first use (see model-download.ts: checksums, resuming).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { downloadModel, modelBytes, modelInstalled, type ModelFile } from '../model-download';

export const DESCRIBER_NAME = 'Florence-2 base';
const REPO = 'onnx-community/Florence-2-base-ft';
export const DESCRIBER_SOURCE = `https://huggingface.co/${REPO}`;
const REVISION = 'e88a44eaf3791a35eae0c5a47b3dbcd36e67eb6f';
const FILES: ModelFile[] = [
  { path: 'vocab.json', size: 1099884, sha256: '394fdc63c71aabe0a9b97117f5d62fb5fcc4d59b2b3ea929a3929e6a53217b3c' },
  { path: 'merges.txt', size: 456318, sha256: '1ce1664773c50f3e0cc8842619a93edc4624525b728b188a9e0be33b7726adc5' },
  { path: 'onnx/vision_encoder_quantized.onnx', size: 93746540, sha256: '3b79d54f23f666f731549db23cb070c35a979ce19cbd9720e90e67a78dc9768c' },
  { path: 'onnx/embed_tokens_quantized.onnx', size: 39390433, sha256: '6b2258db1c8ee9b160576ccde3cd3814d83a2edaed0dd1c6ca9ff3c38fa62214' },
  { path: 'onnx/encoder_model_quantized.onnx', size: 43651493, sha256: 'f4ad7a68f1fb875d3bcf735ea14a7021b7ba7e83baf7cf10289881b4ed6d9b85' },
  { path: 'onnx/decoder_model_merged_quantized.onnx', size: 98177697, sha256: 'f22f52f980c33df0efa15932c2f3db6d9d3595ce6387eca938b8cfe23dc4c641' },
];
export const DESCRIBER_BYTES = modelBytes(FILES);

/** PIXHAVEN_DESCRIBE_MODEL points tests (and developers) at a copy elsewhere. */
export const describerDir = () => process.env.PIXHAVEN_DESCRIBE_MODEL ?? path.join(app.getPath('userData'), 'models', 'describe', 'florence-2-base');
export const describerInstalled = () => modelInstalled(describerDir(), FILES, !!process.env.PIXHAVEN_DESCRIBE_MODEL);
export const downloadDescriber = (onProgress: (got: number, total: number) => void, signal: AbortSignal) =>
  downloadModel({ name: 'Describe a picture', repo: REPO, revision: REVISION, files: FILES }, describerDir(), onProgress, signal);
export function removeDescriber(): void {
  if (process.env.PIXHAVEN_DESCRIBE_MODEL) return;
  fs.rmSync(describerDir(), { recursive: true, force: true });
}
