// App shell: sidebar navigation, job queue, GPU badge, battery banner, and the screens.
import { useEffect, useState } from 'react';
import type { GpuStatus, QueueItem, Settings } from '@shared/types';
import { api, errorText } from './api';
import { Home } from './pages/Home';
import { Upscale } from './pages/Upscale';
import { Sort } from './pages/Sort';
import { SettingsPage } from './pages/SettingsPage';
import { Tidy, type TidyTab } from './pages/Tidy';
import { Library } from './pages/Library';
import { Icon, Notice } from './components/ui';

type Page = 'home' | 'library' | 'upscale' | 'sort' | 'tidy' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('home');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [gpu, setGpu] = useState<GpuStatus | null>(null);
  const [dedicated, setDedicated] = useState(false);
  const [version, setVersion] = useState('');
  const [pending, setPending] = useState<string[] | null>(null);
  const [pendingSort, setPendingSort] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [onBattery, setOnBattery] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [tidyTab, setTidyTab] = useState<TidyTab>('dupes');
  const [pendingTidy, setPendingTidy] = useState<string | null>(null);
  const [pendingLib, setPendingLib] = useState<string | null>(null);
  const [pendingPlay, setPendingPlay] = useState<string | null>(null);
  const [libVisited, setLibVisited] = useState(false);

  useEffect(() => {
    api.getSettings().then(setSettings).catch(e => setFatal(errorText(e)));
    api.appInfo().then(async i => {
      setGpu(i.gpu); setDedicated(i.dedicated); setVersion(i.version); setSettings(i.settings); setOnBattery(i.onBattery);
      const s = await api.takePendingSort();
      if (s) { setPendingSort(s); setPage('sort'); }
    }).catch(e => setFatal(errorText(e)));
    api.queueList().then(setQueue);
    const offs = [
      api.onQueue(setQueue),
      api.onPower(p => setOnBattery(p.onBattery)),
      api.onOpenSort(f => { setPendingSort(f); setPage('sort'); }),
    ];
    return () => offs.forEach(o => o());
  }, []);

  // Lets automated end-to-end tests open files without the OS file dialog.
  useEffect(() => {
    const w = window as unknown as { __clearupOpen?: (p: string[]) => void; __clearupSort?: (f: string) => void; __clearupTidy?: (f: string, t: TidyTab) => void; __clearupLibrary?: (f: string) => void };
    w.__clearupLibrary = f => { setPendingLib(f); setPage('library'); };
    w.__clearupTidy = (f, t) => { setTidyTab(t); setPendingTidy(f); setPage('tidy'); };
    w.__clearupOpen = paths => { setPending(paths); setPage('upscale'); };
    w.__clearupSort = f => { setPendingSort(f); setPage('sort'); };
  }, []);

  if (fatal) return <div className="p-8"><Notice tone="danger">PixHaven could not start: {fatal}</Notice></div>;
  if (!settings) return null;

  const allow4k = dedicated || !settings.lowSpec;
  const upscaleFiles = (paths: string[]) => { setPending(paths); setPage('upscale'); };
  const nav: { id: Page; label: string; icon: string }[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'library', label: 'Library', icon: 'library' },
    { id: 'upscale', label: 'Upscale', icon: 'sparkle' },
    { id: 'sort', label: 'Sort by person', icon: 'people' },
    { id: 'tidy', label: 'Tidy up', icon: 'broom' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const running = queue.find(q => q.state === 'running');
  if (page === 'library' && !libVisited) setLibVisited(true);
  const sortFolder = (f: string) => { setPendingSort(f); setPage('sort'); };
  const cpuMode = settings.cpuOnly || (gpu !== null && !gpu.ok);

  return (
    <div className="h-full flex">
      <nav className="w-[200px] shrink-0 bg-panel border-r border-line flex flex-col p-3 gap-1">
        <div className="flex items-center gap-2 px-2 h-12 mb-2">
          <img src="./icon.svg" alt="" className="h-7 w-7" />
          <span className="font-semibold text-base tracking-tight">PixHaven</span>
        </div>
        {nav.map(n => (
          <button key={n.id} onClick={() => setPage(n.id)} aria-current={page === n.id ? 'page' : undefined}
            className={`flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-sm font-medium transition
              ${page === n.id ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg hover:bg-panel-2'}`}>
            <Icon name={n.icon} size={17} />{n.label}
          </button>
        ))}
        <div className="mt-auto space-y-2 relative">
          {queue.length > 0 && (
            <button onClick={() => setShowQueue(!showQueue)} className="w-full text-left rounded-lg border border-line px-2.5 py-2 hover:bg-panel-2" aria-expanded={showQueue}>
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />
                <span className="truncate">{running?.label ?? 'Waiting…'}</span>
              </div>
              <div className="text-[11px] text-muted mt-0.5">{queue.length > 1 ? `${queue.length - 1} more waiting` : 'Job queue'}</div>
            </button>
          )}
          {showQueue && queue.length > 0 && (
            <div className="absolute bottom-full left-0 mb-2 w-72 rounded-xl border border-line bg-panel shadow-xl p-2 z-30" role="dialog" aria-label="Job queue">
              <div className="text-xs font-semibold text-muted px-2 py-1">Jobs run one after another</div>
              {queue.map((q, i) => (
                <div key={q.id} className="flex items-center gap-2 px-2 h-9 text-sm">
                  <span className="text-xs text-muted w-14">{q.state === 'running' ? 'Running' : `#${i}`}</span>
                  <span className="truncate flex-1">{q.label}</span>
                  {q.kind !== 'apply' && q.kind !== 'undo' && (
                    <button onClick={() => api.queueCancel(q.id)} className="text-muted hover:text-danger" aria-label={`Cancel ${q.label}`}><Icon name="x" size={14} /></button>
                  )}
                </div>
              ))}
            </div>
          )}
          <GpuBadge gpu={gpu} lowSpec={settings.lowSpec} cpu={cpuMode} onClick={() => setPage('settings')} />
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col">
        {onBattery && (page === 'upscale' || page === 'sort' || page === 'tidy') && (
          <div className="flex items-center gap-2 px-5 h-9 text-sm bg-warn-soft text-warn border-b border-line shrink-0" role="status">
            <Icon name="battery" size={16} />On battery power: long jobs run slower and drain the battery. Plug in for best speed.
          </div>
        )}
        <div className="flex-1 min-h-0">
          {page === 'home' && <Home settings={settings} onSettings={setSettings} onUpscale={upscaleFiles} onSort={f => { setPendingSort(f); setPage('sort'); }}
            onTidy={tab => { setTidyTab(tab); setPage('tidy'); }} onLibrary={() => setPage('library')}
            onPlay={p => { setPendingLib(p.replace(/[\\/][^\\/]*$/, '')); setPendingPlay(p); setPage('library'); }} />}
          {/* Mounted on first visit, then kept: the folder, scroll position and thumbnails stay. */}
          {libVisited && (
            <div className={page === 'library' ? 'h-full' : 'hidden'}>
              <Library settings={settings} onSettings={setSettings} active={page === 'library'} initialDir={pendingLib} onConsumedInitial={() => setPendingLib(null)}
                initialPlay={pendingPlay} onPlayed={() => setPendingPlay(null)}
                onUpscale={upscaleFiles} onSort={sortFolder} />
            </div>
          )}
          {/* Kept mounted so running jobs and results survive visiting other pages. */}
          <div className={page === 'upscale' ? 'h-full' : 'hidden'}>
            <Upscale settings={settings} allow4k={allow4k} cpuMode={cpuMode} initialPaths={pending} onConsumedInitial={() => setPending(null)} />
          </div>
          <div className={page === 'sort' ? 'h-full' : 'hidden'}>
            <Sort settings={settings} onSettings={setSettings} initialFolder={pendingSort} onConsumedInitial={() => setPendingSort(null)} onUpscale={upscaleFiles} />
          </div>
          <div className={page === 'tidy' ? 'h-full' : 'hidden'}>
            <Tidy settings={settings} onSettings={setSettings} tab={tidyTab} onTab={setTidyTab} initialFolder={pendingTidy} onConsumedInitial={() => setPendingTidy(null)} />
          </div>
          {page === 'settings' && (
            <SettingsPage settings={settings} gpu={gpu} dedicated={dedicated} version={version} onSettings={setSettings}
              onGpu={(g, d) => { setGpu(g); setDedicated(d); }} />
          )}
        </div>
      </main>
    </div>
  );
}

function GpuBadge({ gpu, lowSpec, cpu, onClick }: { gpu: GpuStatus | null; lowSpec: boolean; cpu: boolean; onClick: () => void }) {
  const name = gpu?.vulkan[0] ?? gpu?.gpus[0]?.name;
  return (
    <button onClick={onClick} className="w-full text-left rounded-lg border border-line px-2.5 py-2 hover:bg-panel-2" title="Graphics settings">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <span className={`h-2 w-2 rounded-full ${gpu === null ? 'bg-line' : cpu ? 'bg-warn' : 'bg-ok'}`} />
        <span className="truncate">{gpu === null ? 'Detecting graphics…' : cpu ? 'CPU mode (slower)' : (name ?? 'GPU')}</span>
      </div>
      <div className="text-[11px] text-muted mt-0.5">{lowSpec ? 'Low-spec mode on' : 'Low-spec mode off'}</div>
    </button>
  );
}
