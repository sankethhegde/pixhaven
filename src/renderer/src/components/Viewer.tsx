// Full-window viewer for the media library (LIB-09): zoom, pan, previous/next, and one click to Upscale or Sort.
// Videos in the same list open in the Player instead (the Library switches between the two).
// v2.1 (TAG-09): labels and stars for photos — keys 1–5 (0 clears), S opens the labels panel; Ctrl+0 fits the picture.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import type { MediaEntry, MediaInfo } from '@shared/types';
import { IMAGE_EXTENSIONS, RAW_EXTENSIONS } from '@shared/types';
import { api, errorText, fmtBytes, fmtClock } from '../api';
import { Button, Icon } from './ui';
import { Stars, TagEditor } from './Tags';
import * as T from '../tags';

const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

interface Props {
  items: MediaEntry[];          // photos and videos of the current view, in display order
  index: number;
  infos: Map<string, MediaInfo>;
  onIndex: (i: number) => void;
  onClose: () => void;
  onUpscale: (paths: string[]) => void;
  onSort: (folder: string) => void;
}

const ext = (n: string) => n.slice(n.lastIndexOf('.') + 1).toLowerCase();
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))) || p;

export function Viewer({ items, index, infos, onIndex, onClose, onUpscale, onSort }: Props) {
  const item = items[index];
  const info = infos.get(item.path);
  const [pic, setPic] = useState<{ path: string; url: string; width: number; height: number; converted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState<number | null>(null);   // null = fit to window
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [box, setBox] = useState({ w: 1000, h: 700 });
  const [tagsOpen, setTagsOpen] = useState(() => store.get('viewer.tags') === '1');
  useEffect(() => store.set('viewer.tags', tagsOpen ? '1' : '0'), [tagsOpen]);
  T.useTags();
  useEffect(() => { void T.loadFor([T.ref(item)]); }, [item]);

  useEffect(() => {
    const el = stage.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    setScale(null); setOffset({ x: 0, y: 0 }); setError(null);
    if (item.kind !== 'image') { setPic(null); return; }
    let live = true;
    api.lib.preview(item.path).then(p => { if (live) setPic({ path: item.path, ...p }); }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [item.path, item.kind]);

  const ready = pic && pic.path === item.path;
  const fit = ready && pic.width ? Math.min(1, (box.w - 40) / pic.width, (box.h - 40) / pic.height) : 1;
  const s = scale ?? fit;

  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const clamped = Math.min(8, Math.max(fit, next));
    const p = at ?? { x: 0, y: 0 };                          // point under the cursor, from the stage centre
    setOffset(o => clamped <= fit ? { x: 0, y: 0 } : { x: p.x - ((p.x - o.x) * clamped) / s, y: p.y - ((p.y - o.y) * clamped) / s });
    setScale(clamped <= fit ? null : clamped);
  }, [fit, s]);

  const go = useCallback((d: number) => { const n = index + d; if (n >= 0 && n < items.length) onIndex(n); }, [index, items.length, onIndex]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === 'Home') onIndex(0);
      else if (e.key === 'End') onIndex(items.length - 1);
      else if (e.key === '+' || e.key === '=') zoomTo(s * 1.25);
      else if (e.key === '-') zoomTo(s / 1.25);
      else if (e.key === '0' && (e.ctrlKey || e.metaKey)) zoomTo(fit);
      else if (/^[0-5]$/.test(e.key) && !e.ctrlKey && !e.altKey) void T.setStars([T.ref(item)], Number(e.key));   // 1–5 stars, 0 clears
      else if (e.key === 's' || e.key === 'S') setTagsOpen(o => !o);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [go, onClose, zoomTo, s, fit, item, items.length, onIndex]);

  const fromCentre = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };
  const onWheel = (e: WheelEvent) => { if (ready) zoomTo(s * (e.deltaY < 0 ? 1.15 : 1 / 1.15), fromCentre(e)); };
  const onDown = (e: PointerEvent) => {
    if (scale === null) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (d) setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
  };

  const e = ext(item.name);
  const canUpscale = item.kind === 'image' && IMAGE_EXTENSIONS.includes(e);
  const raw = RAW_EXTENSIONS.includes(e);
  const dims = ready ? (info?.width ? `${info.width} × ${info.height}` : `${pic.width} × ${pic.height}`) : info?.width ? `${info.width} × ${info.height}` : '';

  return (
    <div className="fixed inset-0 z-40 bg-[#0b0c0f] text-white flex flex-col" role="dialog" aria-label={`Viewer: ${item.name}`}>
      <div className="flex items-center gap-3 px-4 h-14 shrink-0 border-b border-white/10">
        <button onClick={onClose} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center" aria-label="Close viewer"><Icon name="x" /></button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0"><span className="font-medium truncate" data-testid="viewer-name">{item.name}</span>
            {(T.tagsOf(item.path)?.stars ?? 0) > 0 && <Stars value={T.tagsOf(item.path)!.stars} size={13} />}</div>
          <div className="text-xs text-white/60 truncate">
            {[dims, fmtBytes(item.size), new Date(item.mtime).toLocaleString(), info?.duration ? fmtClock(info.duration) : '', `${index + 1} of ${items.length}`].filter(Boolean).join(' · ')}
            {ready && pic.converted && <span className="ml-2 text-white/40">{raw ? 'Showing the camera\'s built-in preview' : 'Converted preview'}</span>}
          </div>
        </div>
        {item.kind === 'image' && (
          <div className="flex items-center gap-1 text-sm">
            <button className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center" onClick={() => zoomTo(s / 1.25)} aria-label="Zoom out"><Icon name="zoomOut" /></button>
            <span className="w-14 text-center tabular-nums text-white/80" data-testid="viewer-zoom">{Math.round(s * 100)}%</span>
            <button className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center" onClick={() => zoomTo(s * 1.25)} aria-label="Zoom in"><Icon name="zoomIn" /></button>
            <button className="h-9 px-2 rounded-lg hover:bg-white/10" onClick={() => zoomTo(fit)}>Fit</button>
            <button className="h-9 px-2 rounded-lg hover:bg-white/10" onClick={() => zoomTo(1)}>100%</button>
          </div>
        )}
        <div className="flex items-center gap-2">
          {item.kind === 'image' && (
            <Button variant="primary" disabled={!canUpscale} onClick={() => onUpscale([item.path])}
              title={canUpscale ? 'Open in Upscale' : 'Upscale works with JPG, PNG, WEBP, BMP and TIFF'}><Icon name="sparkle" size={16} />Upscale</Button>
          )}
          <Button onClick={() => onSort(dirOf(item.path))} className="!bg-white/10 !border-white/10 !text-white hover:!bg-white/20" title="Sort the photos in this folder by person">
            <Icon name="people" size={16} />Sort this folder
          </Button>
          <button onClick={() => setTagsOpen(!tagsOpen)} className={`h-9 px-3 rounded-lg flex items-center gap-1.5 text-sm ${tagsOpen ? 'bg-white/20' : 'hover:bg-white/10'}`} title="Labels and stars (S)" aria-pressed={tagsOpen}>
            <span className="text-[#f5b301]">★</span>Labels
          </button>
          <button onClick={() => api.showItem(item.path)} className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center" title="Show in folder" aria-label="Show in folder">
            <Icon name="folder" />
          </button>
        </div>
      </div>
      <div ref={stage} className="flex-1 min-h-0 relative overflow-hidden flex items-center justify-center select-none"
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }}
        onDoubleClick={ev => item.kind === 'image' && zoomTo(scale === null ? 1 : fit, fromCentre(ev))}
        style={{ cursor: scale !== null ? (drag.current ? 'grabbing' : 'grab') : 'default' }}>
        {error ? (
          <div className="text-white/70 text-sm">Can't show this picture: {error}</div>
        ) : ready ? (
          <img src={pic.url} alt={item.name} draggable={false} data-testid="viewer-image"
            style={{ width: pic.width || undefined, maxWidth: 'none', transform: `translate(${offset.x}px, ${offset.y}px) scale(${s})`, transformOrigin: 'center' }} />
        ) : (
          <div className="h-8 w-8 rounded-full border-2 border-white/60 border-t-transparent animate-spin" aria-label="Loading" />
        )}
        {index > 0 && (
          <button onClick={() => go(-1)} className="absolute left-3 top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center" aria-label="Previous">
            <Icon name="back" size={22} />
          </button>
        )}
        {index < items.length - 1 && (
          <button onClick={() => go(1)} className={`absolute ${tagsOpen ? 'right-[21rem]' : 'right-3'} top-1/2 -translate-y-1/2 h-12 w-12 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center`} aria-label="Next">
            <Icon name="forward" size={22} />
          </button>
        )}
        {tagsOpen && (
          <div className="absolute z-20 top-3 right-3 w-80 max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-2xl bg-black/80 backdrop-blur border border-white/10 p-4 space-y-4 cursor-default"
            onPointerDown={e => e.stopPropagation()} onWheel={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} aria-label="Labels and stars panel">
            <div className="flex items-center text-sm font-medium">Labels & stars
              <button className="ml-auto text-white/60 hover:text-white" onClick={() => setTagsOpen(false)} aria-label="Close labels panel"><Icon name="x" size={15} /></button>
            </div>
            <TagEditor items={[item]} dark />
            <div className="text-xs text-white/50 border-t border-white/10 pt-3 break-all">{item.path}</div>
          </div>
        )}
      </div>
    </div>
  );
}
