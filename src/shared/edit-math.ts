// v2.11 Video editor: timeline and crop maths shared by the export (main/convert/edit.ts) and the live preview.
import type { EditSpec, Range } from './types';

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** What each output file is made of: the trimmed range minus the cut-out parts, divided at the split points. */
export function outputsOf(e: Pick<EditSpec, 'trim' | 'cuts' | 'splits'>, duration: number): Range[][] {
  const start = Math.max(0, e.trim.start), end = Math.min(duration || e.trim.end, e.trim.end);
  let keep: Range[] = [{ start, end }];
  for (const c of [...e.cuts].sort((a, b) => a.start - b.start)) {
    keep = keep.flatMap(k => {
      if (c.end <= k.start || c.start >= k.end) return [k];
      return [{ start: k.start, end: c.start }, { start: c.end, end: k.end }].filter(x => x.end - x.start > 0.05);
    });
  }
  const cuts = [start, ...e.splits.filter(s => s > start && s < end).sort((a, b) => a - b), end];
  const outs: Range[][] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const part = keep.map(k => ({ start: Math.max(k.start, cuts[i]), end: Math.min(k.end, cuts[i + 1]) })).filter(k => k.end - k.start > 0.05);
    if (part.length) outs.push(part);
  }
  return outs;
}

/** Picture size after rotating and cropping (before any resolution change); x, y: top-left of the kept box. */
export function cropBox(w: number, h: number, e: Pick<EditSpec, 'rotate' | 'crop'>): { w: number; h: number; x: number; y: number } {
  const [W, H] = e.rotate === 90 || e.rotate === 270 ? [h, w] : [w, h];
  if (!e.crop) return { w: W, h: H, x: 0, y: 0 };
  const [a, b] = e.crop.aspect.split(':').map(Number);
  const r = a / b;
  let cw = W, ch = H;
  if (W / H > r) cw = even(H * r); else ch = even(W / r);
  return { w: cw, h: ch, x: Math.round((W - cw) * e.crop.x), y: Math.round((H - ch) * e.crop.y) };
}
