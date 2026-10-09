// Thumbnail grid and detail list for the media library (LIB-05). Only the rows on screen are drawn,
// so a folder of thousands of files scrolls smoothly; it reports what is visible so thumbnails come in that order.
// v2.1: stars and labels on photos too, and a keyboard focus (arrow keys) that is kept in view.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import type { MediaEntry, MediaInfo } from '@shared/types';
import { RAW_EXTENSIONS } from '@shared/types';
import { fmtBytes, fmtClock } from '../api';
import { Icon } from './ui';
import { LabelChip, Stars } from './Tags';
import * as T from '../tags';

export const TILE: Record<'s' | 'm' | 'l', number> = { s: 120, m: 168, l: 240 };
const GAP = 10, LABEL = 56, LIST_ROW = 36, OVERSCAN = 2;

interface Props {
  items: MediaEntry[];
  infos: Map<string, MediaInfo>;
  view: 'grid' | 'list';
  size: 's' | 'm' | 'l';
  selected: Set<string>;
  showFolder?: (e: MediaEntry) => string;     // search results: where each file is
  onVisible: (first: number, last: number) => void;
  onClick: (index: number, e: MouseEvent) => void;
  onOpen: (index: number) => void;
  focused?: number | null;                     // keyboard focus (arrow keys)
  onCols?: (cols: number) => void;             // tiles per row, for Up/Down
  resetKey?: string;                           // back to the top when this changes (a new folder or view), not on every edit
}

const ext = (n: string) => n.slice(n.lastIndexOf('.') + 1).toLowerCase();
const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

