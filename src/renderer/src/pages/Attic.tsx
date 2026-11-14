// 1.0.7 Attic tab: the home file server (Attic Hub on the HP) inside PixHaven. Setting up: find Attic on the
// Wi-Fi (or type its address), pair with a 6-digit code from Attic Hub (Devices → Pair a device), sign in with your
// Attic account (the password goes to Attic only). Then it works like the Library: folders, photos and videos with
// thumbnails, the watch page and viewer, the details card, labels and stars (kept in PixHaven), rename, move between
// Attic folders, delete (Attic keeps deleted things 30 days), and copy or move to and from this PC.
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { AtticListing, AtticShareInfo, MediaEntry, MediaInfo } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import { MediaGrid } from '../components/MediaGrid';
import { DetailsCard, useDetailsOpen } from '../components/DetailsCard';
import { WatchPage } from '../components/WatchPage';
import { Viewer } from '../components/Viewer';
import { AtticFolderPicker, useAttic, useTransferDone } from '../components/attic';
import { Button, Icon, Notice } from '../components/ui';
import * as T from '../tags';

const name = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const parentOf = (p: string) => { const rest = p.slice('attic://'.length); const i = rest.lastIndexOf('/'); return i < 0 ? null : 'attic://' + rest.slice(0, i); };

export function Attic({ active }: { active: boolean }) {
  const s = useAttic();
  useEffect(() => { if (active) void api.attic.status(); }, [active]);
  return (
    <div className="h-full flex flex-col min-h-0" data-testid="attic-page" data-attic-state={s.state}>
      {s.state === 'connected' ? <Browser active={active} /> : <Setup />}
    </div>
  );
}

