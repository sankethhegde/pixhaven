// 1.0.8: where each video was left, for the red line under video thumbnails (like a video site). Asked for in
// batches as thumbnails come on screen; kept up to date while the player saves its place.
import { useEffect, useState } from 'react';
import { api } from './api';

type Pos = { position: number; duration: number };
const known = new Map<string, Pos | null>();     // null: asked, never watched
const asking = new Set<string>();
const subs = new Set<() => void>();
const changed = () => { for (const f of subs) f(); };

api.onPositions(p => { for (const [k, v] of Object.entries(p)) known.set(k, v); changed(); });

let queue: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
/** Asks for the places of these videos (once each), together a moment later. */
export function want(paths: string[]): void {
  for (const p of paths) if (!known.has(p) && !asking.has(p)) { asking.add(p); queue.push(p); }
  if (!queue.length || timer) return;
  timer = setTimeout(() => {
    const batch = queue; queue = []; timer = null;
    void api.player.positions(batch).then(r => {
      for (const p of batch) { known.set(p, r[p] ?? null); asking.delete(p); }
      changed();
    }).catch(() => { for (const p of batch) asking.delete(p); });
  }, 60);
}
/** 0–1 of the video watched, or null if never started. */
export function watched(path: string): number | null {
  const p = known.get(path);
  return p ? Math.min(1, p.position / p.duration) : null;
}
/** Redraws when places change. */
export function usePositions(): void {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set(n => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
}
