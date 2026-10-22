// v2.6 Image Generator: text → image, offline, with LCM Dreamshaper v7 (Stable Diffusion 1.5, ONNX for DirectML).
// CLIP tokenizer → text encoder → 4–8 LCM steps of the UNet → VAE decoder → safety checker. No Electron imports
// (runs in generator/worker.ts, and in tests).
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// ---------- CLIP tokenizer (byte-level BPE, as in CLIPTokenizer) ----------
function bytesToUnicode(): Map<number, string> {
  const bs: number[] = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) if (!bs.includes(b)) { bs.push(b); cs.push(256 + n++); }
  return new Map(bs.map((b, i) => [b, String.fromCodePoint(cs[i])]));
}

export const BOS = 49406, EOS = 49407, CONTEXT = 77;

export class ClipTokenizer {
  private vocab: Record<string, number>;
  private rank: Map<string, number>;
  private b2u = bytesToUnicode();
  private cache = new Map<string, string[]>();
  private static PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/gu;

  constructor(dir: string) {
    this.vocab = JSON.parse(fs.readFileSync(path.join(dir, 'vocab.json'), 'utf8'));
    const merges = fs.readFileSync(path.join(dir, 'merges.txt'), 'utf8').split('\n').slice(1).filter(Boolean);
    this.rank = new Map(merges.map((m, i) => [m, i]));
  }

  private bpe(token: string): string[] {
    const hit = this.cache.get(token);
    if (hit) return hit;
    const chars = [...token];
    let word = chars.length === 1 ? [token + '</w>'] : [...chars.slice(0, -1), chars[chars.length - 1] + '</w>'];
    while (word.length > 1) {
      let best = -1, bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const r = this.rank.get(`${word[i]} ${word[i + 1]}`);
        if (r !== undefined && r < bestRank) { bestRank = r; best = i; }
      }
      if (best < 0) break;
      const a = word[best], b = word[best + 1], out: string[] = [];
      for (let i = 0; i < word.length; i++) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) { out.push(a + b); i++; } else out.push(word[i]);
      }
      word = out;
    }
    this.cache.set(token, word);
    return word;
  }

  /** The prompt's own token ids (no start/end, not cut). */
  private ids(text: string): number[] {
    const ids: number[] = [];
    for (const m of text.toLowerCase().replace(/\s+/g, ' ').trim().matchAll(ClipTokenizer.PAT)) {
      const t = [...Buffer.from(m[0], 'utf8')].map(b => this.b2u.get(b)!).join('');
      for (const p of this.bpe(t)) ids.push(this.vocab[p] ?? EOS);
    }
    return ids;
  }

  /** 77 token ids: start, the prompt (cut to fit), end, then padding with the end token. */
  encode(text: string): number[] {
    const ids = [BOS, ...this.ids(text)];
    ids.length = Math.min(ids.length, CONTEXT - 1);
    ids.push(EOS);
    while (ids.length < CONTEXT) ids.push(EOS);
    return ids;
  }

  /** Tokens in a prompt; only the first 75 are used (the UI says so when a prompt is longer). */
  count(text: string): number { return this.ids(text).length; }
}

// ---------- half precision ----------
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return sign;
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | (m >>> 13);
}
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

type Meta = { name: string; type?: string };
const typeOf = (s: ort.InferenceSession, name: string): string =>
  ((s as unknown as { inputMetadata?: Meta[] }).inputMetadata?.find(x => x.name === name)?.type) ?? 'float32';

/** A tensor in the type the model wants. Half precision goes in as raw 16-bit values: on Node 24 onnxruntime wraps
 * them in a Float16Array its native side can't read, so the Uint16Array view is put back. */
function tensor(s: ort.InferenceSession, name: string, data: ArrayLike<number>, dims: number[]): ort.Tensor {
  const t = typeOf(s, name);
  if (t === 'float16') {
    const h = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) h[i] = toHalf(data[i]);
    const x = new ort.Tensor('float16', h, dims);
    (x as unknown as { cpuData: Uint16Array }).cpuData = h;
    return x;
  }
  if (t === 'int32') return new ort.Tensor('int32', Int32Array.from(data), dims);
  if (t === 'int64') return new ort.Tensor('int64', BigInt64Array.from(Array.from(data), v => BigInt(v)), dims);
  return new ort.Tensor('float32', Float32Array.from(data), dims);
}
const floats = (t: ort.Tensor): Float32Array =>
  t.data instanceof Uint16Array && t.type === 'float16' ? Float32Array.from(t.data, fromHalf) : Float32Array.from(t.data as ArrayLike<number>);

