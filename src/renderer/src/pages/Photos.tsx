// v2.5 Photos: an image viewer for sorted folders. Choose a folder (or one sorted before): it opens on its people, as
// it was left — person folders renamed in Explorer are recognised. A Folders view browses it with cut / copy / paste,
// new folder, rename, move to and copy to (labels, people and group photo links follow). Group photos say where they
// are kept and which other folders show them.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { FolderListing, FolderStatus, KnownFolder, MediaEntry, MediaInfo, PersonSummary } from '@shared/types';
import { api, errorText } from '../api';
import { MediaGrid } from '../components/MediaGrid';
import { Viewer } from '../components/Viewer';
import { Button, Icon, Notice, Segmented } from '../components/ui';
import * as T from '../tags';

interface Props {
  active: boolean;
  onUpscale: (paths: string[]) => void;
  onSort: (folder: string) => void;
}

type View = 'people' | 'folders';
interface Clip { mode: 'copy' | 'move'; paths: string[] }

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const parentOf = (p: string) => { const t = p.replace(/[\\/]+$/, ''); const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')); return i > 2 ? t.slice(0, i) : i === 2 ? t.slice(0, 3) : null; };
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : w === 'person' ? 'people' : `${w}s`}`;
const usable = (e: MediaEntry) => e.kind === 'folder' || e.kind === 'image';

export function Photos({ active, onUpscale, onSort }: Props) {
  const [known, setKnown] = useState<KnownFolder[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [people, setPeople] = useState<PersonSummary[]>([]);
  const [view, setView] = useState<View>('people');
  const [person, setPerson] = useState<PersonSummary | null>(null);
  const [dir, setDir] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [personItems, setPersonItems] = useState<MediaEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [ask, setAsk] = useState<{ kind: 'newFolder' | 'rename'; path: string; name: string; error?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const infos = useRef(new Map<string, MediaInfo>());
  const [, setTick] = useState(0);

  const loadKnown = useCallback(() => { void api.photos.folders().then(setKnown).catch(() => {}); }, []);
  useEffect(() => { if (active && !root) loadKnown(); }, [active, root, loadKnown]);
  useEffect(() => {
    let frame = 0;
    return api.onLibThumb(i => {
      infos.current.set(i.path, i);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; setTick(t => t + 1); });
    });
  }, []);

  // ---- opening a folder ----
  /** People of the open folder, after matching it with earlier sorts (renamed folders, moved photos). */
  const loadPeople = useCallback(async (r: string) => {
    const st = await api.sort.status(r);
    setStatus(st);
    if (st.folderId == null || !st.people) { setPeople([]); return st; }
    const rv = await api.sort.review(st.folderId);
    setPeople(rv.people.filter(p => p.photos > 0 && !p.unsorted));
    return st;
  }, []);

  const listDir = useCallback(async (d: string) => {
    const l = await api.lib.list(d);
    setListing(l);
    void T.loadFor(l.entries.filter(e => e.kind !== 'folder').map(T.ref));
  }, []);

  const openRoot = async (r: string) => {
    setError(null); setNote(null); setBusy(true); setPerson(null); setSelected(new Set()); setViewer(null);
    try {
      if ((await api.pathKind(r)) !== 'folder') throw new Error('Please choose a folder.');
      setRoot(r); setDir(r);
      const st = await loadPeople(r);
      setView(st.people ? 'people' : 'folders');
      await listDir(r);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const choose = async () => { const f = await api.openFolder('Choose a folder of photos'); if (f) void openRoot(f); };

  const openPerson = async (p: PersonSummary) => {
    setPerson(p); setSelected(new Set()); setViewer(null);
    setPersonItems(await personPhotos(p.id));
  };
  const personPhotos = async (pid: number): Promise<MediaEntry[]> => {
    const r = await api.photos.person(pid);
    const list = r.dir ? (await api.lib.list(r.dir)).entries.filter(e => e.kind === 'image') : r.items;
    void T.loadFor(list.map(T.ref));
    return list;
  };

  const openDir = (d: string) => { setDir(d); setSelected(new Set()); anchor.current = null; void listDir(d); };

  /** After files changed: what is on screen is listed again (and the people matched again). */
  const refresh = async () => {
    if (!root) return;
    if (dir) await listDir(dir);
    await loadPeople(root);
    if (person) setPersonItems(await personPhotos(person.id));
  };

  // ---- what the grid shows ----
  const items = useMemo(() => {
    if (view === 'people') return person ? personItems : [];
    const list = (listing?.entries ?? []).filter(usable);
    return list.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [view, person, personItems, listing]);
  const photos = useMemo(() => items.filter(e => e.kind === 'image'), [items]);

  const onVisible = useCallback((first: number, last: number) => {
    const want = [...items.slice(first, last + 1), ...items.slice(last + 1)].filter(e => e.kind !== 'folder').slice(0, 3000);
    api.lib.thumbs(want.map(T.ref)).then(ready => { for (const i of ready) infos.current.set(i.path, i); if (ready.length) setTick(t => t + 1); }).catch(() => {});
  }, [items]);

  const onItemClick = (i: number, e: MouseEvent) => {
    const p = items[i].path;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) {
      for (let k = Math.min(anchor.current, i); k <= Math.max(anchor.current, i); k++) next.add(items[k].path);
    } else {
      if ((e.ctrlKey || e.metaKey) && next.has(p)) next.delete(p); else next.add(p);
      anchor.current = i;
    }
    setSelected(next);
  };
  const onItemOpen = (i: number) => {
    const e = items[i];
    if (e.kind === 'folder') openDir(e.path);
    else setViewer(photos.indexOf(e));
  };

  // ---- file actions ----
  const sel = [...selected].filter(p => items.some(e => e.path === p));
  const pasteHere = view === 'folders' ? dir : null;
  const report = (verb: string, r: { done: unknown[]; failed: { path: string; reason: string }[] }) => {
    setNote(`${verb} ${plural(r.done.length, 'item')}${r.failed.length ? `; ${r.failed.length} could not be: ${baseName(r.failed[0].path)} (${r.failed[0].reason})` : ''}.`);
  };
  const copy = (mode: Clip['mode']) => { if (!sel.length) return; setClip({ mode, paths: sel }); setNote(`${plural(sel.length, 'item')} ${mode === 'copy' ? 'copied' : 'cut'}. Open a folder and press Paste (Ctrl+V).`); };
  const paste = async () => {
    if (!clip || !pasteHere) return;
    setBusy(true); setError(null);
    try {
      const r = await api.files.paste(clip.paths, pasteHere, clip.mode);
      for (const m of r.done) if (clip.mode === 'move') T.movedLocally(m.from, m.to);
      report(clip.mode === 'copy' ? 'Pasted a copy of' : 'Moved', r);
      if (clip.mode === 'move') setClip(null);
      setSelected(new Set(r.done.map(d => d.to)));
      await refresh();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const sendTo = async (mode: Clip['mode']) => {
    if (!sel.length) return;
    try {
      const r = await api.files.pasteTo(sel, mode);
      if (!r) return;
      for (const m of r.done) if (mode === 'move') T.movedLocally(m.from, m.to);
      report(mode === 'copy' ? 'Copied' : 'Moved', r);
      setSelected(new Set());
      await refresh();
    } catch (e) { setError(errorText(e)); }
  };
  const submitAsk = async () => {
    if (!ask) return;
    try {
      if (ask.kind === 'newFolder') {
        const made = await api.files.newFolder(ask.path, ask.name);
        setAsk(null); await refresh(); setSelected(new Set([made]));
      } else {
        const to = await api.files.rename(ask.path, ask.name);
        T.movedLocally(ask.path, to);
        setAsk(null); await refresh(); setSelected(new Set([to]));
      }
    } catch (e) { setAsk({ ...ask, error: errorText(e) }); }
  };

  // ---- keyboard: Ctrl+C / X / V, F2, Ctrl+Shift+N, Ctrl+A, Backspace, Enter ----
  useEffect(() => {
    if (!active || !root) return;
    const k = (e: KeyboardEvent) => {
      if (viewer !== null || ask) return;
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      const c = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (c && key === 'c') copy('copy');
      else if (c && key === 'x') copy('move');
      else if (c && key === 'v') void paste();
      else if (c && key === 'a') setSelected(new Set(items.map(x => x.path)));
      else if (c && e.shiftKey && key === 'n') { if (pasteHere) setAsk({ kind: 'newFolder', path: pasteHere, name: 'New folder' }); }
      else if (e.key === 'F2') { if (sel.length === 1) setAsk({ kind: 'rename', path: sel[0], name: baseName(sel[0]) }); }
      else if (e.key === 'Backspace') { if (view === 'people' && person) setPerson(null); else if (view === 'folders' && dir && parentOf(dir)) openDir(parentOf(dir)!); }
      else if (e.key === 'Escape') { if (selected.size) setSelected(new Set()); else return; }
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  // ---------- start: choose a folder ----------
  if (!root) {
    return (
      <div className="h-full overflow-auto p-8">
        <div className="max-w-4xl mx-auto space-y-5">
          <div className="flex items-end gap-3">
            <div className="mr-auto">
              <h1 className="text-2xl font-semibold">Photos</h1>
              <p className="text-sm text-muted mt-1">See a sorted folder person by person, and copy, move or organise its photos.</p>
            </div>
            <Button variant="primary" className="h-10" onClick={() => void choose()}><Icon name="folder" size={16} />Choose folder…</Button>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
          {known.length > 0 ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Sorted before</div>
              <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {known.map(k => (
                  <button key={k.path} onClick={() => void openRoot(k.path)} data-known={k.path}
                    className="text-left rounded-xl border border-line bg-panel p-4 hover:bg-panel-2">
                    <div className="flex items-center gap-2 font-medium"><Icon name="people" size={16} className="text-accent" /><span className="truncate">{baseName(k.path)}</span></div>
                    <div className="text-xs text-muted truncate mt-1">{k.path}</div>
                    <div className="text-xs text-muted mt-1">{plural(k.people, 'person')} · {plural(k.photos, 'photo')}{k.sorted ? ` · sorted ${new Date(k.sorted).toLocaleDateString()}` : ''}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : <Notice tone="info">Folders you sort by person show up here, so you can come back to them. You can also open any folder.</Notice>}
        </div>
      </div>
    );
  }

  // ---------- an open folder ----------
  const f = status?.reconciled;
  const crumbs = (() => {
    if (!dir) return [];
    const out: { label: string; path: string }[] = [];
    let p: string | null = dir;
    while (p) { out.unshift({ label: baseName(p) || p, path: p }); if (p.toLowerCase() === root.toLowerCase()) break; p = parentOf(p); }
    return out;
  })();
  const toolbar = (
    <div className="flex items-center gap-1 flex-wrap" role="toolbar" aria-label="File actions">
      {view === 'folders' && <Button className="!h-8" variant="ghost" disabled={!pasteHere} onClick={() => pasteHere && setAsk({ kind: 'newFolder', path: pasteHere, name: 'New folder' })}><Icon name="folder" size={15} />New folder</Button>}
      <Button className="!h-8" variant="ghost" disabled={!sel.length} onClick={() => copy('move')} title="Ctrl+X">Cut</Button>
      <Button className="!h-8" variant="ghost" disabled={!sel.length} onClick={() => copy('copy')} title="Ctrl+C"><Icon name="copy" size={15} />Copy</Button>
      {view === 'folders' && <Button className="!h-8" variant="ghost" disabled={!clip || !pasteHere || busy} onClick={() => void paste()} title="Ctrl+V">Paste{clip ? ` (${clip.paths.length})` : ''}</Button>}
      <Button className="!h-8" variant="ghost" disabled={sel.length !== 1} onClick={() => setAsk({ kind: 'rename', path: sel[0], name: baseName(sel[0]) })} title="F2">Rename</Button>
      <Button className="!h-8" variant="ghost" disabled={!sel.length} onClick={() => void sendTo('move')}>Move to…</Button>
      <Button className="!h-8" variant="ghost" disabled={!sel.length} onClick={() => void sendTo('copy')}>Copy to…</Button>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 pt-5 pb-3 border-b border-line space-y-3 shrink-0">
        <div className="flex items-center gap-3 flex-wrap">
          <Button variant="ghost" className="!h-8" onClick={() => { setRoot(null); setStatus(null); setPerson(null); setListing(null); }}><Icon name="back" size={16} />All folders</Button>
          <div className="min-w-0 mr-auto">
            <h1 className="text-xl font-semibold truncate">{baseName(root)}</h1>
            <div className="text-xs text-muted truncate selectable">{root}</div>
          </div>
          {people.length > 0 && (
            <Segmented label="View" value={view} onChange={v => { setView(v); setSelected(new Set()); }}
              options={[{ value: 'people', label: `People (${people.length})` }, { value: 'folders', label: 'Folders' }]} />
          )}
          <Button className="!h-8" variant="ghost" onClick={() => void api.openPath(dir ?? root)} title="Open in File Explorer"><Icon name="external" size={15} />Explorer</Button>
          <Button className="!h-8" variant="ghost" onClick={() => void refresh()} title="Refresh"><Icon name="refresh" size={15} /></Button>
        </div>
        {(view === 'folders' || person) && toolbar}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-6 pt-3 space-y-2 shrink-0">
          {error && <Notice tone="danger">{error}</Notice>}
          {note && <Notice tone="info"><div className="flex items-start gap-2"><span className="flex-1">{note}</span><button onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div></Notice>}
          {f && (f.movedFrom || f.folders.length > 0) && (
            <Notice tone="info">
              {f.movedFrom && <div>This folder was sorted before as “{f.movedFrom}”, so its people are shown as they were.</div>}
              {f.folders.length > 0 && <div>Renamed person folders were recognised: {f.folders.map(x => `“${baseName(x.from)}” → “${baseName(x.to)}”`).join(', ')}.</div>}
            </Notice>
          )}
        </div>

        {view === 'people' && !person && (
          <div className="flex-1 min-h-0 overflow-auto px-6 py-4">
            <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {people.map(p => (
                <button key={p.id} onClick={() => void openPerson(p)} data-photos-person={p.label}
                  className="text-left rounded-2xl border border-line bg-panel p-3 hover:bg-panel-2">
                  <div className="grid grid-cols-2 gap-1 aspect-square rounded-xl overflow-hidden bg-panel-2">
                    {p.faceUrls.slice(0, 4).map(u => <img key={u} src={u} alt="" className="w-full h-full object-cover" />)}
                  </div>
                  <div className="mt-2 font-medium truncate">{p.label}</div>
                  <div className="text-xs text-muted">{plural(p.photos, 'photo')}{p.dir ? '' : ' · not sorted into a folder yet'}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'people' && person && (
          <Frame head={<>
            <Button className="!h-8" variant="ghost" onClick={() => { setPerson(null); setSelected(new Set()); }}><Icon name="back" size={16} />People</Button>
            <span className="font-semibold">{person.label}</span>
            <span className="text-sm text-muted">{plural(personItems.length, 'photo')}{person.dir ? ` · folder “${baseName(person.dir)}”` : ''}</span>
          </>}>
            <MediaGrid items={items} infos={infos.current} view="grid" size="m" selected={selected} onVisible={onVisible}
              onClick={onItemClick} onOpen={onItemOpen} resetKey={`p${person.id}`} />
          </Frame>
        )}

        {view === 'folders' && (
          <Frame head={<>
            <Button className="!h-8" variant="ghost" disabled={!dir || !parentOf(dir)} onClick={() => dir && parentOf(dir) && openDir(parentOf(dir)!)} title="Up (Backspace)"><Icon name="up" size={15} /></Button>
            <nav className="flex items-center gap-1 text-sm min-w-0 overflow-hidden" aria-label="Folder path">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center gap-1 min-w-0">
                  {i > 0 && <Icon name="chevron" size={12} className="text-muted shrink-0" />}
                  <button className={`truncate hover:underline ${i === crumbs.length - 1 ? 'font-semibold' : 'text-muted'}`} onClick={() => openDir(c.path)}>{c.label}</button>
                </span>
              ))}
            </nav>
            <span className="text-xs text-muted ml-auto">{plural(items.filter(e => e.kind === 'folder').length, 'folder')} · {plural(photos.length, 'photo')}{selected.size ? ` · ${selected.size} selected` : ''}</span>
          </>}>
            {listing?.error || listing?.denied
              ? <div className="p-6"><Notice tone="warn">{listing.denied ? 'Windows does not allow opening this folder.' : listing.error}</Notice></div>
              : <MediaGrid items={items} infos={infos.current} view="grid" size="m" selected={selected} onVisible={onVisible}
                  onClick={onItemClick} onOpen={onItemOpen} resetKey={dir ?? ''} />}
          </Frame>
        )}
      </div>

      {viewer !== null && photos[viewer] && (
        <Viewer items={photos} index={viewer} infos={infos.current} onIndex={setViewer} onClose={() => setViewer(null)} onUpscale={onUpscale} onSort={onSort} />
      )}
      {ask && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={() => setAsk(null)}>
          <div className="w-[440px] rounded-2xl bg-panel border border-line shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label={ask.kind === 'newFolder' ? 'New folder' : 'Rename'}>
            <div className="font-semibold">{ask.kind === 'newFolder' ? 'New folder' : 'Rename'}</div>
            <input autoFocus value={ask.name} aria-label="Name"
              onFocus={e => { const dot = ask.kind === 'rename' ? e.target.value.lastIndexOf('.') : -1; e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length); }}
              onChange={e => setAsk({ ...ask, name: e.target.value, error: undefined })}
              onKeyDown={e => { if (e.key === 'Enter') void submitAsk(); if (e.key === 'Escape') setAsk(null); e.stopPropagation(); }}
              className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            {ask.error && <div className="text-sm text-danger" role="alert">{ask.error}</div>}
            <div className="text-xs text-muted">{ask.kind === 'newFolder' ? `In “${baseName(ask.path)}”.` : 'Labels, stars and people stay with it. Renaming a person’s folder renames the person.'}</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
              <Button variant="primary" disabled={!ask.name.trim()} onClick={() => void submitAsk()}>{ask.kind === 'newFolder' ? 'Create' : 'Rename'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Frame({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-2 px-6 h-11 shrink-0">{head}</div>
      <div className="flex-1 min-h-0 px-3">{children}</div>
    </div>
  );
}
