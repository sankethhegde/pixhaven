// Home: the big actions (upscale, sort by person), then browsing and the tidy tools.
import { useEffect, useState } from 'react';
import { api, fmtClock } from '../api';
import { DropZone } from '../components/DropZone';
import { Button, Icon } from '../components/ui';
import { ThemeSwitch } from '../components/ThemeSwitch';
import type { MediaInfo, RecentVideo, Settings } from '@shared/types';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  onUpscale: (paths: string[]) => void;
  onSort: (folder: string) => void;
  onTidy: (tab: 'dupes' | 'organize') => void;
  onLibrary: () => void;
  onPlay: (path: string) => void;
}

export function Home({ settings, onSettings, onUpscale, onSort, onTidy, onLibrary, onPlay }: Props) {
  const [over, setOver] = useState(false);
  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-start gap-4 flex-wrap">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold">What would you like to do?</h1>
            <p className="text-muted mt-1">Everything runs on this computer. Your photos never leave it.</p>
          </div>
          <ThemeSwitch settings={settings} onSettings={onSettings} />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-5">
          <section className="space-y-3">
            <div className="flex items-center gap-2 font-semibold"><Icon name="sparkle" size={18} className="text-accent" />Upscale images</div>
            <DropZone onPaths={onUpscale} />
          </section>
          <section className="space-y-3">
            <div className="flex items-center gap-2 font-semibold"><Icon name="people" size={18} className="text-accent" />Sort photos by person</div>
            <div onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={e => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) onSort(api.pathForFile(f)); }}
              className={`rounded-2xl border-2 border-dashed p-8 min-h-[320px] flex flex-col items-center justify-center text-center gap-3 transition ${over ? 'border-accent bg-accent-soft' : 'border-line bg-panel'}`}>
              <div className={`rounded-full p-3 ${over ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-muted'}`}><Icon name="people" size={28} /></div>
              <div className="text-lg font-semibold">Drop a folder of photos</div>
              <p className="text-sm text-muted max-w-xs">PixHaven makes one folder per person. You review everything before any file moves, and you can undo it.</p>
              <Button variant="primary" onClick={async () => { const f = await api.openFolder('Choose a folder of photos to sort'); if (f) onSort(f); }}>
                <Icon name="folder" size={16} />Choose folder
              </Button>
            </div>
          </section>
        </div>
        <section className="space-y-3">
          <div className="flex items-center gap-2 font-semibold"><Icon name="library" size={18} className="text-accent" />Browse my media</div>
          <ToolCard icon="library" title="Browse my media" text="Every drive and folder, showing only photos and videos (phone HEIC, camera RAW, MP4, MKV, AVI…) with thumbnails." onClick={onLibrary} />
          <RecentVideos onPlay={onPlay} />
        </section>
        <section className="space-y-3">
          <div className="flex items-center gap-2 font-semibold"><Icon name="broom" size={18} className="text-accent" />Tidy up</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <ToolCard icon="copy" title="Find duplicates & blurry photos" text="Identical files, resized copies and blurry shots. You pick what to set aside." onClick={() => onTidy('dupes')} />
            <ToolCard icon="calendar" title="Sort by date or place" text="Year / Month or Country / City folders, from the date and GPS saved in each photo." onClick={() => onTidy('organize')} />
          </div>
        </section>
      </div>
    </div>
  );
}

function ToolCard({ icon, title, text, onClick }: { icon: string; title: string; text: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-start gap-4 rounded-2xl border border-line bg-panel p-5 text-left hover:border-accent transition">
      <div className="rounded-full p-2.5 bg-accent-soft text-accent"><Icon name={icon} size={20} /></div>
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-sm text-muted mt-0.5">{text}</div>
      </div>
    </button>
  );
}

/** Recently played videos, newest first, with where you stopped (doc: Home adds a row of recently played videos). */
function RecentVideos({ onPlay }: { onPlay: (path: string) => void }) {
  const [list, setList] = useState<RecentVideo[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, MediaInfo>>({});
  useEffect(() => {
    const add = (i: MediaInfo[]) => setThumbs(t => { const n = { ...t }; for (const x of i) n[x.path] = x; return n; });
    const off = api.onLibThumb(i => add([i]));
    api.player.recent().then(r => {
      setList(r);
      if (r.length) api.lib.thumbs(r.map(v => ({ path: v.path, size: v.size, mtime: v.mtime }))).then(add);
    }).catch(() => {});
    return off;
  }, []);
  if (!list.length) return null;
  const name = (p: string) => p.split(/[\\/]/).pop();
  return (
    <div className="space-y-2" aria-label="Recently played">
      <div className="text-sm text-muted">Recently played</div>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {list.map(v => (
          <button key={v.path} onClick={() => onPlay(v.path)} title={v.path} className="shrink-0 w-44 text-left rounded-xl border border-line bg-panel hover:border-accent overflow-hidden">
            <div className="relative h-24 bg-panel-2 flex items-center justify-center">
              {thumbs[v.path]?.thumb ? <img src={thumbs[v.path].thumb!} alt="" className="h-full w-full object-cover" /> : <Icon name="video" size={24} className="text-muted" />}
              {v.duration > 0 && v.position >= 5 && (
                <div className="absolute bottom-0 inset-x-0 h-1 bg-black/40"><div className="h-full bg-accent" style={{ width: `${Math.min(100, (v.position / v.duration) * 100)}%` }} /></div>
              )}
            </div>
            <div className="px-2.5 py-2">
              <div className="text-sm truncate">{name(v.path)}</div>
              <div className="text-xs text-muted">{v.position >= 5 ? `Stopped at ${fmtClock(v.position)} of ${fmtClock(v.duration)}` : fmtClock(v.duration)}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