export function MediaGrid({ items, infos, view, size, selected, showFolder, onVisible, onClick, onOpen, focused = null, onCols, resetKey }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [height, setHeight] = useState(600);
  const [top, setTop] = useState(0);
  const { label } = T.useTags();
  /** Stars and up to `max` label chips of a photo or video (TAG-03: rate straight from the grid or list). */
  const tagRow = (e: MediaEntry, max: number, small: boolean) => {
    if (e.kind === 'folder') return null;
    const t = T.tagsOf(e.path);
    const chips = (t?.labels ?? []).map(label).filter(Boolean);
    return (
      <div className="flex items-center gap-1 min-w-0" data-tags={e.name}>
        <Stars value={t?.stars ?? 0} size={small ? 11 : 12} onChange={n => void T.setStars([T.ref(e)], n)} label={`Stars for ${e.name}`} />
        {chips.slice(0, max).map(l => <LabelChip key={l!.id} label={l!} small />)}
        {chips.length > max && <span className="text-[10px] text-muted">+{chips.length - max}</span>}
      </div>
    );
  };

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => { setWidth(el.clientWidth); setHeight(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // New folder or search: back to the top.
  useEffect(() => { if (box.current) box.current.scrollTop = 0; setTop(0); }, [resetKey ?? items]);

  const tile = TILE[size];
  const cols = view === 'grid' ? Math.max(1, Math.floor((width - 16 + GAP) / (tile + GAP))) : 1;
  const rowH = view === 'grid' ? tile + LABEL + GAP : LIST_ROW;
  const left = Math.max(8, Math.floor((width - (cols * tile + (cols - 1) * GAP)) / 2));   // centre the columns
  const rows = Math.ceil(items.length / cols);
  const firstRow = Math.max(0, Math.floor(top / rowH) - OVERSCAN);
  const lastRow = Math.min(rows - 1, Math.ceil((top + height) / rowH) + OVERSCAN);
  const first = firstRow * cols, last = Math.min(items.length - 1, (lastRow + 1) * cols - 1);

  useEffect(() => { onCols?.(cols); }, [cols, onCols]);
  // The focused tile stays in view.
  useEffect(() => {
    const el = box.current;
    if (focused === null || !el || focused >= items.length) return;
    const y = 8 + Math.floor(focused / cols) * rowH;
    if (y < el.scrollTop) el.scrollTop = y - 8;
    else if (y + rowH > el.scrollTop + el.clientHeight) el.scrollTop = y + rowH - el.clientHeight + 8;
  }, [focused, cols, rowH, items.length]);

  useEffect(() => {
    const t = setTimeout(() => onVisible(first, last), 80);   // settle while scrolling fast
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first, last, items]);

  const cells = [];
  for (let i = first; i <= last && i >= 0; i++) {
    const e = items[i];
    const info = infos.get(e.path);
    const sel = selected.has(e.path);
    const foc = focused === i;
    const common = {
      'data-path': e.path, role: 'option', 'aria-selected': sel, 'data-focused': foc || undefined, title: showFolder ? `${e.name}\n${showFolder(e)}` : e.name,
      onClick: (ev: MouseEvent) => onClick(i, ev), onDoubleClick: () => onOpen(i),
    };
    if (view === 'grid') {
      const r = Math.floor(i / cols), c = i % cols;
      cells.push(
        <div key={e.path} {...common} className={`absolute rounded-xl p-1.5 cursor-default ${sel ? 'bg-accent-soft ring-2 ring-accent' : 'hover:bg-panel-2'} ${foc ? 'outline-2 outline-dashed outline-offset-2 outline-accent' : ''}`}
          style={{ left: left + c * (tile + GAP), top: 8 + r * rowH, width: tile, height: tile + LABEL }}>
          <Thumb entry={e} info={info} px={tile - 12} offline={(e as { offline?: boolean }).offline} />
          <div className="mt-1 text-xs leading-tight line-clamp-1 break-all text-center px-0.5">{e.name}</div>
          <div className="mt-1 flex justify-center overflow-hidden">{tagRow(e, size === 's' ? 0 : size === 'm' ? 1 : 2, true)}</div>
        </div>,
      );
    } else {
      cells.push(
        <div key={e.path} {...common} className={`absolute left-0 right-0 flex items-center gap-3 px-3 text-sm border-b border-line ${sel ? 'bg-accent-soft' : 'hover:bg-panel-2'} ${foc ? 'outline-2 outline-dashed -outline-offset-2 outline-accent' : ''}`}
          style={{ top: i * LIST_ROW, height: LIST_ROW }}>
          <div className="w-7 h-7 shrink-0"><Thumb entry={e} info={info} px={28} small /></div>
          <div className="flex-1 min-w-0 truncate">{e.name}{showFolder && <span className="text-muted text-xs ml-2">{showFolder(e)}</span>}</div>
          <div className="w-16 text-xs text-muted">{e.kind === 'folder' ? 'Folder' : ext(e.name).toUpperCase()}</div>
          <div className="w-20 text-xs text-muted text-right">{e.kind === 'folder' ? '' : fmtBytes(e.size)}</div>
          <div className="w-40 text-xs text-muted">{fmtDate(e.mtime)}</div>
          <div className="w-16 text-xs text-muted text-right">{info?.duration ? fmtClock(info.duration) : ''}</div>
          <div className="w-24 text-xs text-muted text-right">{info?.width ? `${info.width}×${info.height}` : ''}</div>
          <div className="w-52 overflow-hidden">{tagRow(e, 2, false)}</div>
        </div>,
      );
    }
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {view === 'list' && (
        <div className="flex items-center gap-3 px-3 h-8 text-[11px] font-semibold uppercase tracking-wide text-muted border-b border-line shrink-0 pr-5">
          <div className="w-7" /><div className="flex-1">Name</div><div className="w-16">Type</div><div className="w-20 text-right">Size</div>
          <div className="w-40">Date modified</div><div className="w-16 text-right">Length</div><div className="w-24 text-right">Resolution</div><div className="w-52">Stars · labels</div>
        </div>
      )}
      <div ref={box} className="flex-1 min-h-0 overflow-y-auto relative" role="listbox" aria-multiselectable="true" aria-label="Photos and videos"
        onScroll={e => setTop((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: rows * rowH + 16 }} className="relative">{cells}</div>
      </div>
    </div>
  );
}

function Thumb({ entry, info, px, small, offline }: { entry: MediaEntry; info?: MediaInfo; px: number; small?: boolean; offline?: boolean }) {
  if (entry.kind === 'folder') {
    return <div className="flex items-center justify-center text-accent" style={{ width: px, height: px }}><Icon name="folder" size={small ? 18 : px * 0.55} /></div>;
  }
  const raw = RAW_EXTENSIONS.includes(ext(entry.name));
  return (
    <div className={`relative rounded-lg overflow-hidden bg-panel-2 flex items-center justify-center ${offline ? 'opacity-40' : ''}`} style={{ width: px, height: px }}>
      {info?.thumb ? (
        <img src={info.thumb} alt="" className="max-w-full max-h-full object-contain" draggable={false} loading="lazy" />
      ) : (
        <div className="flex flex-col items-center gap-1 text-muted" title={info?.error}>
          <Icon name={entry.kind === 'video' ? 'video' : 'image'} size={small ? 14 : 26} />
          {!small && <span className="text-[10px]">{info?.error ? 'No preview' : ext(entry.name).toUpperCase()}</span>}
        </div>
      )}
      {!small && entry.kind === 'video' && (
        <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/70 text-white text-[10px] px-1 h-4">
          <Icon name="play" size={9} />{info?.duration ? fmtClock(info.duration) : ''}
        </span>
      )}
      {!small && offline && <span className="absolute top-1 right-1 rounded bg-black/80 text-white text-[9px] font-semibold px-1 h-4 leading-4">OFFLINE</span>}
      {!small && raw && <span className="absolute top-1 left-1 rounded bg-black/70 text-white text-[9px] font-semibold px-1 h-4 leading-4">RAW</span>}
    </div>
  );
}
