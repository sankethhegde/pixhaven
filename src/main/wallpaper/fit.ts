// v2.10 Wallpaper recommended: does a photo make a good wallpaper for this screen? It must cover the screen (scaled to
// fill it, as Windows' "Fill" does) without being stretched more than the screen needs, and be nearly the screen's
// shape, so little is cropped away. Slightly too small photos can be upscaled first (2× or 4×). No Electron imports.

export interface Screen { width: number; height: number }       // physical pixels
export interface Fit { kind: 'ready' | 'upscale'; crop: number; scale: number; upscale: 1 | 2 | 4 }

/** Up to this share of the photo may be cut off to fill the screen (16:9 photo on a 16:10 screen: 10%). */
export const MAX_CROP = 0.22;

/** null: not a wallpaper for this screen (wrong shape, or too small even after a 4× upscale). */
export function fit(w: number, h: number, s: Screen): Fit | null {
  if (!w || !h || !s.width || !s.height) return null;
  const r = s.width / s.height, p = w / h;
  const crop = 1 - Math.min(p / r, r / p);
  if (crop > MAX_CROP) return null;
  // How much the photo is enlarged to cover the screen (1 or less: it has enough pixels).
  const scale = Math.max(s.width / w, s.height / h);
  if (scale <= 1.02) return { kind: 'ready', crop, scale, upscale: 1 };
  if (scale <= 2) return { kind: 'upscale', crop, scale, upscale: 2 };
  if (scale <= 4) return { kind: 'upscale', crop, scale, upscale: 4 };
  return null;
}

/** Best first: least cropped, then sharpest. */
export function rank<T extends { fit: Fit; sharp: number }>(list: T[]): T[] {
  return [...list].sort((a, b) => (Math.round(a.fit.crop * 50) - Math.round(b.fit.crop * 50)) || b.sharp - a.sharp);
}

/** "16:10" from a screen size. */
export function aspectName(w: number, h: number): string {
  const known: [string, number][] = [['16:9', 16 / 9], ['16:10', 16 / 10], ['3:2', 3 / 2], ['4:3', 4 / 3], ['21:9', 64 / 27], ['32:9', 32 / 9], ['5:4', 5 / 4]];
  const r = Math.max(w, h) / Math.min(w, h);
  const hit = known.find(([, v]) => Math.abs(v - r) < 0.02);
  const name = hit?.[0] ?? `${(r).toFixed(2)}:1`;
  return h > w ? name.split(':').reverse().join(':') : name;
}
