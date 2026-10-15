// Groups face fingerprints into people (FACE-03). Average-linkage clustering on cosine similarity,
// computed through cluster sums so it scales to 10,000+ photos:
//   avg similarity(face x, cluster C)   = x · ΣC / |C|
//   avg similarity(cluster A, cluster B) = ΣA · ΣB / (|A| |B|)
// "Anchor" people (edited or already applied by the user) keep their faces; new faces can join them but anchors
// never merge.
// v2.2: weak faces (small, blurry, dark or turned away — quality below WEAK) don't take part in building the groups:
// their fingerprints look alike whoever they are, so they used to pull unrelated people into one folder. Afterwards
// each joins a group only when it is clearly that person (well above the threshold, and well ahead of the next
// best); otherwise it stays unassigned and its photo is left where it is ("Couldn't recognise").
// v2.2.1, from a real folder where one person had been split into 35 groups:
//  • Nearest-face linkage: a big group holds very different looks of one person (filters, make-up, angles), so its
//    average sits far from each of them. Two groups also count as close when the faces of the smaller one are, on
//    average, close to their KNN nearest faces in the bigger one (minus KNN_PENALTY, so this needs a clearer match).
//  • The same person twice in one photo (collages, mirror selfies) is allowed when the faces clearly match
//    (threshold + SAME_PHOTO); before, one collage kept two groups of the same person apart for good.

export interface ClusterFace { id: number; imageId: number; emb: Float32Array; anchor?: number | null; quality?: number }

export const WEAK = 0.3;
const WEAK_EXTRA = 0.05;     // a weak face needs threshold + this…
const WEAK_LEAD = 0.07;      // …and this much more than its second-best group
const KNN = 5;
const KNN_PENALTY = 0.05;
const SAME_PHOTO = 0.1;
const CLASH_SHARE = 0.2;     // groups sharing up to this share of photos may still merge (collages)
const ORPHAN_BELOW = 0.04;   // a leftover face joins a person at threshold − this (nearest 3 faces)…
const ORPHAN_LEAD = 0.1;     // …when that person is clearly closer than anyone else
export interface ClusterResult { groups: { anchor: number | null; faceIds: number[] }[] }

interface Group { anchor: number | null; sum: Float32Array; n: number; faces: number[]; members: Float32Array[]; images: Map<number, number>; alive: boolean }

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const add = (s: Float32Array, v: Float32Array) => { for (let i = 0; i < s.length; i++) s[i] += v[i]; };

/** Mean similarity of a face to its KNN nearest faces in a group. */
function nearest(e: Float32Array, g: Group): number {
  const top: number[] = [];
  for (const m of g.members) {
    const s = dot(e, m);
    if (top.length < KNN) { top.push(s); top.sort((a, b) => a - b); } else if (s > top[0]) { top[0] = s; top.sort((a, b) => a - b); }
  }
  return top.reduce((a, b) => a + b, 0) / (top.length || 1);
}

/** How close two groups are: average linkage, or (for clear matches) nearest-face linkage. */
function linkage(a: Group, b: Group, threshold: number): number {
  const avg = dot(a.sum, b.sum) / (a.n * b.n);
  if (avg < threshold - 0.3) return avg;                 // far apart: skip the costlier check
  const [small, big] = a.n <= b.n ? [a, b] : [b, a];
  let t = 0;
  for (const m of small.members) t += nearest(m, big);
  return Math.max(avg, t / small.members.length - KNN_PENALTY);
}

