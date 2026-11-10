// 1.0.5: the Library's watch page, like a video site: the video large, its details (stars and labels editable)
// underneath, and "Up next" on the right with the other videos of the folder, view or playlist. Theatre makes the
// video wider and moves Up next below it; Full screen is the player's own. The player is the usual one
// (components/Player.tsx, embedded), so formats, subtitles, sound tracks, resume and shortcuts all work the same.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MediaEntry, MediaInfo } from '@shared/types';
import { api, fmtBytes, fmtClock } from '../api';
import { Player } from './Player';
import { Stars, TagEditor } from './Tags';
import { Button, Icon } from './ui';
import * as T from '../tags';

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

interface Props {
  items: MediaEntry[];               // the videos to choose from (folder, view or playlist), in order
  index: number;                     // the one playing
  infos: Map<string, MediaInfo>;     // thumbnails and lengths already loaded
  title: string;                     // where they come from: the folder name, a playlist…
  active: boolean;                   // this tab and the Library are on screen
  playlist?: string;
  onIndex: (i: number) => void;
  onClose: () => void;               // back to the folder
}

export function WatchPage({ items, index, infos, title, active, playlist, onIndex, onClose }: Props) {
  const [theatre, setTheatreState] = useState(() => store.get('watch.theatre') === '1');
  const setTheatre = (t: boolean) => { setTheatreState(t); store.set('watch.theatre', t ? '1' : '0'); };
  const [, setTick] = useState(0);
  T.useTags();
  const item = items[index];
  const info = infos.get(item.path);
  const videos = useMemo(() => items.map((e, i) => ({ e, i })).filter(x => x.e.kind === 'video'), [items]);
  const list = useRef<HTMLDivElement>(null);

  // Thumbnails and lengths for Up next (the folder's may not all be made yet).
  useEffect(() => {
    const want = videos.map(v => v.e).filter(e => !infos.get(e.path)?.thumb).slice(0, 400);
    if (!want.length) return;
    let live = true;
    api.lib.thumbs(want.map(T.ref)).then(ready => { for (const i of ready) infos.set(i.path, i); if (live && ready.length) setTick(t => t + 1); }).catch(() => {});
    const off = api.onLibThumb(i => { if (want.some(w => w.path === i.path)) { infos.set(i.path, i); setTick(t => t + 1); } });
    void T.loadFor(want.map(T.ref));
    return () => { live = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos]);
  // The one playing stays in view in Up next.
  useEffect(() => { list.current?.querySelector('[data-now-playing]')?.scrollIntoView({ block: 'nearest' }); }, [index, theatre]);
  // T (theatre) when no text box has the keys.
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === 't' || e.key === 'T') { setTheatre(!theatre); e.preventDefault(); }
      else if (e.key === 'Backspace') { onClose(); e.preventDefault(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const folder = item.path.replace(/[\\/][^\\/]*$/, '');
  const pos = videos.findIndex(v => v.i === index);
  const upNext = (
    <div className="min-h-0 flex flex-col" aria-label="Up next" data-testid="up-next">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="text-sm font-semibold">Up next</span>
        <span className="text-xs text-muted truncate">{title} · {pos + 1} of {videos.length}</span>
      </div>
      <div ref={list} className={`space-y-1 ${theatre ? '' : 'overflow-y-auto min-h-0 flex-1 pr-1'}`}>
        {videos.map(({ e, i }) => {
          const inf = infos.get(e.path);
          const now = i === index;
          const stars = T.tagsOf(e.path)?.stars ?? 0;
          return (
            <button key={e.path} onClick={() => onIndex(i)} data-up-next={e.name} data-now-playing={now || undefined}
              className={`w-full flex gap-2.5 p-1.5 rounded-lg text-left ${now ? 'bg-accent-soft' : 'hover:bg-panel-2'}`} title={e.name}>
              <div className="relative w-36 shrink-0 aspect-video rounded-md overflow-hidden bg-panel-2 flex items-center justify-center">
                {inf?.thumb ? <img src={inf.thumb} alt="" className="w-full h-full object-cover" draggable={false} loading="lazy" /> : <Icon name="video" size={18} className="text-muted" />}
                {inf?.duration ? <span className="absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/75 text-white">{fmtClock(inf.duration)}</span> : null}
                {now && <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[11px] font-semibold">▶ Playing</span>}
              </div>
              <div className="min-w-0 py-0.5">
                <div className={`text-sm leading-snug line-clamp-2 break-words ${now ? 'text-accent font-medium' : ''}`}>{e.name}</div>
                <div className="text-xs text-muted mt-0.5">{fmtBytes(e.size)}{inf?.width ? ` · ${Math.min(inf.width, inf.height ?? inf.width)}p` : ''}</div>
                {stars > 0 && <Stars value={stars} size={11} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
  const about = (
    <div className="space-y-3 py-3" data-testid="watch-info">
      <h1 className="text-lg font-semibold break-words" data-testid="watch-title">{item.name}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
        <span>{fmtBytes(item.size)}</span>
        {info?.width ? <span>{info.width} × {info.height}</span> : null}
        {info?.duration ? <span>{fmtClock(info.duration)}</span> : null}
        <span>{new Date(item.mtime).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
        <span className="truncate max-w-full" title={folder}>{folder}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button className="!h-8" variant="ghost" onClick={() => void api.showItem(item.path)}><Icon name="external" size={14} />Show in Explorer</Button>
        <Button className="!h-8" variant="ghost" onClick={() => void api.copyText(item.path)}><Icon name="copy" size={14} />Copy path</Button>
      </div>
      <div className="rounded-xl border border-line bg-panel p-3" data-testid="watch-tags" aria-label="Labels and stars panel">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Stars & labels</div>
        <TagEditor items={[item]} />
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col min-h-0 bg-bg" data-testid="watch-page" data-theatre={theatre || undefined}>
      <div className="flex items-center gap-2 px-3 h-12 border-b border-line shrink-0">
        <Button className="!h-8" variant="ghost" onClick={onClose} title="Back to the folder (Esc)"><Icon name="back" size={16} />Back to {title}</Button>
        <div className="ml-auto flex items-center gap-1">
          <Button className="!h-8" variant={theatre ? 'primary' : 'ghost'} onClick={() => setTheatre(!theatre)} aria-pressed={theatre} title="Theatre: a wider video (T)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2" /></svg>
            {theatre ? 'Normal view' : 'Theatre'}
          </Button>
          <Button className="!h-8" variant="ghost" title="Full screen (F)"
            onClick={() => void document.querySelector<HTMLElement>('[data-testid=watch-page] [data-embedded]')?.requestFullscreen()}><Icon name="fit" size={15} />Full screen</Button>
        </div>
      </div>
      {/* The player keeps its place in the page in both layouts, so switching does not restart the video. Square corners:
          a rounded, clipped video cannot go straight to the graphics card's overlay and drops frames at 4K. */}
      <div className={theatre ? 'flex-1 min-h-0 overflow-y-auto' : 'flex-1 min-h-0 flex gap-5 px-5 pt-4'}>
        <div className={theatre ? '' : 'flex-1 min-w-0 overflow-y-auto'}>
          <div className={theatre ? 'bg-black w-full h-[min(72vh,56.25vw)]' : 'w-full aspect-video max-h-[calc(100vh-15rem)] bg-black'}>
            <Player embedded active={active} items={items} index={index} infos={infos} onIndex={onIndex} onClose={onClose} playlist={playlist} />
          </div>
          {theatre ? (
            <div className="flex gap-6 px-6 max-w-[1400px] mx-auto">
              <div className="flex-1 min-w-0">{about}</div>
              <div className="w-[380px] shrink-0 py-3">{upNext}</div>
            </div>
          ) : about}
        </div>
        {!theatre && <div className="w-[360px] shrink-0 min-h-0 flex flex-col pb-3">{upNext}</div>}
      </div>
    </div>
  );
}
