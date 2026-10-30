// v2.9 Photos → a person → "Merge into…": a person who is really someone else goes where they belong. PixHaven compares
// each of their photos with everyone in the sorted folder: all of them like Person 4 → one click merges into Person 4;
// spread over several people → one click sends each photo to its person. Or pick one person and merge everything there.
import { useEffect, useMemo, useState } from 'react';
import type { MergePlan, MergeResult, PersonSummary } from '@shared/types';
import { api, errorText } from '../api';
import { Button, Icon } from './ui';

interface Props { person: PersonSummary; people: PersonSummary[]; onDone: (r: MergeResult, what: string) => void; onClose: () => void }

const plural = (n: number, w: string) => `${n.toLocaleString()} ${n === 1 ? w : w === 'person' ? 'people' : `${w}s`}`;

export function MergeDialog({ person, people, onDone, onClose }: Props) {
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [off, setOff] = useState<Set<number>>(new Set());     // matched people left out
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.photos.mergeSuggest(person.id).then(p => live && setPlan(p)).catch(e => live && setError(errorText(e)));
    return () => { live = false; };
  }, [person.id]);

  const chosen = plan?.targets.filter(t => !off.has(t.personId)) ?? [];
  const count = chosen.reduce((n, t) => n + t.photos.length, 0);
  const others = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(p => p.id !== person.id && (!q || p.label.toLowerCase().includes(q))).slice(0, 60);
  }, [people, person.id, query]);

  const run = async (moves: { imageId: number; to: number }[] | null, all: number | null, what: string) => {
    setBusy(true); setError(null);
    try { onDone(await api.photos.merge(person.id, moves, all), what); } catch (e) { setError(errorText(e)); setBusy(false); }
  };
  const mergeMatched = () => {
    const moves = chosen.flatMap(t => t.photos.map(p => ({ imageId: p.imageId, to: t.personId })));
    void run(moves, null, chosen.length === 1 ? `into ${chosen[0].label}` : `into ${plural(chosen.length, 'person')}`);
  };
  const button = chosen.length === 1 ? `Merge ${plural(count, 'photo')} into ${chosen[0].label}` : `Merge ${plural(count, 'photo')} into ${plural(chosen.length, 'person')}`;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center" onClick={() => !busy && onClose()}>
      <div className="w-[640px] max-h-[86vh] flex flex-col rounded-2xl bg-panel border border-line shadow-2xl p-5 gap-3" onClick={e => e.stopPropagation()} role="dialog" aria-label="Merge into">
        <div className="font-semibold">Merge {person.label} into…</div>
        {!plan && !error && <div className="text-sm text-muted py-6">Comparing {person.label}’s faces with everyone else in this folder…</div>}
        {plan && (
          <div className="flex-1 min-h-0 overflow-auto space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted">Matched by face</div>
            {plan.targets.length === 0 && <div className="text-sm text-muted">No photo clearly looks like anyone else. Choose a person below to merge all of them there.</div>}
            {plan.targets.map(t => (
              <label key={t.personId} className="flex items-start gap-3 rounded-xl border border-line p-3 cursor-pointer hover:bg-panel-2" data-merge-target={t.label}>
                <input type="checkbox" className="mt-3" checked={!off.has(t.personId)} disabled={busy}
                  onChange={e => { const s = new Set(off); if (e.target.checked) s.delete(t.personId); else s.add(t.personId); setOff(s); }} />
                {t.faceUrl ? <img src={t.faceUrl} alt="" className="w-11 h-11 rounded-full object-cover shrink-0" /> : <div className="w-11 h-11 rounded-full bg-panel-2 shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{t.label} <span className="text-sm text-muted font-normal">· {plural(t.photos.length, 'photo')}</span></div>
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {t.photos.slice(0, 10).map(p => p.thumbUrl ? <img key={p.imageId} src={p.thumbUrl} alt="" title={p.path} className="w-12 h-12 rounded object-cover" /> : null)}
                    {t.photos.length > 10 && <span className="text-xs text-muted self-center">+{t.photos.length - 10}</span>}
                  </div>
                </div>
              </label>
            ))}
            {plan.unmatched.length > 0 && <div className="text-sm text-muted">{plural(plan.unmatched.length, 'photo')} had no clear match and stay with {person.label}.</div>}

            <div className="text-xs font-semibold uppercase tracking-wide text-muted pt-2">Or merge all {plural(plan.photos, 'photo')} into one person</div>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Find a person" aria-label="Find a person"
              onKeyDown={e => { if (e.key === 'Escape') onClose(); e.stopPropagation(); }}
              className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
            <div className="rounded-xl border border-line divide-y divide-line max-h-56 overflow-auto">
              {others.map(p => (
                <div key={p.id} className="flex items-center gap-2 px-3 h-11" data-merge-person={p.label}>
                  {p.faceUrls[0] ? <img src={p.faceUrls[0]} alt="" className="w-7 h-7 rounded-full object-cover" /> : <div className="w-7 h-7 rounded-full bg-panel-2" />}
                  <span className="text-sm truncate flex-1">{p.label} <span className="text-muted">· {plural(p.photos, 'photo')}</span></span>
                  <Button className="!h-7 text-xs" disabled={busy} onClick={() => void run(null, p.id, `into ${p.label}`)}>Merge all here</Button>
                </div>
              ))}
              {others.length === 0 && <div className="p-3 text-sm text-muted">Nobody by that name.</div>}
            </div>
          </div>
        )}
        {error && <div className="text-sm text-danger" role="alert">{error}</div>}
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted mr-auto">Photos move into the new person’s folder; names, labels and group photo shortcuts follow.</span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          {plan && plan.targets.length > 0 && <Button variant="primary" disabled={busy || !count} onClick={mergeMatched}><Icon name="people" size={15} />{busy ? 'Merging…' : button}</Button>}
        </div>
      </div>
    </div>
  );
}