// ---------- setting up ----------
function Setup() {
  const s = useAttic();
  const [found, setFound] = useState<{ name: string; address: string; port: number }[] | null>(null);
  const [finding, setFinding] = useState(false);
  const [address, setAddress] = useState(s.address ?? '');
  const [code, setCode] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [master, setMaster] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  // Looking on the Wi-Fi never blocks typing an address and connecting.
  const find = async () => { setFinding(true); try { setFound(await api.attic.find()); } catch (e) { setError(errorText(e)); } finally { setFinding(false); } };
  useEffect(() => { if (s.state === 'none') void find(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const step = s.state === 'unpaired' ? 2 : s.state === 'signed-out' ? 3 : 1;
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto py-10 px-6 space-y-6">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-2xl bg-accent-soft text-accent flex items-center justify-center"><Icon name="attic" size={26} /></div>
          <div>
            <h1 className="text-xl font-semibold">Attic</h1>
            <p className="text-sm text-muted">Your home file server (Attic Hub on the HP), right here: browse it, watch its videos, label them, and move files between this PC and Attic.</p>
          </div>
        </div>
        <ol className="flex gap-2 text-xs" aria-label="Steps">
          {['Find Attic', 'Pair this PC', 'Sign in'].map((t, i) => (
            <li key={t} className={`flex-1 rounded-lg px-3 py-2 border ${step === i + 1 ? 'border-accent bg-accent-soft text-accent font-semibold' : step > i + 1 ? 'border-line text-muted' : 'border-line text-muted'}`}>
              {step > i + 1 ? '✓ ' : `${i + 1}. `}{t}
            </li>
          ))}
        </ol>
        {s.state === 'offline' && <Notice tone="warn">{s.error ?? 'Attic is not answering.'} <button className="underline ml-1" onClick={() => void run(() => api.attic.status())}>Try again</button></Notice>}

        {step === 1 && (
          <section className="rounded-2xl border border-line bg-panel p-5 space-y-4" aria-label="Find Attic">
            <div className="flex items-center gap-2">
              <div className="font-medium">Attic on this Wi-Fi</div>
              <Button className="!h-8 ml-auto" variant="ghost" onClick={() => void find()} disabled={finding}><Icon name="refresh" size={14} />{finding ? 'Looking…' : 'Look again'}</Button>
            </div>
            {found?.length ? found.map(f => (
              <button key={f.address} onClick={() => void run(() => api.attic.connect(f.address, f.port))} disabled={busy} data-found-attic={f.name}
                className="w-full flex items-center gap-3 px-3 h-12 rounded-xl border border-line hover:bg-panel-2 text-left">
                <Icon name="attic" size={18} className="text-accent" /><span className="font-medium">{f.name}</span><span className="text-sm text-muted">{f.address}</span>
                <span className="ml-auto text-sm text-accent">Use this</span>
              </button>
            )) : <div className="text-sm text-muted">{finding ? 'Looking for Attic…' : 'None found. Check Attic Hub is running on the HP and this PC is on the same Wi-Fi, or type its address.'}</div>}
            <div className="flex items-center gap-2 pt-1">
              <input value={address} onChange={e => setAddress(e.target.value)} placeholder="The HP's address, e.g. 192.168.1.200" aria-label="Attic address"
                onKeyDown={e => { if (e.key === 'Enter') void run(() => api.attic.connect(address)); }}
                className="flex-1 h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
              <Button variant="primary" disabled={!address.trim() || busy} onClick={() => void run(() => api.attic.connect(address))}>Connect</Button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="rounded-2xl border border-line bg-panel p-5 space-y-3" aria-label="Pair this PC">
            <div className="font-medium">Pair PixHaven with {s.name ?? 'Attic'}</div>
            <p className="text-sm text-muted">In Attic Hub on a PC where you're signed in as the master: <b className="text-fg">Devices → Pair a device</b>. Type the 6-digit code it shows (it works once, for 10 minutes).</p>
            <div className="flex items-center gap-2">
              <input value={code} onChange={e => setCode(e.target.value)} inputMode="numeric" placeholder="123 456" aria-label="Pairing code" maxLength={9}
                onKeyDown={e => { if (e.key === 'Enter') void run(() => api.attic.pair(code)); }}
                className="w-40 h-10 rounded-lg bg-panel-2 border border-line px-3 text-lg tracking-widest outline-none focus:border-accent" />
              <Button variant="primary" disabled={code.replace(/\D/g, '').length !== 6 || busy} onClick={() => void run(() => api.attic.pair(code))}>Pair</Button>
              <button className="ml-auto text-sm text-muted hover:text-fg" onClick={() => void run(() => api.attic.forget())}>Use a different Attic</button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="rounded-2xl border border-line bg-panel p-5 space-y-3" aria-label="Sign in to Attic">
            <div className="font-medium">Sign in to {s.name ?? 'Attic'}</div>
            <p className="text-sm text-muted">Your Attic account. The password goes to Attic only; PixHaven keeps just the sign-in Attic gives back (30 days, renewed while you use it).</p>
            <input value={user} onChange={e => setUser(e.target.value)} placeholder="Username or email" aria-label="Attic username" autoComplete="username"
              className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            <input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Password" aria-label="Attic password" autoComplete="current-password"
              onKeyDown={e => { if (e.key === 'Enter') void run(async () => { await api.attic.signIn(user, password, master); setPassword(''); }); }}
              className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={master} onChange={e => setMaster(e.target.checked)} aria-label="Master account" />This is the master account</label>
              <Button className="ml-auto" variant="primary" disabled={!user.trim() || !password || busy}
                onClick={() => void run(async () => { await api.attic.signIn(user, password, master); setPassword(''); })}>Sign in</Button>
            </div>
          </section>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </div>
  );
}

// ---------- browsing (like the Library) ----------
function Browser({ active }: { active: boolean }) {
  const s = useAttic();
  const [shares, setShares] = useState<AtticShareInfo[]>([]);
  const [dir, setDir] = useState<string | null>(() => { try { return localStorage.getItem('attic.dir'); } catch { return null; } });
  const [back, setBack] = useState<string[]>([]);
  const [listing, setListing] = useState<AtticListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<number | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [details, setDetails] = useDetailsOpen();
  const [ask, setAsk] = useState<{ kind: 'rename' | 'newFolder' | 'delete'; name: string; error?: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [, setRedraw] = useState(0);
  const infos = useRef(new Map<string, MediaInfo>());
  const activeRef = useRef(active); activeRef.current = active;
  T.useTags();

  useEffect(() => api.onLibThumb(i => { if (i.path.startsWith('attic://')) { infos.current.set(i.path, i); if (activeRef.current) setRedraw(r => r + 1); } }), []);
  useEffect(() => { void api.attic.shares().then(list => { setShares(list); if (!dir && list[0]) setDir(list[0].path); }).catch(e => setError(errorText(e))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useCallback(async (d: string, how: 'push' | 'back' | 'refresh' = 'push') => {
    setError(null);
    try {
      const l = await api.attic.list(d);
      setListing(l);
      if (how === 'push' && dir && dir !== d) setBack(b => [...b, dir]);
      if (how !== 'refresh') { setSelected(new Set()); anchor.current = null; setQuery(''); }
      setDir(l.path);
      try { localStorage.setItem('attic.dir', l.path); } catch { /* not remembered */ }
      void T.loadFor(l.entries.filter(e => e.kind !== 'folder').map(T.ref));
    } catch (e) {
      setError(errorText(e));
      if (how === 'push' && shares[0] && d !== shares[0].path) void open(shares[0].path, 'refresh');
    }
  }, [dir, shares]);
  useEffect(() => { if (dir && !listing) void open(dir, 'refresh'); }, [dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => { if (dir) void open(dir, 'refresh'); };
  useTransferDone(useCallback(() => refresh(), [dir])); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    const dirFirst = (a: MediaEntry, b: MediaEntry) => Number(b.kind === 'folder') - Number(a.kind === 'folder');
    return (listing?.entries ?? []).filter(e => q.every(w => e.name.toLowerCase().includes(w)))
      .sort((a, b) => dirFirst(a, b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  }, [listing, query]);
  const media = useMemo(() => items.filter(e => e.kind !== 'folder'), [items]);
  const photos = useMemo(() => items.filter(e => e.kind === 'image'), [items]);
  const videos = useMemo(() => items.filter(e => e.kind === 'video'), [items]);
  const sel = items.filter(e => selected.has(e.path));

  const onVisible = useCallback((first: number, last: number) => {
    const want = items.slice(first, last + 60).filter(e => e.kind !== 'folder' && !infos.current.get(e.path)?.thumb);
    if (want.length) api.lib.thumbs(want.map(T.ref)).then(r => { for (const i of r) infos.current.set(i.path, i); if (r.length) setRedraw(x => x + 1); }).catch(() => {});
  }, [items]);
  const onClick = (i: number, e: MouseEvent) => {
    const p = items[i].path;
    const next = new Set(e.ctrlKey || e.metaKey ? selected : []);
    if (e.shiftKey && anchor.current !== null) for (let k = Math.min(anchor.current, i); k <= Math.max(anchor.current, i); k++) next.add(items[k].path);
    else { if ((e.ctrlKey || e.metaKey) && next.has(p)) next.delete(p); else next.add(p); anchor.current = i; }
    setSelected(next);
  };
  const onOpen = (i: number) => {
    const e = items[i];
    if (e.kind === 'folder') void open(e.path);
    else if (e.kind === 'video') setWatching(videos.indexOf(e));
    else setViewing(photos.indexOf(e));
  };

  // ---- changes ----
  const submit = async () => {
    if (!ask || !dir) return;
    try {
      if (ask.kind === 'newFolder') { const p = await api.attic.newFolder(dir, ask.name); setAsk(null); await open(dir, 'refresh'); setSelected(new Set([p])); }
      else if (ask.kind === 'rename') { const it = sel[0]; const p = await api.attic.move(it.path, parentOf(it.path) ?? dir, ask.name); T.movedLocally(it.path, p); setAsk(null); await open(dir, 'refresh'); setSelected(new Set([p])); }
      else {
        const r = await api.attic.trash(sel.map(e => e.path));
        setAsk(null);
        setNote(`${r.done.length} item${r.done.length === 1 ? '' : 's'} deleted. Attic keeps them in its trash for 30 days.${r.failed.length ? ` ${r.failed.length} could not be: ${name(r.failed[0].path)} (${r.failed[0].reason})` : ''}`);
        await open(dir, 'refresh');
      }
    } catch (e) { setAsk({ ...ask, error: errorText(e) }); }
  };
  const toPC = async (move: boolean) => {
    const d = await api.openFolder(move ? 'Move to this folder on this PC' : 'Copy to this folder on this PC');
    if (!d) return;
    await api.attic.fromAttic(sel.map(e => ({ path: e.path, kind: e.kind, size: e.size })), d, move).catch(e => setNote(errorText(e)));
    setSelected(new Set());
  };
  const moveWithin = async (dest: string) => {
    setPicking(false);
    const failed: string[] = [];
    for (const e of sel) { try { const p = await api.attic.move(e.path, dest); T.movedLocally(e.path, p); } catch (err) { failed.push(`${e.name} (${errorText(err)})`); } }
    setNote(failed.length ? `Could not move ${failed.join(', ')}.` : `Moved ${sel.length} item${sel.length === 1 ? '' : 's'}.`);
    refresh();
  };
  const upload = async () => {
    if (!dir) return;
    const files = await api.openMedia('Send photos and videos to this Attic folder');
    if (files.length) await api.attic.toAttic(files, dir, false).catch(e => setNote(errorText(e)));
  };

  // ---- keys ----
  useEffect(() => {
    if (!active || watching !== null || viewing !== null || ask || picking) return;
    const k = (e: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName) || document.querySelector('[role="dialog"]')) return;
      const c = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape' && selected.size) setSelected(new Set());
      else if (c && e.key.toLowerCase() === 'a') setSelected(new Set(media.map(x => x.path)));
      else if (e.key === 'F2' && sel.length === 1) setAsk({ kind: 'rename', name: sel[0].name });
      else if (e.key === 'Delete' && sel.length) setAsk({ kind: 'delete', name: '' });
      else if (e.key === 'Backspace' && dir && parentOf(dir)) void open(parentOf(dir)!);
      else if (e.key === 'F5') refresh();
      else if ((e.key === 'i' || e.key === 'I') && !c && !e.altKey) setDetails(!details);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const shareId = dir ? dir.slice('attic://'.length).split('/')[0] : null;
  const share = shares.find(x => x.id === shareId);
  const crumbs = dir ? dir.slice('attic://'.length).split('/').map((part, i, all) => ({ label: i === 0 ? share?.name ?? part : part, path: 'attic://' + all.slice(0, i + 1).join('/') })) : [];

  return (
    <>
      {watching !== null && videos[watching] && (
        <div className="h-full">
          <WatchPage items={videos} index={watching} infos={infos.current} title={crumbs[crumbs.length - 1]?.label ?? 'Attic'} active={active}
            onIndex={setWatching} onClose={() => { const e = videos[watching]; setWatching(null); if (e) setSelected(new Set([e.path])); }} />
        </div>
      )}
      <div className={watching !== null ? 'hidden' : 'h-full flex min-h-0'}>
        <aside className="w-[220px] shrink-0 border-r border-line bg-panel flex flex-col">
          <div className="p-3 border-b border-line">
            <div className="flex items-center gap-2"><Icon name="attic" size={18} className="text-accent" /><span className="font-semibold truncate" data-testid="attic-name">{s.name ?? 'Attic'}</span></div>
            <div className="text-xs text-muted mt-1 truncate" data-testid="attic-account">Signed in as {s.account?.displayName ?? s.account?.username}{s.account?.type === 'master' ? ' (master)' : ''}</div>
          </div>
          <div className="p-2 flex-1 overflow-y-auto" aria-label="Attic shares">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Shared folders</div>
            {shares.map(x => (
              <button key={x.id} onClick={() => void open(x.path)} data-attic-share={x.name}
                className={`w-full flex items-center gap-2 h-8 px-2 rounded-md text-sm text-left ${shareId === x.id ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'}`}>
                <Icon name="drive" size={14} className="opacity-70" /><span className="truncate">{x.name}</span>
              </button>
            ))}
          </div>
          <div className="p-2 border-t border-line flex gap-1">
            <Button className="!h-8 flex-1" variant="ghost" onClick={() => void api.attic.signOut()}>Sign out</Button>
          </div>
        </aside>
        <section className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 h-14 border-b border-line shrink-0">
            <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" disabled={!back.length}
              onClick={() => { const p = back[back.length - 1]; setBack(back.slice(0, -1)); if (p) void open(p, 'back'); }} aria-label="Back"><Icon name="back" size={16} /></button>
            <button className="h-8 w-8 rounded-lg hover:bg-panel-2 disabled:opacity-30 flex items-center justify-center" disabled={!dir || !parentOf(dir)}
              onClick={() => dir && parentOf(dir) && void open(parentOf(dir)!)} aria-label="Up one folder"><Icon name="up" size={16} /></button>
            <button className="h-8 w-8 rounded-lg hover:bg-panel-2 flex items-center justify-center" onClick={refresh} aria-label="Refresh"><Icon name="refresh" size={15} /></button>
            <nav className="flex items-center min-w-0 flex-1 overflow-hidden text-sm" aria-label="Folder path">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex items-center min-w-0 shrink">
                  {i > 0 && <Icon name="chevron" size={12} className="text-muted mx-0.5" />}
                  <button className={`truncate px-1.5 h-7 rounded hover:bg-panel-2 max-w-[220px] ${i === crumbs.length - 1 ? 'font-semibold' : 'text-muted'}`} onClick={() => void open(c.path)}>{c.label}</button>
                </span>
              ))}
            </nav>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search this folder" aria-label="Search this folder"
              className="w-52 h-8 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            <Button className="!h-8" variant="ghost" onClick={() => setAsk({ kind: 'newFolder', name: 'New folder' })}><Icon name="folder" size={15} />New folder</Button>
            <Button className="!h-8" variant="primary" onClick={() => void upload()} title="Send photos and videos from this PC into this folder"><Icon name="upload" size={15} />Send files here</Button>
            <button className={`h-8 w-8 rounded-lg flex items-center justify-center ${details ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2 text-muted'}`} onClick={() => setDetails(!details)}
              aria-label="Details" aria-pressed={details} title="Details (I)"><Icon name="info" size={16} /></button>
          </div>
          {note && (
            <div className="flex items-center gap-2 px-4 h-10 text-sm bg-panel-2 border-b border-line shrink-0" role="status" data-testid="attic-note">
              <span className="truncate">{note}</span><button className="ml-auto text-muted hover:text-fg" onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
            </div>
          )}
          <div className="flex-1 min-h-0 flex">
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
              {error ? <div className="p-6"><Notice tone="danger">{error}</Notice></div>
                : !listing ? <div className="flex-1 flex items-center justify-center text-sm text-muted">Loading…</div>
                : !items.length ? <div className="flex-1 flex items-center justify-center text-sm text-muted p-6 text-center" data-testid="attic-empty">{query ? 'No names match.' : s.account?.type === 'device' ? 'Nothing here for this account. Attic shows a device account only the files it sent and shared ones; the files already on the HP belong to the master. Sign out and sign in as the master to see everything.' : 'No photos, videos or folders here.'}</div>
                : <MediaGrid items={items} infos={infos.current} view="grid" size="m" selected={selected} onVisible={onVisible} resetKey={dir ?? ''} onClick={onClick} onOpen={onOpen} />}
            </div>
            {details && listing && (
              <DetailsCard items={sel} infos={infos.current} onClose={() => setDetails(false)} all={items} allTitle="In this Attic folder"
                onOpen={e => { const i = items.indexOf(e); if (i >= 0) onOpen(i); }} />
            )}
          </div>
          <footer className="flex items-center gap-x-3 gap-y-1 px-4 py-1.5 min-h-11 flex-wrap border-t border-line text-xs text-muted shrink-0">
            <span data-testid="attic-counts">
              {[items.filter(e => e.kind === 'folder').length && `${items.filter(e => e.kind === 'folder').length} folder(s)`, `${photos.length} photo${photos.length === 1 ? '' : 's'}`, `${videos.length} video${videos.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
              {listing?.otherFiles ? ` · ${listing.otherFiles} other file${listing.otherFiles === 1 ? '' : 's'} not shown` : ''}
            </span>
            {sel.length > 0 && (
              <div className="ml-auto flex items-center gap-1 flex-wrap justify-end text-fg">
                <span>{sel.length} selected · {fmtBytes(sel.reduce((n, e) => n + e.size, 0))}</span>
                {sel.length === 1 && <Button className="!h-8" variant="ghost" onClick={() => setAsk({ kind: 'rename', name: sel[0].name })} title="F2">Rename</Button>}
                <Button className="!h-8" variant="ghost" onClick={() => setPicking(true)}>Move to…</Button>
                <Button className="!h-8" variant="ghost" onClick={() => void toPC(false)} data-testid="copy-to-pc">Copy to this PC…</Button>
                <Button className="!h-8" variant="primary" onClick={() => void toPC(true)} data-testid="move-from-attic" title="Copied to this PC, then deleted from Attic (kept in Attic's trash 30 days)"><Icon name="download" size={15} />Move to this PC…</Button>
                <Button className="!h-8" variant="ghost" onClick={() => setAsk({ kind: 'delete', name: '' })} title="Delete (Attic keeps it 30 days)">Delete</Button>
                <Button className="!h-8" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </div>
            )}
          </footer>
        </section>
      </div>
      {viewing !== null && photos[viewing] && (
        <Viewer items={photos} index={viewing} infos={infos.current} onIndex={setViewing} onClose={() => setViewing(null)}
          onUpscale={() => setNote('Copy the photo to this PC first, then upscale it there.')} onSort={() => setNote('Sort by person works on folders on this PC.')} />
      )}
      {picking && <AtticWithinPicker count={sel.length} onClose={() => setPicking(false)} onPick={d => void moveWithin(d)} />}
      {ask && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={() => setAsk(null)}>
          <div className="w-[440px] rounded-2xl bg-panel border border-line shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label={ask.kind === 'delete' ? 'Delete from Attic' : ask.kind === 'rename' ? 'Rename' : 'New folder'}>
            <div className="font-semibold">{ask.kind === 'delete' ? `Delete ${sel.length} item${sel.length === 1 ? '' : 's'} from Attic?` : ask.kind === 'rename' ? 'Rename' : 'New folder'}</div>
            {ask.kind === 'delete' ? <p className="text-sm text-muted">They go to Attic's trash and are removed for good after 30 days. To get one back sooner, take it out of the "~attic-trash" folder on the HP.</p> : (
              <input autoFocus value={ask.name} aria-label={ask.kind === 'rename' ? 'New name' : 'Folder name'} onChange={e => setAsk({ ...ask, name: e.target.value, error: undefined })}
                onFocus={e => { const dot = e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, ask.kind === 'rename' && dot > 0 ? dot : e.target.value.length); }}
                onKeyDown={e => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') setAsk(null); e.stopPropagation(); }}
                className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            )}
            {ask.error && <div className="text-sm text-danger" role="alert">{ask.error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsk(null)}>Cancel</Button>
              <Button variant={ask.kind === 'delete' ? 'danger' : 'primary'} onClick={() => void submit()}>{ask.kind === 'delete' ? 'Delete' : ask.kind === 'rename' ? 'Rename' : 'Create'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** The Attic folder picker, for moving inside Attic (no "remove from this PC" choice). */
function AtticWithinPicker({ count, onPick, onClose }: { count: number; onPick: (dest: string) => void; onClose: () => void }) {
  return <AtticFolderPicker count={count} within onClose={onClose} onPick={d => onPick(d)} />;
}
