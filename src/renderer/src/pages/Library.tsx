// Media library: browse every drive, see only photos and videos with thumbnails, search by name, open the viewer or
// player, send photos to Upscale or a folder to Sort by person (v2.0 Phase A/B). Phase C: labels and stars, filters
// (all of / any of, minimum stars), a view of everything labelled across drives, and rename / move in the app.
// v2.1: labels and stars on photos too, playlists (saved filters, "Play all"), watched folders (indexed in the
// background: instant search and filters without browsing, live updates) and keyboard shortcuts.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { DriveInfo, FolderListing, LibrarySettings, MediaEntry, MediaInfo, Playlist, SearchUpdate, Settings, TaggedMedia, TagFilter, WatchedFolder } from '@shared/types';
import { IMAGE_EXTENSIONS } from '@shared/types';
import { api, errorText } from '../api';
import { FolderTree } from '../components/FolderTree';
import { MediaGrid } from '../components/MediaGrid';
import { Viewer } from '../components/Viewer';
import { Player } from '../components/Player';
import { FilterBar, ManageLabels, NO_FILTER, TagEditor, filterActive, noun } from '../components/Tags';
import { ShortcutsDialog } from '../components/Shortcuts';
import { Button, Icon, Notice, Segmented } from '../components/ui';
import * as T from '../tags';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  active: boolean;
  initialDir: string | null;
  onConsumedInitial: () => void;
  initialPlay: string | null;        // a video to start once its folder is open (Home → recently played)
  onPlayed: () => void;
  onUpscale: (paths: string[]) => void;
  onSort: (folder: string) => void;
}

interface Search { id: number; root: string; query: string; items: MediaEntry[]; scanned: number; done: boolean; truncated?: boolean; indexed?: boolean }
type Mode = 'folder' | 'tagged' | 'watched';

const ext = (n: string) => n.slice(n.lastIndexOf('.') + 1).toLowerCase();
const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const WIN = navigator.userAgent.includes('Windows');
const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (p: string, dir: string) => { const d = dir.replace(/[\\/]+$/, ''); return same(p, d) || (WIN ? p.toLowerCase() : p).startsWith((WIN ? d.toLowerCase() : d) + sep(d)); };
const offline = (e: MediaEntry) => !!(e as TaggedMedia).offline;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/** Does this entry pass the label / star filter? (TAG-05) */
function matches(e: MediaEntry, f: TagFilter): boolean {
  if (!filterActive(f)) return true;
  if (e.kind === 'folder') return false;
  const t = T.tagsOf(e.path);
  if (!t || t.stars < f.minStars) return false;
  if (!f.labels.length) return true;
  return f.mode === 'all' ? f.labels.every(l => t.labels.includes(l)) : f.labels.some(l => t.labels.includes(l));
}
const sameFilter = (a: TagFilter, b: TagFilter) => a.mode === b.mode && a.minStars === b.minStars && a.labels.length === b.labels.length && a.labels.every(l => b.labels.includes(l));

