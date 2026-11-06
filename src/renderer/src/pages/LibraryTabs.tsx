// v1.0.4: tabs in the Library. Each tab is its own Library (folder, history, search, scroll and selection are kept);
// Cut / Copy is shared by every tab, so files copied in one tab are pasted in another. Photos and videos can also be
// dragged onto a tab: they are moved there (hold Ctrl to copy). Open tabs are remembered after a restart.
// Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab next / previous, Ctrl+1…9 a tab by number.
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { api, errorText } from '../api';
import { Icon } from '../components/ui';
import * as T from '../tags';
import { Library, DRAG_TYPE, type Clip } from './Library';

type LibraryProps = Omit<Parameters<typeof Library>[0], 'clip' | 'onClip' | 'startDir' | 'onState' | 'epoch' | 'onChanged'>;
interface Tab { id: number; dir: string | null; title: string }

const KEY = 'lib.tabs';
const MAX_TABS = 12;
const load = (): { tabs: Tab[]; active: number } | null => {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!j || !Array.isArray(j.tabs) || !j.tabs.length) return null;
    const tabs: Tab[] = j.tabs.slice(0, MAX_TABS).map((t: { dir?: unknown }, i: number) => ({ id: i + 1, dir: typeof t.dir === 'string' ? t.dir : null, title: '' }));
    return { tabs, active: tabs[Math.max(0, Math.min(tabs.length - 1, Number(j.active) || 0))].id };
  } catch { return null; }
};
const save = (tabs: Tab[], active: number) => {
  try { localStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map(t => ({ dir: t.dir })), active: Math.max(0, tabs.findIndex(t => t.id === active)) })); } catch { /* private mode */ }
};
const name = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function LibraryTabs(props: LibraryProps) {
  const saved = useRef(load());
  const [tabs, setTabs] = useState<Tab[]>(() => saved.current?.tabs ?? [{ id: 1, dir: null, title: '' }]);
  const [active, setActive] = useState(() => saved.current?.active ?? 1);
  const nextId = useRef(Math.max(...tabs.map(t => t.id)) + 1);
  // Where each tab started (new tabs and restored ones); a tab's later folders come from its own Library.
  const starts = useRef(new Map(tabs.map(t => [t.id, t.dir])));
  const [clip, setClip] = useState<Clip | null>(null);
  const [epochs, setEpochs] = useState<Record<number, number>>({});
  const [dropOn, setDropOn] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => save(tabs, active), [tabs, active]);
  useEffect(() => { if (!note) return; const t = setTimeout(() => setNote(null), 8000); return () => clearTimeout(t); }, [note]);

  const current = tabs.find(t => t.id === active) ?? tabs[0];
  const newTab = useCallback((dir: string | null = current?.dir ?? null) => {
    if (tabs.length >= MAX_TABS) { setNote(`At most ${MAX_TABS} tabs. Close one to open another.`); return; }
    const id = nextId.current++;
    starts.current.set(id, dir);
    setTabs(ts => [...ts, { id, dir, title: dir ? name(dir) : 'New tab' }]);
    setActive(id);
  }, [tabs.length, current?.dir]);
  const closeTab = useCallback((id: number) => {
    setTabs(ts => {
      if (ts.length === 1) return ts;
      const i = ts.findIndex(t => t.id === id);
      const rest = ts.filter(t => t.id !== id);
      if (id === active) setActive(rest[Math.min(i, rest.length - 1)].id);
      return rest;
    });
  }, [active]);
  const onState = useCallback((id: number, s: { dir: string | null; title: string }) => {
    // A restored tab not visited yet has no folder open: keep showing the folder it will open.
    setTabs(ts => ts.map(t => (t.id === id ? { ...t, dir: s.dir ?? t.dir, title: !s.dir && s.title === 'New tab' && t.dir ? name(t.dir) : s.title } : t)));
  }, []);
  /** Files changed in one tab: the others show their folder again (moved files leave, pasted ones arrive). */
  const changed = useCallback((from: number) => {
    setEpochs(e => { const n = { ...e }; for (const t of tabs) if (t.id !== from) n[t.id] = (n[t.id] ?? 0) + 1; return n; });
  }, [tabs]);

  // Tab shortcuts, only while the Library is on screen and no dialog is open.
  useEffect(() => {
    if (!props.active) return;
    const k = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (document.querySelector('[role="dialog"]')) return;
      const key = e.key.toLowerCase();
      const i = tabs.findIndex(t => t.id === active);
      if (key === 't' && !e.shiftKey) newTab();
      else if (key === 'w' && !e.shiftKey) { if (tabs.length < 2) return; closeTab(active); }
      else if (key === 'tab') setActive(tabs[(i + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length].id);
      else if (/^[1-9]$/.test(key) && !e.shiftKey) { const t = key === '9' ? tabs[tabs.length - 1] : tabs[Number(key) - 1]; if (!t) return; setActive(t.id); }
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [props.active, tabs, active, newTab, closeTab]);

  // ---- drop photos and videos on a tab: move there (Ctrl: copy) ----
  const dragOk = (e: DragEvent) => e.dataTransfer.types.includes(DRAG_TYPE);
  const onDrop = async (t: Tab, e: DragEvent) => {
    setDropOn(null);
    if (!dragOk(e)) return;
    e.preventDefault();
    let paths: string[] = [];
    try { paths = JSON.parse(e.dataTransfer.getData(DRAG_TYPE)); } catch { return; }
    if (!t.dir) { setNote('Open a folder in that tab first, then drop there.'); return; }
    const how = e.ctrlKey ? 'copy' : 'move';
    try {
      const r = await api.files.paste(paths, t.dir, how);
      if (how === 'move') for (const m of r.done) T.movedLocally(m.from, m.to);
      setNote(`${how === 'copy' ? 'Copied' : 'Moved'} ${r.done.length} item${r.done.length === 1 ? '' : 's'} to “${t.title || name(t.dir)}”${r.failed.length ? `; ${r.failed.length} could not be: ${name(r.failed[0].path)} (${r.failed[0].reason})` : ''}.`);
      setEpochs(ep => { const n = { ...ep }; for (const x of tabs) n[x.id] = (n[x.id] ?? 0) + 1; return n; });
    } catch (err) { setNote(errorText(err)); }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-end gap-1 px-2 pt-1.5 h-10 border-b border-line bg-panel shrink-0 overflow-x-auto" role="tablist" aria-label="Library tabs">
        {tabs.map((t, i) => (
          <div key={t.id} role="tab" aria-selected={t.id === active} data-tab={i + 1} title={`${t.dir ?? t.title}${i < 8 ? `\nCtrl+${i + 1}` : ''}`}
            onClick={() => setActive(t.id)} onAuxClick={e => { if (e.button === 1) closeTab(t.id); }}
            onDragOver={e => { if (!dragOk(e) || t.id === active) return; e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move'; setDropOn(t.id); }}
            onDragLeave={() => setDropOn(d => (d === t.id ? null : d))}
            onDrop={e => void onDrop(t, e)}
            className={`group flex items-center gap-1.5 h-8 pl-3 pr-1 rounded-t-lg text-sm cursor-default select-none max-w-[220px] min-w-[110px] border border-b-0 ${
              t.id === active ? 'bg-bg border-line text-fg font-medium' : 'border-transparent text-muted hover:bg-panel-2'} ${dropOn === t.id ? '!border-accent !bg-accent-soft !text-accent' : ''}`}>
            <Icon name="folder" size={13} className="shrink-0 opacity-70" />
            <span className="truncate flex-1">{t.title || (t.dir ? name(t.dir) : 'New tab')}</span>
            {tabs.length > 1 && (
              <button className={`h-6 w-6 shrink-0 rounded flex items-center justify-center hover:bg-panel-2 ${t.id === active ? '' : 'opacity-0 group-hover:opacity-100'}`}
                onClick={e => { e.stopPropagation(); closeTab(t.id); }} aria-label={`Close tab ${t.title}`} title="Close tab (Ctrl+W)"><Icon name="x" size={12} /></button>
            )}
          </div>
        ))}
        <button className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-muted hover:bg-panel-2 hover:text-fg mb-0.5" onClick={() => newTab()}
          aria-label="New tab" title="New tab (Ctrl+T)"><Icon name="plus" size={15} /></button>
        {clip && (
          <span className="ml-auto mb-2 mr-2 text-xs text-muted whitespace-nowrap" data-testid="clip-status">
            {clip.paths.length} {clip.mode === 'copy' ? 'copied' : 'cut'} · paste in any tab (Ctrl+V)
          </span>
        )}
      </div>
      {note && (
        <div className="flex items-center gap-2 px-4 h-9 text-sm bg-panel-2 border-b border-line shrink-0" role="status" data-testid="tabs-note">
          <span className="truncate">{note}</span><button className="ml-auto text-muted hover:text-fg" onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {tabs.map(t => (
          <div key={t.id} className={t.id === active ? 'h-full' : 'hidden'} data-tab-panel={t.id}>
            <Library {...props} active={props.active && t.id === active}
              initialDir={t.id === active ? props.initialDir : null} initialPlay={t.id === active ? props.initialPlay : null}
              clip={clip} onClip={setClip} startDir={starts.current.get(t.id) ?? null}
              onState={s => onState(t.id, s)} epoch={epochs[t.id] ?? 0} onChanged={() => changed(t.id)} />
          </div>
        ))}
      </div>
    </div>
  );
}
