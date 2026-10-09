// Labels, stars and playlists in the UI: one shared store, so the grid, list, viewer, player and filters always agree.
// v2.1: photos get labels and stars too (TAG-09).
import { useEffect, useState } from 'react';
import type { LabelInfo, MediaEntry, MediaTags, Playlist, TagFilter } from '@shared/types';
import { mediaKind } from '@shared/types';
import { api, type TagUpdate } from './api';

type Ref = { path: string; size: number; mtime: number };
const state = { labels: [] as LabelInfo[], playlists: [] as Playlist[], tags: new Map<string, MediaTags>(), refs: new Map<string, Ref>(), version: 0 };
const listeners = new Set<() => void>();
const changed = () => { state.version++; listeners.forEach(l => l()); };
const key = (p: string) => (navigator.userAgent.includes('Windows') ? p.toLowerCase() : p);

/** Re-renders the component whenever labels, stars or playlists change anywhere. */
export function useTags() {
  const [, set] = useState(0);
  useEffect(() => { const l = () => set(v => v + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  return { labels: state.labels, playlists: state.playlists, version: state.version, tagsOf, label: (id: number) => state.labels.find(l => l.id === id) };
}
export const tagsOf = (p: string): MediaTags | undefined => state.tags.get(key(p));
export const ref = (e: MediaEntry | Ref): Ref => ({ path: e.path, size: e.size, mtime: e.mtime });

function apply(u: TagUpdate, paths: string[]) {
  state.labels = u.labels;
  put(u.tags, paths);
  changed();
}
function put(tags: Record<string, MediaTags>, paths: string[]) {
  for (const p of paths) { const t = tags[p]; if (t) state.tags.set(key(p), t); else state.tags.delete(key(p)); }
}

export async function loadLabels() { state.labels = await api.tags.labels(); changed(); }

/** Tags for the files on screen (also re-links files renamed or moved outside the app). */
export async function loadFor(files: Ref[]) {
  const list = files.filter(f => taggable(f.path));
  if (!list.length) return;
  for (const f of list) state.refs.set(key(f.path), ref(f));
  const r = await api.tags.forFiles(list);
  put(r.tags, list.map(f => f.path));
  changed();
}
/** Tags that came with a query result (watched folders): no extra round trip. */
export function known(tags: Record<string, MediaTags>, files: Ref[]) {
  for (const f of files) state.refs.set(key(f.path), ref(f));
  put(tags, files.map(f => f.path));
  changed();
}

export async function setStars(files: Ref[], stars: number) { apply(await api.tags.setStars(files, stars), files.map(f => f.path)); }
export async function addLabel(files: Ref[], name: string, color: string | null = null) { apply(await api.tags.addLabel(files, name, color), files.map(f => f.path)); }
export async function removeLabel(paths: string[], id: number) { apply(await api.tags.removeLabel(paths, id), paths); }
export async function renameLabel(id: number, name: string) { const r = await api.tags.renameLabel(id, name); state.labels = r.labels; await reloadAll(); return r; }
export async function setColor(id: number, color: string | null) { state.labels = await api.tags.setColor(id, color); changed(); }
export async function deleteLabel(id: number) { state.labels = await api.tags.deleteLabel(id); await reloadAll(); }

/** After a label rename/merge/delete, an import or files re-linked in the background: refresh what we hold. */
export async function reloadAll() {
  state.labels = await api.tags.labels();
  state.playlists = await api.tags.playlists();
  const refs = [...state.refs.values()];
  state.tags.clear();
  changed();
  for (let i = 0; i < refs.length; i += 2000) await loadFor(refs.slice(i, i + 2000));
}
/** A file renamed or moved by the app: its tags move with it. */
export function movedLocally(from: string, to: string) {
  const t = state.tags.get(key(from));
  const r = state.refs.get(key(from));
  state.tags.delete(key(from)); state.refs.delete(key(from));
  if (t) state.tags.set(key(to), t);
  if (r) state.refs.set(key(to), { ...r, path: to });
  changed();
}

// ---------- playlists: saved filters (PLAY-08) ----------
export async function loadPlaylists() { state.playlists = await api.tags.playlists(); changed(); }
export async function savePlaylist(name: string, filter: TagFilter, id?: number) { state.playlists = await api.tags.savePlaylist(name, filter, id); changed(); }
export async function deletePlaylist(id: number) { state.playlists = await api.tags.deletePlaylist(id); changed(); }

export const isVideo = (p: string) => mediaKind(p) === 'video';
export const taggable = (p: string) => mediaKind(p) !== null;