function shuffle<X>(list: X[]): X[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function Library({ settings, onSettings, active, initialDir, onConsumedInitial, initialPlay, onPlayed, onUpscale, onSort }: Props) {
  const lib = settings.library;
  const { labels, playlists, version } = T.useTags();
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [hasMedia, setHasMedia] = useState<Record<string, boolean | null>>({});
  const infos = useRef(new Map<string, MediaInfo>());
  const [, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<Search | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openMs, setOpenMs] = useState<number | null>(null);
  // Phase C
  const [mode, setMode] = useState<Mode>('folder');
  const [tagged, setTagged] = useState<TaggedMedia[] | null>(null);
  const [filter, setFilter] = useState<TagFilter>(NO_FILTER);
  const [showFilter, setShowFilter] = useState(false);
  const [tagPanel, setTagPanel] = useState(false);
  const [manage, setManage] = useState(false);
  const [rename, setRename] = useState<{ path: string; name: string; error?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [allLabels, setAllLabels] = useState(false);
  // v2.1
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [savePl, setSavePl] = useState<{ name: string; error?: string } | null>(null);
  const [playing, setPlaying] = useState<{ items: MediaEntry[]; index: number; name: string } | null>(null);
  const [watched, setWatched] = useState<WatchedFolder[]>([]);
  const [watchRoot, setWatchRoot] = useState<string | null>(null);
  const [watchTotal, setWatchTotal] = useState<{ total: number; truncated: boolean } | null>(null);
  const [watchTick, setWatchTick] = useState(0);
  const [focus, setFocus] = useState<number | null>(null);
  const cols = useRef(1);
  const [help, setHelp] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);
  const modeRef = useRef(mode); modeRef.current = mode;
  const dirRef = useRef(dir); dirRef.current = dir;

  const setLib = useCallback(async (patch: Partial<LibrarySettings>) => {
    onSettings(await api.setSettings({ library: { ...settings.library, ...patch } }));
  }, [settings.library, onSettings]);
  const mergeHasMedia = useCallback((m: Record<string, boolean | null>) => setHasMedia(h => ({ ...h, ...m })), []);

  useEffect(() => { void T.loadLabels(); void T.loadPlaylists(); }, []);
  // A label made elsewhere (another window of the app, an import, a playlist from a restore): fetch the list again.
  const unknownLabel = [...filter.labels, ...playlists.flatMap(p => p.filter.labels)].some(id => !labels.some(l => l.id === id));
  useEffect(() => { if (unknownLabel) void T.loadLabels(); }, [unknownLabel]);

  // Thumbnails arrive one by one: collect them and redraw at most once a frame.
  useEffect(() => {
    let frame = 0;
    const off = api.onLibThumb(i => {
      infos.current.set(i.path, i);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick(t => t + 1); });
    });
    const offSearch = api.onLibSearch((u: SearchUpdate) => setSearch(s => s && s.id === u.id
      ? { ...s, items: s.items.concat(u.items), scanned: u.scanned, done: u.done, truncated: u.truncated, indexed: u.indexed } : s));
    return () => { off(); offSearch(); };
  }, []);

  // LIB-01: drive list, refreshed every few seconds while the page is open (a USB stick plugged in shows up).
  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => api.lib.drives().then(d => { if (live) setDrives(d); }).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => { live = false; clearInterval(t); };
  }, [active]);

  // LIB-08: watched folders — their indexing status, and files changing in them while the app is open.
  useEffect(() => {
    void api.watch.list().then(setWatched);
    const offStatus = api.onWatchStatus(setWatched);
    const offChange = api.onWatchChanged(c => {
      if (c.relinked) void T.reloadAll();
      setWatchTick(t => t + 1);
      const d = dirRef.current;
      if (modeRef.current === 'folder' && d && c.dirs.some(x => same(x, d))) void relist(d);
    });
    return () => { offStatus(); offChange(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The open folder changed on disk: show it again without losing the selection or scroll position. */
  const relist = async (d: string) => {
    const l = await api.lib.list(d).catch(() => null);
    if (!l || dirRef.current !== d || modeRef.current !== 'folder') return;
    setListing(l);
    void T.loadFor(l.entries.filter(e => e.kind !== 'folder').map(T.ref));
  };

  const resetView = () => { setSelected(new Set()); anchor.current = null; setTagPanel(false); setFocus(null); };

  const open = useCallback(async (target: string, how: 'push' | 'back' | 'fwd' | 'refresh' = 'push') => {
    setLoading(true); setError(null); setSearch(null); setQuery(''); resetView();
    void api.lib.cancelSearch();
    const t0 = performance.now();
    try {
      const l = await api.lib.list(target);
      setListing(l);
      setMode('folder'); setPlaylist(null);
      if (how === 'push' && dir && dir !== target) { setBack(b => [...b, dir]); setFwd([]); }
      setDir(target);
      setOpenMs(Math.round(performance.now() - t0));
      if (!l.denied && !l.error) void setLib({ lastDir: target });
      const folders = l.entries.filter(e => e.kind === 'folder').map(e => e.path);
      if (folders.length) api.lib.hasMedia(folders).then(mergeHasMedia);
      // Labels and stars of the photos and videos here (renamed or moved ones are found again by fingerprint).
      void T.loadFor(l.entries.filter(e => e.kind !== 'folder').map(T.ref));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [dir, setLib, mergeHasMedia]);

  // All labelled or rated photos and videos, from the database (any folder or drive).
  const loadTagged = useCallback(async (f: TagFilter, text: string) => {
    const rows = await api.tags.query(f, text);
    setTagged(rows);
    void T.loadFor(rows.map(T.ref));
  }, []);
  const showTagged = (f: TagFilter, pl: Playlist | null = null) => {
    setMode('tagged'); setFilter(f); setShowFilter(true); setSearch(null); setQuery(''); setPlaylist(pl); resetView();
    void loadTagged(f, '');
  };
  // Keep the labelled view current after edits (debounced).
  useEffect(() => {
    if (mode !== 'tagged') return;
    const t = setTimeout(() => void loadTagged(filter, query), 250);
    return () => clearTimeout(t);
  }, [mode, filter, query, version, loadTagged]);

  // Watched folders view: straight from the index, so names, type, labels and stars filter without browsing.
  const showWatched = (root: string | null) => {
    setMode('watched'); setWatchRoot(root); setSearch(null); setQuery(''); setPlaylist(null); setTagged(null); resetView();
  };
  const filterVersion = filterActive(filter) ? version : 0;
  useEffect(() => {
    if (mode !== 'watched') return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await api.watch.query({ text: query, type: lib.type, filter, root: watchRoot });
      if (!live) return;
      T.known(r.tags, r.items);
      setTagged(r.items);
      setWatchTotal({ total: r.total, truncated: r.truncated });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [mode, query, lib.type, filter, watchRoot, watchTick, filterVersion]);

  // First visit: the folder from Home / a test, else the last one, else Pictures.
  const started = useRef(false);
  useEffect(() => {
    if (initialDir) { void open(initialDir); onConsumedInitial(); started.current = true; return; }
    if (!active || started.current || !drives.length) return;
    started.current = true;
    const start = lib.lastDir ?? drives.find(d => d.name === 'Pictures')?.path;
    if (start) void open(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDir, active, drives.length]);

  const goBack = () => {
    if (mode !== 'folder') { if (dir) void open(dir, 'refresh'); else setMode('folder'); return; }
    const p = back[back.length - 1]; if (!p || !dir) return; setBack(back.slice(0, -1)); setFwd([dir, ...fwd]); void open(p, 'back');
  };
  const goFwd = () => { if (mode !== 'folder') return; const p = fwd[0]; if (!p || !dir) return; setFwd(fwd.slice(1)); setBack([...back, dir]); void open(p, 'fwd'); };
  const goUp = () => { if (mode === 'folder' && listing?.parent) void open(listing.parent); };
  const refresh = () => {
    if (mode === 'tagged') void loadTagged(filter, query);
    else if (mode === 'watched') setWatchTick(t => t + 1);
    else if (dir) void open(dir, 'refresh');
  };

  // What the grid shows: labelled files, a watched-folder query, search results, or this folder; filtered by type,
  // name, labels and stars.
  const items = useMemo(() => {
    const source: MediaEntry[] = mode !== 'folder' ? (tagged ?? []) : search ? search.items : (listing?.entries ?? []);
    const q = search || mode !== 'folder' ? [] : query.toLowerCase().split(/\s+/).filter(Boolean);
    const list = source.filter(e =>
      (e.kind === 'folder' ? hasMedia[e.path] !== false && (lib.type === 'all' || !search) && !filterActive(filter) : lib.type === 'all' || e.kind === lib.type) &&
      q.every(w => e.name.toLowerCase().includes(w)) && (e.kind === 'folder' || matches(e, filter)));
    const dirFirst = (a: MediaEntry, b: MediaEntry) => Number(b.kind === 'folder') - Number(a.kind === 'folder');
    const by = lib.sortBy === 'date' ? (a: MediaEntry, b: MediaEntry) => a.mtime - b.mtime
      : lib.sortBy === 'size' ? (a: MediaEntry, b: MediaEntry) => a.size - b.size
      : (a: MediaEntry, b: MediaEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return list.sort((a, b) => dirFirst(a, b) || (lib.sortDesc ? -by(a, b) : by(a, b)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, tagged, listing, search, query, hasMedia, lib.type, lib.sortBy, lib.sortDesc, filter, version]);
  const media = useMemo(() => items.filter(e => e.kind !== 'folder'), [items]);
  useEffect(() => { if (focus !== null && focus >= items.length) setFocus(items.length ? items.length - 1 : null); }, [items.length, focus]);
  useEffect(() => {
    if (!initialPlay || !listing) return;
    const i = media.findIndex(m => m.path === initialPlay);
    if (i >= 0) { setViewer(i); onPlayed(); }
    else if (!loading && listing.dir.toLowerCase() === initialPlay.replace(/[\\/][^\\/]*$/, '').toLowerCase()) onPlayed();   // not here any more
  }, [initialPlay, media, listing, loading, onPlayed]);

  // Thumbnails for what is on screen first, then the rest of the folder in the background.
  const onVisible = useCallback((first: number, last: number) => {
    const live = (e: MediaEntry) => e.kind !== 'folder' && !offline(e);
    const onScreen = items.slice(first, last + 1).filter(live);
    const rest = items.slice(last + 1).concat(items.slice(0, first)).filter(live).slice(0, 3000);
    api.lib.thumbs([...onScreen, ...rest].map(T.ref)).then(ready => {
      for (const i of ready) infos.current.set(i.path, i);
      if (ready.length) setTick(t => t + 1);
    }).catch(() => {});
  }, [items]);
  const onCols = useCallback((n: number) => { cols.current = n; }, []);

  const onItemClick = (i: number, e: MouseEvent) => {
    const p = items[i].path;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      for (let k = a; k <= b; k++) if (items[k].kind !== 'folder') next.add(items[k].path);
    } else {
      if (e.ctrlKey && next.has(p)) next.delete(p); else next.add(p);
      anchor.current = i;
    }
    setSelected(next);
    setFocus(i);
  };
  const onItemOpen = (i: number) => {
    const e = items[i];
    if (e.kind === 'folder') void open(e.path);
    else if (offline(e)) setNote(`“${e.name}” is on a drive that is not connected. Its labels and stars are kept until it is back.`);
    else setViewer(media.indexOf(e));
  };

  const startSearch = async () => {
    if (!dir || !query.trim() || mode !== 'folder') return;
    const id = await api.lib.search(dir, query.trim());
    setSearch({ id, root: dir, query: query.trim(), items: [], scanned: 0, done: false });
  };
  const endSearch = () => { void api.lib.cancelSearch(); setSearch(null); };

  // ---- PLAY-08: play the videos of a playlist or the labelled view, in order or shuffled ----
  const playableVideos = useMemo(() => items.filter(e => e.kind === 'video' && !offline(e)), [items]);
  const playAll = (mix: boolean) => {
    if (!playableVideos.length) return;
    setPlaying({ items: mix ? shuffle(playableVideos) : playableVideos, index: 0, name: playlist?.name ?? (mode === 'watched' ? 'Watched folders' : 'Labelled videos') });
  };
  const doSavePlaylist = async () => {
    if (!savePl) return;
    try {
      await T.savePlaylist(savePl.name, filter);
      const clean = savePl.name.trim().replace(/\s+/g, ' ').toLowerCase();
      const p = (await api.tags.playlists()).find(x => x.name.toLowerCase() === clean);
      setSavePl(null);
      if (p) { setPlaylist(p); if (mode !== 'tagged') showTagged(filter, p); }
      setNote(`Saved the playlist “${savePl.name.trim()}”. It stays up to date as you label and rate.`);
    } catch (e) { setSavePl({ ...savePl, error: errorText(e) }); }
  };

  // ---- rename and move inside the app (TAG-06: labels follow) ----
  const replaceEntry = (from: string, to: string | null) => {
    const swap = <E extends MediaEntry>(list: E[]) => to === null ? list.filter(e => e.path !== from)
      : list.map(e => e.path === from ? { ...e, path: to, name: baseName(to) } : e);
    setListing(l => l && { ...l, entries: swap(l.entries) });
    setTagged(t => t && swap(t));
    setSearch(s => s && { ...s, items: swap(s.items) });
  };
  const doRename = async () => {
    if (!rename) return;
    try {
      const to = await api.tags.renameFile(rename.path, rename.name);
      T.movedLocally(rename.path, to);
      replaceEntry(rename.path, to);
      setSelected(new Set([to]));
      setRename(null);
    } catch (e) { setRename({ ...rename, error: errorText(e) }); }
  };
  const doMove = async () => {
    const paths = [...selected].filter(p => items.some(e => e.path === p && e.kind !== 'folder' && !offline(e)));
    const r = await api.tags.moveFiles(paths);
    if (!r) return;
    for (const m of r.moved) {
      T.movedLocally(m.from, m.to);
      replaceEntry(m.from, mode === 'folder' ? null : m.to);   // gone from this folder; still listed in the other views
    }
    setSelected(new Set());
    setNote(`Moved ${r.moved.length} file${r.moved.length === 1 ? '' : 's'}${r.failed.length ? `; ${r.failed.length} could not be moved (${r.failed[0].reason})` : ''}.`);
  };

  const selectedEntries = items.filter(e => selected.has(e.path));
  const selectedPhotos = [...selected].filter(p => IMAGE_EXTENSIONS.includes(ext(p)));
  const selectedTaggable = selectedEntries.filter(e => e.kind !== 'folder' && !offline(e));

  // ---- keyboard (v2.1) ----
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (viewer !== null || playing || rename || manage || help || savePl) return;
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
      if ((e.key.toLowerCase() === 'f' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) { searchBox.current?.focus(); searchBox.current?.select(); e.preventDefault(); return; }
      if (typing) return;
      const n = items.length;
      const cur = focus ?? -1;
      const move = (to: number) => {
        if (!n) return;
        const i = Math.max(0, Math.min(n - 1, to));
        setFocus(i);
        if (e.shiftKey) {
          const a = anchor.current ?? Math.max(0, cur);
          const next = new Set<string>();
          for (let x = Math.min(a, i); x <= Math.max(a, i); x++) if (items[x].kind !== 'folder') next.add(items[x].path);
          setSelected(next);
          anchor.current = a;
        } else if (!e.ctrlKey) {
          setSelected(items[i].kind === 'folder' ? new Set() : new Set([items[i].path]));
          anchor.current = i;
        }
      };
      const targets = selectedTaggable.length ? selectedTaggable : cur >= 0 && items[cur]?.kind !== 'folder' && !offline(items[cur]) ? [items[cur]] : [];
      const key = e.key;
      if (key === 'a' && (e.ctrlKey || e.metaKey)) setSelected(new Set(items.filter(x => x.kind !== 'folder').map(x => x.path)));   // every photo and video shown
      else if (e.altKey && key === 'ArrowLeft') goBack();
      else if (e.altKey && key === 'ArrowRight') goFwd();
      else if (e.altKey && key === 'ArrowUp') goUp();
      else if (e.altKey || e.metaKey) return;
      else if (key === 'ArrowRight') move(cur + 1);
      else if (key === 'ArrowLeft') move(cur < 0 ? 0 : cur - 1);
      else if (key === 'ArrowDown') move(cur < 0 ? 0 : cur + cols.current);
      else if (key === 'ArrowUp') move(cur < 0 ? 0 : cur - cols.current);
      else if (key === 'Home') move(0);
      else if (key === 'End') move(n - 1);
      else if (key === 'Enter') { if (cur >= 0 && cur < n) onItemOpen(cur); }
      else if (key === ' ') {
        if (cur < 0 || items[cur]?.kind === 'folder') return;
        const next = new Set(selected); const p = items[cur].path;
        if (next.has(p)) next.delete(p); else next.add(p);
        setSelected(next); anchor.current = cur;
      }
      else if (key === 'Escape') { if (selected.size) { setSelected(new Set()); setTagPanel(false); } else if (search) endSearch(); else if (query) setQuery(''); else return; }
      else if (key === 'Backspace') goBack();
      else if (key === 'F5') refresh();
      else if (key === 'F2') {
        if (selected.size !== 1) return;
        const it = items.find(x => x.path === [...selected][0]);
        if (it && it.kind !== 'folder' && !offline(it)) setRename({ path: it.path, name: baseName(it.path) }); else return;
      }
      else if (key === '?') setHelp(true);
      else if ((key === 'l' || key === 'L') && !e.ctrlKey) { if (!selectedTaggable.length) return; setTagPanel(true); }
      else if ((key === 'p' || key === 'P') && !e.ctrlKey && mode !== 'folder') playAll(false);
      else if (/^[0-5]$/.test(key) && !e.ctrlKey) { if (!targets.length) return; void T.setStars(targets.map(T.ref), Number(key)); }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const crumbs = useMemo(() => {
    if (!dir) return [];
    const s = sep(dir);
    const parts = dir.split(/[\\/]/).filter(Boolean);
    const out: { label: string; path: string }[] = [];
    let acc = '';
    parts.forEach((p, i) => {
      acc = i === 0 ? (s === '\\' ? `${p}\\` : `/${p}`) : `${acc.replace(/[\\/]$/, '')}${s}${p}`;
      out.push({ label: p, path: acc });
    });
    if (s === '/') out.unshift({ label: '/', path: '/' });
    return out;
  }, [dir]);

  const counts = useMemo(() => ({
    folders: items.filter(e => e.kind === 'folder').length,
    images: items.filter(e => e.kind === 'image').length,
    videos: items.filter(e => e.kind === 'video').length,
    offline: items.filter(offline).length,
  }), [items]);
  const fActive = filterActive(filter);
  const isLabelView = (id: number | null) => mode === 'tagged' && !playlist && (id === null ? !filter.labels.length : filter.labels.length === 1 && filter.labels[0] === id);
  const watchedHere = dir ? watched.find(w => inside(dir, w.path)) : undefined;
  const title = mode === 'tagged' ? (playlist ? playlist.name : 'Labelled photos and videos')
    : mode === 'watched' ? (watchRoot ? `${baseName(watchRoot)} · watched` : 'All watched folders') : null;
  const resetKey = `${mode}|${dir}|${search?.id ?? ''}|${playlist?.id ?? ''}|${watchRoot ?? ''}`;
  const indexing = watched.filter(w => w.state === 'indexing' || w.state === 'paused' || w.state === 'waiting');

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-[250px] shrink-0 border-r border-line overflow-y-auto bg-panel">
        {/* Labels (TAG-05): everything labelled, whichever folder or drive it is on. First, so it is always in view. */}
        <Section id="labels" title="Labels" action={<button className="text-xs text-accent hover:underline" onClick={() => setManage(true)}>Manage</button>}>
          <button onClick={() => showTagged(NO_FILTER)} data-label-view="all"
            className={`w-full flex items-center gap-1.5 h-8 px-2 rounded-md text-sm text-left ${isLabelView(null) ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
            <span className="text-[#f5b301]">★</span><span className="truncate">All labelled or rated</span>
          </button>
          {(allLabels ? labels : [...labels].sort((a, b) => b.count - a.count).slice(0, 8)).map(l => (
            <button key={l.id} onClick={() => showTagged({ labels: [l.id], mode: 'all', minStars: 0 })} data-label-view={l.name}
              className={`w-full flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left ${isLabelView(l.id) ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
              <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: l.color ?? '#8d8d8d' }} />
              <span className="truncate flex-1">{l.name}</span><span className="text-xs text-muted">{l.count}</span>
            </button>
          ))}
          {labels.length > 8 && <button className="px-2 h-7 text-xs text-accent hover:underline" onClick={() => setAllLabels(!allLabels)}>{allLabels ? 'Show fewer' : `Show all ${labels.length}`}</button>}
          {!labels.length && <div className="px-2 py-1 text-xs text-muted">Select photos or videos, then “Labels & stars”, or open one and press 1–5.</div>}
        </Section>

        {/* Playlists (PLAY-08): saved filters that stay up to date. */}
        <Section id="playlists" title="Playlists">
          {playlists.map(p => (
            <div key={p.id} className={`group w-full flex items-center gap-1 h-8 pl-2 pr-1 rounded-md text-sm ${mode === 'tagged' && playlist?.id === p.id ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
              <button className="flex-1 min-w-0 flex items-center gap-2 text-left h-full" onClick={() => showTagged(p.filter, p)} data-playlist={p.name}>
                <Icon name="playlist" size={14} className="shrink-0 opacity-70" /><span className="truncate">{p.name}</span>
              </button>
              <button className="h-6 w-6 rounded opacity-0 group-hover:opacity-100 hover:bg-panel flex items-center justify-center text-muted hover:text-danger"
                onClick={() => { if (playlist?.id === p.id) setPlaylist(null); void T.deletePlaylist(p.id); }} aria-label={`Delete playlist ${p.name}`} title="Delete playlist (the files and labels stay)">
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          {!playlists.length && <div className="px-2 py-1 text-xs text-muted">Filter by labels and stars, then “Save as playlist”.</div>}
        </Section>

        {/* Watched folders (LIB-08): indexed in the background. */}
        <Section id="watched" title="Watched folders" action={<button className="text-xs text-accent hover:underline" onClick={() => void api.watch.choose().then(w => w && setWatched(w)).catch(e => setNote(errorText(e)))}>Add</button>}>
          {watched.length > 1 && (
            <button onClick={() => showWatched(null)} data-watch-view="all"
              className={`w-full flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left ${mode === 'watched' && !watchRoot ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
              <Icon name="eye" size={14} className="shrink-0 opacity-70" /><span className="truncate flex-1">All watched folders</span>
              <span className="text-xs text-muted">{watched.reduce((n, w) => n + w.files, 0).toLocaleString()}</span>
            </button>
          )}
          {watched.map(w => (
            <button key={w.path} onClick={() => showWatched(w.path)} data-watch-view={w.path} title={w.path}
              className={`w-full flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left ${mode === 'watched' && watchRoot && same(watchRoot, w.path) ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
              <Icon name={w.state === 'offline' ? 'usb' : 'eye'} size={14} className={`shrink-0 ${w.state === 'offline' ? 'text-muted' : 'opacity-70'}`} />
              <span className={`truncate flex-1 ${w.state === 'offline' ? 'text-muted' : ''}`}>{baseName(w.path) || w.path}</span>
              <span className="text-xs text-muted whitespace-nowrap" data-watch-state={w.state}>
                {w.state === 'indexing' ? `${w.scanned.toLocaleString()}…` : w.state === 'paused' ? 'paused' : w.state === 'waiting' ? 'waiting' : w.state === 'offline' ? 'offline' : w.files.toLocaleString()}
              </span>
            </button>
          ))}
          {!watched.length && <div className="px-2 py-1 text-xs text-muted">Watch your photo and video folders: search and filters then work without opening them, and changes show up by themselves.</div>}
        </Section>

        <FolderTree drives={drives} current={mode === 'folder' ? dir : null} hasMedia={hasMedia} onHasMedia={mergeHasMedia} onOpen={d => void open(d)} />
      </aside>
      <section className="flex-1 min-w-0 flex flex-col">
        {/* toolbar */}
        <div className="flex items-center gap-2 px-3 h-14 border-b border-line shrink-0">
          <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" onClick={goBack} disabled={mode === 'folder' && !back.length} aria-label="Back" title="Back (Alt+←)"><Icon name="back" size={16} /></button>
          <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" onClick={goFwd} disabled={mode !== 'folder' || !fwd.length} aria-label="Forward" title="Forward (Alt+→)"><Icon name="forward" size={16} /></button>
          <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" onClick={goUp} disabled={mode !== 'folder' || !listing?.parent} aria-label="Up one folder" title="Up one folder (Alt+↑)"><Icon name="up" size={16} /></button>
          <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" onClick={refresh} disabled={mode === 'folder' && !dir} aria-label="Refresh" title="Refresh (F5)"><Icon name="refresh" size={15} /></button>
          <nav className="flex items-center min-w-0 flex-1 overflow-hidden text-sm" aria-label="Folder path">
            {title ? <span className="font-semibold px-1.5 truncate" data-testid="lib-title">{title}</span> : (
              /* Long paths: the drive, "…", then the last three folders. */
              (crumbs.length > 4 ? [crumbs[0], null, ...crumbs.slice(-3)] : crumbs).map((c, i, all) => (
                <span key={c?.path ?? '…'} className="flex items-center min-w-0 shrink">
                  {i > 0 && <Icon name="chevron" size={12} className="text-muted mx-0.5" />}
                  {c ? (
                    <button className={`truncate px-1.5 h-7 rounded hover:bg-panel-2 max-w-[220px] ${i === all.length - 1 ? 'font-semibold' : 'text-muted'}`}
                      onClick={() => void open(c.path)} title={c.path}>{c.label}</button>
                  ) : <span className="px-1 text-muted" title={dir ?? ''}>…</span>}
                </span>
              ))
            )}
          </nav>
          <div className="relative w-56 shrink-0">
            <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
            <input ref={searchBox} value={query} onChange={e => { setQuery(e.target.value); if (search) endSearch(); }} aria-label="Search by name"
              placeholder={mode === 'tagged' ? 'Search names and labels' : mode === 'watched' ? 'Search watched folders' : 'Search by name'}
              onKeyDown={e => { if (e.key === 'Enter') void startSearch(); if (e.key === 'Escape') { setQuery(''); endSearch(); (e.target as HTMLInputElement).blur(); } }}
              className="w-full h-8 rounded-lg bg-panel-2 border border-line pl-8 pr-2 text-sm outline-none focus:border-accent" />
          </div>
          <button className="h-8 w-8 rounded-lg hover:bg-panel-2 flex items-center justify-center text-muted" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"><Icon name="keyboard" size={16} /></button>
        </div>
        <div className="flex items-center gap-3 px-3 h-12 border-b border-line shrink-0 flex-wrap">
          {mode !== 'tagged' && (
            <Segmented label="Show" value={lib.type} onChange={v => void setLib({ type: v })}
              options={[{ value: 'all', label: 'All' }, { value: 'image', label: 'Photos' }, { value: 'video', label: 'Videos' }]} />
          )}
          <button onClick={() => setShowFilter(!showFilter)} aria-expanded={showFilter} aria-label="Filter by labels and stars"
            className={`h-8 px-3 rounded-lg border text-sm flex items-center gap-1.5 ${fActive ? 'border-accent text-accent bg-accent-soft' : 'border-line hover:bg-panel-2'}`}>
            <span className="text-[#f5b301]">★</span>Filter{fActive ? ` (${filter.labels.length + (filter.minStars ? 1 : 0)})` : ''}
          </button>
          {mode !== 'folder' && (
            <>
              <Button className="!h-8" variant="primary" disabled={!playableVideos.length} onClick={() => playAll(false)} title="Play all videos here, one after another (P)">
                <Icon name="play" size={14} />Play all{playableVideos.length ? ` ${playableVideos.length}` : ''}
              </Button>
              <Button className="!h-8" variant="ghost" disabled={playableVideos.length < 2} onClick={() => playAll(true)} title="Play in random order"><Icon name="shuffle" size={15} />Shuffle</Button>
            </>
          )}
          <label className="flex items-center gap-1.5 text-sm text-muted">Sort
            <select value={`${lib.sortBy}:${lib.sortDesc ? 'desc' : 'asc'}`} aria-label="Sort by"
              onChange={e => { const [by, d] = e.target.value.split(':'); void setLib({ sortBy: by as LibrarySettings['sortBy'], sortDesc: d === 'desc' }); }}
              className="h-8 rounded-lg bg-panel-2 border border-line px-2 text-sm text-fg">
              <option value="name:asc">Name (A–Z)</option><option value="name:desc">Name (Z–A)</option>
              <option value="date:desc">Newest first</option><option value="date:asc">Oldest first</option>
              <option value="size:desc">Largest first</option><option value="size:asc">Smallest first</option>
            </select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            {lib.view === 'grid' && (
              <Segmented label="Thumbnail size" value={lib.size} onChange={v => void setLib({ size: v })}
                options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }]} />
            )}
            <Segmented label="View" value={lib.view} onChange={v => void setLib({ view: v })}
              options={[{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }]} />
          </div>
        </div>
        {(showFilter || fActive) && (
          <FilterBar filter={filter} onChange={setFilter}
            onSave={() => setSavePl({ name: playlist?.name ?? labels.filter(l => filter.labels.includes(l.id)).map(l => l.name).join(filter.mode === 'any' ? ' or ' : ' + ') + (filter.minStars ? `${filter.labels.length ? ', ' : ''}${filter.minStars}+ stars` : '') })} />
        )}
        {playlist && !sameFilter(filter, playlist.filter) && (
          <div className="flex items-center gap-2 px-4 h-9 text-sm border-b border-line shrink-0 text-muted">
            You changed the filter of “{playlist.name}”.
            <button className="text-accent hover:underline" onClick={() => setSavePl({ name: playlist.name })}>Update the playlist</button>
            <button className="text-accent hover:underline" onClick={() => setFilter(playlist.filter)}>Undo</button>
          </div>
        )}

        {search && (
          <div className="flex items-center gap-2 px-4 h-10 text-sm bg-accent-soft text-accent shrink-0" role="status">
            <Icon name="search" size={15} />
            <span className="truncate" data-testid="search-status">
              {search.done ? `${search.items.length}${search.truncated ? '+' : ''} found` : `Searching… ${search.items.length} found`} for “{search.query}” in {search.root}
              <span className="text-muted ml-2">{search.indexed ? '(instantly, from the watched-folder index)' : `(${search.scanned.toLocaleString()} files looked at)`}</span>
            </span>
            <button className="ml-auto underline" onClick={endSearch}>Back to folder</button>
          </div>
        )}
        {!search && mode === 'folder' && query.trim() && dir && (
          <div className="flex items-center gap-2 px-4 h-10 text-sm border-b border-line shrink-0">
            <span className="text-muted">Showing matches in this folder.</span>
            <button className="text-accent hover:underline" onClick={() => void startSearch()}>Search all subfolders too</button>
          </div>
        )}
        {mode === 'watched' && indexing.length > 0 && (
          <div className="flex items-center gap-2 px-4 h-9 text-sm border-b border-line shrink-0 text-muted" role="status">
            <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
            Still indexing {indexing.map(w => baseName(w.path)).join(', ')} — more will appear as it goes{indexing.some(w => w.state === 'paused') ? ' (paused while a video plays)' : ''}.
          </div>
        )}
        {note && (
          <div className="flex items-center gap-2 px-4 h-10 text-sm bg-panel-2 border-b border-line shrink-0" role="status">
            <span className="truncate">{note}</span><button className="ml-auto text-muted hover:text-fg" onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        )}

        <div className="flex-1 min-h-0 flex flex-col">
          {error ? <div className="p-6"><Notice tone="danger">{error}</Notice></div>
            : mode === 'folder' && listing?.denied && !search ? (
              <div className="p-6"><Notice>You don't have permission to open this folder. Windows only lets its owner (or an administrator) look inside.</Notice></div>
            ) : mode === 'folder' && listing?.error && !search ? <div className="p-6"><Notice tone="danger">{listing.error}</Notice></div>
            : mode === 'folder' && !dir ? (
              <div className="flex-1 flex items-center justify-center text-muted text-sm">{drives.length ? 'Pick a drive or folder on the left.' : 'Looking for drives…'}</div>
            ) : items.length === 0 && !loading ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-2 text-muted text-sm">
                <Icon name="image" size={32} />
                {mode === 'tagged' ? (tagged === null ? 'Loading…' : fActive || query ? 'Nothing matches these labels and stars.' : 'No labelled or rated photos or videos yet.')
                  : mode === 'watched' ? (tagged === null ? 'Loading…' : indexing.length ? 'Indexing… photos and videos appear here as they are found.' : fActive || query ? 'Nothing in the watched folders matches.' : 'No photos or videos in the watched folders.')
                  : search ? (search.done ? 'Nothing found.' : 'Searching…') : fActive ? 'Nothing here matches the filter.' : query ? 'No names match.' : 'No photos or videos in this folder.'}
              </div>
            ) : (
              <MediaGrid items={items} infos={infos.current} view={lib.view} size={lib.size} selected={selected} focused={focus} onCols={onCols} resetKey={resetKey}
                showFolder={mode !== 'folder' ? e => e.path.replace(/[\\/][^\\/]*$/, '')
                  : search ? e => e.path.slice(search.root.length).replace(/^[\\/]/, '').replace(/[\\/][^\\/]*$/, '') || '(this folder)' : undefined}
                onVisible={onVisible} onClick={onItemClick} onOpen={onItemOpen} />
            )}
        </div>

        {/* Labels & stars for the selection (TAG-04, TAG-09) */}
        {tagPanel && selectedTaggable.length > 0 && (
          <div className="border-t border-line bg-panel px-4 py-3 shrink-0" aria-label="Labels and stars for the selection">
            <div className="flex items-center mb-2 text-sm font-medium">
              Labels & stars · {noun(selectedTaggable)}
              <button className="ml-auto text-muted hover:text-fg" onClick={() => setTagPanel(false)} aria-label="Close labels"><Icon name="x" size={15} /></button>
            </div>
            <TagEditor items={selectedTaggable} />
          </div>
        )}

        <footer className="flex items-center gap-3 px-4 h-11 border-t border-line text-xs text-muted shrink-0">
          <span data-testid="lib-counts">
            {[counts.folders && `${counts.folders} folder${counts.folders > 1 ? 's' : ''}`, (mode === 'folder' || counts.images > 0) && `${counts.images} photo${counts.images === 1 ? '' : 's'}`, `${counts.videos} video${counts.videos === 1 ? '' : 's'}`, counts.offline && `${counts.offline} offline`].filter(Boolean).join(' · ')}
            {mode === 'folder' && !search && listing?.hiddenFiles ? ` · ${listing.hiddenFiles} other file${listing.hiddenFiles > 1 ? 's' : ''} hidden` : ''}
            {mode === 'watched' && watchTotal?.truncated ? ` · showing the newest ${items.length.toLocaleString()} of ${watchTotal.total.toLocaleString()} (search or filter to narrow down)` : ''}
          </span>
          {openMs !== null && mode === 'folder' && !search && <span className="opacity-60" data-testid="lib-open-ms">opened in {openMs} ms</span>}
          {selected.size > 0 && (
            <div className="ml-auto flex items-center gap-2 text-fg">
              <span>{selected.size} selected</span>
              {selectedTaggable.length > 0 && (
                <Button className="!h-8" variant={tagPanel ? 'primary' : 'secondary'} onClick={() => setTagPanel(!tagPanel)} title="Labels & stars (L)">
                  <span className="text-[#f5b301]">★</span>Labels & stars
                </Button>
              )}
              {selected.size === 1 && selectedEntries[0] && !offline(selectedEntries[0]) && (
                <Button className="!h-8" variant="ghost" onClick={() => setRename({ path: selectedEntries[0].path, name: selectedEntries[0].name })} title="Rename (F2)">Rename</Button>
              )}
              <Button className="!h-8" variant="ghost" onClick={() => void doMove()} disabled={!selectedEntries.some(e => !offline(e))}>Move to…</Button>
              {mode === 'folder' && (
                <Button className="!h-8" variant="ghost" disabled={!selectedPhotos.length} onClick={() => onUpscale(selectedPhotos)}
                  title={selectedPhotos.length ? undefined : 'Upscale works with JPG, PNG, WEBP, BMP and TIFF'}>
                  <Icon name="sparkle" size={15} />Upscale{selectedPhotos.length ? ` ${selectedPhotos.length}` : ''}
                </Button>
              )}
              <Button className="!h-8" variant="ghost" onClick={() => { setSelected(new Set()); setTagPanel(false); }}>Clear</Button>
            </div>
          )}
          {selected.size === 0 && mode === 'folder' && dir && !search && !listing?.denied && (
            <div className="ml-auto flex items-center gap-4">
              {watchedHere ? <span title={watchedHere.path}>Watched folder</span>
                : <button className="text-accent hover:underline" onClick={() => void api.watch.add(dir).then(setWatched).catch(e => setNote(errorText(e)))}>Watch this folder</button>}
              <button className="text-accent hover:underline" onClick={() => onSort(dir)}>Sort this folder by person…</button>
            </div>
          )}
        </footer>
      </section>
      {viewer !== null && media[viewer]?.kind === 'video' && (
        <Player items={media} index={viewer} infos={infos.current} onIndex={setViewer} onClose={() => setViewer(null)} />
      )}
      {viewer !== null && media[viewer]?.kind === 'image' && (
        <Viewer items={media} index={viewer} infos={infos.current} onIndex={setViewer} onClose={() => setViewer(null)}
          onUpscale={p => { setViewer(null); onUpscale(p); }} onSort={f => { setViewer(null); onSort(f); }} />
      )}
      {playing && (
        <Player items={playing.items} index={playing.index} infos={infos.current} playlist={playing.name}
          onIndex={i => setPlaying(p => p && { ...p, index: i })} onClose={() => setPlaying(null)} />
      )}
      {manage && <ManageLabels onClose={() => setManage(false)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {savePl && (
        <Dialog label="Save as playlist" onClose={() => setSavePl(null)}>
          <div className="font-semibold">{playlist && savePl.name === playlist.name ? 'Update playlist' : 'Save as playlist'}</div>
          <input autoFocus value={savePl.name} aria-label="Playlist name" placeholder="Playlist name"
            onChange={e => setSavePl({ name: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') void doSavePlaylist(); if (e.key === 'Escape') setSavePl(null); e.stopPropagation(); }}
            className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
          {savePl.error && <div className="text-sm text-danger" role="alert">{savePl.error}</div>}
          <div className="text-xs text-muted">A playlist is a saved filter: anything you label or rate later that matches joins it by itself.</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSavePl(null)}>Cancel</Button>
            <Button variant="primary" disabled={!savePl.name.trim()} onClick={() => void doSavePlaylist()}>Save</Button>
          </div>
        </Dialog>
      )}
      {rename && (
        <Dialog label="Rename" onClose={() => setRename(null)}>
          <div className="font-semibold">Rename</div>
          <input autoFocus value={rename.name} aria-label="New name"
            onFocus={e => { const dot = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }}
            onChange={e => setRename({ ...rename, name: e.target.value, error: undefined })}
            onKeyDown={e => { if (e.key === 'Enter') void doRename(); if (e.key === 'Escape') setRename(null); e.stopPropagation(); }}
            className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
          {rename.error && <div className="text-sm text-danger" role="alert">{rename.error}</div>}
          <div className="text-xs text-muted">Labels, stars and the resume position stay with the file.</div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRename(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => void doRename()}>Rename</Button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** A small modal box. */
function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div className="w-[440px] rounded-2xl bg-panel border border-line shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** A collapsible part of the left column (open/closed is remembered). */
function Section({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(() => store.get(`lib.section.${id}`) !== '0');
  return (
    <div className="p-2 pb-0" aria-label={title}>
      <div className="flex items-center px-2 pb-1">
        <button className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-fg" aria-expanded={open}
          onClick={() => { setOpen(!open); store.set(`lib.section.${id}`, open ? '0' : '1'); }}>
          <Icon name="chevron" size={11} className={`transition ${open ? 'rotate-90' : ''}`} />{title}
        </button>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {open && children}
    </div>
  );
}
