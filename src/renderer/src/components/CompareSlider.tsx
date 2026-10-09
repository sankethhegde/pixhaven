// Before/after comparison with a draggable divider, mouse-wheel zoom and drag-to-pan (IMG-05).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { Icon } from './ui';

interface Props {
  beforeUrl: string;
  afterUrl?: string;
  width: number;   // pixel size of the result (or the input when there is no result yet)
  height: number;
}

export function CompareSlider({ beforeUrl, afterUrl, width, height }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [split, setSplit] = useState(0.5);  // divider position, fraction of the viewer width
  const [zoom, setZoom] = useState(1);      // 1 = whole image fits
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ kind: 'split' | 'pan'; x: number; y: number; px: number; py: number } | null>(null);

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // A new image resets the view.
  useEffect(() => { setZoom(1); setPan({ x: 0, y: 0 }); setSplit(0.5); }, [beforeUrl, afterUrl]);

  const fit = Math.min(size.w / width, size.h / height) || 0;
  const fitW = width * fit, fitH = height * fit;
  const maxZoom = Math.max(8, (1 / fit) * 4);
  const stageW = fitW * zoom, stageH = fitH * zoom;

  const clampPan = useCallback((x: number, y: number, z: number) => {
    const sw = fitW * z, sh = fitH * z;
    const mx = Math.max(0, (sw - size.w) / 2), my = Math.max(0, (sh - size.h) / 2);
    return { x: Math.max(-mx, Math.min(mx, x)), y: Math.max(-my, Math.min(my, y)) };
  }, [fitW, fitH, size]);

  const left = (size.w - stageW) / 2 + pan.x;
  const top = (size.h - stageH) / 2 + pan.y;

  const zoomTo = (z: number, cx = size.w / 2, cy = size.h / 2) => {
    const nz = Math.max(1, Math.min(maxZoom, z));
    // Keep the point under (cx, cy) in place.
    const rx = (cx - left) / stageW, ry = (cy - top) / stageH;
    const nl = cx - rx * fitW * nz, nt = cy - ry * fitH * nz;
    setZoom(nz);
    setPan(clampPan(nl - (size.w - fitW * nz) / 2, nt - (size.h - fitH * nz) / 2, nz));
  };

  const onWheel = (e: WheelEvent) => {
    const r = box.current!.getBoundingClientRect();
    zoomTo(zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX - r.left, e.clientY - r.top);
  };
  const onDown = (e: PointerEvent, kind: 'split' | 'pan') => {
    if (kind === 'pan' && zoom <= 1) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'split') {
      const r = box.current!.getBoundingClientRect();
      setSplit(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    } else {
      setPan(clampPan(d.px + e.clientX - d.x, d.py + e.clientY - d.y, zoom));
    }
  };
  const onUp = () => { drag.current = null; };

  const clipLeft = Math.max(0, split * size.w - left);
  const actualPixels = 1 / fit; // zoom level that shows 1 image pixel per screen pixel

  return (
    <div className="flex flex-col h-full min-h-0">
      <div ref={box} onWheel={onWheel} onPointerMove={onMove} onPointerUp={onUp} onPointerDown={e => onDown(e, 'pan')}
        className={`relative flex-1 min-h-0 overflow-hidden rounded-xl checker ${zoom > 1 ? 'cursor-grab active:cursor-grabbing' : ''}`}>
        {fit > 0 && (
          <div className="absolute" style={{ left, top, width: stageW, height: stageH }}>
            <img src={beforeUrl} alt="Original" draggable={false} className="absolute inset-0 w-full h-full" />
            {afterUrl && (
              <img src={afterUrl} alt="Upscaled" draggable={false} className="absolute inset-0 w-full h-full"
                style={{ clipPath: `inset(0 0 0 ${clipLeft}px)` }} />
            )}
          </div>
        )}
        {afterUrl && (
          <>
            <span className="absolute top-3 left-3 rounded-md bg-black/60 text-white text-xs font-medium px-2 py-1 pointer-events-none">Before</span>
            <span className="absolute top-3 right-3 rounded-md bg-black/60 text-white text-xs font-medium px-2 py-1 pointer-events-none">After</span>
            <div className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_0_1px_rgba(0,0,0,.25)] pointer-events-none" style={{ left: split * size.w - 1 }} />
            <button aria-label="Drag to compare" onPointerDown={e => onDown(e, 'split')}
              onKeyDown={e => { if (e.key === 'ArrowLeft') setSplit(s => Math.max(0, s - 0.05)); if (e.key === 'ArrowRight') setSplit(s => Math.min(1, s + 0.05)); }}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-10 w-10 rounded-full bg-white text-black shadow-lg flex items-center justify-center cursor-ew-resize"
              style={{ left: split * size.w }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 7-5 5 5 5M15 7l5 5-5 5" /></svg>
            </button>
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 pt-2 text-xs text-muted">
        <span>{width.toLocaleString()} × {height.toLocaleString()} px{afterUrl ? ' · scroll to zoom, drag to move' : ''}</span>
        <div className="flex items-center gap-1">
          <ZoomBtn label="Zoom out" icon="zoomOut" onClick={() => zoomTo(zoom / 1.5)} />
          <span className="w-14 text-center tabular-nums">{Math.round(zoom * fit * 100)}%</span>
          <ZoomBtn label="Zoom in" icon="zoomIn" onClick={() => zoomTo(zoom * 1.5)} />
          <ZoomBtn label="Fit to window" icon="fit" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} />
          <button onClick={() => zoomTo(actualPixels)} className="h-7 px-2 rounded-md hover:bg-panel-2 hover:text-fg font-medium">100%</button>
        </div>
      </div>
    </div>
  );
}

function ZoomBtn({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="h-7 w-7 rounded-md flex items-center justify-center hover:bg-panel-2 hover:text-fg">
      <Icon name={icon} size={16} />
    </button>
  );
}
