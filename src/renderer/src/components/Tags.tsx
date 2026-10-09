// Labels and stars controls (v2.0 Phase C; photos too since v2.1): stars, label chips, a label box with auto-complete,
// the editor used in the player, the viewer and for a selection, the filter bar (with "Save as playlist"), and the
// "Manage labels" dialog.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LabelInfo, MediaEntry, TagFilter } from '@shared/types';
import { LABEL_COLORS } from '@shared/types';
import { errorText } from '../api';
import * as T from '../tags';
import { Button, Icon } from './ui';

// ---------- stars (TAG-03) ----------

/** 0–5 stars. Clicking the current rating again clears it. `mixed` = a selection with different ratings. */
export function Stars({ value, onChange, size = 16, mixed, label = 'Stars' }: { value: number; onChange?: (n: number) => void; size?: number; mixed?: boolean; label?: string }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <div className="inline-flex items-center" role={onChange ? 'radiogroup' : 'img'} aria-label={onChange ? label : `${value} of 5 stars`}
      onMouseLeave={() => setHover(0)} title={mixed ? 'Different ratings' : undefined}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" disabled={!onChange} role={onChange ? 'radio' : undefined} aria-checked={value === n} aria-label={`${n} star${n > 1 ? 's' : ''}`}
          onMouseEnter={() => onChange && setHover(n)} onClick={e => { e.stopPropagation(); onChange?.(value === n ? 0 : n); }}
          className={`leading-none disabled:cursor-default ${onChange ? 'cursor-pointer' : ''}`} style={{ fontSize: size, width: size + 2 }}>
          <span className={n <= shown ? 'text-[#f5b301]' : mixed ? 'text-[#f5b301]/30' : 'text-muted/40'}>★</span>
        </button>
      ))}
    </div>
  );
}

// ---------- chips ----------