export function cluster(faces: ClusterFace[], threshold: number): ClusterResult {
  if (!faces.length) return { groups: [] };
  const D = faces[0].emb.length;
  const groups: Group[] = [];
  const byAnchor = new Map<number, Group>();
  const byId = new Map(faces.map(f => [f.id, f]));
  const newGroup = (anchor: number | null): Group => ({ anchor, sum: new Float32Array(D), n: 0, faces: [], members: [], images: new Map(), alive: true });
  const put = (g: Group, f: ClusterFace) => { add(g.sum, f.emb); g.n++; g.faces.push(f.id); g.members.push(f.emb); g.images.set(f.imageId, (g.images.get(f.imageId) ?? 0) + 1); };

  // 1. Anchors keep their own faces.
  for (const f of faces) {
    if (f.anchor == null) continue;
    let g = byAnchor.get(f.anchor);
    if (!g) { g = newGroup(f.anchor); byAnchor.set(f.anchor, g); groups.push(g); }
    put(g, f);
  }

  // 2. Greedy pass: each free face joins the closest group on average, if close enough. A group that already has a
  //    face from this photo needs a clearly closer match (the same person twice in a collage or mirror selfie).
  const weak = (f: ClusterFace) => (f.quality ?? 1) < WEAK;
  for (const f of faces) {
    if (f.anchor != null || weak(f)) continue;
    let best: Group | null = null, bestSim = threshold;
    for (const g of groups) {
      const sim = dot(f.emb, g.sum) / g.n;
      if (g.images.has(f.imageId) && sim < threshold + SAME_PHOTO) continue;
      if (sim >= bestSim) { bestSim = sim; best = g; }
    }
    if (!best) { best = newGroup(null); groups.push(best); }
    put(best, f);
  }

  // 3. Merge sweeps: join the closest pairs above the threshold until none are left.
  for (let sweep = 0; sweep < 100; sweep++) {
    const live = groups.filter(g => g.alive);
    const pairs: [number, Group, Group][] = [];
    for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.anchor != null && b.anchor != null) continue;
      const sim = linkage(a, b, threshold);
      if (sim < threshold) continue;
      // Photos both groups have a face in: fine for a clear match or a few collages, otherwise two people.
      let clash = 0;
      for (const im of b.images.keys()) if (a.images.has(im)) clash++;
      if (clash && sim < threshold + SAME_PHOTO && clash > CLASH_SHARE * Math.min(a.images.size, b.images.size)) continue;
      pairs.push([sim, a, b]);
    }
    if (!pairs.length) break;
    pairs.sort((p, q) => q[0] - p[0]);
    const touched = new Set<Group>();
    let merged = 0;
    for (const [, a, b] of pairs) {
      if (touched.has(a) || touched.has(b) || !a.alive || !b.alive) continue;
      const [into, from] = a.anchor != null ? [a, b] : b.anchor != null ? [b, a] : a.n >= b.n ? [a, b] : [b, a];
      add(into.sum, from.sum); into.n += from.n; into.faces.push(...from.faces); into.members.push(...from.members);
      for (const [i, c] of from.images) into.images.set(i, (into.images.get(i) ?? 0) + c);
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
      const sim = Math.max(dot(f.emb, g.sum) / g.n, nearest(f.emb, g) - KNN_PENALTY);
      if (sim > b1) { b2 = b1; b1 = sim; best = g; } else if (sim > b2) b2 = sim;
    }
    if (best && b1 >= threshold + WEAK_EXTRA && b1 - b2 >= WEAK_LEAD) { best.faces.push(f.id); best.images.set(f.imageId, 1); }
  }

  // 5. Leftovers: a face alone in its group, or a weak face still unassigned, joins a person with 2+ photos when its
  //    nearest faces there are close (threshold − ORPHAN_BELOW) and that person is clearly closer than any other
  //    (ORPHAN_LEAD ahead). On a real folder different people never came closer than 0.29 this way, while one-off
  //    photos of a known person (filters, turned heads) scored 0.31–0.39 with nobody else above 0.24.
  const near3 = (e: Float32Array, g: Group) => {
    const s = g.members.map(m => dot(e, m)).sort((a, b) => b - a).slice(0, 3);
    return s.reduce((a, b) => a + b, 0) / (s.length || 1);
  };
  const people = live.filter(g => g.images.size >= 2 && g.members.length);
  const placed = new Set(live.flatMap(g => g.faces));
  const leftovers: { f: ClusterFace; from: Group | null }[] = [
    ...live.filter(g => g.images.size < 2 && g.anchor == null).flatMap(g => g.faces.map(id => ({ f: byId.get(id)!, from: g }))),
    ...faces.filter(f => f.anchor == null && !placed.has(f.id)).map(f => ({ f, from: null })),
  ];
  for (const { f, from } of leftovers) {
    let best: Group | null = null, b1 = -1, b2 = -1;
    for (const g of people) {
      if (g === from) continue;
      const sim = near3(f.emb, g);
      if (sim > b1) { b2 = b1; b1 = sim; best = g; } else if (sim > b2) b2 = sim;
    }
    if (!best || best.images.has(f.imageId) || b1 < threshold - ORPHAN_BELOW || b1 - b2 < ORPHAN_LEAD) continue;
    best.faces.push(f.id); best.images.set(f.imageId, 1);
    if (from) { from.faces = from.faces.filter(id => id !== f.id); from.n--; }
  }

  return { groups: live.filter(g => g.faces.length).map(g => ({ anchor: g.anchor, faceIds: g.faces })) };
}
