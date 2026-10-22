// v2.7 "Describe a picture": Florence-2 base (Microsoft, MIT licence; ONNX, 8-bit) writes a description of any picture,
// which becomes a prompt for the Image Generator. Runs on the processor (leaves the graphics card to the generator).
// Vision encoder → (image features + task prompt) → text encoder → decoder, greedy with no repeated 3-grams.
// No Electron imports (runs in describe/worker.ts and in tests).
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

// ---------- BART tokenizer (byte-level BPE, as GPT-2) ----------
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

export const BOS = 0, PAD = 1, EOS = 2;

export class BartTokenizer {
  private vocab: Record<string, number>;
  private inv: string[] = [];
  private rank: Map<string, number>;
  private b2u = bytesToUnicode();
  private u2b = new Map([...this.b2u].map(([b, u]) => [u, b]));
  private static PAT = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

  constructor(dir: string) {
    this.vocab = JSON.parse(fs.readFileSync(path.join(dir, 'vocab.json'), 'utf8'));
    for (const [t, i] of Object.entries(this.vocab)) this.inv[i] = t;
    const merges = fs.readFileSync(path.join(dir, 'merges.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#version'));
    this.rank = new Map(merges.map((m, i) => [m, i]));
  }

  private bpe(token: string): string[] {
    let word = [...token];
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
    return word;
  }

  /** <s> text </s> */
  encode(text: string): number[] {
    const ids = [BOS];
    for (const m of text.matchAll(BartTokenizer.PAT)) {
      const t = [...Buffer.from(m[0], 'utf8')].map(b => this.b2u.get(b)!).join('');
      for (const p of this.bpe(t)) ids.push(this.vocab[p] ?? 3);
    }
    ids.push(EOS);
    return ids;
  }

  /** Text of the ids, special and location tokens left out. */
  decode(ids: number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      const t = this.inv[id];
      if (!t || id <= 3 || /^<.*>$/.test(t)) continue;
      for (const ch of t) { const b = this.u2b.get(ch); if (b !== undefined) bytes.push(b); }
    }
    return Buffer.from(bytes).toString('utf8').trim();
  }
}

// ---------- the model ----------
const TASKS = {
  short: 'What does the image describe?',
  detailed: 'Describe in detail what is shown in the image.',
  paragraph: 'Describe with a paragraph what is shown in the image.',
} as const;
export type Detail = keyof typeof TASKS;

const SIZE = 768, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

export class PictureDescriber {
  private constructor(
    private tok: BartTokenizer,
    private vision: ort.InferenceSession, private embed: ort.InferenceSession,
    private encoder: ort.InferenceSession, private decoder: ort.InferenceSession,
  ) {}

  static async load(dir: string): Promise<PictureDescriber> {
    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['cpu'], logSeverityLevel: 3, graphOptimizationLevel: 'all',
      extra: { session: { intra_op: { allow_spinning: '0' } } },
    } as ort.InferenceSession.SessionOptions;
    const s = await Promise.all(['vision_encoder', 'embed_tokens', 'encoder_model', 'decoder_model_merged']
      .map(m => ort.InferenceSession.create(path.join(dir, 'onnx', `${m}_quantized.onnx`), opts)));
    return new PictureDescriber(new BartTokenizer(dir), s[0], s[1], s[2], s[3]);
  }

  private async embedIds(ids: number[]): Promise<ort.Tensor> {
    const r = await this.embed.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, v => BigInt(v)), [1, ids.length]) });
    return r.inputs_embeds;
  }

  /** A description of the picture (any format sharp reads; the caller passes RAW previews etc. as a buffer). */
  async describe(input: string | Buffer, detail: Detail = 'detailed', maxTokens = 160, cancelled?: () => boolean): Promise<string | null> {
    // Picture → 768 × 768, normalised, channels first.
    const px = await sharp(input, { limitInputPixels: false }).rotate().removeAlpha().resize(SIZE, SIZE, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
    const pv = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) pv[c * SIZE * SIZE + i] = (px[i * 3 + c] / 255 - MEAN[c]) / STD[c];
    const img = (await this.vision.run({ pixel_values: new ort.Tensor('float32', pv, [1, 3, SIZE, SIZE]) })).image_features;
    if (cancelled?.()) return null;

    // Encoder input: image features, then the task's words.
    const text = await this.embedIds(this.tok.encode(TASKS[detail]));
    const ni = img.dims[1], nt = text.dims[1], d = 768;
    const joined = new Float32Array((ni + nt) * d);
    joined.set(img.data as Float32Array, 0);
    joined.set(text.data as Float32Array, ni * d);
    const mask = new ort.Tensor('int64', new BigInt64Array(ni + nt).fill(1n), [1, ni + nt]);
    const enc = (await this.encoder.run({ inputs_embeds: new ort.Tensor('float32', joined, [1, ni + nt, d]), attention_mask: mask })).last_hidden_state;

    // Greedy decoding with the key/value cache; the first token is forced to <s>, and no 3-gram may repeat.
    const layers = this.decoder.inputNames.filter(n => /^past_key_values\.\d+\.decoder\.key$/.test(n)).length;
    const empty = new ort.Tensor('float32', new Float32Array(0), [1, 12, 0, 64]);
    let past: Record<string, ort.Tensor> = {};
    for (let l = 0; l < layers; l++) for (const k of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) past[`past_key_values.${l}.${k}`] = empty;
    const out: number[] = [];
    let next = EOS;   // decoder_start_token_id
    for (let step = 0; step < maxTokens; step++) {
      if (cancelled?.()) return null;
      const feeds: Record<string, ort.Tensor> = {
        inputs_embeds: await this.embedIds([next]), encoder_hidden_states: enc, encoder_attention_mask: mask, ...past,
      };
      if (this.decoder.inputNames.includes('use_cache_branch')) feeds.use_cache_branch = new ort.Tensor('bool', [step > 0], [1]);
      const r = await this.decoder.run(feeds);
      const logits = r.logits.data as Float32Array, V = r.logits.dims[2];
      const row = logits.subarray(logits.length - V);
      // Keep the cache: the encoder part only from the first step (later steps return it unchanged or empty).
      const nextPast: Record<string, ort.Tensor> = {};
      for (let l = 0; l < layers; l++) {
        for (const k of ['decoder.key', 'decoder.value']) nextPast[`past_key_values.${l}.${k}`] = r[`present.${l}.${k}`];
        for (const k of ['encoder.key', 'encoder.value']) nextPast[`past_key_values.${l}.${k}`] = step === 0 ? r[`present.${l}.${k}`] : past[`past_key_values.${l}.${k}`];
      }
      past = nextPast;
      if (step === 0) { next = BOS; out.push(BOS); continue; }
      const banned = new Set<number>();
      if (out.length >= 2) {
        const a = out[out.length - 2], b = out[out.length - 1];
        for (let i = 0; i + 2 < out.length; i++) if (out[i] === a && out[i + 1] === b) banned.add(out[i + 2]);
      }
      let best = -1, bv = -Infinity;
      for (let i = 0; i < V; i++) if (row[i] > bv && !banned.has(i)) { bv = row[i]; best = i; }
      if (best === EOS) break;
      out.push(best);
      next = best;
    }
    return this.tok.decode(out);
  }

  async release(): Promise<void> {
    for (const s of [this.vision, this.embed, this.encoder, this.decoder]) await s.release().catch(() => {});
  }
}
