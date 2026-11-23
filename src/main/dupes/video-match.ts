// 1.1.0 Duplicate videos: which videos are the same, which is a longer version of another, and which two overlap
// (the end of one is the start of the other). Works on fingerprints: a tiny picture hash every STEP seconds, the
// same whatever the size, format or quality of the copy. No Electron imports (unit tested).

export const STEP = 1;                 // seconds between two hashes
const NEAR = 12;                       // hashes this close (of 64 bits) show the same picture
const MIN_RATIO = 0.7;                 // share of the overlap that must match
const MIN_OVERLAP = 30 / STEP;          // samples (30 s) for an overlap to count
const BUSY_BUCKET = 300;               // a hash band seen this often is a common picture (black, logo): ignored

export interface Fingerprint {
  path: string; size: number; mtime: number;
  duration: number; width: number; height: number;
  /** Two 32-bit halves per sample (hi, lo); a blank sample (one flat colour) is 0, 0 and `blank` is set. */
  hashes: Uint32Array;
  blank: Uint8Array;
}

// ---------- hashing ----------

/** A 64-bit difference hash of a 9×8 grey picture (72 bytes): each pixel brighter than its right neighbour = 1. */
export function dHash(px: Uint8Array): { hi: number; lo: number; blank: boolean } {
  let hi = 0, lo = 0, min = 255, max = 0;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const a = px[y * 9 + x], b = px[y * 9 + x + 1];
    const bit = a > b ? 1 : 0;
    const k = y * 8 + x;
    if (k < 32) hi = (hi | (bit << (31 - k))) >>> 0; else lo = (lo | (bit << (63 - k))) >>> 0;
  }
  for (let i = 0; i < 72; i++) { if (px[i] < min) min = px[i]; if (px[i] > max) max = px[i]; }
  return { hi, lo, blank: max - min < 12 };
}

/** Hashes of raw 9×8 grey frames, one after another. */
export function hashFrames(raw: Uint8Array): { hashes: Uint32Array; blank: Uint8Array } {
  const n = Math.floor(raw.length / 72);
  const hashes = new Uint32Array(n * 2), blank = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const h = dHash(raw.subarray(i * 72, i * 72 + 72));
    hashes[i * 2] = h.hi; hashes[i * 2 + 1] = h.lo; blank[i] = h.blank ? 1 : 0;
  }
  return { hashes, blank };
}

const pop = (x: number) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const dist = (a: Fingerprint, i: number, b: Fingerprint, j: number) => pop((a.hashes[i * 2] ^ b.hashes[j * 2]) >>> 0) + pop((a.hashes[i * 2 + 1] ^ b.hashes[j * 2 + 1]) >>> 0);
const len = (f: Fingerprint) => f.blank.length;

// ---------- comparing two videos ----------

export interface Alignment { offset: number; overlap: number; matched: number; compared: number; ratio: number }

/**
 * How well `a` lines up with `b` when sample i of a is sample i + offset of b. A part cut from a longer video starts
 * anywhere, so its samples fall between the other's: a sample also matches the one either side of it.
 */
export function align(a: Fingerprint, b: Fingerprint, offset: number): Alignment {
  const from = Math.max(0, -offset), to = Math.min(len(a), len(b) - offset);
  let matched = 0, compared = 0;
  for (let i = from; i < to; i++) {
    const j = i + offset;
    if (a.blank[i] || b.blank[j]) continue;
    compared++;
    if (dist(a, i, b, j) <= NEAR || (j > 0 && dist(a, i, b, j - 1) <= NEAR) || (j + 1 < len(b) && dist(a, i, b, j + 1) <= NEAR)) matched++;
  }
  const overlap = Math.max(0, to - from);
  return { offset, overlap, matched, compared, ratio: compared ? matched / compared : 0 };
}

export type Relation =
  | { kind: 'same' }
  | { kind: 'contains'; longer: 'a' | 'b'; at: number }                       // the longer one holds all of the other, from `at` s
  | { kind: 'overlap'; first: 'a' | 'b'; cut: number; overlapSec: number };   // play `first`, then the other from `cut` s

/** What a (best) alignment says about two videos, or null when they are not related enough. */
export function relate(a: Fingerprint, b: Fingerprint, al: Alignment): Relation | null {
  if (al.ratio < MIN_RATIO || al.compared < Math.min(MIN_OVERLAP, Math.floor(0.6 * Math.min(len(a), len(b))))) return null;
  const covA = al.overlap / len(a), covB = al.overlap / len(b);
  if (covA >= 0.9 && covB >= 0.9) return { kind: 'same' };
  if (covA >= 0.9 && len(b) > len(a)) return { kind: 'contains', longer: 'b', at: Math.max(0, al.offset) * STEP };
  if (covB >= 0.9 && len(a) > len(b)) return { kind: 'contains', longer: 'a', at: Math.max(0, -al.offset) * STEP };
  if (al.overlap < MIN_OVERLAP) return null;
  const from = Math.max(0, -al.offset), to = Math.min(len(a), len(b) - al.offset);   // overlap, in a's samples
  // a then b: a's overlap runs to its end, b's starts at its beginning (offset < 0: b's sample 0 is a's sample -offset).
  if (to >= len(a) - 2 && from + al.offset <= 2) return { kind: 'overlap', first: 'a', cut: Math.max(0, (len(a) + al.offset)) * STEP, overlapSec: al.overlap * STEP };
  // b then a: b's overlap runs to its end, a's starts at its beginning.
  if (from <= 2 && to + al.offset >= len(b) - 2) return { kind: 'overlap', first: 'b', cut: Math.max(0, len(b) - al.offset) * STEP, overlapSec: al.overlap * STEP };
  return null;
}

