// Face detection (YuNet) + alignment + fingerprint (SFace) via onnxruntime-node. No Electron imports
// (runs inside the scan worker thread). Proven in phase0/face-poc.mjs.
import path from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

const DET = 640;            // YuNet input is fixed 640×640
const SCORE = 0.85;         // detector confidence
export const CHIP = 112;    // SFace input

export interface Face {
  x: number; y: number; w: number; h: number;   // box in working-image pixels
  score: number;
  kps: [number, number][];                      // eyes, nose, mouth corners
  sharpness: number;                            // variance of Laplacian on the aligned chip
  usable: boolean;                              // big and sharp enough to recognise (FACE-02)
  emb?: Float32Array;                           // 128-d L2-normalised fingerprint (usable faces only)
}

export class FaceEngine {
  private constructor(private det: ort.InferenceSession, private rec: ort.InferenceSession, readonly provider: string) {}

  static async create(modelsDir: string, preferGpu: boolean): Promise<FaceEngine> {
    const load = (ep: string[]) => Promise.all([
      ort.InferenceSession.create(path.join(modelsDir, 'yunet.onnx'), { logSeverityLevel: 3, executionProviders: ep }),
      ort.InferenceSession.create(path.join(modelsDir, 'sface.onnx'), { logSeverityLevel: 3, executionProviders: ep }),
    ]);
    if (preferGpu) {
      try { const [d, r] = await load(['dml', 'cpu']); return new FaceEngine(d, r, 'dml'); } catch { /* fall back to CPU */ }
    }
    const [d, r] = await load(['cpu']);
    return new FaceEngine(d, r, 'cpu');
  }

  /** rgb: raw 3-channel pixels of the (upright, ≤1280 px) working image. */
  async analyse(rgb: Buffer, W: number, H: number, minFace: number, minSharpness: number): Promise<Face[]> {
    const faces: Face[] = [];
    // Whole image, letterboxed into 640×640.
    const s = Math.min(DET / W, DET / H);
    const full = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
      .resize(Math.round(W * s), Math.round(H * s)).extend({ right: DET - Math.round(W * s), bottom: DET - Math.round(H * s), background: '#000' })
      .raw().toBuffer();
    faces.push(...await this.detect(full, s, 0, 0));
    // Larger photos: also scan overlapping 640-px tiles at full working resolution, for small faces in group shots.
    if (Math.max(W, H) > DET * 1.2) {
      const step = Math.round(DET * 0.75);
      for (let ty = 0; ; ty += step) {
        const y = Math.min(ty, Math.max(0, H - DET));
        for (let tx = 0; ; tx += step) {
          const x = Math.min(tx, Math.max(0, W - DET));
          const w = Math.min(DET, W), h = Math.min(DET, H);
          const tile = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
            .extract({ left: x, top: y, width: w, height: h }).extend({ right: DET - w, bottom: DET - h, background: '#000' })
            .raw().toBuffer();
          faces.push(...await this.detect(tile, 1, x, y));
          if (x + DET >= W) break;
        }
        if (y + DET >= H) break;
      }
    }
    const kept = nms(faces);
    for (const f of kept) {
      const chip = alignCrop(rgb, W, H, f.kps);
      f.sharpness = laplacianVariance(chip);
      f.usable = Math.min(f.w, f.h) >= minFace && f.sharpness >= minSharpness;
      if (f.usable) f.emb = await this.fingerprint(chip);
    }
    return kept;
  }

