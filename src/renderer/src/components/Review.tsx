// Review people before anything moves (FACE-08/09): merge (drag a card onto another), remove, split.
// v2.2: people are "Person 1", "Person 2"… — names are no longer guessed or typed, and folders keep these names.
import { useEffect, useState, type DragEvent } from 'react';
import type { JobUpdate, PersonSummary, PhotoRef, ReviewData } from '@shared/types';
import { api, errorText } from '../api';
import { Button, Icon, Notice } from './ui';

interface Props {
  data: ReviewData;
  onChanged: () => void;
  onUpscale: (paths: string[]) => void;
}

export function Review({ data, onChanged, onUpscale }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PersonSummary | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; ok: string; run: () => Promise<void> } | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); onChanged(); } catch (e) { setError(errorText(e)); }
  };

  const merge = (from: number, into: number) => {
    const a = data.people.find(x => x.id === from)!, b = data.people.find(x => x.id === into)!;
    setConfirm({ text: `Put all ${a.photos} photo${a.photos === 1 ? '' : 's'} of ${a.label} into ${b.label}?`, ok: 'Merge', run: () => act(() => api.sort.merge(from, into)) });
  };

  const people = data.people.filter(p => !p.unsorted);
  const unsorted = data.people.filter(p => p.unsorted);

  return (
    <div className="space-y-6">
      {error && <Notice tone="danger">{error}</Notice>}

      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-semibold">People <span className="text-muted font-normal">({people.length})</span></h2>
          <span className="text-xs text-muted">Drag one card onto another if they are the same person. Click the photos to fix mistakes.</span>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
          {people.map(p => (
            <PersonCard key={p.id} p={p} dragging={dragging}
              onDragStart={() => setDragging(p.id)} onDragEnd={() => setDragging(null)}
              onDropOn={() => { if (dragging && dragging !== p.id) merge(dragging, p.id); setDragging(null); }}
              onOpen={() => setOpen(p)} />
          ))}
        </div>
      </section>

      {unsorted.length > 0 && (
        <Group title={`Unsorted (${unsorted.length} people with too few photos)`} hint="They go to an “Unsorted” folder. Change the minimum in Settings.">
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
            {unsorted.map(p => (
              <PersonCard key={p.id} p={p} dragging={dragging}
                onDragStart={() => setDragging(p.id)} onDragEnd={() => setDragging(null)}
                onDropOn={() => { if (dragging && dragging !== p.id) merge(dragging, p.id); setDragging(null); }}
                onOpen={() => setOpen(p)} />
            ))}
          </div>
        </Group>
      )}
      <LowRes photos={data.lowRes} onDone={onChanged} onError={setError} />
      <PhotoGroup title="Couldn't recognise" hint="Faces were found but are too small, blurry or turned away. These photos stay where they are." photos={data.cantRecognise} />
      <PhotoGroup title="No faces" hint="These stay where they are, unless “No faces” folder is on in Settings." photos={data.noFaces} />
      {data.skipped.length > 0 && (
        <Group title={`Skipped (${data.skipped.length})`} hint="Online-only, locked or unreadable files are left alone.">
          <ul className="text-sm space-y-1">{data.skipped.slice(0, 200).map(s => <li key={s.path} className="flex gap-3"><span className="truncate flex-1 selectable">{s.path}</span><span className="text-muted">{s.reason}</span></li>)}</ul>
        </Group>
      )}

      {open && <PersonPhotos person={open} others={data.people.filter(x => x.id !== open.id)} onClose={() => setOpen(null)}
        onChanged={onChanged} onUpscale={onUpscale} onError={setError} />}
      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
          <div className="bg-panel rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="text-sm leading-relaxed">{confirm.text}</div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
              <Button variant="primary" onClick={async () => { const c = confirm; setConfirm(null); await c.run(); }}>{confirm.ok}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PersonCard({ p, dragging, onDragStart, onDragEnd, onDropOn, onOpen }: {
  p: PersonSummary; dragging: number | null; onDragStart: () => void; onDragEnd: () => void; onDropOn: () => void;
  onOpen: () => void;
}) {
  const [over, setOver] = useState(false);
  const canDrop = dragging !== null && dragging !== p.id;
  return (
    <div draggable onDragStart={(e: DragEvent) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }} onDragEnd={onDragEnd}
      onDragOver={e => { if (canDrop) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={e => { e.preventDefault(); setOver(false); onDropOn(); }}
      data-person={p.label}
      className={`rounded-xl border bg-panel p-3 space-y-2.5 transition cursor-grab active:cursor-grabbing
        ${over ? 'border-accent ring-2 ring-accent/40' : 'border-line'} ${dragging === p.id ? 'opacity-50' : ''}`}>
      <button onClick={onOpen} className="w-full grid grid-cols-2 gap-1 rounded-lg overflow-hidden aspect-square bg-panel-2" aria-label={`Show photos of ${p.label}`}>
        {p.faceUrls.slice(0, 4).map((u, i) => <img key={i} src={u} alt="" draggable={false} className={`w-full h-full object-cover ${p.faceUrls.length === 1 ? 'col-span-2 row-span-2' : ''}`} />)}
      </button>
      <div className="font-medium text-sm truncate" data-testid="person-label">{p.label}</div>
      <div className="flex items-center justify-between text-xs text-muted gap-2">
        <span className="whitespace-nowrap">{p.photos} photo{p.photos === 1 ? "" : "s"}</span>
        {p.dir && <span className="truncate">Has a folder</span>}
      </div>
    </div>
  );
}

function PersonPhotos({ person, others, onClose, onChanged, onUpscale, onError }: {
  person: PersonSummary; others: PersonSummary[]; onClose: () => void; onChanged: () => void;
  onUpscale: (paths: string[]) => void; onError: (e: string) => void;
}) {
  const [photos, setPhotos] = useState<PhotoRef[] | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [mergeInto, setMergeInto] = useState('');
  const load = () => api.sort.person(person.id).then(setPhotos).catch(e => onError(errorText(e)));
  useEffect(() => { load(); }, [person.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, close = false) => {
    try { await fn(); setSel(new Set()); onChanged(); if (close) onClose(); else load(); } catch (e) { onError(errorText(e)); }
  };
  const toggle = (id: number) => setSel(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-8" onClick={onClose}>
      <div className="bg-panel rounded-2xl w-full h-full max-w-5xl flex flex-col shadow-2xl" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Photos of ${person.label}`}>
        <div className="flex items-center gap-3 p-4 border-b border-line flex-wrap">
          <div className="font-semibold text-lg mr-auto">{person.label} <span className="text-muted font-normal text-sm">· {photos?.length ?? person.photos} photos</span></div>
          <Button onClick={async () => { const f = await api.sort.personFiles(person.id); onClose(); onUpscale(f.map(x => x.path)); }}>
            <Icon name="sparkle" size={16} />Upscale all photos
          </Button>
          <select aria-label="Merge into" value={mergeInto} onChange={e => setMergeInto(e.target.value)} className="h-9 rounded-lg border border-line bg-panel px-2 text-sm">
            <option value="">Merge into…</option>
            {others.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <Button disabled={!mergeInto} onClick={() => run(() => api.sort.merge(person.id, Number(mergeInto)), true)}>Merge</Button>
          <Button variant="ghost" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></Button>
        </div>
        <div className="px-4 py-2 flex items-center gap-2 text-sm border-b border-line min-h-12">
          {sel.size ? (
            <>
              <span className="mr-auto">{sel.size} selected</span>
              <Button className="h-8" onClick={() => run(async () => { for (const f of sel) await api.sort.removeFace(f); })}>Not this person</Button>
              <Button className="h-8" onClick={() => run(() => api.sort.split(person.id, [...sel]))}>Move to a new person</Button>
            </>
          ) : <span className="text-muted">Select photos that aren't {person.label} to remove them or split them off.</span>}
        </div>
        <div className="flex-1 overflow-auto p-4">
          {!photos ? <div className="text-muted">Loading…</div> : (
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {photos.map(ph => (
                <button key={ph.faceId} onClick={() => toggle(ph.faceId!)} aria-pressed={sel.has(ph.faceId!)}
                  className={`relative rounded-lg overflow-hidden border-2 text-left ${sel.has(ph.faceId!) ? 'border-accent' : 'border-transparent'}`}>
                  <img src={ph.thumbUrl} alt={ph.name} className="w-full aspect-square object-cover bg-panel-2" />
                  {ph.faceUrl && <img src={ph.faceUrl} alt="" className="absolute right-1.5 bottom-7 h-11 w-11 rounded-md border-2 border-white shadow" />}
                  {(ph.people ?? 1) > 1 && <span className="absolute left-1.5 top-1.5 rounded bg-black/60 text-white text-[10px] px-1.5 py-0.5">Group · {ph.people}</span>}
                  {sel.has(ph.faceId!) && <span className="absolute right-1.5 top-1.5 h-6 w-6 rounded-full bg-accent text-accent-fg flex items-center justify-center"><Icon name="check" size={14} /></span>}
                  <div className="text-xs truncate px-1 py-1">{ph.name}</div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const [openG, setOpenG] = useState(false);
  return (
    <section className="rounded-xl border border-line bg-panel">
      <button onClick={() => setOpenG(!openG)} className="w-full flex items-center gap-2 px-4 h-11 text-left">
        <Icon name="chevron" size={15} className={`text-muted transition ${openG ? 'rotate-90' : ''}`} />
        <span className="font-medium">{title}</span>
        {hint && <span className="text-xs text-muted ml-2 truncate">{hint}</span>}
      </button>
      {openG && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

/**
 * v2.3, optional: photos with few pixels (Instagram, WhatsApp, screenshots) can be upscaled in place — each keeps its
 * name, format, date, people and labels; the original goes to the Recycle Bin.
 */
function LowRes({ photos, onDone, onError }: { photos: ReviewData['lowRes']; onDone: () => void; onError: (e: string) => void }) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(photos.map(p => p.path)));
  const [ask, setAsk] = useState(false);
  const [jobs, setJobs] = useState<string[]>([]);
  const [prog, setProg] = useState<Record<string, JobUpdate>>({});
  useEffect(() => setSel(new Set(photos.map(p => p.path))), [photos]);
  useEffect(() => api.onJobUpdate(u => { if (jobs.includes(u.jobId)) setProg(p => ({ ...p, [u.jobId]: u })); }), [jobs]);
  const ups = jobs.map(j => prog[j]).filter(Boolean);
  const running = jobs.length > 0 && !(ups.length === jobs.length && ups.every(u => u.finished));
  useEffect(() => {
    if (!jobs.length || running) return;
    const failed = ups.flatMap(u => u.items.filter(i => i.state === 'failed'));
    if (failed.length) onError(`${failed.length} photo(s) could not be upscaled: ${failed.slice(0, 3).map(i => `${i.name} (${i.error})`).join('; ')}`);
    setJobs([]); setProg({}); onDone();
  }, [running]);           // eslint-disable-line react-hooks/exhaustive-deps
  if (!photos.length) return null;
  const done = ups.reduce((n, u) => n + u.done, 0), total = ups.reduce((n, u) => n + u.total, 0) || sel.size;
  const start = async () => {
    setAsk(false);
    try { setJobs(await api.sort.upscaleLow(photos.filter(p => sel.has(p.path)).map(p => ({ path: p.path, width: p.width, height: p.height })))); }
    catch (e) { onError(errorText(e)); }
  };
  const toggle = (p: string) => setSel(s => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });
  return (
    <Group title={`Low resolution — upscale recommended (${photos.length})`} hint="Optional. Small photos (under 2 megapixels) look sharper upscaled.">
      <div className="flex items-center gap-2 flex-wrap mb-3 text-sm" data-testid="lowres">
        {running ? (
          <div className="flex-1 min-w-60">
            <div className="text-sm mb-1">Upscaling {Math.min(done + 1, total)} of {total}…</div>
            <div className="h-2 rounded-full bg-panel-2 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${(done / total) * 100}%` }} /></div>
          </div>
        ) : <>
          <span className="mr-auto text-muted">{sel.size} of {photos.length} selected</span>
          <Button className="h-8" variant="ghost" onClick={() => setSel(new Set(photos.map(p => p.path)))}>Select all</Button>
          <Button className="h-8" variant="ghost" onClick={() => setSel(new Set())}>Select none</Button>
          <Button className="h-8" variant="primary" disabled={!sel.size} onClick={() => setAsk(true)}><Icon name="sparkle" size={15} />Upscale {sel.size} and replace</Button>
        </>}
      </div>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
        {photos.slice(0, 500).map(p => (
          <label key={p.path} title={p.path} className={`relative cursor-pointer rounded-md ${sel.has(p.path) ? 'ring-2 ring-accent' : ''}`}>
            <img src={p.thumbUrl} alt={p.name} loading="lazy" className="w-full aspect-square object-cover rounded-md bg-panel-2" />
            <input type="checkbox" checked={sel.has(p.path)} disabled={running} onChange={() => toggle(p.path)} aria-label={`Upscale ${p.name}`}
              className="absolute left-1.5 top-1.5 h-4 w-4 accent-[var(--accent)]" />
            <span className="absolute right-1 bottom-6 rounded bg-black/65 text-white text-[10px] px-1">{p.width}×{p.height}</span>
            <div className="text-[11px] text-muted truncate mt-0.5">{p.name}</div>
          </label>
        ))}
      </div>
      {ask && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
          <div className="bg-panel rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="font-semibold">Upscale {sel.size} photo{sel.size === 1 ? '' : 's'} and replace them?</div>
            <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1 text-muted">
              <li>Each photo becomes 2× bigger (4× when very small), in the same format and with the same name.</li>
              <li>Its date, people and labels are kept.</li>
              <li>The originals go to the Recycle Bin, so you can restore them from there.</li>
              <li>This runs in the background; you can keep reviewing.</li>
            </ul>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAsk(false)}>Cancel</Button>
              <Button variant="primary" onClick={start}>Upscale and replace</Button>
            </div>
          </div>
        </div>
      )}
    </Group>
  );
}

function PhotoGroup({ title, hint, photos }: { title: string; hint: string; photos: PhotoRef[] }) {
  if (!photos.length) return null;
  return (
    <Group title={`${title} (${photos.length})`} hint={hint}>
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
        {photos.slice(0, 300).map(p => (
          <div key={p.imageId} title={p.path}>
            <img src={p.thumbUrl} alt={p.name} loading="lazy" className="w-full aspect-square object-cover rounded-md bg-panel-2" />
            <div className="text-[11px] text-muted truncate mt-0.5">{p.name}</div>
          </div>
        ))}
      </div>
      {photos.length > 300 && <div className="text-xs text-muted mt-2">…and {photos.length - 300} more</div>}
    </Group>
  );
}
