// v2.8.1 "Move to…" / "Copy to…" inside PixHaven (Photos and Library). Windows' own folder picker returns the folder it
// is showing when a just-made folder is not selected, so "move to a new folder" moved nothing. Here the user browses
// folders, sees which one the items are in now ("here"), and can make a new folder and move into it in one step.
// "Other folder…" still opens the Windows picker for anywhere else.
import { useEffect, useState } from 'react';
import type { FileOpResult, MediaEntry } from '@shared/types';
import { api, errorText } from '../api';
import { Button, Icon } from './ui';

interface Props {
  mode: 'copy' | 'move';
  paths: string[];
  start: string;                 // folder shown first (the sorted folder, or the folder open in the Library)
  onDone: (r: FileOpResult) => void;
  onClose: () => void;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const parentOf = (p: string) => { const t = p.replace(/[\\/]+$/, ''); const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')); return i > 2 ? t.slice(0, i) : i === 2 ? t.slice(0, 3) : null; };
const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function MoveDialog({ mode, paths, start, onDone, onClose }: Props) {
  const [dir, setDir] = useState(start);
  const [folders, setFolders] = useState<MediaEntry[]>([]);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verb = mode === 'move' ? 'Move' : 'Copy';
  const what = `${paths.length} item${paths.length === 1 ? '' : 's'}`;
  const homes = new Set(paths.map(p => (parentOf(p) ?? '').toLowerCase()));
  const isHere = (d: string) => mode === 'move' && homes.has(d.replace(/[\\/]+$/, '').toLowerCase());
  const moving = (d: string) => paths.some(p => same(p, d));       // a folder can't go into itself

  useEffect(() => {
    let live = true;
    api.lib.list(dir).then(l => { if (live) setFolders(l.entries.filter(e => e.kind === 'folder')); }).catch(e => live && setError(errorText(e)));
    return () => { live = false; };
  }, [dir]);

  const go = async (dest: string) => {
    if (isHere(dest)) { setError(`Already in “${baseName(dest)}”. Choose another folder.`); return; }
    setBusy(true); setError(null);
    try { onDone(await api.files.paste(paths, dest, mode)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const intoNew = async () => {
    setBusy(true); setError(null);
    try { const made = await api.files.newFolder(dir, newName); setBusy(false); await go(made); }
    catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const other = async () => {
    const f = await api.openFolder(`${verb} ${what} to…`);
    if (f) await go(f);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div className="w-[520px] max-h-[80vh] flex flex-col rounded-2xl bg-panel border border-line shadow-2xl p-5 gap-3" onClick={e => e.stopPropagation()} role="dialog" aria-label={`${verb} to`}>
        <div className="font-semibold">{verb} {what} to…</div>
        <div className="flex items-center gap-2 text-sm min-w-0">
          <Button className="!h-8" variant="ghost" disabled={!parentOf(dir)} onClick={() => { const p = parentOf(dir); if (p) setDir(p); }} title="Up"><Icon name="up" size={15} /></Button>
          <span className="truncate selectable" title={dir}>{dir}</span>
        </div>
        <div className="flex-1 min-h-[160px] overflow-auto rounded-xl border border-line divide-y divide-line" role="list" aria-label="Folders">
          {folders.length === 0 && <div className="p-3 text-sm text-muted">No folders here.</div>}
          {folders.map(f => (
            <div key={f.path} className="flex items-center gap-2 px-3 h-10 hover:bg-panel-2" role="listitem" data-move-folder={f.name}>
              <button className="flex items-center gap-2 min-w-0 flex-1 text-left text-sm" onClick={() => setDir(f.path)} title="Open">
                <Icon name="folder" size={15} className="text-accent shrink-0" /><span className="truncate">{f.name}</span>
                {isHere(f.path) && <span className="text-xs text-muted">(here)</span>}
              </button>
              <Button className="!h-7 text-xs" disabled={busy || isHere(f.path) || moving(f.path)} onClick={() => void go(f.path)}>{verb} here</Button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input value={newName} onChange={e => { setNewName(e.target.value); setError(null); }} placeholder="New folder name" aria-label="New folder name"
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) void intoNew(); if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
            className="flex-1 h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
          <Button variant="primary" disabled={busy || !newName.trim()} onClick={() => void intoNew()}><Icon name="folder" size={15} />New folder and {verb.toLowerCase()}</Button>
        </div>
        <div className="text-xs text-muted">The new folder is made in “{baseName(dir) || dir}”.</div>
        {error && <div className="text-sm text-danger" role="alert">{error}</div>}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void other()} disabled={busy}>Other folder…</Button>
          <span className="mr-auto" />
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || isHere(dir) || paths.some(p => same(p, dir))} onClick={() => void go(dir)}>{verb} into “{baseName(dir) || dir}”</Button>
        </div>
      </div>
    </div>
  );
}
