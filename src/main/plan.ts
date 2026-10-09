// Pure helpers: which model/scale to run, final size, and safe output file names.
import fs from 'node:fs';
import path from 'node:path';
import type { ModelId, OutputFormat, SizeChoice } from '@shared/types';
import { TARGETS } from '@shared/types';

export type EngineModel = 'realesr-animevideov3' | 'realesrgan-x4plus' | 'realesrgan-x4plus-anime';

/** Native scales each model ships with. */
export const MODEL_SCALES: Record<EngineModel, number[]> = {
  'realesr-animevideov3': [2, 3, 4],
  'realesrgan-x4plus': [4],
  'realesrgan-x4plus-anime': [4],
};

export const ENGINE_MODEL: Record<ModelId, EngineModel> = {
  fast: 'realesr-animevideov3',
  photo: 'realesrgan-x4plus',
  anime: 'realesrgan-x4plus-anime',
};

export interface ScalePlan {
  model: EngineModel;
  engineScale: number;   // what the AI model enlarges by
  factor: number;        // overall enlargement wanted
  width: number;         // final output size
  height: number;
  needsResize: boolean;  // AI output differs from final size → Lanczos resize
}

/** Overall factor for a size choice: a fixed factor, or "fit inside the target box" keeping orientation. */
export function wantedFactor(w: number, h: number, size: SizeChoice): number {
  if (size.kind === 'scale') return size.factor;
  const t = TARGETS[size.target];
  const [boxW, boxH] = w >= h ? [t.long, t.short] : [t.short, t.long];
  return Math.min(boxW / w, boxH / h);
}

export function planScale(w: number, h: number, size: SizeChoice, model: ModelId): ScalePlan | { error: string } {
  const factor = wantedFactor(w, h, size);
  if (factor <= 1.0001) {
    return { error: `Already ${w}×${h}, which is at or above the chosen size. Pick a larger size or a scale factor.` };
  }
  const engineModel = ENGINE_MODEL[model];
  const scales = MODEL_SCALES[engineModel];
  // Smallest native scale that reaches the factor; otherwise the largest, then a Lanczos resize up.
  const engineScale = scales.find(s => s >= factor - 1e-6) ?? scales[scales.length - 1];
  const width = Math.round(w * factor);
  const height = Math.round(h * factor);
  return { model: engineModel, engineScale, factor, width, height, needsResize: width !== w * engineScale || height !== h * engineScale };
}

export const EXT: Record<OutputFormat, string> = { png: '.png', jpg: '.jpg', webp: '.webp' };

/** "photo.jpg" → "photo_upscaled.png" in outDir (or next to the input). */
export function outputPath(input: string, format: OutputFormat, outDir: string | null): string {
  const dir = outDir ?? path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}_upscaled${EXT[format]}`);
}

/** Never overwrite: "name.png" → "name (2).png", "name (3).png", … */
export function uniquePath(p: string, exists: (p: string) => boolean = fs.existsSync): string {
  if (!exists(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, -ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

export function isUpscaledName(file: string): boolean {
  return /_upscaled( \(\d+\))?$/i.test(path.basename(file, path.extname(file)));
}
