// v2.10 Wallpaper recommended: photos that fit this computer's screen — big enough and nearly the screen's shape,
// sharp, best fit first — from the watched folders or any folder. One click sets one as the Windows wallpaper;
// photos a bit too small are listed under "Upscale first" and go to Upscale.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { MediaInfo, WallProgress, WallResult, WallScreen } from '@shared/types';
import { api, errorText } from '../api';
import { MediaGrid } from '../components/MediaGrid';
import { Viewer } from '../components/Viewer';
import { Button, Icon, Notice, ProgressBar, Segmented } from '../components/ui';
import { usePrivacy } from '../components/Privacy';
import * as T from '../tags';

interface Props { active: boolean; onUpscale: (paths: string[]) => void; onSort: (folder: string) => void; onDescribe: (p: string) => void; onSimilar: (p: string) => void }

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const LAST = 'wall.source';
const remembered = () => { try { return localStorage.getItem(LAST); } catch { return null; } };

export function Wallpaper({ active, onUpscale, onSort, onDescribe, onSimilar }: Props) {
  const [screens, setScreens] = useState<WallScreen[]>([]);
  const [screenId, setScreenId] = useState<number | null>(null);
  const [watchedCount, setWatchedCount] = useState(0);
  const [source, setSource] = useState<string | null>(remembered());
  const [result, setResult] = useState<WallResult | null>(null);
  const [progress, setProgress] = useState<WallProgress | null>(null);
  const [view, setView] = useState<'ready' | 'upscale'>('ready');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewer, setViewer] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const infos = useRef(new Map<string, MediaInfo>());
  const [, setTick] = useState(0);
  const privacy = usePrivacy();

  useEffect(() => api.onWallProgress(setProgress), []);
  useEffect(() => {
    let frame = 0;
    return api.onLibThumb(i => { infos.current.set(i.path, i); if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick(t => t + 1); }); });
  }, []);
  useEffect(() => {
    if (!active) return;
    void api.wall.screens().then(s => { setScreens(s); setScreenId(id => id ?? s[0]?.id ?? null); });
    void api.watch.list().then(w => setWatchedCount(w.length)).catch(() => {});
  }, [active]);

  const check = useCallback(async (src: string, sid: number | null) => {
    setError(null); setNote(null); setSelected(new Set()); setProgress({ phase: 'listing', done: 0, total: 0 });
    try { localStorage.setItem(LAST, src); } catch { /* not remembered */ }
    try {
      const r = await api.wall.scan(src, sid);
      setResult(r);
      setView(r.ready.length || !r.upscale.length ? 'ready' : 'upscale');
      void T.loadFor([...r.ready, ...r.upscale].map(T.ref));
    } catch (e) { setError(errorText(e)); } finally { setProgress(null); }
  }, []);

  // First visit: check the last source again (or the watched folders) for the main screen.
  const started = useRef(false);
  useEffect(() => {
    if (!active || started.current || screenId === null) return;
    const src = source ?? (watchedCount ? 'watched' : null);
    if (!src) return;
    started.current = true;
    setSource(src);
    void check(src, screenId);
  }, [active, screenId, watchedCount, source, check]);
  // Hidden items locked or shown: checked again (hidden photos never show while locked).
  const lockKey = `${privacy.unlocked}|${privacy.items}|${privacy.labels}`;
  const firstLock = useRef(true);
  useEffect(() => { if (firstLock.current) { firstLock.current = false; return; } if (source && result) void check(source, screenId); }, [lockKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => (result ? (view === 'ready' ? result.ready : result.upscale) : []), [result, view]);
  const onVisible = useCallback((first: number, last: number) => {
    const want = [...items.slice(first, last + 1), ...items.slice(last + 1)].slice(0, 3000);
    api.lib.thumbs(want.map(T.ref)).then(ready => { for (const i of ready) infos.current.set(i.path, i); if (ready.length) setTick(t => t + 1); }).catch(() => {});
  }, [items]);
  const anchor = useRef<number | null>(null);
  const onClick = (i: number, e: MouseEvent) => {
    const p = items[i].path;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) for (let k = Math.min(anchor.current, i); k <= Math.max(anchor.current, i); k++) next.add(items[k].path);
    else { if ((e.ctrlKey || e.metaKey) && next.has(p)) next.delete(p); else next.add(p); anchor.current = i; }
    setSelected(next);
  };
  const sel = items.filter(e => selected.has(e.path));
  const one = sel.length === 1 ? sel[0] : null;

  const setAsWallpaper = async (p: string) => {
    setError(null);
    try { await api.wall.set(p); setNote(`“${baseName(p)}” is now your wallpaper.`); } catch (e) { setError(errorText(e)); }
  };
  const chooseFolder = async () => {
    const f = await api.wall.chooseFolder();
    if (f) { setSource(f); void check(f, screenId); }
  };
  const scr = screens.find(s => s.id === screenId) ?? screens[0];

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-5 pb-3 border-b border-line space-y-3 shrink-0">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="mr-auto min-w-0">
            <h1 className="text-xl font-semibold">Wallpaper recommended</h1>
            <p className="text-sm text-muted mt-0.5">Sharp photos big enough for {scr ? <b className="text-fg" data-testid="wall-screen">{scr.width} × {scr.height}</b> : 'your screen'} and nearly its shape, best fit first.</p>
          </div>
          {screens.length > 1 && (
            <select value={screenId ?? ''} onChange={e => { const id = Number(e.target.value); setScreenId(id); if (source) void check(source, id); }} aria-label="Screen"
              className="h-9 rounded-lg bg-panel-2 border border-line px-2 text-sm">
              {screens.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted">Look in:</span>
          <Button className="!h-8" variant={source === 'watched' ? 'primary' : 'secondary'} disabled={!watchedCount || !!progress}
            onClick={() => { setSource('watched'); void check('watched', screenId); }} title={watchedCount ? undefined : 'Watch folders in the Library first'}>
            <Icon name="library" size={15} />Watched folders{watchedCount ? ` (${watchedCount})` : ''}
          </Button>
          {source && source !== 'watched' && <Button className="!h-8" variant="primary" disabled={!!progress} onClick={() => void check(source, screenId)} title={source}><Icon name="folder" size={15} />{baseName(source)}</Button>}
          <Button className="!h-8" disabled={!!progress} onClick={() => void chooseFolder()}><Icon name="folder" size={15} />Check a folder…</Button>
          {result && !progress && <Button className="!h-8" variant="ghost" onClick={() => source && void check(source, screenId)} title="Check again"><Icon name="refresh" size={15} /></Button>}
        </div>
      </div>

      <div className="px-6 pt-3 space-y-2 shrink-0">
        {error && <Notice tone="danger">{error}</Notice>}
        {note && <Notice tone="info"><div className="flex items-start gap-2"><span className="flex-1">{note}</span><button onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div></Notice>}
        {progress && (
          <div className="rounded-xl border border-line bg-panel p-4 space-y-2">
            <div className="flex justify-between text-sm">
              <span>{progress.phase === 'listing' ? 'Finding photos…' : `Checking photos · ${progress.found ?? 0} found`}</span>
              <span className="text-muted tabular-nums">{progress.total ? `${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}` : ''}</span>
            </div>
            <ProgressBar value={progress.total ? progress.done / progress.total : 0} />
            <div className="flex items-center gap-2"><span className="text-xs text-muted mr-auto">Each photo is measured once; checking again is quick.</span><Button className="!h-7 text-xs" variant="ghost" onClick={() => void api.wall.cancel()}>Stop</Button></div>
          </div>
        )}
        {!progress && !result && !source && (
          <Notice tone="info">{watchedCount ? 'Choose where to look.' : 'Choose a folder of photos to look for wallpapers in (or watch folders in the Library to have them checked here).'}</Notice>
        )}
      </div>

      {result && !progress && (
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-3 px-6 h-12 shrink-0 flex-wrap">
            <Segmented label="Wallpapers" value={view} onChange={v => { setView(v); setSelected(new Set()); }}
              options={[{ value: 'ready', label: `Ready (${result.ready.length})` }, { value: 'upscale', label: `Upscale first (${result.upscale.length})` }]} />
            <span className="text-xs text-muted" data-testid="wall-summary">
              {result.checked.toLocaleString()} photos checked{result.blurry ? ` · ${result.blurry} blurry left out` : ''}{result.cancelled ? ' · stopped early' : ''}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {one && <span className="text-xs text-muted">{one.width} × {one.height}{one.crop > 0.005 ? ` · ${Math.round(one.crop * 100)}% cropped` : ' · no crop'}{one.upscale > 1 ? ` · needs ${one.upscale}×` : ''}</span>}
              {view === 'ready' && <Button className="!h-8" variant="primary" disabled={!one} onClick={() => one && void setAsWallpaper(one.path)}><Icon name="image" size={15} />Set as wallpaper</Button>}
              {view === 'upscale' && <Button className="!h-8" variant="primary" disabled={!sel.length} onClick={() => onUpscale(sel.map(e => e.path))}><Icon name="sparkle" size={15} />Upscale{sel.length ? ` ${sel.length}` : ''}</Button>}
            </div>
          </div>
          {view === 'upscale' && result.upscale.length > 0 && <div className="px-6 pb-2 text-xs text-muted">These fit your screen's shape but have too few pixels. Upscale them 2× or 4× (shown when you select one), then check again.</div>}
          {items.length === 0
            ? <div className="px-6"><Notice tone="info">{view === 'ready' ? 'No photo here is big and sharp enough for this screen yet.' : 'Nothing to upscale.'}</Notice></div>
            : <div className="flex-1 min-h-0 px-3">
                <MediaGrid items={items} infos={infos.current} view="grid" size="m" selected={selected} onVisible={onVisible}
                  onClick={onClick} onOpen={i => setViewer(i)} resetKey={`${source}|${view}|${result.screen.id}`} />
              </div>}
        </div>
      )}

      {viewer !== null && items[viewer] && (
        <Viewer items={items} index={viewer} infos={infos.current} onIndex={setViewer} onClose={() => setViewer(null)} onUpscale={onUpscale} onSort={onSort} onDescribe={p => { setViewer(null); onDescribe(p); }} onSimilar={p => { setViewer(null); onSimilar(p); }} />
      )}
    </div>
  );
}
