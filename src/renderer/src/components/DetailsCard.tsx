// v1.0.4: a card on the right of the grid with the details of the selected photo or video (Library and Photos tabs).
// One item: preview, name, folder, size, dates, and what FFprobe / ExifTool can tell (length, resolution, codec,
// frame rate, bitrate, audio; date taken, camera, lens, exposure), plus stars, labels and people. Several: a summary.
// Facts are read only for the item selected, a moment after the selection settles (arrow keys stay quick).
import { useEffect, useState, type ReactNode } from 'react';
import type { FileDetails, MediaEntry, MediaInfo } from '@shared/types';
import { api, errorText, fmtBytes, fmtClock } from '../api';
import { Icon } from './ui';
import { TagEditor } from './Tags';
import * as T from '../tags';

const cache = new Map<string, FileDetails>();
const keyOf = (e: MediaEntry) => `${e.path}|${e.size}|${e.mtime}`;
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/** Open / closed, remembered; toggled with I or the card's button. */
export function useDetailsOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => store.get('details.open') !== '0');
  return [open, (o: boolean) => { setOpen(o); store.set('details.open', o ? '1' : '0'); }];
}

const date = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
/** ExifTool's "2024:05:01 10:22:13+05:30" → a local date. */
export function takenText(s: string): string {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return s;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return isNaN(d.getTime()) ? s : date(d.getTime());
}
const bitrate = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} Mbit/s` : `${Math.round(b / 1e3)} kbit/s`);
const megapixels = (w: number, h: number) => { const mp = (w * h) / 1e6; return mp >= 0.1 ? ` · ${mp >= 10 ? Math.round(mp) : mp.toFixed(1)} MP` : ''; };

interface Props {
  items: MediaEntry[];                       // the selection, in grid order
  infos: Map<string, MediaInfo>;             // thumbnails (and quick facts) already loaded
  onOpen?: (e: MediaEntry) => void;
  onClose: () => void;
  all?: MediaEntry[];                        // 1.0.5: everything shown — its totals when nothing is selected
  allTitle?: string;                         // "In this folder", "In this view"…
}

export function DetailsCard({ items, infos, onOpen, onClose, all, allTitle = 'In this folder' }: Props) {
  const one = items.length === 1 ? items[0] : null;
  const [details, setDetails] = useState<FileDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { labels } = T.useTags();
  const k = one ? keyOf(one) : '';

  useEffect(() => {
    setError(null);
    if (!one) { setDetails(null); return; }
    const hit = cache.get(k);
    setDetails(hit ?? null);
    if (hit) return;
    let live = true;
    const t = setTimeout(() => {
      api.lib.details(one.path).then(d => {
        if (cache.size > 500) cache.delete(cache.keys().next().value!);
        cache.set(k, d);
        if (live) setDetails(d);
      }).catch(e => { if (live) setError(errorText(e)); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);

  return (
    <aside className="w-[300px] shrink-0 border-l border-line bg-panel overflow-y-auto" aria-label="Details" data-testid="details-card">
      <div className="flex items-center gap-2 px-4 h-11 border-b border-line sticky top-0 bg-panel z-10">
        <Icon name="info" size={15} className="text-muted" />
        <span className="text-sm font-semibold">Details</span>
        <button className="ml-auto h-7 w-7 rounded hover:bg-panel-2 flex items-center justify-center text-muted hover:text-fg" onClick={onClose}
          aria-label="Hide details" title="Hide details (I)"><Icon name="x" size={14} /></button>
      </div>
      {!items.length ? (all?.length ? <Many items={all} infos={infos} title={allTitle} summary />
          : <div className="p-4 text-sm text-muted">{all ? 'Nothing here.' : 'Select a photo or video to see its details.'}</div>)
        : one ? <One e={one} info={infos.get(one.path)} d={details} error={error} labelNames={id => labels.find(l => l.id === id)} onOpen={onOpen} />
        : <Many items={items} infos={infos} />}
    </aside>
  );
}

function Row({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <div className="grid grid-cols-[92px_1fr] gap-2 py-1 text-sm" data-detail={testid ?? label}>
      <dt className="text-muted">{label}</dt><dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function One({ e, info, d, error, labelNames, onOpen }: {
  e: MediaEntry; info?: MediaInfo; d: FileDetails | null; error: string | null;
  labelNames: (id: number) => { name: string; color: string | null } | undefined; onOpen?: (e: MediaEntry) => void;
}) {
  const folder = e.path.replace(/[\\/][^\\/]*$/, '');
  const w = d?.width ?? info?.width, h = d?.height ?? info?.height;
  const duration = d?.duration ?? info?.duration;
  const offline = !!(e as { offline?: boolean }).offline;
  return (
    <div className="p-4 space-y-3">
      {e.kind !== 'folder' && (
        <button className="w-full aspect-video rounded-lg bg-panel-2 flex items-center justify-center overflow-hidden relative" onClick={() => onOpen?.(e)}
          title={e.kind === 'video' ? 'Play' : 'Open'} disabled={!onOpen || offline}>
          {info?.thumb ? <img src={info.thumb} alt="" className="max-w-full max-h-full object-contain" draggable={false} />
            : <Icon name={e.kind === 'video' ? 'video' : 'image'} size={28} className="text-muted" />}
          {e.kind === 'video' && duration ? <span className="absolute bottom-1.5 right-1.5 text-[11px] px-1.5 rounded bg-black/70 text-white">{fmtClock(duration)}</span> : null}
        </button>
      )}
      <div>
        <div className="font-semibold text-sm break-all" data-testid="details-name">{e.name}</div>
        <div className="text-xs text-muted break-all mt-0.5" title={folder}>{folder}</div>
      </div>
      <dl>
        <Row label="Type">{e.kind === 'folder' ? 'Folder' : `${e.kind === 'video' ? 'Video' : 'Photo'}${d?.format ? ` · ${d.format}` : ''}`}</Row>
        {e.kind !== 'folder' && <Row label="Size">{fmtBytes(e.size)}</Row>}
        {w && h ? <Row label="Resolution" testid="resolution">{w} × {h}{e.kind === 'image' ? megapixels(w, h) : ''}</Row> : null}
        {e.kind === 'video' && duration ? <Row label="Length" testid="length">{fmtClock(duration)}</Row> : null}
        {d?.videoCodec && <Row label="Video" testid="codec">{d.videoCodec}{d.fps ? ` · ${d.fps} fps` : ''}</Row>}
        {d?.bitrate ? <Row label="Bitrate">{bitrate(d.bitrate)}</Row> : null}
        {d?.audio?.length ? <Row label="Audio">{d.audio.join(', ')}</Row> : e.kind === 'video' && d && !d.error ? <Row label="Audio">None</Row> : null}
        {d?.taken && <Row label="Taken" testid="taken">{takenText(d.taken)}</Row>}
        {d?.camera && <Row label="Camera" testid="camera">{d.camera}</Row>}
        {d?.lens && <Row label="Lens">{d.lens}</Row>}
        {d?.exposure && <Row label="Exposure">{d.exposure}</Row>}
        <Row label="Modified">{date(d?.modified ?? e.mtime)}</Row>
        {d?.created ? <Row label="Created">{date(d.created)}</Row> : null}
        {d?.people?.length ? <Row label="People">{d.people.join(', ')}</Row> : null}
      </dl>
      {/* 1.0.5: stars and labels, changed right here (written into the file like "Labels & stars") */}
      {e.kind !== 'folder' && !offline && <TagSection items={[e]} />}
      {!d && !error && !offline && e.kind !== 'folder' && <div className="text-xs text-muted" role="status">Reading details…</div>}
      {offline && <div className="text-xs text-muted">On a drive that is not connected.</div>}
      {(error || d?.error) && <div className="text-xs text-danger" role="alert">Some details could not be read: {error ?? d?.error}</div>}
      {!offline && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {onOpen && <SmallButton onClick={() => onOpen(e)} icon={e.kind === 'video' ? 'play' : e.kind === 'folder' ? 'folder' : 'image'}>{e.kind === 'video' ? 'Play' : 'Open'}</SmallButton>}
          <SmallButton onClick={() => void api.showItem(e.path)} icon="external">Show in Explorer</SmallButton>
          <SmallButton onClick={() => void api.copyText(e.path)} icon="copy">Copy path</SmallButton>
        </div>
      )}
    </div>
  );
}

/** Stars and labels of one or several photos and videos; several: "mixed" stars and how many carry each label. */
function TagSection({ items }: { items: MediaEntry[] }) {
  const taggable = items.filter(e => e.kind !== 'folder' && !(e as { offline?: boolean }).offline);
  if (!taggable.length) return null;
  return (
    <div className="border-t border-line pt-3" data-testid="details-tags">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted mb-2">Stars & labels{taggable.length > 1 ? ` · ${taggable.length} items` : ''}</div>
      <TagEditor items={taggable} />
    </div>
  );
}

function Many({ items, infos, title, summary }: { items: MediaEntry[]; infos: Map<string, MediaInfo>; title?: string; summary?: boolean }) {
  const videos = items.filter(e => e.kind === 'video'), photos = items.filter(e => e.kind === 'image'), folders = items.filter(e => e.kind === 'folder');
  const size = items.reduce((n, e) => n + (e.kind === 'folder' ? 0 : e.size), 0);
  const known = videos.map(v => infos.get(v.path)?.duration).filter((x): x is number => !!x);
  const length = known.reduce((n, x) => n + x, 0);
  const times = items.filter(e => e.kind !== 'folder').map(e => e.mtime).sort((a, b) => a - b);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <div className="p-4 space-y-3">
      <div className="grid grid-cols-3 gap-1.5">
        {items.slice(0, 6).map(e => {
          const t = infos.get(e.path)?.thumb;
          return (
            <div key={e.path} className="aspect-square rounded bg-panel-2 overflow-hidden flex items-center justify-center">
              {t ? <img src={t} alt="" className="w-full h-full object-cover" draggable={false} /> : <Icon name={e.kind === 'video' ? 'video' : e.kind === 'folder' ? 'folder' : 'image'} size={18} className="text-muted" />}
            </div>
          );
        })}
      </div>
      <div className="font-semibold text-sm" data-testid="details-name">{summary ? title : `${plural(items.length, 'item')} selected`}</div>
      <dl>
        {summary && <Row label="Files" testid="total-files">{(photos.length + videos.length).toLocaleString()}</Row>}
        {photos.length > 0 && <Row label="Photos">{photos.length}</Row>}
        {videos.length > 0 && <Row label="Videos">{videos.length}</Row>}
        {folders.length > 0 && <Row label="Folders">{folders.length}</Row>}
        {size > 0 && <Row label="Total size" testid="total-size">{fmtBytes(size)}{folders.length ? ' (not counting folders)' : ''}</Row>}
        {length > 0 && <Row label="Total length" testid="total-length">{fmtClock(length)}{known.length < videos.length ? ` (${known.length} of ${videos.length} videos)` : ''}</Row>}
        {times.length > 1 && <Row label="Modified">{date(times[0])} – {date(times[times.length - 1])}</Row>}
      </dl>
      {summary ? <div className="text-xs text-muted">Select a photo or video to see its details, or several to rate and label them together.</div> : <TagSection items={items} />}
    </div>
  );
}

function SmallButton({ onClick, icon, children }: { onClick: () => void; icon: string; children: ReactNode }) {
  return (
    <button onClick={onClick} className="h-8 px-2.5 rounded-lg border border-line text-xs flex items-center gap-1.5 hover:bg-panel-2">
      <Icon name={icon as never} size={13} />{children}
    </button>
  );
}
