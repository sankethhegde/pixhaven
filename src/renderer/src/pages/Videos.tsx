// 1.0.6 Videos tab: every video PixHaven knows, on this PC and external drives (Attic joins in 1.0.7), in one grid —
// with the same watch page, details card, labels and stars as the Library. Walking whole drives each time would be
// slow, so it reads the watched-folder index (instant, kept up to date in the background); "Add a drive or folder"
// adds more to it.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { DriveInfo, MediaEntry, MediaInfo, TaggedMedia, TagFilter, WatchedFolder } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import { MediaGrid } from '../components/MediaGrid';
import { DetailsCard, useDetailsOpen } from '../components/DetailsCard';
import { WatchPage } from '../components/WatchPage';
import { FilterBar, NO_FILTER, filterActive } from '../components/Tags';
import { Button, Icon, Notice, Segmented } from '../components/ui';
import * as T from '../tags';
import { MoveToAtticButton, useAttic, useTransferDone } from '../components/attic';

type Source = 'all' | 'pc' | 'external' | 'network' | 'attic';
type Order = 'date:desc' | 'date:asc' | 'name:asc' | 'name:desc' | 'size:desc' | 'size:asc';
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const rootOf = (p: string) => (/^[a-z]:/i.test(p) ? p.slice(0, 2).toUpperCase() + '\\' : p.startsWith('\\\\') ? p.split('\\').slice(0, 4).join('\\') : '/');
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function Videos({ active }: { active: boolean }) {
  const [watched, setWatched] = useState<WatchedFolder[]>([]);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [items, setItems] = useState<TaggedMedia[] | null>(null);
  const [total, setTotal] = useState<{ total: number; truncated: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<TagFilter>(NO_FILTER);
  const [showFilter, setShowFilter] = useState(false);
  const [source, setSource] = useState<Source>('all');
  const [order, setOrderState] = useState<Order>(() => (store.get('videos.order') as Order) || 'date:desc');
  const setOrder = (o: Order) => { setOrderState(o); store.set('videos.order', o); };
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tick, setTick] = useState(0);          // the index changed: ask it again
  const [, setRedraw] = useState(0);            // thumbnails arrived: draw again
  const [details, setDetails] = useDetailsOpen();
  const infos = useRef(new Map<string, MediaInfo>());
  const { version } = T.useTags();
  const activeRef = useRef(active); activeRef.current = active;

  useEffect(() => {
    void api.watch.list().then(setWatched);
    const offs = [api.onWatchStatus(setWatched), api.onWatchChanged(() => setTick(t => t + 1)),
      api.onLibThumb(i => { infos.current.set(i.path, i); if (activeRef.current) setRedraw(r => r + 1); })];
    return () => offs.forEach(f => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (active) void api.lib.drives().then(setDrives).catch(() => {}); }, [active]);

  // The index, asked again when the search, filter or the folders change (debounced while typing).
  const filterVersion = filterActive(filter) ? version : 0;
  useEffect(() => {
    if (!active) return;
    let live = true;
    const t = setTimeout(async () => {
      const r = await api.watch.query({ text: query, type: 'video', filter, root: null, limit: 20000 }).catch(e => { setNote(errorText(e)); return null; });
      if (!live || !r) return;
      T.known(r.tags, r.items);
      setItems(r.items);
      setTotal({ total: r.total, truncated: r.truncated });
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [active, query, filter, filterVersion, tick, watched.length]);

  // 1.0.7: Attic's videos too, when Attic is connected (its index; labels and stars are PixHaven's).
  const attic = useAttic();
  const [atticItems, setAtticItems] = useState<TaggedMedia[]>([]);
  useEffect(() => {
    if (!active || attic.state !== 'connected') { if (attic.state !== 'connected') setAtticItems([]); return; }
    let live = true;
    void api.attic.videos(tick > 0).then(list => {
      if (!live) return;
      void T.loadFor(list.map(T.ref));
      setAtticItems(list.map(e => ({ ...e, stars: 0, labels: [], offline: false })));
    }).catch(() => {});
    return () => { live = false; };
  }, [active, attic.state, tick]);
  useTransferDone(useCallback(() => setTick(t => t + 1), []));
  const atticShown = useMemo(() => {
    const q = query.toLowerCase().split(/s+/).filter(Boolean);
    return atticItems.filter(e => q.every(w => e.name.toLowerCase().includes(w)) && (!filterActive(filter) || (() => {
      const t = T.tagsOf(e.path);
      if (!t || t.stars < filter.minStars) return false;
      return !filter.labels.length || (filter.mode === 'all' ? filter.labels.every(l => t.labels.includes(l)) : filter.labels.some(l => t.labels.includes(l)));
    })()));
  }, [atticItems, query, filter, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const kindOf = useCallback((p: string): Source => {
    if (p.startsWith('attic://')) return 'attic';
    const d = drives.find(x => rootOf(x.path) === rootOf(p));
    return d?.kind === 'removable' ? 'external' : d?.kind === 'network' || p.startsWith('\\\\') ? 'network' : 'pc';
  }, [drives]);
  const shown = useMemo(() => {
    const list = [...(items ?? []), ...atticShown].filter(e => source === 'all' || kindOf(e.path) === source);
    const [by, dir] = order.split(':');
    const cmp = by === 'date' ? (a: MediaEntry, b: MediaEntry) => a.mtime - b.mtime : by === 'size' ? (a: MediaEntry, b: MediaEntry) => a.size - b.size
      : (a: MediaEntry, b: MediaEntry) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return list.sort((a, b) => (dir === 'desc' ? -cmp(a, b) : cmp(a, b)));
  }, [items, atticShown, source, order, kindOf]);
  const counts = useMemo(() => {
    const c = { pc: 0, external: 0, network: 0, attic: 0 };
    for (const e of [...(items ?? []), ...atticShown]) c[kindOf(e.path) as 'pc' | 'external' | 'network' | 'attic']++;
    return c;
  }, [items, atticShown, kindOf]);
  // Selection survives a new order; what is no longer shown is no longer selected.
  useEffect(() => { setSelected(s => { const here = new Set(shown.map(e => e.path)); return [...s].every(p => here.has(p)) ? s : new Set([...s].filter(p => here.has(p))); }); }, [shown]);

  const onVisible = useCallback((first: number, last: number) => {
    const want = [...shown.slice(first, last + 1), ...shown.slice(last + 1, last + 200)].filter(e => !infos.current.get(e.path)?.thumb);
    if (!want.length) return;
    api.lib.thumbs(want.map(T.ref)).then(ready => { for (const i of ready) infos.current.set(i.path, i); if (ready.length) setRedraw(r => r + 1); }).catch(() => {});
  }, [shown]);
  const onClick = (i: number, e: MouseEvent) => {
    const p = shown[i].path;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) for (let k = Math.min(anchor.current, i); k <= Math.max(anchor.current, i); k++) next.add(shown[k].path);
    else { if ((e.ctrlKey || e.metaKey) && next.has(p)) next.delete(p); else next.add(p); anchor.current = i; }
    setSelected(next);
  };

  // Keys: Esc clears the selection, Ctrl+A selects everything shown, I shows or hides the details.
  useEffect(() => {
    if (!active || watching !== null) return;
    const k = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Escape' && selected.size) setSelected(new Set());
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') setSelected(new Set(shown.map(x => x.path)));
      else if ((e.key === 'i' || e.key === 'I') && !e.ctrlKey && !e.altKey) setDetails(!details);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const addFolder = async (dir: string | null) => {
    setAdding(false);
    try {
      const w = dir ? await api.watch.add(dir) : await api.watch.choose();
      if (w) { setWatched(w); setNote(`Added ${dir ?? 'the folder'}: its videos appear here as it is indexed.`); }
    } catch (e) { setNote(errorText(e)); }
  };
  const watchedRoots = new Set(watched.map(w => w.path.toLowerCase().replace(/[\\/]+$/, '')));
  const unwatchedDrives = drives.filter(d => d.kind !== 'cd' && d.kind !== 'place' && !watchedRoots.has(d.path.toLowerCase().replace(/[\\/]+$/, '')));
  const indexing = watched.filter(w => w.state === 'indexing' || w.state === 'waiting' || w.state === 'paused');
  const sel = shown.filter(e => selected.has(e.path));
  const totalSize = useMemo(() => shown.reduce((n, e) => n + e.size, 0), [shown]);

  const isWatching = watching !== null && !!shown[watching];
  return (
    <>
    {isWatching && (
      <div className="h-full">
        <WatchPage items={shown} index={watching!} infos={infos.current} title="Videos" active={active}
          onIndex={setWatching} onClose={() => { const e = shown[watching!]; setWatching(null); if (e) { setSelected(new Set([e.path])); anchor.current = watching; } }} />
      </div>
    )}
    {/* Kept (hidden) while a video plays: back here, the scroll position and selection are as left. */}
    <div className={isWatching ? 'hidden' : 'h-full flex flex-col min-h-0'} data-testid="videos-page">
      <div className="flex items-center gap-3 px-5 h-14 border-b border-line shrink-0">
        <Icon name="video" size={20} className="text-accent" />
        <h1 className="text-lg font-semibold">Videos</h1>
        <span className="text-sm text-muted" data-testid="videos-count">
          {items === null ? 'Loading…' : `${shown.length.toLocaleString()} video${shown.length === 1 ? '' : 's'}${shown.length ? ` · ${fmtBytes(totalSize)}` : ''}${total?.truncated ? ` (the newest ${items.length.toLocaleString()} of ${total.total.toLocaleString()})` : ''}`}
        </span>
        <div className="ml-auto relative w-64">
          <Icon name="search" size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search videos by name" aria-label="Search videos"
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); } }}
            className="w-full h-8 rounded-lg bg-panel-2 border border-line pl-8 pr-2 text-sm outline-none focus:border-accent" />
        </div>
        <div className="relative">
          <Button className="!h-8" variant="primary" onClick={() => setAdding(!adding)} aria-expanded={adding}><Icon name="plus" size={15} />Add a drive or folder</Button>
          {adding && (
            <div className="absolute right-0 top-10 z-30 w-80 rounded-xl bg-panel border border-line shadow-2xl p-2" role="menu" aria-label="Add a drive or folder">
              <div className="px-2 py-1.5 text-xs text-muted">Its videos are found in the background and kept up to date.</div>
              {unwatchedDrives.map(d => (
                <button key={d.path} role="menuitem" onClick={() => void addFolder(d.path)} data-add-drive={d.path}
                  className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-sm text-left hover:bg-panel-2">
                  <Icon name={d.kind === 'removable' ? 'usb' : d.kind === 'network' ? 'network' : 'drive'} size={15} className="text-muted" />
                  <span className="truncate flex-1">{d.name}</span>{d.total ? <span className="text-xs text-muted">{fmtBytes(d.total)}</span> : null}
                </button>
              ))}
              <button role="menuitem" onClick={() => void addFolder(null)} className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-sm text-left hover:bg-panel-2 text-accent">
                <Icon name="folder" size={15} />Choose a folder…
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 px-5 h-12 border-b border-line shrink-0 flex-wrap">
        <Segmented label="Where" value={source} onChange={setSource} options={[
          { value: 'all', label: `All` }, { value: 'pc', label: `This PC (${counts.pc})` },
          { value: 'external', label: `External drives (${counts.external})` }, ...(counts.network ? [{ value: 'network' as const, label: `Network (${counts.network})` }] : []),
          ...(attic.state === 'connected' ? [{ value: 'attic' as const, label: `Attic (${counts.attic})` }] : []),
        ]} />
        <button onClick={() => setShowFilter(!showFilter)} aria-expanded={showFilter} aria-label="Filter by labels and stars"
          className={`h-8 px-3 rounded-lg border text-sm flex items-center gap-1.5 ${filterActive(filter) ? 'border-accent text-accent bg-accent-soft' : 'border-line hover:bg-panel-2'}`}>
          <span className="text-[#f5b301]">★</span>Filter{filterActive(filter) ? ` (${filter.labels.length + (filter.minStars ? 1 : 0)})` : ''}
        </button>
        <label className="flex items-center gap-1.5 text-sm text-muted">Sort
          <select value={order} onChange={e => setOrder(e.target.value as Order)} aria-label="Sort videos" className="h-8 rounded-lg bg-panel-2 border border-line px-2 text-sm text-fg">
            <option value="date:desc">Newest first</option><option value="date:asc">Oldest first</option>
            <option value="name:asc">Name (A–Z)</option><option value="name:desc">Name (Z–A)</option>
            <option value="size:desc">Largest first</option><option value="size:asc">Smallest first</option>
          </select>
        </label>
        <button className={`ml-auto h-8 w-8 rounded-lg flex items-center justify-center ${details ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2 text-muted'}`} onClick={() => setDetails(!details)}
          aria-label="Details" aria-pressed={details} title="Details (I)"><Icon name="info" size={16} /></button>
      </div>
      {(showFilter || filterActive(filter)) && <FilterBar filter={filter} onChange={setFilter} />}
      {indexing.length > 0 && (
        <div className="flex items-center gap-2 px-5 h-9 text-sm border-b border-line shrink-0 text-muted" role="status">
          <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          Finding videos in {indexing.map(w => baseName(w.path) || w.path).join(', ')} — more appear as it goes.
        </div>
      )}
      {note && (
        <div className="flex items-center gap-2 px-5 h-10 text-sm bg-panel-2 border-b border-line shrink-0" role="status">
          <span className="truncate">{note}</span><button className="ml-auto text-muted hover:text-fg" onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {!watched.length && !atticItems.length ? (
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md text-center space-y-3">
                <Icon name="video" size={36} className="text-muted mx-auto" />
                <div className="font-semibold">Show every video in one place</div>
                <p className="text-sm text-muted">Add the drives or folders that hold your videos. PixHaven finds them in the background and keeps the list up to date, so this tab opens instantly.</p>
                <Button variant="primary" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add a drive or folder</Button>
              </div>
            </div>
          ) : items !== null && !shown.length ? (
            <div className="flex-1 flex items-center justify-center text-sm text-muted p-6"><Notice>{query || filterActive(filter) || source !== 'all' ? 'No videos match.' : indexing.length ? 'Finding videos… they appear here as they are found.' : 'No videos in the folders and drives added so far.'}</Notice></div>
          ) : (
            <MediaGrid items={shown} infos={infos.current} view="grid" size="m" selected={selected} onVisible={onVisible} resetKey={`${source}|${order}|${query}`}
              showFolder={e => e.path.replace(/[\\/][^\\/]*$/, '')} onClick={onClick} onOpen={i => setWatching(i)} />
          )}
        </div>
        {details && (watched.length > 0 || atticItems.length > 0) && (
          <DetailsCard items={sel} infos={infos.current} onClose={() => setDetails(false)} all={shown} allTitle="All videos shown"
            onOpen={e => { const i = shown.indexOf(e as TaggedMedia); if (i >= 0) setWatching(i); }} />
        )}
      </div>
      {sel.length > 0 && (
        <footer className="flex items-center gap-2 px-4 min-h-11 py-1.5 border-t border-line text-sm shrink-0" data-testid="videos-selection">
          <span>{sel.length} selected · {fmtBytes(sel.reduce((n, e) => n + e.size, 0))}</span>
          <div className="ml-auto flex items-center gap-1">
            {sel.some(e => !e.path.startsWith('attic://')) && <MoveToAtticButton paths={sel.filter(e => !e.path.startsWith('attic://')).map(e => e.path)} onDone={() => setSelected(new Set())} />}
            <Button className="!h-8" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </footer>
      )}
    </div>
    </>
  );
}