// ---------- the whole library ----------

export interface Pair { a: number; b: number; rel: Relation; ratio: number }

/** Every related pair of videos (indexes into `fps`), found through shared hash bands, then checked in full. */
export function findPairs(fps: Fingerprint[]): Pair[] {
  const buckets = new Map<number, number[]>();   // band key → [video, sample, video, sample, …]
  fps.forEach((f, v) => {
    for (let i = 0; i < len(f); i++) {
      if (f.blank[i]) continue;
      const hi = f.hashes[i * 2], lo = f.hashes[i * 2 + 1];
      const bands = [hi >>> 16, hi & 0xffff, lo >>> 16, lo & 0xffff];
      for (let k = 0; k < 4; k++) {
        const key = k * 65536 + bands[k];
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        if (list.length < BUSY_BUCKET * 2 + 2) list.push(v, i);
      }
    }
  });
  // Votes: for two videos, how many samples agree on each offset.
  const votes = new Map<number, Map<number, number>>();   // a * N + b → offset → votes
  const N = fps.length;
  for (const list of buckets.values()) {
    if (list.length < 4 || list.length > BUSY_BUCKET * 2) continue;
    for (let x = 0; x < list.length; x += 2) for (let y = x + 2; y < list.length; y += 2) {
      let va = list[x], ia = list[x + 1], vb = list[y], ib = list[y + 1];
      if (va === vb) continue;
      if (va > vb) { [va, vb] = [vb, va]; [ia, ib] = [ib, ia]; }
      const key = va * N + vb;
      let m = votes.get(key);
      if (!m) votes.set(key, (m = new Map()));
      const off = ib - ia;
      m.set(off, (m.get(off) ?? 0) + 1);
    }
  }
  const pairs: Pair[] = [];
  for (const [key, m] of votes) {
    const a = Math.floor(key / N), b = key % N;
    const best = [...m].sort((p, q) => q[1] - p[1]).slice(0, 3).filter(([, n]) => n >= 3);
    let top: Alignment | null = null;
    for (const [off] of best) for (const o of [off - 1, off, off + 1]) {
      const al = align(fps[a], fps[b], o);
      if (!top || al.matched > top.matched) top = al;
    }
    if (!top) continue;
    const rel = relate(fps[a], fps[b], top);
    if (rel) pairs.push({ a, b, rel, ratio: top.ratio });
  }
  return pairs;
}

// ---------- what to do ----------

export interface VideoFacts { path: string; size: number; duration: number; width: number; height: number; exactOf?: number }
export interface SameGroup { members: number[]; keep: number | null; exact: boolean }   // keep null = you choose
export interface Longer { longer: number; shorter: number; at: number }
export interface Combine { first: number; second: number; cut: number; overlapSec: number }
export interface DupePlan { same: SameGroup[]; longer: Longer[]; combine: Combine[] }

const quality = (v: VideoFacts) => Math.min(v.width, v.height);
const bitrate = (v: VideoFacts) => (v.duration > 0 ? v.size / v.duration : v.size);

/** Which copy is clearly the best (bigger picture, or the same picture at a clearly higher bitrate); null = too close. */
export function bestOf(vs: VideoFacts[], members: number[]): number | null {
  const sorted = [...members].sort((x, y) => quality(vs[y]) - quality(vs[x]) || bitrate(vs[y]) - bitrate(vs[x]));
  const [p, q] = [vs[sorted[0]], vs[sorted[1]]];
  if (!q) return sorted[0];
  if (quality(p) > quality(q)) return sorted[0];
  return bitrate(p) > bitrate(q) * 1.15 ? sorted[0] : null;   // same size of picture: only a clearly better copy wins
}

/**
 * Groups of the same video (exact copies, renamed, other quality), longer versions and parts to combine.
 * `exact` lists index pairs whose files are byte-for-byte the same.
 */
export function planDupes(vs: VideoFacts[], pairs: Pair[], exact: [number, number][]): DupePlan {
  const parent = vs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { const x = find(a), y = find(b); if (x !== y) parent[y] = x; };
  const exactSet = new Set<number>();
  for (const [a, b] of exact) { join(a, b); exactSet.add(a); exactSet.add(b); }
  for (const p of pairs) if (p.rel.kind === 'same') join(p.a, p.b);
  const groups = new Map<number, number[]>();
  vs.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const same: SameGroup[] = [];
  const rep = new Map<number, number>();         // video → the one standing for its group
  for (const members of groups.values()) {
    if (members.length < 2) { rep.set(members[0], members[0]); continue; }
    const keep = bestOf(vs, members);
    same.push({ members, keep, exact: members.every(m => exactSet.has(m)) });
    const r = keep ?? [...members].sort((x, y) => quality(vs[y]) - quality(vs[x]) || bitrate(vs[y]) - bitrate(vs[x]))[0];
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
    if (p.rel.kind === 'contains') longer.push(p.rel.longer === 'a' ? { longer: a, shorter: b, at: p.rel.at } : { longer: b, shorter: a, at: p.rel.at });
    else combine.push(p.rel.first === 'a' ? { first: a, second: b, cut: p.rel.cut, overlapSec: p.rel.overlapSec } : { first: b, second: a, cut: p.rel.cut, overlapSec: p.rel.overlapSec });
  }
  return { same, longer, combine };
}
