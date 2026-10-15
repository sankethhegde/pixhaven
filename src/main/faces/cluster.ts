// Groups face fingerprints into people (FACE-03). Average-linkage clustering on cosine similarity,
// computed through cluster sums so it scales to 10,000+ photos:
//   avg similarity(face x, cluster C)   = x · ΣC / |C|
//   avg similarity(cluster A, cluster B) = ΣA · ΣB / (|A| |B|)
// Two faces from the same photo are never the same person. "Anchor" people (named, edited or
// already applied by the user) keep their faces; new faces can join them but anchors never merge.
// v2.2: weak faces (small, blurry, dark or turned away — quality below WEAK) don't take part in building the groups:
// their fingerprints look alike whoever they are, so they used to pull unrelated people into one folder. Afterwards
// each joins a group only when it is clearly that person (well above the threshold, and well ahead of the next
// best); otherwise it stays unassigned and its photo is left where it is ("Couldn't recognise").

export interface ClusterFace { id: number; imageId: number; emb: Float32Array; anchor?: number | null; quality?: number }

export const WEAK = 0.3;
const WEAK_EXTRA = 0.05;     // a weak face needs threshold + this…
const WEAK_LEAD = 0.07;      // …and this much more than its second-best group
export interface ClusterResult { groups: { anchor: number | null; faceIds: number[] }[] }

interface Group { anchor: number | null; sum: Float32Array; n: number; faces: number[]; images: Set<number>; alive: boolean }

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const add = (s: Float32Array, v: Float32Array) => { for (let i = 0; i < s.length; i++) s[i] += v[i]; };

export function cluster(faces: ClusterFace[], threshold: number): ClusterResult {
  if (!faces.length) return { groups: [] };
  const D = faces[0].emb.length;
  const groups: Group[] = [];
  const byAnchor = new Map<number, Group>();

  // 1. Anchors keep their own faces.
  for (const f of faces) {
    if (f.anchor == null) continue;
    let g = byAnchor.get(f.anchor);
    if (!g) { g = { anchor: f.anchor, sum: new Float32Array(D), n: 0, faces: [], images: new Set(), alive: true }; byAnchor.set(f.anchor, g); groups.push(g); }
    add(g.sum, f.emb); g.n++; g.faces.push(f.id); g.images.add(f.imageId);
  }

  // 2. Greedy pass: each free face joins the closest group on average, if close enough and not already in its photo.
  const weak = (f: ClusterFace) => (f.quality ?? 1) < WEAK;
  for (const f of faces) {
    if (f.anchor != null || weak(f)) continue;
    let best: Group | null = null, bestSim = threshold;
    for (const g of groups) {
      if (g.images.has(f.imageId)) continue;
      const sim = dot(f.emb, g.sum) / g.n;
      if (sim >= bestSim) { bestSim = sim; best = g; }
    }
    if (!best) { best = { anchor: null, sum: new Float32Array(D), n: 0, faces: [], images: new Set(), alive: true }; groups.push(best); }
    add(best.sum, f.emb); best.n++; best.faces.push(f.id); best.images.add(f.imageId);
  }

  // 3. Merge sweeps (average linkage): join the closest pairs above the threshold until none are left.
  for (let sweep = 0; sweep < 50; sweep++) {
    const live = groups.filter(g => g.alive);
    const pairs: [number, Group, Group][] = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.anchor != null && b.anchor != null) continue;
      const sim = dot(a.sum, b.sum) / (a.n * b.n);
      if (sim >= threshold) pairs.push([sim, a, b]);
    }
    if (!pairs.length) break;
    pairs.sort((p, q) => q[0] - p[0]);
    const touched = new Set<Group>();
    let merged = 0;
    for (const [, a, b] of pairs) {
      if (touched.has(a) || touched.has(b) || !a.alive || !b.alive) continue;
      if ([...b.images].some(i => a.images.has(i))) continue;
      const [into, from] = a.anchor != null ? [a, b] : b.anchor != null ? [b, a] : a.n >= b.n ? [a, b] : [b, a];
      add(into.sum, from.sum); into.n += from.n; into.faces.push(...from.faces);
      for (const i of from.images) into.images.add(i);
      from.alive = false;
      touched.add(into); touched.add(from);
      merged++;
    }
    if (!merged) break;
  }

  // 4. Weak faces: only clear matches join.
  const live = groups.filter(g => g.alive && g.n > 0);
  for (const f of faces) {
    if (f.anchor != null || !weak(f)) continue;
    let best: Group | null = null, b1 = -1, b2 = -1;
    for (const g of live) {
      if (g.images.has(f.imageId)) continue;
      const sim = dot(f.emb, g.sum) / g.n;
      if (sim > b1) { b2 = b1; b1 = sim; best = g; } else if (sim > b2) b2 = sim;
    }
    if (best && b1 >= threshold + WEAK_EXTRA && b1 - b2 >= WEAK_LEAD) { best.faces.push(f.id); best.images.add(f.imageId); }
  }

  return { groups: live.map(g => ({ anchor: g.anchor, faceIds: g.faces })) };
}
