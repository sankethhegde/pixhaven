// v2.8 Photos → Combine people: the same person sorted in several folders ends up in one folder. Choose the sorted
// folders and a destination → PixHaven compares their people by face → check the matches (and their names) → see how
// long it takes → Combine. Face data, names inside the photos, labels and group photo shortcuts follow.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CombineEstimate, CombineMatch, CombinePerson, CombineProgress, CombineRequest, CombineResult, KnownFolder } from '@shared/types';
import { api, errorText, fmtBytes, fmtDuration } from '../api';
import { Button, Icon, Notice, ProgressBar, Toggle } from './ui';

interface Props { known: KnownFolder[]; onClose: () => void; onOpen: (dir: string) => void }
type Step = 'choose' | 'matching' | 'review' | 'moving' | 'done';

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
const plural = (n: number, w: string) => `${n.toLocaleString()} ${n === 1 ? w : w === 'person' ? 'people' : `${w}s`}`;
/** Rounded for an estimate: "under a minute", "about 25 min", "about 2 h 40 min". */
export const roughly = (s: number) => (s < 60 ? 'under a minute' : `about ${fmtDuration(s < 3600 ? Math.ceil(s / 60) * 60 : Math.ceil(s / 600) * 600).replace(/ 0 s$/, '').replace(/ 0 min$/, '')}`);

