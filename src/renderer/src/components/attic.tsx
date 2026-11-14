// 1.0.7: Attic in the window — whether it is connected (one shared status for every tab), the dialog that picks an
// Attic folder ("Move to Attic" / "Copy to Attic"), the transfer progress, and the "Move to Attic" button (blue only
// when Attic is connected).
import { useEffect, useState } from 'react';
import type { AtticShareInfo, AtticStatus, AtticTransfer, MediaEntry } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import { Button, Icon, ProgressBar } from './ui';

// ---------- the status, shared ----------
let status: AtticStatus = { state: 'none' };
const subs = new Set<(s: AtticStatus) => void>();
const set = (s: AtticStatus) => { status = s; for (const f of subs) f(s); };
api.onAtticStatus(set);
void api.attic.current().then(set).catch(() => {});
export function useAttic(): AtticStatus {
  const [s, setS] = useState(status);
  useEffect(() => { subs.add(setS); setS(status); return () => { subs.delete(setS); }; }, []);
  return s;
}
export const atticConnected = (s: AtticStatus) => s.state === 'connected';
export const isAtticPath = (p: string) => p.startsWith('attic://');
export function atticHint(s: AtticStatus): string {
  return s.state === 'none' ? 'Set up Attic first (the Attic tab).' : s.state === 'offline' ? `Attic${s.name ? ` (${s.name})` : ''} is not answering.`
    : s.state === 'unpaired' ? 'Pair PixHaven with Attic first (the Attic tab).' : s.state === 'signed-out' ? 'Sign in to Attic first (the Attic tab).' : '';
}

// ---------- transfers ----------
let transfers: AtticTransfer[] = [];
const tsubs = new Set<(t: AtticTransfer[]) => void>();
const doneSubs = new Set<(t: AtticTransfer) => void>();
api.onAtticTransfer(t => {
  transfers = [...transfers.filter(x => x.id !== t.id), t];
  for (const f of tsubs) f(transfers);
  if (t.finished) for (const f of doneSubs) f(t);
});
/** Called when a transfer finishes (to show the folder again). */
export function useTransferDone(fn: (t: AtticTransfer) => void) {
  useEffect(() => { doneSubs.add(fn); return () => { doneSubs.delete(fn); }; }, [fn]);
}
const fileName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
/** A strip across the top of the window while files go to or come from Attic, and the result after. */
export function AtticTransfers() {
  const [list, setList] = useState(transfers);
  useEffect(() => { tsubs.add(setList); return () => { tsubs.delete(setList); }; }, []);
  const shown = list.slice(-2);
  if (!shown.length) return null;
  return (
    <div className="shrink-0 border-b border-line" data-testid="attic-transfers">
      {shown.map(t => {
        const verb = `${t.move ? 'Moving' : 'Copying'} ${t.kind === 'to-attic' ? 'to Attic' : 'to this PC'}`;
        const pct = t.totalBytes ? Math.round((t.bytes / t.totalBytes) * 100) : 0;
        return (
          <div key={t.id} className={`flex items-center gap-3 px-5 h-10 text-sm ${t.finished ? (t.failed.length ? 'bg-warn-soft' : 'bg-accent-soft') : 'bg-panel-2'}`} role="status" data-transfer={t.finished ? 'done' : 'running'}>
            <Icon name="attic" size={16} className="text-accent shrink-0" />
            {t.finished ? (
              <span className="truncate" data-testid="transfer-result">
                {`${t.move ? 'Moved' : 'Copied'} ${t.done} of ${t.files} file${t.files === 1 ? '' : 's'} ${t.kind === 'to-attic' ? 'to Attic' : 'to this PC'}`}
                {t.failed.length ? `; ${t.failed.length} could not be: ${fileName(t.failed[0].path)} (${t.failed[0].reason})` : '.'}
                {t.move && t.done && t.kind === 'to-attic' ? ' The originals are in the Recycle Bin.' : ''}
                {t.move && t.done && t.kind === 'from-attic' ? ' The originals are in Attic\'s trash for 30 days.' : ''}
              </span>
            ) : (
              <>
                <span className="shrink-0">{verb}: {t.done} of {t.files}</span>
                <div className="w-48 shrink-0"><ProgressBar value={pct} /></div>
                <span className="text-muted truncate">{fmtBytes(t.bytes)} of {fmtBytes(t.totalBytes)}{t.current ? ` · ${t.current}` : ''}</span>
              </>
            )}
            {t.finished && <button className="ml-auto text-muted hover:text-fg" onClick={() => { transfers = transfers.filter(x => x.id !== t.id); for (const f of tsubs) f(transfers); }} aria-label="Dismiss"><Icon name="x" size={14} /></button>}
          </div>
        );
      })}
    </div>
  );
}

