// Settings → Watched folders (v2.1, LIB-08): the folders indexed in the background, their state, add / remove /
// index again. Plus the keyboard shortcuts list.
import { useEffect, useState } from 'react';
import type { WatchedFolder } from '@shared/types';
import { api, errorText } from '../api';
import { Button, Icon, Notice } from './ui';
import { ShortcutList } from './Shortcuts';

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet');

export function WatchedSettings() {
  const [list, setList] = useState<WatchedFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.watch.list().then(setList); return api.onWatchStatus(setList); }, []);
  const act = (p: Promise<WatchedFolder[] | null>) => p.then(r => { if (r) setList(r); setError(null); }, e => setError(errorText(e)));
  return (
    <section className="rounded-2xl border border-line bg-panel p-5 space-y-4" aria-label="Watched folders settings">
      <div className="flex items-center">
        <h2 className="font-semibold">Watched folders</h2>
        <Button className="ml-auto" onClick={() => act(api.watch.choose())}>Add a folder…</Button>
      </div>
      <p className="text-xs text-muted leading-relaxed">
        PixHaven keeps a list of the photos and videos in these folders (and all folders inside them), so search, labels and filters work
        without opening them first, and new, renamed, moved or deleted files show up by themselves. Indexing runs in the background,
        pauses while a video plays, and carries on where it stopped. Labels and stars follow files you move or rename between watched folders.
      </p>
      {list.length === 0 && <div className="text-sm text-muted">No watched folders yet — for example your Pictures and Videos folders.</div>}
      <div className="space-y-1">
        {list.map(w => (
          <div key={w.path} className="flex items-center gap-3 rounded-lg px-3 py-2 bg-panel-2" data-watched={w.path}>
            <Icon name={w.state === 'offline' ? 'usb' : 'eye'} size={16} className="text-muted shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm truncate selectable" title={w.path}>{w.path}</div>
              <div className="text-xs text-muted">
                {w.state === 'indexing' ? `Indexing… ${w.scanned.toLocaleString()} found so far`
                  : w.state === 'paused' ? `Indexing paused while a video plays (${w.scanned.toLocaleString()} so far)`
                  : w.state === 'waiting' ? 'Waiting to be indexed'
                  : w.state === 'offline' ? `Not connected — ${w.files.toLocaleString()} files kept from last time`
                  : `${w.files.toLocaleString()} photos and videos · indexed ${when(w.lastScan)}${w.live ? '' : ' · checked every 15 minutes (changes on this drive can’t be watched live)'}`}
              </div>
            </div>
            <Button className="!h-8" variant="ghost" disabled={w.state === 'offline'} onClick={() => act(api.watch.reindex(w.path))}>Index again</Button>
            <Button className="!h-8" variant="ghost" onClick={() => act(api.watch.remove(w.path))} aria-label={`Stop watching ${w.path}`}>Remove</Button>
          </div>
        ))}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
    </section>
  );
}

export function ShortcutsSettings() {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5 space-y-4" aria-label="Keyboard shortcuts">
      <h2 className="font-semibold">Keyboard shortcuts</h2>
      <ShortcutList columns={3} />
    </section>
  );
}
