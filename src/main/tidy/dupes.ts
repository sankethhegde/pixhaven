// Find duplicates (identical files, or the same picture resized/re-saved) and blurry photos. Pure logic.

export interface TidyPhoto {
  id: number; path: string; size: number; sha1: string; dhash: string; blur: number; width: number; height: number;
}
export interface DupGroup { kind: 'exact' | 'similar'; keep: number; photos: TidyPhoto[] }

const POP = Uint8Array.from({ length: 256 }, (_, i) => { let n = 0; for (let v = i; v; v >>= 1) n += v & 1; return n; });
export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < 16; i += 2) d += POP[parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)];
  return d;
}

/** Which copy to keep: most pixels, then sharpest, then largest file, then the shortest / first name. */
export function bestOf(photos: TidyPhoto[]): TidyPhoto {
  return [...photos].sort((a, b) =>
    b.width * b.height - a.width * a.height || b.blur - a.blur || b.size - a.size ||
    a.path.length - b.path.length || a.path.localeCompare(b.path))[0];
}

/**
 * maxDistance (bits of the 64-bit dHash that may differ): 0 = identical files only; ~6 = the same picture
 * resized or re-saved; ~12 = also near-identical shots taken a moment apart. Identical files always group.
 */
export function findDuplicates(photos: TidyPhoto[], maxDistance: number): DupGroup[] {
  const parent = photos.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const bySha = new Map<string, number>();
  photos.forEach((p, i) => { const j = bySha.get(p.sha1); if (j === undefined) bySha.set(p.sha1, i); else join(j, i); });
  if (maxDistance > 0) {
    for (let i = 0; i < photos.length; i++) for (let j = i + 1; j < photos.length; j++) {
      if (find(i) === find(j)) continue;
      // Clearly different shapes (a crop, portrait vs landscape) are not "the same picture".
      const ra = photos[i].width / photos[i].height, rb = photos[j].width / photos[j].height;
      if (Math.abs(ra - rb) > 0.08 * Math.max(ra, rb)) continue;
      if (hamming(photos[i].dhash, photos[j].dhash) <= maxDistance) join(i, j);
    }
  }
  const groups = new Map<number, TidyPhoto[]>();
  photos.forEach((p, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(p); else groups.set(r, [p]);
  });
  return [...groups.values()].filter(g => g.length > 1).map(g => ({
    kind: (new Set(g.map(p => p.sha1)).size === 1 ? 'exact' : 'similar') as DupGroup['kind'],
    keep: bestOf(g).id,
    photos: g.sort((a, b) => a.path.localeCompare(b.path)),
  })).sort((a, b) => b.photos.length - a.photos.length || a.photos[0].path.localeCompare(b.photos[0].path));
}

/** Blurry: sharpness score (sharpest tile's Laplacian variance at 512 px) below the threshold, blurriest first. */
export const findBlurry = (photos: TidyPhoto[], threshold: number) =>
  photos.filter(p => p.blur < threshold).sort((a, b) => a.blur - b.blur);