// ---------- choosing a folder on Attic ----------
/** Picks a folder on Attic (any share), with "New folder", and whether to move or copy. */
export function AtticFolderPicker({ count, defaultMove = true, within = false, onPick, onClose }: { count: number; defaultMove?: boolean; within?: boolean; onPick: (dest: string, move: boolean) => void; onClose: () => void }) {
  const [shares, setShares] = useState<AtticShareInfo[] | null>(null);
  const [at, setAt] = useState<string | null>(() => { try { return localStorage.getItem('attic.lastFolder'); } catch { return null; } });
  const [folders, setFolders] = useState<MediaEntry[] | null>(null);
  const [move, setMove] = useState(defaultMove);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  useEffect(() => { void api.attic.shares().then(s => { setShares(s); if (!at && s[0]) setAt(s[0].path); }).catch(e => setError(errorText(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!at) return;
    setFolders(null);
    void api.attic.list(at).then(l => setFolders(l.entries.filter(e => e.kind === 'folder'))).catch(e => { setError(errorText(e)); if (shares?.[0] && at !== shares[0].path) setAt(shares[0].path); });
  }, [at]); // eslint-disable-line react-hooks/exhaustive-deps
  const parts = at ? at.slice('attic://'.length).split('/') : [];
  const shareName = shares?.find(s => s.id === parts[0])?.name ?? parts[0];
  const up = parts.length > 1 ? `attic://${parts.slice(0, -1).join('/')}` : null;
  const makeFolder = async () => {
    if (!at || !making?.trim()) return;
    try { const p = await api.attic.newFolder(at, making.trim()); setMaking(null); setAt(p); } catch (e) { setError(errorText(e)); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div className="w-[520px] max-h-[80vh] flex flex-col rounded-2xl bg-panel border border-line shadow-2xl" onClick={e => e.stopPropagation()} role="dialog" aria-label="Choose a folder on Attic">
        <div className="flex items-center gap-2 px-5 h-14 border-b border-line">
          <Icon name="attic" size={18} className="text-accent" />
          <div className="font-semibold">{move || within ? 'Move' : 'Copy'} {count} item{count === 1 ? '' : 's'} to {within ? 'another Attic folder' : 'Attic'}</div>
          <button className="ml-auto h-8 w-8 rounded-lg hover:bg-panel-2 flex items-center justify-center" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="flex items-center gap-1 px-4 py-2 border-b border-line text-sm flex-wrap">
          {shares?.map(s => (
            <button key={s.id} onClick={() => setAt(s.path)} className={`h-8 px-3 rounded-lg ${parts[0] === s.id ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`} data-attic-share={s.name}>
              <Icon name="drive" size={13} className="inline mr-1" />{s.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 px-4 h-10 text-sm text-muted">
          <button disabled={!up} onClick={() => up && setAt(up)} className="h-7 w-7 rounded hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" aria-label="Up one folder"><Icon name="up" size={14} /></button>
          <span className="truncate" data-testid="picker-at">{[shareName, ...parts.slice(1)].join(' › ')}</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-2 min-h-[180px]">
          {folders === null && !error && <div className="p-3 text-sm text-muted">Loading…</div>}
          {folders?.map(f => (
            <button key={f.path} onClick={() => setAt(f.path)} data-attic-folder={f.name}
              className="w-full flex items-center gap-2 px-2 h-9 rounded-lg text-sm text-left hover:bg-panel-2">
              <Icon name="folder" size={15} className="text-accent" /><span className="truncate">{f.name}</span><Icon name="chevron" size={12} className="ml-auto text-muted" />
            </button>
          ))}
          {folders?.length === 0 && <div className="p-3 text-sm text-muted">No folders here. The files go straight into this one.</div>}
          {making !== null ? (
            <div className="flex gap-2 px-2 pt-2">
              <input autoFocus value={making} onChange={e => setMaking(e.target.value)} aria-label="New folder name" placeholder="Folder name"
                onKeyDown={e => { if (e.key === 'Enter') void makeFolder(); if (e.key === 'Escape') { setMaking(null); e.stopPropagation(); } }}
                className="flex-1 h-8 rounded-lg bg-panel-2 border border-accent px-2 text-sm outline-none" />
              <Button className="!h-8" variant="primary" onClick={() => void makeFolder()}>Make</Button>
            </div>
          ) : <button className="mx-2 mt-1 text-sm text-accent hover:underline" onClick={() => setMaking('New folder')}>+ New folder here</button>}
        </div>
        {error && <div className="px-5 py-2 text-sm text-danger border-t border-line" role="alert">{error}</div>}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-line">
          {!within && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={move} onChange={e => setMove(e.target.checked)} aria-label="Remove the originals from this PC" />
            Remove from this PC after (to the Recycle Bin)</label>}
          <Button className="ml-auto" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button className="whitespace-nowrap" variant="primary" disabled={!at} onClick={() => { try { if (at) localStorage.setItem('attic.lastFolder', at); } catch { /* not remembered */ } if (at) onPick(at, move); }}>
            {move || within ? 'Move here' : 'Copy here'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "Move to Attic" for a selection: blue when Attic is connected, grey (with the reason) otherwise. */
export function MoveToAtticButton({ paths, onDone }: { paths: string[]; onDone?: () => void }) {
  const s = useAttic();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = atticConnected(s) && paths.length > 0;
  return (
    <>
      <button onClick={() => on && setOpen(true)} disabled={!on} data-testid="move-to-attic" title={on ? 'Move (or copy) to a folder on Attic' : atticHint(s)}
        className={`h-8 px-3 rounded-lg text-sm font-medium flex items-center gap-1.5 transition ${on ? 'bg-accent text-accent-fg hover:opacity-90' : 'bg-panel-2 text-muted cursor-not-allowed'}`}>
        <Icon name="attic" size={15} />Move to Attic
      </button>
      {error && <span className="text-xs text-danger" role="alert">{error}</span>}
      {open && <AtticFolderPicker count={paths.length} onClose={() => setOpen(false)}
        onPick={(dest, move) => { setOpen(false); void api.attic.toAttic(paths, dest, move).then(() => onDone?.(), e => setError(errorText(e))); }} />}
    </>
  );
}