export function Combine({ known, onClose, onOpen }: Props) {
  const usable = known.filter(k => (k.personFolders ?? 0) > 0 && k.id != null);
  const [step, setStep] = useState<Step>('choose');
  const [picked, setPicked] = useState<Set<number>>(new Set(usable.map(k => k.id!)));
  const [dest, setDest] = useState<string | null>(null);
  const [moveSingles, setMoveSingles] = useState(true);
  const [match, setMatch] = useState<CombineMatch | null>(null);
  const [off, setOff] = useState<Set<number>>(new Set());          // people taken out of a match
  const [names, setNames] = useState<Record<number, string>>({});    // match index → name
  const [estimate, setEstimate] = useState<CombineEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [progress, setProgress] = useState<CombineProgress | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<CombineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSingles, setShowSingles] = useState(false);

  useEffect(() => api.onCombineProgress(setProgress), []);
  // End-to-end tests choose the destination without the folder dialog.
  useEffect(() => { (window as unknown as { __clearupCombineDest?: (d: string) => void }).__clearupCombineDest = setDest; }, []);

  const people = useMemo(() => new Map((match?.people ?? []).map(p => [p.id, p])), [match]);
  const destKnown = dest ? usable.find(k => same(k.path, dest)) : undefined;

  // ---- the request built from what is ticked ----
  const req = useMemo((): CombineRequest | null => {
    if (!match || !dest) return null;
    const inGroup = new Set<number>();
    const groups: CombineRequest['groups'] = [];
    match.groups.forEach((g, i) => {
      const on = g.members.filter(id => !off.has(id));
      if (on.length < 2) return;
      on.forEach(id => inGroup.add(id));
      groups.push({ people: on, name: (names[i] ?? '').trim() });
    });
    if (moveSingles) for (const p of match.people) if (!inGroup.has(p.id)) groups.push({ people: [p.id], name: p.named ? p.label : '' });
    return { dest, groups };
  }, [match, dest, off, names, moveSingles]);
  const merged = req?.groups.filter(g => g.people.length > 1).length ?? 0;
  const singles = match ? match.people.filter(p => !req?.groups.some(g => g.people.length > 1 && g.people.includes(p.id))) : [];

  // The time estimate follows the choices (counted on disk, so it waits a moment after the last change).
  const seq = useRef(0);
  useEffect(() => {
    if (step !== 'review' || !req || !req.groups.length) { setEstimate(null); return; }
    const n = ++seq.current;
    setEstimating(true);
    const t = setTimeout(() => {
      api.photos.combineEstimate(req).then(e => { if (n === seq.current) setEstimate(e); })
        .catch(e => { if (n === seq.current) setError(errorText(e)); })
        .finally(() => { if (n === seq.current) setEstimating(false); });
    }, 400);
    return () => clearTimeout(t);
  }, [step, req]);

  const findMatches = async () => {
    setError(null); setProgress(null); setStep('matching');
    try {
      const m = await api.photos.match([...picked]);
      setMatch(m); setOff(new Set());
      const n: Record<number, string> = {};
      m.groups.forEach((g, i) => { const named = g.members.map(id => m.people.find(p => p.id === id)!).find(p => p.named); n[i] = named?.label ?? ''; });
      setNames(n);
      setStep('review');
    } catch (e) { setError(errorText(e)); setStep('choose'); }
  };

  const run = async () => {
    if (!req) return;
    setConfirm(false); setError(null); setProgress(null); setStep('moving');
    try { setResult(await api.photos.combine(req)); setStep('done'); }
    catch (e) { setError(errorText(e)); setStep('review'); }
  };

  const head = (title: string, sub?: string) => (
    <div className="flex items-start gap-3">
      <div className="mr-auto min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {sub && <p className="text-sm text-muted mt-1">{sub}</p>}
      </div>
      {step !== 'moving' && <Button variant="ghost" onClick={onClose}><Icon name="back" size={16} />Back to Photos</Button>}
    </div>
  );

  // ---------- choose folders and destination ----------
  if (step === 'choose') {
    const enough = picked.size + (destKnown && !picked.has(destKnown.id!) ? 1 : 0) >= 2;
    return (
      <Shell>
        {head('Combine people', 'The same person sorted in different folders ends up in one folder. PixHaven compares the people by face; nothing moves until you confirm.')}
        {error && <Notice tone="danger">{error}</Notice>}
        <section className="rounded-2xl border border-line bg-panel p-5 space-y-3">
          <div className="flex items-center gap-2">
            <div className="font-semibold mr-auto">1. Sorted folders to combine</div>
            <Button className="!h-8" variant="ghost" onClick={() => setPicked(new Set(usable.map(k => k.id!)))}>All</Button>
            <Button className="!h-8" variant="ghost" onClick={() => setPicked(new Set())}>None</Button>
          </div>
          <div className="grid gap-2 max-h-[40vh] overflow-auto" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
            {usable.map(k => (
              <label key={k.id} className="flex items-start gap-3 rounded-xl border border-line p-3 hover:bg-panel-2 cursor-pointer" data-combine-folder={k.path}>
                <input type="checkbox" className="mt-1" checked={picked.has(k.id!)}
                  onChange={e => { const s = new Set(picked); if (e.target.checked) s.add(k.id!); else s.delete(k.id!); setPicked(s); }} />
                <span className="min-w-0">
                  <span className="block font-medium truncate">{baseName(k.path)}</span>
                  <span className="block text-xs text-muted truncate">{k.path}</span>
                  <span className="block text-xs text-muted">{plural(k.personFolders ?? 0, 'person folder')} · {plural(k.photos, 'photo')}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
        <section className="rounded-2xl border border-line bg-panel p-5 space-y-3">
          <div className="font-semibold">2. Where the combined people go</div>
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0 text-sm truncate selectable">{dest ?? <span className="text-muted">Choose a folder, for example a new “People” folder.</span>}</div>
            <Button onClick={async () => { const f = await api.openFolder('Where should the combined people go?'); if (f) setDest(f); }}><Icon name="folder" size={16} />{dest ? 'Change…' : 'Choose…'}</Button>
          </div>
          {destKnown && <div className="text-xs text-muted">“{baseName(destKnown.path)}” is a sorted folder: its people stay where they are and the same people from the other folders join them.</div>}
          <label className="flex items-center gap-3 text-sm">
            <Toggle label="Also move people found in only one folder" checked={moveSingles} onChange={setMoveSingles} />
            Also move people found in only one folder <span className="text-muted">(so everyone is together; otherwise they stay where they are)</span>
          </label>
        </section>
        <div className="flex gap-2">
          <Button variant="primary" className="h-10" disabled={!enough || !dest} onClick={() => void findMatches()}><Icon name="people" size={16} />Find the same people</Button>
          {!enough && <span className="text-sm text-muted self-center">Choose at least two folders.</span>}
        </div>
        <p className="text-xs text-muted">Only person folders move. Photos a sort left in place (no faces, couldn’t recognise, Unsorted) stay in their folders.</p>
      </Shell>
    );
  }

  // ---------- comparing ----------
  if (step === 'matching' || step === 'moving') {
    const p = progress;
    const label = step === 'matching' ? 'Comparing people by face…'
      : p?.phase === 'naming' ? 'Writing the new names into the photos…' : p?.phase === 'finishing' ? 'Updating the group photo lists…' : 'Moving person folders…';
    return (
      <Shell>
        {head(step === 'matching' ? 'Finding the same people' : 'Combining people')}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-3">
          <div className="flex justify-between text-sm"><span>{label}</span><span className="text-muted tabular-nums">{p && p.total ? `${p.done.toLocaleString()} / ${p.total.toLocaleString()}` : ''}</span></div>
          <ProgressBar value={p && p.total ? p.done / p.total : 0} />
          {p?.current && <div className="text-xs text-muted truncate">{p.current}</div>}
          {step === 'moving' && <p className="text-xs text-muted">Every move is written to a log first. Please keep PixHaven open until this finishes.</p>}
        </div>
      </Shell>
    );
  }

  // ---------- done ----------
  if (step === 'done' && result) {
    return (
      <Shell>
        {head('People combined')}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-3">
          <div className="text-lg font-semibold">{plural(result.people, 'person')} in “{baseName(result.dest)}”</div>
          <div className="text-sm text-muted">{plural(result.moved, 'file')} moved{result.renamed ? ` · new names written into ${plural(result.renamed, 'photo')}` : ''}.</div>
          {result.skipped.length > 0 && (
            <Notice tone="warn">
              <div>{plural(result.skipped.length, 'item')} could not be done:</div>
              <ul className="mt-1 max-h-40 overflow-auto text-xs">{result.skipped.slice(0, 200).map((s, i) => <li key={i} className="truncate">{s.path}: {s.reason}</li>)}</ul>
            </Notice>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => onOpen(result.dest)}><Icon name="people" size={16} />Open in Photos</Button>
            <Button onClick={() => void api.openPath(result.dest)}><Icon name="external" size={16} />Open in File Explorer</Button>
          </div>
        </div>
      </Shell>
    );
  }

  // ---------- review the matches ----------
  const groupsShown = match?.groups ?? [];
  return (
    <Shell>
      {head('Check the matches', `${plural(groupsShown.length, 'person')} found in more than one folder · ${plural(match?.people.length ?? 0, 'person')} compared`)}
      {error && <Notice tone="danger">{error}</Notice>}
      {(match?.people.some(p => !p.matchable)) && (
        <Notice tone="warn">{plural(match!.people.filter(p => !p.matchable).length, 'person')} could not be compared (face data from an older version). Scan their folders again in Sort to include them.</Notice>
      )}
      {groupsShown.length === 0 && <Notice tone="info">No person was found in more than one of these folders.</Notice>}
      <div className="space-y-3">
        {groupsShown.map((g, i) => {
          const on = g.members.filter(id => !off.has(id)).length;
          return (
            <div key={i} className={`rounded-2xl border border-line bg-panel p-4 space-y-3 ${on < 2 ? 'opacity-60' : ''}`} data-combine-match={i}>
              <div className="flex items-center gap-3 flex-wrap">
                <input value={names[i] ?? ''} placeholder="Person (numbered automatically)" aria-label="Name"
                  onChange={e => setNames({ ...names, [i]: e.target.value })}
                  className="h-9 w-64 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
                <span className={`text-xs rounded-full px-2 py-0.5 ${g.score >= 0.5 ? 'bg-accent-soft text-accent' : 'bg-warn-soft text-warn'}`}>
                  {g.score >= 0.5 ? 'Strong match' : 'Likely match'}{g.sameName ? ' · same name' : ''}
                </span>
                {on < 2 && <span className="text-xs text-muted">Not combined: tick at least two</span>}
              </div>
              <div className="flex gap-3 flex-wrap">
                {g.members.map(id => { const p = people.get(id)!; return (
                  <PersonTile key={id} p={p} checked={!off.has(id)} onChange={v => { const s = new Set(off); if (v) s.delete(id); else s.add(id); setOff(s); }} />
                ); })}
              </div>
            </div>
          );
        })}
      </div>
      {moveSingles && singles.length > 0 && (
        <div className="rounded-2xl border border-line bg-panel p-4 space-y-2">
          <button className="flex items-center gap-2 text-sm font-medium" onClick={() => setShowSingles(!showSingles)}>
            <Icon name="chevron" size={14} className={showSingles ? 'rotate-90' : ''} />{plural(singles.length, 'person')} only in one folder move as they are
          </button>
          {showSingles && <div className="flex gap-3 flex-wrap">{singles.map(p => <PersonTile key={p.id} p={p} />)}</div>}
        </div>
      )}

      <div className="rounded-2xl border border-line bg-panel p-5 space-y-2 sticky bottom-0">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="mr-auto min-w-0">
            <div className="font-semibold">
              {estimating ? 'Working out how long it takes…' : estimate ? `${roughly(estimate.seconds)} (estimate)` : '—'}
            </div>
            {estimate && !estimating && (
              <div className="text-xs text-muted">
                {plural(merged, 'person')} combined, {plural(estimate.people - merged, 'person')} moved as they are · {plural(estimate.files, 'file')} ({fmtBytes(estimate.bytes)})
                {' · '}{estimate.sameDrive ? 'same drive: folders are renamed, not copied' : 'another drive: files are copied, checked, then removed'}
                {estimate.renamed ? ` · new names written into ${plural(estimate.renamed, 'photo')}` : ''}
              </div>
            )}
          </div>
          <Button onClick={() => setStep('choose')}>Back</Button>
          <Button variant="primary" className="h-10" disabled={!req?.groups.length || estimating} onClick={() => setConfirm(true)}><Icon name="people" size={16} />Combine…</Button>
        </div>
      </div>

      {confirm && estimate && dest && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={() => setConfirm(false)}>
          <div className="w-[480px] rounded-2xl bg-panel border border-line shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label="Combine people">
            <div className="font-semibold">Move {plural(estimate.people, 'person')} into “{baseName(dest)}”?</div>
            <div className="text-sm text-muted leading-relaxed">
              {plural(estimate.files, 'file')} ({fmtBytes(estimate.bytes)}) move into {dest}. This takes {roughly(estimate.seconds)}.
              Labels, stars, face data and group photo shortcuts follow. Combining can’t be undone with one click; every move is listed in
              “{baseName(dest)}\.clearup\combine-log.jsonl”.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => void run()}>Combine</Button>
            </div>
          </div>
        </div>
      )}
    </Shell>
  );
}

function PersonTile({ p, checked, onChange }: { p: CombinePerson; checked?: boolean; onChange?: (v: boolean) => void }) {
  return (
    <label className={`w-40 rounded-xl border border-line p-2 ${onChange ? 'cursor-pointer hover:bg-panel-2' : ''}`} data-combine-person={p.id}>
      <div className="relative grid grid-cols-2 gap-0.5 aspect-square rounded-lg overflow-hidden bg-panel-2">
        {p.faceUrls.slice(0, 4).map(u => <img key={u} src={u} alt="" loading="lazy" decoding="async" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} className="w-full h-full object-cover" />)}
        {onChange && <input type="checkbox" className="absolute top-1.5 left-1.5" checked={!!checked} onChange={e => onChange(e.target.checked)} aria-label={`Include ${p.label} from ${baseName(p.folder)}`} />}
      </div>
      <div className="mt-1.5 text-sm font-medium truncate">{p.label}</div>
      <div className="text-xs text-muted truncate" title={p.folder}>{baseName(p.folder)} · {plural(p.photos, 'photo')}</div>
    </label>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-auto p-8"><div className="max-w-5xl mx-auto space-y-5">{children}</div></div>;
}