export function LabelChip({ label, onRemove, small, onClick, active }: { label: LabelInfo; onRemove?: () => void; small?: boolean; onClick?: () => void; active?: boolean }) {
  const c = label.color ?? '#8d8d8d';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border max-w-full ${small ? 'h-5 px-1.5 text-[10px]' : 'h-7 px-2.5 text-xs'} ${active ? 'ring-2 ring-accent' : ''} ${onClick ? 'cursor-pointer' : ''}`}
      style={{ borderColor: c + '80', background: c + '22' }} onClick={onClick} data-label={label.name}>
      <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: c }} />
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button type="button" onClick={e => { e.stopPropagation(); onRemove(); }} className="opacity-60 hover:opacity-100" aria-label={`Remove label ${label.name}`}>
          <Icon name="x" size={small ? 10 : 12} />
        </button>
      )}
    </span>
  );
}

// ---------- label box with auto-complete (TAG-01) ----------

export function LabelInput({ onPick, exclude = [], placeholder = 'Add a label…', autoFocus, dark }: {
  onPick: (name: string) => void; exclude?: number[]; placeholder?: string; autoFocus?: boolean; dark?: boolean;
}) {
  const { labels } = T.useTags();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const q = text.trim().toLowerCase();
  const options = useMemo(() => {
    const avail = labels.filter(l => !exclude.includes(l.id));
    const starts = avail.filter(l => l.name.toLowerCase().startsWith(q));
    const contains = avail.filter(l => !l.name.toLowerCase().startsWith(q) && l.name.toLowerCase().includes(q));
    const list: { name: string; label?: LabelInfo }[] = [...starts, ...contains].slice(0, 8).map(l => ({ name: l.name, label: l }));
    if (q && !labels.some(l => l.name.toLowerCase() === q)) list.push({ name: text.trim() });
    return list;
  }, [labels, exclude, q, text]);
  useEffect(() => setSel(0), [q]);
  const pick = (name: string) => { if (!name.trim()) return; onPick(name.trim()); setText(''); setOpen(true); };
  // Near the bottom of the window (the selection panel), the suggestions open upwards.
  const wrap = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useEffect(() => { if (open && wrap.current) setUp(wrap.current.getBoundingClientRect().bottom > window.innerHeight - 260); }, [open]);
  return (
    <div className="relative" ref={wrap}>
      <input value={text} autoFocus={autoFocus} placeholder={placeholder} aria-label="Add a label" role="combobox" aria-expanded={open && options.length > 0}
        onChange={e => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { setSel(s => Math.min(options.length - 1, s + 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setSel(s => Math.max(0, s - 1)); e.preventDefault(); }
          else if (e.key === 'Enter') { pick(options[sel]?.name ?? text); e.preventDefault(); }
          else if (e.key === 'Escape') { setOpen(false); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();   // typing must not trigger player/library shortcuts
        }}
        className={`w-full h-8 rounded-lg border px-2.5 text-sm outline-none ${dark ? 'bg-white/10 border-white/15 text-white placeholder:text-white/40 focus:border-white/40' : 'bg-panel-2 border-line focus:border-accent'}`} />
      {open && options.length > 0 && (
        <div className={`absolute z-50 w-full rounded-lg ${up ? 'bottom-full mb-1' : 'mt-1'} border shadow-xl py-1 max-h-60 overflow-y-auto ${dark ? 'bg-[#1b1d22] border-white/10 text-white' : 'bg-panel border-line'}`} role="listbox">
          {options.map((o, i) => (
            <button key={o.name + i} type="button" role="option" aria-selected={i === sel} onMouseDown={e => { e.preventDefault(); pick(o.name); }}
              className={`w-full text-left flex items-center gap-2 px-2.5 h-8 text-sm ${i === sel ? (dark ? 'bg-white/10' : 'bg-accent-soft') : ''}`}>
              {o.label ? <><span className="h-2 w-2 rounded-full" style={{ background: o.label.color ?? '#8d8d8d' }} />{o.label.name}<span className="ml-auto text-xs opacity-50">{o.label.count}</span></>
                : <><Icon name="sparkle" size={13} />Create “{o.name}”</>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "3 videos", "1 photo", "5 files" (a mix). */
export function noun(items: { path: string }[]): string {
  const v = items.filter(i => T.isVideo(i.path)).length;
  const n = items.length;
  const word = v === n ? 'video' : v === 0 ? 'photo' : 'file';
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- editor for one file or a selection (TAG-01..04, TAG-09, PLAY-07) ----------

export function TagEditor({ items, dark }: { items: MediaEntry[]; dark?: boolean }) {
  const { label } = T.useTags();
  const [error, setError] = useState<string | null>(null);
  const videos = items.filter(i => T.taggable(i.path));
  const tags = videos.map(v => T.tagsOf(v.path) ?? { stars: 0, labels: [] });
  const stars = tags.length ? tags[0].stars : 0;
  const mixed = tags.some(t => t.stars !== stars);
  // Labels on the selection, with how many of the videos carry each.
  const counts = new Map<number, number>();
  for (const t of tags) for (const l of t.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const run = (p: Promise<unknown>) => p.then(() => setError(null), e => setError(errorText(e)));
  if (!videos.length) return null;
  return (
    <div className="space-y-3" data-testid="tag-editor">
      <div className="flex items-center gap-3">
        <Stars value={mixed ? 0 : stars} mixed={mixed} size={22} label={videos.length > 1 ? `Stars for ${noun(videos)}` : 'Stars'}
          onChange={n => run(T.setStars(videos.map(T.ref), n))} />
        <span className={`text-xs ${dark ? 'text-white/50' : 'text-muted'}`}>{mixed ? 'mixed' : stars ? `${stars} of 5` : 'not rated'}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {[...counts].map(([id, n]) => {
          const l = label(id);
          if (!l) return null;
          return (
            <span key={id} className="inline-flex items-center gap-1" title={n < videos.length ? `${n} of ${noun(videos)} selected` : undefined}>
              <LabelChip label={l} onRemove={() => run(T.removeLabel(videos.map(v => v.path), id))} />
              {n < videos.length && <span className={`text-[10px] ${dark ? 'text-white/50' : 'text-muted'}`}>{n}/{videos.length}</span>}
            </span>
          );
        })}
        {!counts.size && <span className={`text-xs ${dark ? 'text-white/50' : 'text-muted'}`}>No labels yet</span>}
      </div>
      <LabelInput dark={dark} exclude={[...counts].filter(([, n]) => n === videos.length).map(([id]) => id)}
        placeholder={videos.length > 1 ? `Add a label to ${noun(videos)}…` : 'Add a label…'} onPick={name => run(T.addLabel(videos.map(T.ref), name))} />
      {error && <div className="text-xs text-danger" role="alert">{error}</div>}
    </div>
  );
}

// ---------- filter bar (TAG-05) ----------

export const NO_FILTER: TagFilter = { labels: [], mode: 'all', minStars: 0 };
export const filterActive = (f: TagFilter) => f.labels.length > 0 || f.minStars > 0;

export function FilterBar({ filter, onChange, onSave }: { filter: TagFilter; onChange: (f: TagFilter) => void; onSave?: () => void }) {
  const { labels, label } = T.useTags();
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap text-sm shrink-0" data-testid="filter-bar">
      <span className="text-muted">Labels</span>
      {filter.labels.map(id => { const l = label(id); return l && <LabelChip key={id} label={l} onRemove={() => onChange({ ...filter, labels: filter.labels.filter(x => x !== id) })} />; })}
      {adding ? (
        <div className="w-44">
          <LabelInput autoFocus placeholder="Label…" exclude={filter.labels} onPick={name => {
            const l = labels.find(x => x.name.toLowerCase() === name.toLowerCase());
            if (l) onChange({ ...filter, labels: [...filter.labels, l.id] });
            setAdding(false);
          }} />
        </div>
      ) : <button className="h-7 px-2 rounded-full border border-dashed border-line text-muted hover:text-fg" onClick={() => setAdding(true)} disabled={!labels.length}>+ label</button>}
      {filter.labels.length > 1 && (
        <div className="inline-flex rounded-lg bg-panel-2 p-0.5 border border-line" role="radiogroup" aria-label="Match">
          {(['all', 'any'] as const).map(m => (
            <button key={m} role="radio" aria-checked={filter.mode === m} onClick={() => onChange({ ...filter, mode: m })}
              className={`px-2.5 h-7 rounded-md text-xs font-medium ${filter.mode === m ? 'bg-panel shadow-sm' : 'text-muted'}`}>{m === 'all' ? 'All of them' : 'Any of them'}</button>
          ))}
        </div>
      )}
      <span className="text-muted ml-2">Stars</span>
      <select value={filter.minStars} aria-label="Minimum stars" onChange={e => onChange({ ...filter, minStars: Number(e.target.value) })}
        className="h-8 rounded-lg bg-panel-2 border border-line px-2 text-sm">
        <option value={0}>Any</option>
        {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{'★'.repeat(n)}{n < 5 ? ' or more' : ''}</option>)}
      </select>
      {filterActive(filter) && (
        <div className="ml-auto flex items-center gap-3">
          {onSave && <button className="text-accent hover:underline" onClick={onSave}>Save as playlist…</button>}
          <button className="text-accent hover:underline" onClick={() => onChange(NO_FILTER)}>Clear filter</button>
        </div>
      )}
    </div>
  );
}

// ---------- manage labels (TAG-02) ----------

export function ManageLabels({ onClose }: { onClose: () => void }) {
  const { labels } = T.useTags();
  const [editing, setEditing] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const save = async (id: number) => {
    try { const r = await T.renameLabel(id, name); setEditing(null); setError(r.mergedInto ? `Merged into the existing label “${name.trim()}”.` : null); } catch (e) { setError(errorText(e)); }
  };
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={onClose}>
      <div ref={box} className="w-[520px] max-h-[80vh] flex flex-col rounded-2xl bg-panel border border-line shadow-2xl" onClick={e => e.stopPropagation()} role="dialog" aria-label="Manage labels">
        <div className="flex items-center px-5 h-14 border-b border-line">
          <div className="font-semibold">Labels</div>
          <button className="ml-auto h-8 w-8 rounded-lg hover:bg-panel-2 flex items-center justify-center" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {!labels.length && <div className="text-sm text-muted p-3">No labels yet. Add one to a photo or video from the grid, the viewer, the player or a selection.</div>}
          {labels.map(l => (
            <div key={l.id} className="flex items-center gap-2 px-2 h-11 rounded-lg hover:bg-panel-2" data-manage={l.name}>
              <ColorPicker value={l.color} onChange={c => void T.setColor(l.id, c)} />
              {editing === l.id ? (
                <input autoFocus value={name} onChange={e => setName(e.target.value)} aria-label="New name"
                  onKeyDown={e => { if (e.key === 'Enter') void save(l.id); if (e.key === 'Escape') { setEditing(null); e.stopPropagation(); } }}
                  className="flex-1 h-8 rounded-lg bg-panel-2 border border-accent px-2 text-sm outline-none" />
              ) : <div className="flex-1 truncate text-sm">{l.name}</div>}
              <span className="text-xs text-muted w-16 text-right">{l.count} file{l.count === 1 ? '' : 's'}</span>
              {editing === l.id ? <Button className="!h-8" variant="primary" onClick={() => void save(l.id)}>Save</Button>
                : <Button className="!h-8" variant="ghost" onClick={() => { setEditing(l.id); setName(l.name); }}>Rename</Button>}
              {confirm === l.id ? (
                <Button className="!h-8" variant="danger" onClick={() => { void T.deleteLabel(l.id); setConfirm(null); }}>Delete from {l.count}</Button>
              ) : <Button className="!h-8" variant="ghost" onClick={() => setConfirm(l.id)} aria-label={`Delete ${l.name}`}><Icon name="x" size={15} /></Button>}
            </div>
          ))}
        </div>
        {error && <div className="px-5 py-2 text-sm text-muted border-t border-line">{error}</div>}
        <div className="px-5 py-3 border-t border-line text-xs text-muted">Renaming a label to the name of another one merges them. Deleting removes it from every photo and video.</div>
      </div>
    </div>
  );
}

function ColorPicker({ value, onChange }: { value: string | null; onChange: (c: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button className="h-6 w-6 rounded-full border border-line" style={{ background: value ?? '#8d8d8d' }} onClick={() => setOpen(!open)} aria-label="Label colour" />
      {open && (
        <div className="absolute z-10 top-8 left-0 flex gap-1 p-2 rounded-xl bg-panel border border-line shadow-xl">
          {LABEL_COLORS.map(c => <button key={c} className="h-6 w-6 rounded-full" style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => { onChange(c); setOpen(false); }} />)}
        </div>
      )}
    </div>
  );
}