  private async detect(img640: Buffer, s: number, ox: number, oy: number): Promise<Face[]> {
    const N = DET * DET;
    const input = new Float32Array(3 * N);
    for (let i = 0, p = 0; i < N; i++, p += 3) { input[i] = img640[p + 2]; input[N + i] = img640[p + 1]; input[2 * N + i] = img640[p]; } // BGR planes
    const out = await this.det.run({ input: new ort.Tensor('float32', input, [1, 3, DET, DET]) });
    const faces: Face[] = [];
    for (const st of [8, 16, 32]) {
      const cls = out['cls_' + st].data as Float32Array, obj = out['obj_' + st].data as Float32Array;
      const bb = out['bbox_' + st].data as Float32Array, kp = out['kps_' + st].data as Float32Array;
      const cols = DET / st;
      for (let i = 0; i < cls.length; i++) {
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
        if (score < SCORE) continue;
        const c = i % cols, r = Math.floor(i / cols);
        const cx = (c + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
        const bw = Math.exp(bb[i * 4 + 2]) * st, bh = Math.exp(bb[i * 4 + 3]) * st;
        const kps: [number, number][] = [];
        for (let k = 0; k < 5; k++) kps.push([(kp[i * 10 + 2 * k] + c) * st / s + ox, (kp[i * 10 + 2 * k + 1] + r) * st / s + oy]);
        faces.push({ x: (cx - bw / 2) / s + ox, y: (cy - bh / 2) / s + oy, w: bw / s, h: bh / s, score, kps, sharpness: 0, usable: false });
      }
    }
    return faces;
  }

  private async fingerprint(chip: Uint8Array): Promise<Float32Array> {
    const N = CHIP * CHIP;
    const t = new Float32Array(3 * N);
    for (let i = 0; i < N; i++) { t[i] = chip[i * 3]; t[N + i] = chip[i * 3 + 1]; t[2 * N + i] = chip[i * 3 + 2]; } // RGB planes
    const out = await this.rec.run({ data: new ort.Tensor('float32', t, [1, 3, CHIP, CHIP]) });
    const f = Float32Array.from(out.fc1.data as Float32Array);
    let n = 0; for (const v of f) n += v * v;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < f.length; i++) f[i] /= n;
    return f;
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function iou(a: Face, b: Face): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}
function nms(faces: Face[]): Face[] {
  faces.sort((a, b) => b.score - a.score);
  const keep: Face[] = [];
  for (const f of faces) if (keep.every(k => iou(k, f) < 0.3)) keep.push(f);
  return keep;
}

// ArcFace 5-point template for a 112×112 chip.
const TEMPLATE: [number, number][] = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

/** Least-squares similarity transform (2D Umeyama) mapping src → dst: x' = a x − b y + tx, y' = b x + a y + ty. */
export function similarity(src: [number, number][], dst: [number, number][]): [number, number, number, number] {
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sxx = 0, sab = 0, sad = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
    sxx += x * x + y * y; sab += x * u + y * v; sad += x * v - y * u;
  }
  const a = sab / sxx, b = sad / sxx;
  return [a, b, nx - (a * mx - b * my), ny - (b * mx + a * my)];
}

/** 112×112 RGB face chip, inverse-mapped from the photo with bilinear sampling. */
export function alignCrop(rgb: Buffer, W: number, H: number, kps: [number, number][]): Uint8Array {
  const [a, b, tx, ty] = similarity(kps, TEMPLATE);
  const det = a * a + b * b;
  const out = new Uint8Array(CHIP * CHIP * 3);
  for (let v = 0; v < CHIP; v++) for (let u = 0; u < CHIP; u++) {
    const du = u - tx, dv = v - ty;
    const x = (a * du + b * dv) / det, y = (-b * du + a * dv) / det;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (let ch = 0; ch < 3; ch++) {
      const px = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : rgb[(yy * W + xx) * 3 + ch];
      out[(v * CHIP + u) * 3 + ch] = Math.round(px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy);
    }
  }
  return out;
}

/** Blur measure: variance of the Laplacian over the central part of the chip (higher = sharper). */
export function laplacianVariance(chip: Uint8Array): number {
  const g = (x: number, y: number) => { const i = (y * CHIP + x) * 3; return 0.299 * chip[i] + 0.587 * chip[i + 1] + 0.114 * chip[i + 2]; };
  let sum = 0, sq = 0, n = 0;
  for (let y = 24; y < 100; y++) for (let x = 20; x < 92; x++) {
    const l = g(x - 1, y) + g(x + 1, y) + g(x, y - 1) + g(x, y + 1) - 4 * g(x, y);
    sum += l; sq += l * l; n++;
  }
  const mean = sum / n;
  return sq / n - mean * mean;
}
