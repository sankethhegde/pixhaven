// 1.0.8: "People in this video" under the video in Theatre: the people of your sorted folders whose faces appear in
// it, with how sure, when they appear, a few of their photos and the folder those come from (click to open it in
// the Library). Worked out once per video in the background, then remembered.
import { useEffect, useState } from 'react';
import type { MediaEntry, VideoFaces } from '@shared/types';
import { api, errorText, fmtClock } from '../api';
import { Button, Icon, ProgressBar } from './ui';

const openFolder = (dir: string) => (window as unknown as { __clearupLibrary?: (f: string) => void }).__clearupLibrary?.(dir);
const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function VideoPeople({ item, auto }: { item: MediaEntry; auto: boolean }) {
  const [v, setV] = useState<VideoFaces | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setV(null); setError(null);
    const off = api.onVideoFaces(u => { if (u.path === item.path && live) setV(u); });
    void api.videoFaces.get(item.path, item.size, item.mtime).then(r => {
      if (!live) return;
      setV(r);
      if (auto && r.state === 'none') void api.videoFaces.start(item.path, item.size, item.mtime).then(x => live && setV(x)).catch(e => live && setError(errorText(e)));
    }).catch(e => live && setError(errorText(e)));
    return () => { live = false; off(); };
  }, [item.path, item.size, item.mtime, auto]);
  // Leaving the video (or Theatre) stops a search that is still running.
  useEffect(() => () => { void api.videoFaces.cancel(); }, [item.path]);

  const search = () => { setError(null); void api.videoFaces.start(item.path, item.size, item.mtime).then(setV).catch(e => setError(errorText(e))); };
  return (
    <section className="rounded-xl border border-line bg-panel p-4 space-y-3" aria-label="People in this video" data-testid="video-people" data-state={v?.state ?? 'loading'}>
      <div className="flex items-center gap-2">
        <Icon name="people" size={16} className="text-accent" />
        <div className="text-sm font-semibold">People in this video</div>
        {v?.state === 'done' && <span className="text-xs text-muted">{v.people.length ? `${v.people.length} found` : 'nobody you sorted'} · {v.frames} frames looked at, in {v.folders} sorted folder{v.folders === 1 ? '' : 's'}</span>}
        {(v?.state === 'done' || v?.state === 'error') && <Button className="!h-7 ml-auto" variant="ghost" onClick={search}><Icon name="refresh" size={13} />Search again</Button>}
      </div>
      {error && <div className="text-sm text-danger" role="alert">{error}</div>}
      {v?.state === 'none' && (
        <div className="flex items-center gap-3 text-sm text-muted">
          Find the people of your sorted folders in this video.
          <Button className="!h-8" variant="primary" onClick={search}><Icon name="search" size={14} />Find people</Button>
        </div>
      )}
      {v?.state === 'no-people' && <div className="text-sm text-muted">Sort a folder of photos by person first (Sort by person): then the people in it are found in your videos.</div>}
      {v?.state === 'searching' && (
        <div className="space-y-1.5" role="status">
          <div className="text-sm text-muted">Looking for faces… {v.done} of {v.total} frames, in {v.folders} sorted folder{v.folders === 1 ? '' : 's'}</div>
          <ProgressBar value={v.total ? Math.round((v.done / v.total) * 100) : 0} />
        </div>
      )}
      {v?.state === 'error' && <div className="text-sm text-danger" role="alert">Could not look through this video: {v.error}</div>}
      {v?.state === 'done' && !v.people.length && (
        <div className="text-sm text-muted">{v.faces ? `${v.faces} face${v.faces === 1 ? '' : 's'} seen, none of them anyone in your sorted folders.` : 'No faces clear enough to recognise in this video.'}</div>
      )}
      {v?.state === 'done' && v.people.map(p => (
        <div key={p.id} className="flex gap-3 rounded-lg border border-line p-3" data-video-person={p.name}>
          <div className="w-16 shrink-0 text-center">
            <div className="h-16 w-16 rounded-full overflow-hidden bg-panel-2 flex items-center justify-center">
              {p.face ? <img src={p.face} alt="" className="h-full w-full object-cover" /> : <Icon name="people" size={22} className="text-muted" />}
            </div>
            <div className="text-[11px] text-accent font-semibold mt-1" title="How sure PixHaven is that this is them">{p.sure}% sure</div>
          </div>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">seen in {p.frames} frame{p.frames === 1 ? '' : 's'}: {p.times.slice(0, 6).map(fmtClock).join(', ')}{p.times.length > 6 ? '…' : ''}</span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {p.photos.map(ph => (
                <button key={ph.path} onClick={() => openFolder(p.folder ?? p.root)} title={ph.path} className="h-16 w-16 shrink-0 rounded-md overflow-hidden bg-panel-2">
                  <img src={ph.url} alt="" className="h-full w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
            <div className="text-xs text-muted truncate" data-testid="person-folder">
              From <button className="text-accent hover:underline" onClick={() => openFolder(p.folder ?? p.root)} title={p.folder ?? p.root}>{p.folder ?? p.root}</button>
              {p.folder ? <> · sorted folder “{folderName(p.root)}”</> : null}
            </div>
          </div>
        </div>
      ))}
    </section>
  );
}
