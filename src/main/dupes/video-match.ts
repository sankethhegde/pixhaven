// 1.1.0 Duplicate videos: which videos are the same, which is a longer version of another, and which two overlap
// (the end of one is the start of the other). Works on fingerprints: a tiny picture hash every STEP seconds, the
// same whatever the size, format or quality of the copy. Copies that were mirrored, cropped (or had black bars added
// or taken off) or sped up are found too: each picture is also hashed mirrored and zoomed into its middle, and
// videos are lined up at the usual speed-ups as well. No Electron imports (unit tested).

export const STEP = 1;                 // seconds between two hashes
export const GRID_W = 32, GRID_H = 24; // the grey picture each sample is read as (FFmpeg)
const NEAR = 12;                       // hashes this close (of 64 bits) show the same picture
const MIN_RATIO = 0.7;                 // share of the overlap that must match
const MIN_OVERLAP = 30 / STEP;         // samples (30 s) for an overlap to count
const BUSY_BUCKET = 300;               // a hash band seen this often is a common picture (black, logo): ignored
const CENTRE = 0.75;                   // the zoomed-in hash: the middle 75 % of the picture
/** How much faster one copy can be than the other (b's time ÷ a's time). */
export const SPEEDS = [1, 0.5, 2 / 3, 0.75, 0.8, 0.9, 1 / 0.9, 1.25, 4 / 3, 1.5, 2];

export interface Fingerprint {
  path: string; size: number; mtime: number;
  duration: number; width: number; height: number;
  /** Two 32-bit halves per sample (hi, lo): the picture (black bars left out), its middle, and the picture mirrored. */
  hashes: Uint32Array; centre: Uint32Array; mirror: Uint32Array;
  blank: Uint8Array;     // a blank sample (one flat colour) is never compared
}

// ---------- hashing ----------

/** A 64-bit difference hash of a 9×8 grey picture (72 values): each cell brighter than its right neighbour = 1. */
export function dHash(px: ArrayLike<number>): { hi: number; lo: number; blank: boolean } {
  let hi = 0, lo = 0, min = 255, max = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const bit = px[y * 9 + x] > px[y * 9 + x + 1] ? 1 : 0;
    const k = y * 8 + x;
    if (k < 32) hi = (hi | (bit << (31 - k))) >>> 0; else lo = (lo | (bit << (63 - k))) >>> 0;
  }
  for (let i = 0; i < 72; i++) { if (px[i] < min) min = px[i]; if (px[i] > max) max = px[i]; }
  return { hi, lo, blank: max - min < 12 };
}

/** The mean of each of 9×8 cells over a box of a grid picture (mirrored: columns right to left). */
function cells(g: Uint8Array, box: { x: number; y: number; w: number; h: number }, mirrored: boolean): Float32Array {
  const out = new Float32Array(72);
  for (let cy = 0; cy < 8; cy++) for (let cx = 0; cx < 9; cx++) {
    const x0 = Math.floor(box.x + (cx * box.w) / 9), x1 = Math.max(x0 + 1, Math.floor(box.x + ((cx + 1) * box.w) / 9));
    const y0 = Math.floor(box.y + (cy * box.h) / 8), y1 = Math.max(y0 + 1, Math.floor(box.y + ((cy + 1) * box.h) / 8));
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += g[y * GRID_W + x]; n++; }
    out[cy * 9 + (mirrored ? 8 - cx : cx)] = sum / n;
  }
  return out;
}

/**
 * Black bars all through the video (letterbox or pillarbox): the rows and columns at the edges that stay dark in
 * nearly every picture. Returns the box that is left.
 */
