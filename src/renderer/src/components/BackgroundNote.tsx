// 1.1.2: what PixHaven is doing in the background on its own (keeping watched folders up to date), with Pause. Shown in
// the sidebar only while it works or waits, so the fans are never a mystery. Jobs you start have the job queue.
import { useEffect, useState } from 'react';
import type { WatchedFolder } from '@shared/types';
import { api } from '../api';
import { Icon } from './ui';

const nameOf = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

export function BackgroundNote() {
  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [why, setWhy] = useState<string[]>([]);
  useEffect(() => {
    const read = () => void api.watch.pausedBy().then(setWhy).catch(() => {});
    void api.watch.list().then(setFolders);
    read();
    const off = api.onWatchStatus(s => { setFolders(s); read(); });
    return off;
  }, []);
  const busy = folders.find(f => f.state === 'indexing' || f.state === 'paused');
  if (!busy) return null;
  const byUser = why.includes('user'), byBattery = why.includes('battery');
  const paused = busy.state === 'paused';
  return (
    <div className="rounded-lg border border-line px-2.5 py-2 text-xs" role="status" data-testid="background-note" data-state={paused ? 'paused' : 'working'}>
      <div className="flex items-center gap-1.5 font-medium">
        {paused ? <Icon name="pause" size={12} className="text-muted" /> : <span className="h-3 w-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />}
        <span className="truncate">{paused ? 'Paused' : 'Working in the background'}</span>
      </div>
      <div className="text-[11px] text-muted mt-0.5 truncate" title={busy.path}>
        {paused ? (byBattery && !byUser ? `On battery: ${nameOf(busy.path)} is checked when plugged in` : `Checking ${nameOf(busy.path)} is paused`) : `Checking ${nameOf(busy.path)} for photos and videos${busy.scanned ? ` · ${busy.scanned.toLocaleString()} found` : ''}`}
      </div>
      {(!paused || byUser) && (
        <button className="mt-1 text-accent hover:underline" onClick={() => void api.watch.pauseUser(!byUser).then(() => api.watch.pausedBy().then(setWhy))} data-testid="background-pause">
          {byUser ? 'Resume' : 'Pause'}
        </button>
      )}
    </div>
  );
}