// ---------- seeded noise ----------
export function gaussian(seed: number): () => number {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(Math.max(u(), 1e-12))) * Math.cos(2 * Math.PI * u());
}

// ---------- LCM scheduler ----------
export interface SchedulerConfig {
  num_train_timesteps?: number; beta_start?: number; beta_end?: number; original_inference_steps?: number;
  set_alpha_to_one?: boolean; timestep_scaling?: number;
}

export class LcmScheduler {
  readonly alphas: Float64Array;
  private final: number;
  constructor(private c: SchedulerConfig) {
    const T = c.num_train_timesteps ?? 1000, b0 = Math.sqrt(c.beta_start ?? 0.00085), b1 = Math.sqrt(c.beta_end ?? 0.012);
    this.alphas = new Float64Array(T);
    let p = 1;
    for (let i = 0; i < T; i++) { p *= 1 - (b0 + (b1 - b0) * i / (T - 1)) ** 2; this.alphas[i] = p; }
    this.final = c.set_alpha_to_one ? 1 : this.alphas[0];
  }
  /** 4 steps: 999, 759, 519, 279 (picked from the 50-step schedule LCM was distilled from). */
  timesteps(n: number): number[] {
    const T = this.alphas.length, orig = this.c.original_inference_steps ?? 50, k = Math.floor(T / orig);
    const origin = Array.from({ length: orig }, (_, i) => (i + 1) * k - 1).reverse();
    const skip = Math.floor(orig / n);
    return origin.filter((_, i) => i % skip === 0).slice(0, n);
  }
  /** One step: the model's noise estimate → the clean image it implies → (unless last) noised again to the next step. */
  step(sample: Float32Array, eps: Float32Array, t: number, next: number | null, noise: () => number): Float32Array {
    const a = this.alphas[t], prev = next === null ? this.final : this.alphas[next];
    const sc = t * (this.c.timestep_scaling ?? 10), sd = 0.5;
    const cSkip = sd * sd / (sc * sc + sd * sd), cOut = sc / Math.sqrt(sc * sc + sd * sd);
    const out = new Float32Array(sample.length), ra = Math.sqrt(a), r1a = Math.sqrt(1 - a), rp = Math.sqrt(prev), r1p = Math.sqrt(1 - prev);
    for (let i = 0; i < sample.length; i++) {
      const den = cOut * ((sample[i] - r1a * eps[i]) / ra) + cSkip * sample[i];
      out[i] = next === null ? den : rp * den + r1p * noise();
    }
    return out;
  }
}

/** LCM's guidance-scale embedding (w = guidance − 1), 256 values. */
export function guidanceEmbedding(w: number, dim = 256): Float32Array {
  const half = dim / 2, e = Math.log(10000) / (half - 1), out = new Float32Array(dim);
  for (let i = 0; i < half; i++) { const v = w * 1000 * Math.exp(-e * i); out[i] = Math.sin(v); out[i + half] = Math.cos(v); }
  return out;
}

// ---------- the generator ----------
export interface GenerateOptions {
  prompt: string; seed: number; steps: number; width: number; height: number;
  guidance?: number;     // LCM's built-in guidance (default 8)
  negative?: string;     // what to steer away from (with cfg > 1): a second, unconditioned pass per step
  cfg?: number;          // strength of that steering (1 = off)
  keepBorders?: boolean; // tests: leave plain edge bands as they are
}
export interface Generated { rgb: Buffer; width: number; height: number; nsfw: boolean | null; ms: number; trimmed?: boolean }

export class ImageGenerator {
  private constructor(
    private tok: ClipTokenizer, private sched: LcmScheduler,
    private text: ort.InferenceSession, private unet: ort.InferenceSession, private vae: ort.InferenceSession,
    private safety: ort.InferenceSession | null, readonly device: 'dml' | 'cpu',
  ) {}

