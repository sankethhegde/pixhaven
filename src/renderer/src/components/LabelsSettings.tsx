// Settings → Labels and stars (v2.0 Phase C): database location, daily backups, export / import (TAG-07),
// and "Find moved files" for labels whose files were moved outside the app. v2.1: writing stars and labels into the
// files themselves (TAG-08, off by default).
import { useEffect, useState, type ReactNode } from 'react';
import type { BackupInfo, FileWriteStatus } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import * as T from '../tags';
import { Button, Notice, Toggle } from './ui';

export function LabelsSettings() {
  const [loc, setLoc] = useState<{ path: string; isDefault: boolean } | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [restoreFile, setRestoreFile] = useState('');
  const [missing, setMissing] = useState(0);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger' | 'warn'; text: string } | null>(null);
  const [ask, setAsk] = useState<{ dir: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeOn, setWriteOn] = useState(false);
  const [ws, setWs] = useState<FileWriteStatus | null>(null);
  useEffect(() => {
    void api.getSettings().then(s => setWriteOn(s.library.writeToFiles));
    void api.tags.writeStatus().then(setWs);
    return api.onWriteStatus(setWs);
  }, []);

  const refresh = async () => {
    setLoc(await api.tags.location());
    const b = await api.tags.backups();
    setBackups(b);
    setRestoreFile(f => f || b[0]?.file || '');
    setMissing(await api.tags.missing());
  };
  useEffect(() => { void refresh(); }, []);
  const act = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    try { const text = await fn(); if (text) setMsg({ tone: 'info', text }); await refresh(); } catch (e) { setMsg({ tone: 'danger', text: errorText(e) }); } finally { setBusy(false); }
  };
  const day = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const name = (f: string) => f.split(/[\\/]/).pop()!.replace(/^library-|\.db$/g, '');

  return (
    <section className="rounded-2xl border border-line bg-panel p-5 space-y-4" aria-label="Labels and stars settings">
      <h2 className="font-semibold">Labels and stars</h2>
      <Row label="Saved in" hint={<>Labels, stars and resume positions live in one file on this computer (and only go into your files if you switch that on below).<br /><span className="selectable break-all">{loc?.path}</span></>}>
        <Button disabled={busy} onClick={() => act(async () => { const r = await api.tags.chooseLocation(); if (!r) return null; if (r.taken) { setAsk({ dir: r.dir }); return null; } await api.tags.setLocation(r.dir, 'move'); await T.reloadAll(); return 'The library now lives in the new folder (copied there; the old file is kept).'; })}>Change location…</Button>
      </Row>
      {ask && (
        <Notice tone="warn">
          That folder already has a PixHaven library.
          <div className="flex gap-2 mt-2">
            <Button className="!h-8" onClick={() => act(async () => { await api.tags.setLocation(ask.dir, 'use'); setAsk(null); await T.reloadAll(); return 'Now using the library in that folder.'; })}>Use that one</Button>
            <Button className="!h-8" variant="danger" onClick={() => act(async () => { await api.tags.setLocation(ask.dir, 'move'); setAsk(null); await T.reloadAll(); return 'Replaced it with this library (a backup of the old one was made).'; })}>Replace it with mine</Button>
            <Button className="!h-8" variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
          </div>
        </Notice>
      )}
      <Row label="Daily backup" hint={backups.length ? `Last: ${day(backups[0].date)} · ${backups.length} kept (the last 7 days)` : 'A copy is made once a day while PixHaven is open; the last 7 are kept.'}>
        <Button disabled={busy} onClick={() => act(async () => { await api.tags.backupNow(); return 'Backup made.'; })}>Back up now</Button>
      </Row>
      {backups.length > 0 && (
        <Row label="Restore" hint="Puts the labels and stars back as they were then. A copy of the current state is kept first.">
          <div className="flex gap-2">
            <select value={restoreFile} onChange={e => setRestoreFile(e.target.value)} aria-label="Backup to restore" className="h-9 rounded-lg bg-panel-2 border border-line px-2 text-sm max-w-56">
              {backups.map(b => <option key={b.file} value={b.file}>{name(b.file)} · {fmtBytes(b.size)}</option>)}
            </select>
            <Button disabled={busy || !restoreFile} onClick={() => act(async () => { await api.tags.restore(restoreFile); await T.reloadAll(); return 'Restored.'; })}>Restore</Button>
          </div>
        </Row>
      )}
      <Row label="Export" hint="All labels and stars, to keep safe or move to another computer. JSON keeps label colours; CSV opens in Excel.">
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => act(async () => { const r = await api.tags.exportTo('json'); return r && `Exported ${r.count} files to ${r.file}`; })}>Export JSON…</Button>
          <Button disabled={busy} onClick={() => act(async () => { const r = await api.tags.exportTo('csv'); return r && `Exported ${r.count} files to ${r.file}`; })}>Export CSV…</Button>
        </div>
      </Row>
      <Row label="Import" hint="Adds labels and stars from an export (JSON or CSV), also from another computer: photos and videos are recognised by their content, wherever they are now.">
        <Button disabled={busy} onClick={() => act(async () => {
          const r = await api.tags.importFrom();
          if (!r) return null;
          await T.reloadAll();
          return `Imported: ${r.applied} file${r.applied === 1 ? '' : 's'} matched now${r.waiting ? `, ${r.waiting} will be matched when you open their folders or watch them (or use “Find moved files”)` : ''}${r.labels ? `, ${r.labels} new label${r.labels === 1 ? '' : 's'}` : ''}${r.skipped ? `, ${r.skipped} skipped` : ''}.`;
        })}>Import…</Button>
      </Row>
      <Row label="Find moved files" hint={missing ? `${missing} labelled file${missing === 1 ? ' is' : 's are'} not where PixHaven last saw ${missing === 1 ? 'it' : 'them'} (moved, renamed, or on a drive that is not connected). Pick a folder to look in.` : 'Every labelled photo and video is where PixHaven last saw it.'}>
        <Button disabled={busy || !missing} onClick={() => act(async () => { const n = await api.tags.findMoved(); if (n === null) return null; await T.reloadAll(); return `Found ${n} moved file${n === 1 ? '' : 's'}.`; })}>Look in a folder…</Button>
      </Row>
      <Row label="Also write into the files" hint={<>
        Puts the stars and labels inside the photos and MP4/MOV videos too (as XMP, which Windows Explorer shows as Rating and Tags, and Lightroom,
        digiKam and others read). Camera RAW files and other videos get a small .xmp file next to them instead. This changes your files (their
        date is kept); labels added by other apps are left alone. Off: PixHaven never touches your files.
        {writeOn && ws && (ws.pending > 0 || ws.written > 0 || ws.failed.length > 0) && (
          <span className="block mt-1" data-testid="write-status">
            {ws.pending > 0 ? `Writing… ${ws.pending} to go. ` : ''}{ws.written > 0 ? `${ws.written} written since PixHaven started. ` : ''}
            {ws.failed.length > 0 && <span className="text-danger">{ws.failed.length} could not be written (first: {ws.failed[0].path.split(/[\/]/).pop()} — {ws.failed[0].reason}).</span>}
          </span>
        )}
      </>}>
        <Toggle label="Also write stars and labels into the files" checked={writeOn} onChange={v => act(async () => {
          const n = await api.tags.setWriteToFiles(v);
          setWriteOn(v);
          return v ? (n ? `Writing stars and labels into ${n} file${n === 1 ? '' : 's'} you have already labelled; new changes follow automatically.` : 'New labels and stars will also be written into the files.') : 'Stopped: new changes stay in PixHaven only (files already written keep what they have).';
        })} />
      </Row>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