export function barsBox(frames: Uint8Array[]): { x: number; y: number; w: number; h: number } {
  const dark = (pick: (g: Uint8Array) => number) => frames.length > 0 && frames.filter(g => pick(g) < 24).length >= frames.length * 0.9;
  const rowMax = (g: Uint8Array, y: number) => { let m = 0; for (let x = 0; x < GRID_W; x++) m = Math.max(m, g[y * GRID_W + x]); return m; };
  const colMax = (g: Uint8Array, x: number) => { let m = 0; for (let y = 0; y < GRID_H; y++) m = Math.max(m, g[y * GRID_W + x]); return m; };
  let top = 0, bottom = GRID_H, left = 0, right = GRID_W;
  while (top < GRID_H / 3 && dark(g => rowMax(g, top))) top++;
  while (bottom > GRID_H * 2 / 3 && dark(g => rowMax(g, bottom - 1))) bottom--;
  while (left < GRID_W / 3 && dark(g => colMax(g, left))) left++;
  while (right > GRID_W * 2 / 3 && dark(g => colMax(g, right - 1))) right--;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Hashes of raw GRID_W×GRID_H grey frames, one after another: the picture, its middle and the picture mirrored. */
export function hashFrames(raw: Uint8Array): Pick<Fingerprint, 'hashes' | 'centre' | 'mirror' | 'blank'> {
  const size = GRID_W * GRID_H;
  const n = Math.floor(raw.length / size);
  const frames = Array.from({ length: n }, (_, i) => raw.subarray(i * size, (i + 1) * size));
  const box = barsBox(frames);
  const mid = { x: box.x + (box.w * (1 - CENTRE)) / 2, y: box.y + (box.h * (1 - CENTRE)) / 2, w: box.w * CENTRE, h: box.h * CENTRE };
  const hashes = new Uint32Array(n * 2), centre = new Uint32Array(n * 2), mirror = new Uint32Array(n * 2), blank = new Uint8Array(n);
  frames.forEach((g, i) => {
    const h = dHash(cells(g, box, false)), c = dHash(cells(g, mid, false)), m = dHash(cells(g, box, true));
    hashes[i * 2] = h.hi; hashes[i * 2 + 1] = h.lo;
    centre[i * 2] = c.hi; centre[i * 2 + 1] = c.lo;
    mirror[i * 2] = m.hi; mirror[i * 2 + 1] = m.lo;
    blank[i] = h.blank ? 1 : 0;
  });
  return { hashes, centre, mirror, blank };
}

const pop = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const len = (f: Fingerprint) => f.blank.length;

// ---------- comparing two videos ----------

/** Which hashes of each video are compared: a's picture with b's picture, mirrored picture or middle (and back). */
export type View = 'plain' | 'mirror' | 'cropA' | 'cropB';   // cropA: a is the cropped one (a's picture = b's middle)
const VIEWS: Record<View, [keyof Fingerprint, keyof Fingerprint]> = { plain: ['hashes', 'hashes'], mirror: ['hashes', 'mirror'], cropA: ['hashes', 'centre'], cropB: ['centre', 'hashes'] };

export interface Alignment { offset: number; speed: number; view: View; overlap: number; matched: number; compared: number; ratio: number }

/**
 * How well `a` lines up with `b` when sample i of a is sample round(speed × i + offset) of b. A part cut from a
 * longer video starts anywhere, so its samples fall between the other's: a sample also matches the one either side.
 */
export function align(a: Fingerprint, b: Fingerprint, offset: number, speed = 1, view: View = 'plain'): Alignment {
  const ha = a[VIEWS[view][0]] as Uint32Array, hb = b[VIEWS[view][1]] as Uint32Array;
  const d = (i: number, j: number) => pop((ha[i * 2] ^ hb[j * 2]) >>> 0) + pop((ha[i * 2 + 1] ^ hb[j * 2 + 1]) >>> 0);
  let matched = 0, compared = 0, overlap = 0;
  for (let i = 0; i < len(a); i++) {
    const j = Math.round(speed * i + offset);
    if (j < 0 || j >= len(b)) continue;
    overlap++;
    if (a.blank[i] || b.blank[j]) continue;
    compared++;
    if (d(i, j) <= NEAR || (j > 0 && d(i, j - 1) <= NEAR) || (j + 1 < len(b) && d(i, j + 1) <= NEAR)) matched++;
  }
  return { offset, speed, view, overlap, matched, compared, ratio: compared ? matched / compared : 0 };
}

export interface How { view: View; speed: number }
export type Relation =
  | { kind: 'same'; how: How }
  | { kind: 'contains'; longer: 'a' | 'b'; at: number; how: How }                       // the longer one holds all of the other, from `at` s
  | { kind: 'overlap'; first: 'a' | 'b'; cut: number; overlapSec: number };             // play `first`, then the other from `cut` s

/** What a (best) alignment says about two videos, or null when they are not related enough. */
export function relate(a: Fingerprint, b: Fingerprint, al: Alignment): Relation | null {
  if (al.ratio < MIN_RATIO || al.compared < Math.min(MIN_OVERLAP, Math.floor(0.6 * Math.min(len(a), len(b) / al.speed)))) return null;
  const how: How = { view: al.view, speed: al.speed };
  const covA = al.overlap / len(a), covB = Math.min(1, (al.overlap * al.speed) / len(b));
  if (covA >= 0.9 && covB >= 0.9) return { kind: 'same', how };
  if (covA >= 0.9) return { kind: 'contains', longer: 'b', at: Math.max(0, al.offset) * STEP, how };
  if (covB >= 0.9) return { kind: 'contains', longer: 'a', at: Math.max(0, -al.offset / al.speed) * STEP, how };
  // Two parts are only put together when they are the same picture at the same speed.
  if (al.view !== 'plain' || al.speed !== 1 || al.overlap < MIN_OVERLAP) return null;
  const from = Math.max(0, -al.offset), to = Math.min(len(a), len(b) - al.offset);   // overlap, in a's samples
  // a then b: a's overlap runs to its end, b's starts at its beginning (offset < 0: b's sample 0 is a's sample -offset).
  if (to >= len(a) - 2 && from + al.offset <= 2) return { kind: 'overlap', first: 'a', cut: Math.max(0, (len(a) + al.offset)) * STEP, overlapSec: al.overlap * STEP };
  // b then a: b's overlap runs to its end, a's starts at its beginning.
  if (from <= 2 && to + al.offset >= len(b) - 2) return { kind: 'overlap', first: 'b', cut: Math.max(0, len(b) - al.offset) * STEP, overlapSec: al.overlap * STEP };
  return null;
}

// ---------- the whole library ----------

export interface Pair { a: number; b: number; rel: Relation; ratio: number }

// Hash kinds put in the buckets: 0 picture, 1 middle, 2 mirrored. Which pairs of kinds say which View (a's kind, b's kind).
const KINDS: (keyof Fingerprint)[] = ['hashes', 'centre', 'mirror'];
const VIEW_OF: Record<string, View> = { '0,0': 'plain', '0,2': 'mirror', '2,0': 'mirror', '0,1': 'cropA', '1,0': 'cropB' };

/** Every related pair of videos (indexes into `fps`), found through shared hash bands, then checked in full. */
export function findPairs(fps: Fingerprint[]): Pair[] {
  const buckets = new Map<number, number[]>();   // band key → [video, kind, sample, …]
  fps.forEach((f, v) => {
    for (let k = 0; k < 3; k++) {
      const h = f[KINDS[k]] as Uint32Array;
      for (let i = 0; i < len(f); i++) {
        if (f.blank[i]) continue;
        const hi = h[i * 2], lo = h[i * 2 + 1];
        const bands = [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff];
        for (let band = 0; band < 4; band++) {
          const key = band * 65536 + bands[band];
          let list = buckets.get(key);
          if (!list) buckets.set(key, (list = []));
          if (list.length <= BUSY_BUCKET * 3) list.push(v, k, i);
        }
      }
    }
  });
  // Matching samples of two videos, per view: "a|b|view" → [ia, ib, …] (enough to find the speed and offset).
  const hits = new Map<string, number[]>();
  for (const list of buckets.values()) {
    if (list.length < 6 || list.length > BUSY_BUCKET * 3) continue;
    for (let x = 0; x < list.length; x += 3) for (let y = x + 3; y < list.length; y += 3) {
      let va = list[x], ka = list[x + 1], ia = list[x + 2], vb = list[y], kb = list[y + 1], ib = list[y + 2];
      if (va === vb) continue;
      if (va > vb) { [va, vb] = [vb, va]; [ka, kb] = [kb, ka]; [ia, ib] = [ib, ia]; }
      const view = VIEW_OF[`${ka},${kb}`];
      if (!view) continue;
      const key = `${va}|${vb}|${view}`;
      let h = hits.get(key);
      if (!h) hits.set(key, (h = []));
      if (h.length < 8000) h.push(ia, ib);
    }
  }
  // Per pair of videos, the best way they line up (any view, any speed).
  const best = new Map<string, Alignment>();
  for (const [key, h] of hits) {
    const [sa, sb, view] = key.split('|');
    const a = Number(sa), b = Number(sb);
    const tries: { speed: number; offset: number; votes: number }[] = [];
    for (const speed of SPEEDS) {
      const votes = new Map<number, number>();
      for (let x = 0; x < h.length; x += 2) { const o = Math.round(h[x + 1] - speed * h[x]); votes.set(o, (votes.get(o) ?? 0) + 1); }
      for (const [offset, n] of votes) if (n >= 3) tries.push({ speed, offset, votes: n });
    }
    tries.sort((p, q) => q.votes - p.votes);
    for (const t of tries.slice(0, 4)) for (const o of [t.offset - 1, t.offset, t.offset + 1]) {
      const al = align(fps[a], fps[b], o, t.speed, view as View);
      const k = `${a}|${b}`, cur = best.get(k);
      // The plain view at normal speed wins a tie: it is the simplest explanation.
      const score = (x: Alignment) => x.matched - (x.view === 'plain' ? 0 : 0.5) - (x.speed === 1 ? 0 : 0.5);
      if (relate(fps[a], fps[b], al) && (!cur || score(al) > score(cur))) best.set(k, al);
    }
  }
  const pairs: Pair[] = [];
  for (const [k, al] of best) {
    const [a, b] = k.split('|').map(Number);
    const rel = relate(fps[a], fps[b], al);
    if (rel) pairs.push({ a, b, rel, ratio: al.ratio });
  }
  return pairs;
}

// ---------- what to do ----------

export interface VideoFacts { path: string; size: number; duration: number; width: number; height: number }
/** Same video: keep null = you choose. `notes` says how a copy differs (mirrored, cropped, faster…). */
export interface SameGroup { members: number[]; keep: number | null; exact: boolean; notes: Record<number, string[]> }
export interface Longer { longer: number; shorter: number; at: number; how: string | null }
export interface Combine { first: number; second: number; cut: number; overlapSec: number }
export interface DupePlan { same: SameGroup[]; longer: Longer[]; combine: Combine[] }

const quality = (v: VideoFacts) => Math.min(v.width, v.height);
const bitrate = (v: VideoFacts) => (v.duration > 0 ? v.size / v.duration : v.size);
const speedText = (s: number) => `${(Math.round(s * 100) / 100).toString()}× speed`;

/** Which copy is clearly the best (bigger picture, or the same picture at a clearly higher bitrate); null = too close. */
export function bestOf(vs: VideoFacts[], members: number[]): number | null {
  const sorted = [...members].sort((x, y) => quality(vs[y]) - quality(vs[x]) || bitrate(vs[y]) - bitrate(vs[x]));
  const [p, q] = [vs[sorted[0]], vs[sorted[1]]];
  if (!q) return sorted[0];
  if (quality(p) > quality(q)) return sorted[0];
  return bitrate(p) > bitrate(q) * 1.15 ? sorted[0] : null;   // same size of picture: only a clearly better copy wins
}

/** How the copies of a pair differ, said of each of them. */
function notesOf(vs: VideoFacts[], a: number, b: number, how: How): [string[], string[]] {
  const na: string[] = [], nb: string[] = [];
  if (how.view === 'cropA') na.push('Cropped');
  if (how.view === 'cropB') nb.push('Cropped');
  // speed = b's time ÷ a's time: above 1, a plays faster.
  if (how.speed > 1.01) na.push(speedText(how.speed));
  if (how.speed < 0.99) nb.push(speedText(1 / how.speed));
  return [na, nb];
}
const howText = (how: How) => [how.view === 'mirror' ? 'mirrored' : how.view.startsWith('crop') ? 'cropped' : '',
  how.speed > 1.01 || how.speed < 0.99 ? 'at another speed' : ''].filter(Boolean).join(', ') || null;

/**
 * Groups of the same video (exact copies, renamed, other quality, mirrored, cropped, faster), longer versions and
 * parts to combine. `exact` lists index pairs whose files are byte-for-byte the same.
 */
export function planDupes(vs: VideoFacts[], pairs: Pair[], exact: [number, number][]): DupePlan {
  const parent = vs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const exactSet = new Set<number>();
  const notes = new Map<number, Set<string>>();
  const altered = new Set<number>();               // groups with a mirrored, cropped or faster copy: you choose
  for (const [a, b] of exact) { join(a, b); exactSet.add(a); exactSet.add(b); }
  const edges = new Map<number, { to: number; flip: boolean }[]>();   // which way each copy faces (mirrored or not)
  const edge = (a: number, b: number, flip: boolean) => { edges.set(a, [...(edges.get(a) ?? []), { to: b, flip }]); edges.set(b, [...(edges.get(b) ?? []), { to: a, flip }]); };
  for (const [a, b] of exact) edge(a, b, false);
  for (const p of pairs) if (p.rel.kind === 'contains') edge(p.a, p.b, p.rel.how.view === 'mirror');   // a piece faces some way too
  for (const p of pairs) {
    if (p.rel.kind !== 'same') continue;
    join(p.a, p.b);
    edge(p.a, p.b, p.rel.how.view === 'mirror');
    const [na, nb] = notesOf(vs, p.a, p.b, p.rel.how);
    for (const [i, n] of [[p.a, na], [p.b, nb]] as const) for (const t of n) { notes.set(i, (notes.get(i) ?? new Set()).add(t)); altered.add(i); }
  }
  // Which way each video faces, over everything linked (copies and pieces): most face the way they were filmed.
  const side = new Map<number, boolean>();
  const odd = new Set<number>();
  for (let start = 0; start < vs.length; start++) {
    if (side.has(start) || !edges.has(start)) continue;
    const comp = [start];
    side.set(start, false);
    for (let k = 0; k < comp.length; k++) for (const e of edges.get(comp[k]) ?? []) if (!side.has(e.to)) { side.set(e.to, side.get(comp[k])! !== e.flip); comp.push(e.to); }
    const flipped = comp.filter(m => side.get(m)), straight = comp.filter(m => !side.get(m));
    if (!flipped.length) continue;
    const best = [...comp].sort((x, y) => quality(vs[y]) - quality(vs[x]) || bitrate(vs[y]) - bitrate(vs[x]))[0];
    for (const m of flipped.length < straight.length ? flipped : straight.length < flipped.length ? straight : (side.get(best) ? straight : flipped)) odd.add(m);
  }
  const groups = new Map<number, number[]>();
  vs.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const same: SameGroup[] = [];
  const rep = new Map<number, number>();         // video → the one standing for its group
  for (const members of groups.values()) {
    if (members.length < 2) { rep.set(members[0], members[0]); continue; }
    for (const m of members) if (odd.has(m)) { notes.set(m, (notes.get(m) ?? new Set()).add('Mirrored')); altered.add(m); }
    const keep = members.some(m => altered.has(m)) ? null : bestOf(vs, members);
    same.push({ members, keep, exact: members.every(m => exactSet.has(m)), notes: Object.fromEntries(members.filter(m => notes.has(m)).map(m => [m, [...notes.get(m)!]])) });
    const r = keep ?? [...members].sort((x, y) => Number(altered.has(x)) - Number(altered.has(y)) || quality(vs[y]) - quality(vs[x]) || bitrate(vs[y]) - bitrate(vs[x]))[0];
    for (const m of members) rep.set(m, r);
  }
  const seen = new Set<string>();
  const longer: Longer[] = [], combine: Combine[] = [];
  for (const p of pairs) {
    if (p.rel.kind === 'same') continue;
    const a = rep.get(p.a)!, b = rep.get(p.b)!;
    if (a === b || a !== p.a || b !== p.b) continue;   // only between the copies that stay
    const k = `${Math.min(a, b)}|${Math.max(a, b)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (p.rel.kind === 'contains') longer.push(p.rel.longer === 'a' ? { longer: a, shorter: b, at: p.rel.at, how: howText(p.rel.how) } : { longer: b, shorter: a, at: p.rel.at, how: howText(p.rel.how) });
    else combine.push(p.rel.first === 'a' ? { first: a, second: b, cut: p.rel.cut, overlapSec: p.rel.overlapSec } : { first: b, second: a, cut: p.rel.cut, overlapSec: p.rel.overlapSec });
  }
  return { same, longer, combine };
}