  static async load(dir: string, preferGpu = true): Promise<ImageGenerator> {
    const opts = (ep: string[]): ort.InferenceSession.SessionOptions => ({
      executionProviders: ep, logSeverityLevel: 3, graphOptimizationLevel: 'all', enableMemPattern: false,
      extra: { session: { intra_op: { allow_spinning: '0' } } },
    } as ort.InferenceSession.SessionOptions);
    // The text encoder and the safety checker run on the processor: on integrated graphics (memory shared with the
    // system, ~4 GB) the UNet's attention at 768 px needs the room — with everything on the GPU the second large picture
    // made Windows suspend the device. They are small and quick on the CPU. PIXHAVEN_GEN_PLACE overrides (tests).
    const onCpu = new Set((process.env.PIXHAVEN_GEN_PLACE ?? 'text,safety').split(',').filter(Boolean));
    const tryLoad = async (ep: string[]) => Promise.all(['text_encoder', 'unet', 'vae_decoder'].map(m =>
      ort.InferenceSession.create(path.join(dir, m, 'model.onnx'), opts(onCpu.has(m.split('_')[0]) ? ['cpu'] : ep))));
    let device: 'dml' | 'cpu' = preferGpu && process.platform === 'win32' ? 'dml' : 'cpu';
    let s: ort.InferenceSession[];
    try { s = await tryLoad(device === 'dml' ? ['dml', 'cpu'] : ['cpu']); }
    catch (e) { if (device === 'cpu') throw e; device = 'cpu'; s = await tryLoad(['cpu']); }
    const safety = await ort.InferenceSession.create(path.join(dir, 'safety_checker', 'model.onnx'), opts(device === 'dml' && !onCpu.has('safety') ? ['dml', 'cpu'] : ['cpu'])).catch(() => null);
    const sched = new LcmScheduler(JSON.parse(fs.readFileSync(path.join(dir, 'scheduler', 'scheduler_config.json'), 'utf8')));
    return new ImageGenerator(new ClipTokenizer(path.join(dir, 'tokenizer')), sched, s[0], s[1], s[2], safety, device);
  }

  tokens(prompt: string): number { return this.tok.count(prompt); }

  async generate(o: GenerateOptions, onStep?: (done: number, total: number) => void, cancelled?: () => boolean): Promise<Generated | null> {
    const t0 = Date.now();
    const W = o.width, H = o.height, lw = W / 8, lh = H / 8, n = 4 * lw * lh;
    const encode = async (text: string) => {
      const te = await this.text.run({ [this.text.inputNames[0]]: tensor(this.text, this.text.inputNames[0], this.tok.encode(text), [1, CONTEXT]) });
      return floats(te[this.text.outputNames[0]]);
    };
    const hidden = await encode(o.prompt);
    const cfg = o.cfg ?? 1;
    const hiddenNeg = cfg > 1 ? await encode(o.negative ?? '') : null;
    const noise = gaussian(o.seed);
    let lat: Float32Array = new Float32Array(n);
    for (let i = 0; i < n; i++) lat[i] = noise();
    const w = guidanceEmbedding((o.guidance ?? 8) - 1);
    const ts = this.sched.timesteps(o.steps);
    for (let k = 0; k < ts.length; k++) {
      if (cancelled?.()) return null;
      const feeds: Record<string, ort.Tensor> = {
        sample: tensor(this.unet, 'sample', lat, [1, 4, lh, lw]),
        timestep: tensor(this.unet, 'timestep', [ts[k]], [1]),
        encoder_hidden_states: tensor(this.unet, 'encoder_hidden_states', hidden, [1, CONTEXT, 768]),
      };
      if (this.unet.inputNames.includes('timestep_cond')) feeds.timestep_cond = tensor(this.unet, 'timestep_cond', w, [1, 256]);
      const out = await this.unet.run(feeds);
      let eps = floats(out[this.unet.outputNames[0]]);
      if (hiddenNeg) {
        // Steer away from the negative description: eps = neg + cfg × (prompt − neg).
        const neg = floats((await this.unet.run({ ...feeds, encoder_hidden_states: tensor(this.unet, 'encoder_hidden_states', hiddenNeg, [1, CONTEXT, 768]) }))[this.unet.outputNames[0]]);
        for (let i = 0; i < eps.length; i++) eps[i] = neg[i] + cfg * (eps[i] - neg[i]);
      }
      lat = this.sched.step(lat, eps, ts[k], k + 1 < ts.length ? ts[k + 1] : null, noise);
      onStep?.(k + 1, ts.length + 1);
    }
    if (cancelled?.()) return null;
    const vo = await this.vae.run({ [this.vae.inputNames[0]]: tensor(this.vae, this.vae.inputNames[0], lat.map(v => v / 0.18215), [1, 4, lh, lw]) });
    const img = floats(vo[this.vae.outputNames[0]]);
    const raw = Buffer.alloc(W * H * 3);
    for (let c = 0; c < 3; c++) for (let i = 0; i < W * H; i++) raw[i * 3 + c] = Math.round(Math.min(1, Math.max(0, img[c * W * H + i] / 2 + 0.5)) * 255);
    const { rgb, trimmed } = o.keepBorders ? { rgb: raw, trimmed: false } : await trimBorders(raw, W, H);
    onStep?.(ts.length + 1, ts.length + 1);
    return { rgb, width: W, height: H, nsfw: await this.check(rgb, W, H), ms: Date.now() - t0, trimmed };
  }

