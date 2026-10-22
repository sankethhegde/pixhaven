// v2.6 Image Generator model: LCM Dreamshaper v7 (Stable Diffusion 1.5, ONNX for DirectML), downloaded once on first
// use from a pinned Hugging Face revision (see model-download.ts: checksums, resuming).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { downloadModel, modelBytes, modelInstalled, type ModelFile } from '../model-download';

export const MODEL_NAME = 'LCM Dreamshaper v7';
const REPO = 'softwareweaver/LCM_Dreamshaper_v7_Olive_Onnx';
export const MODEL_SOURCE = `https://huggingface.co/${REPO}`;
export const MODEL_LICENCE = 'https://huggingface.co/spaces/CompVis/stable-diffusion-license';
const REVISION = '25bf953af1ff2d6761da8d94bd4e0698f3b54a07';
const FILES: ModelFile[] = [
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
export const MODEL_BYTES = modelBytes(FILES);

/** Where the model lives. PIXHAVEN_GEN_MODEL points tests (and developers) at a copy elsewhere. */
export const generatorDir = () => process.env.PIXHAVEN_GEN_MODEL ?? path.join(app.getPath('userData'), 'models', 'generator', 'lcm-dreamshaper-v7');

export function generatorInstalled(): boolean {
  return modelInstalled(generatorDir(), files(), !!process.env.PIXHAVEN_GEN_MODEL && !process.env.PIXHAVEN_GEN_DL_TEST);
}

export function downloadGenerator(onProgress: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  return downloadModel({ name: 'Image Generator', repo: REPO, revision: REVISION, files: files() }, generatorDir(), onProgress, signal);
}

// v2.8 image to image: the VAE encoder, an optional extra from the same revision (downloaded when first needed).
const ENCODER: ModelFile[] = [
  { path: 'vae_encoder/model.onnx', size: 68391734, sha256: '9855ebc42edfac6e07df762ec53cc446d2ae847b80d1aacaf38c1a33de961f3b' },
];
export const ENCODER_BYTES = modelBytes(ENCODER);
export const encoderInstalled = () => ENCODER.every(f => { try { return fs.statSync(path.join(generatorDir(), f.path)).size === f.size; } catch { return false; } });
export function downloadEncoder(onProgress: (got: number, total: number) => void, signal: AbortSignal): Promise<void> {
  return downloadModel({ name: 'Image to image', repo: REPO, revision: REVISION, files: ENCODER }, generatorDir(), onProgress, signal);
}

/** Settings → free the space again. */
export function removeGenerator(): void {
  if (process.env.PIXHAVEN_GEN_MODEL && !process.env.PIXHAVEN_GEN_DL_TEST) return;
  fs.rmSync(generatorDir(), { recursive: true, force: true });
}