  /** The model's safety checker: true = explicit content (the image is not shown or saved). null = could not run. */
  private async check(rgb: Buffer, W: number, H: number): Promise<boolean | null> {
    if (!this.safety) return null;
    try {
      // A proper (area) resize, as the checker was trained on: a nearest-pixel one gave false alarms.
      const clip = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } }).resize(224, 224, { fit: 'cover' }).raw().toBuffer();
      const mean = [0.48145466, 0.4578275, 0.40821073], std = [0.26862954, 0.26130258, 0.27577711];
      const ci = new Float32Array(3 * 224 * 224);
      for (let i = 0; i < 224 * 224; i++) for (let c = 0; c < 3; c++) ci[c * 224 * 224 + i] = (clip[i * 3 + c] / 255 - mean[c]) / std[c];
      const feeds: Record<string, ort.Tensor> = {};
      for (const name of this.safety.inputNames) {
        feeds[name] = /clip/i.test(name) ? tensor(this.safety, name, ci, [1, 3, 224, 224]) : tensor(this.safety, name, Float32Array.from(rgb, v => v / 255), [1, H, W, 3]);
      }
      const r = await this.safety.run(feeds);
      const flag = r[this.safety.outputNames.find(x => /nsfw/i.test(x)) ?? this.safety.outputNames[this.safety.outputNames.length - 1]];
      return Boolean((flag.data as ArrayLike<number | boolean>)[0]);
    } catch { return null; }
  }

  async release(): Promise<void> {
    for (const s of [this.text, this.unet, this.vae, this.safety]) await s?.release().catch(() => {});
  }
}

// ---------- borders ----------
/**
 * Plain bands along the edges (the model sometimes draws a poster's white margin or a dark frame, mostly in
 * portrait / landscape shapes): how many rows / columns from each edge are a flat, even colour.
 */
export function findBorders(rgb: Uint8Array, W: number, H: number): { top: number; bottom: number; left: number; right: number } {
  const lum = (x: number, y: number) => { const i = (y * W + x) * 3; return 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]; };
  const flat = (vals: number[], ref: number | null) => {
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    return { ok: sd < 7 && (ref === null || Math.abs(m - ref) < 12), m };
  };
  const band = (count: number, line: (k: number) => number[], limit: number) => {
    let ref: number | null = null, n = 0;
    for (let k = 0; k < limit; k++) { const f = flat(line(k), ref); if (!f.ok) break; ref ??= f.m; n++; }
    return n >= 4 ? n : 0;   // a few rows of sky are not a border
  };
  const row = (y: number) => Array.from({ length: Math.ceil(W / 2) }, (_, i) => lum(i * 2, y));
  const col = (x: number) => Array.from({ length: Math.ceil(H / 2) }, (_, i) => lum(x, i * 2));
  const lh = Math.floor(H * 0.18), lw = Math.floor(W * 0.18);
  return {
    top: band(H, k => row(k), lh), bottom: band(H, k => row(H - 1 - k), lh),
    left: band(W, k => col(k), lw), right: band(W, k => col(W - 1 - k), lw),
  };
}

/** Borders cut off and the picture scaled back to its size (the crop keeps the shape, centred on what is left). */
export async function trimBorders(rgb: Buffer, W: number, H: number): Promise<{ rgb: Buffer; trimmed: boolean }> {
  const b = findBorders(rgb, W, H);
  if (!b.top && !b.bottom && !b.left && !b.right) return { rgb, trimmed: false };
  const pad = 2;   // the soft edge between band and picture
  let x0 = b.left ? b.left + pad : 0, x1 = W - (b.right ? b.right + pad : 0), y0 = b.top ? b.top + pad : 0, y1 = H - (b.bottom ? b.bottom + pad : 0);
  // Same shape as before: crop the other side too, around the centre of what is left.
  const want = W / H;
  if ((x1 - x0) / (y1 - y0) > want) { const w = Math.round((y1 - y0) * want), cx = (x0 + x1) / 2; x0 = Math.round(cx - w / 2); x1 = x0 + w; }
  else { const h = Math.round((x1 - x0) / want), cy = (y0 + y1) / 2; y0 = Math.round(cy - h / 2); y1 = y0 + h; }
  const out = await sharp(rgb, { raw: { width: W, height: H, channels: 3 } })
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 }).resize(W, H, { kernel: 'lanczos3' }).raw().toBuffer();
  return { rgb: out, trimmed: true };
}
