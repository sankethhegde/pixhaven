// 1.0.13: "More like this" in the player (the i button, full screen): other videos of the list with the same people
// in them, then those with similar names. Made to be instant: names are compared in memory (rare words, like a
// person's name, count most), and the people come from "People in this video" answers already worked out — no new
// search is started here.
import { useEffect, useMemo, useState } from 'react';
import type { MediaEntry, MediaInfo } from '@shared/types';
import { api, fmtClock } from '../api';
import { Icon } from './ui';
import * as T from '../tags';

// Little words that say nothing about what a video is.
const STOP = new Set(('the and with her his him she they them their this that these those for from into onto over out off are was were '
  + 'has have had get gets got you your yours our ours who what when where why how all any one two new part video videos clip clips '
  + 'mp4 mkv avi mov webm wmv full final copy edit').split(' '));
const isPerson = (name: string) => !/^person\s*\d+$/i.test(name.trim());

/** The words of a file name that can match another's: not the extension, numbers, resolutions or little words. */
export function words(name: string): string[] {
  const base = name.replace(/\.[^.]+$/, '').toLowerCase();
  const out: string[] = [];
  for (const w of base.split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w) || /^\d{3,4}[pk]$/.test(w) || /^s\d+e\d+$/.test(w)) continue;
    out.push(w);
  }
  return out;
}

interface Hit { i: number; why: string[]; score: number }

/** Videos of the list whose names share rare words with this one, best first (a shared pair of words counts more). */
export function similarByName(items: MediaEntry[], index: number, max = 30): Hit[] {
  const ws = items.map(e => (e.kind === 'video' ? words(e.name) : []));
  const df = new Map<string, number>();
  for (const w of ws) for (const t of new Set(w)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = ws.filter(w => w.length).length || 1;
  const limit = Math.max(3, Math.ceil(n * 0.15));     // a word in more videos than this says little
  const mine = ws[index];
  const mineSet = new Set(mine);
  const pairs = new Set(mine.slice(1).map((w, k) => `${mine[k]} ${w}`));
  const hits: Hit[] = [];
  ws.forEach((w, i) => {
    if (i === index || !w.length) return;
    const shared = [...new Set(w)].filter(t => mineSet.has(t) && (df.get(t) ?? 0) <= limit);
    if (!shared.length) return;
    let score = shared.reduce((s, t) => s + Math.log(n / (df.get(t) ?? 1)), 0);
    for (let k = 1; k < w.length; k++) if (pairs.has(`${w[k - 1]} ${w[k]}`)) score += 1;
    hits.push({ i, why: shared, score });
  });
  return hits.sort((a, b) => b.score - a.score).slice(0, max);
}

interface Props {
  items: MediaEntry[];
  index: number;
  infos: Map<string, MediaInfo>;
  onIndex: (i: number) => void;
  onClose: () => void;
  faded: boolean;                    // fades with the player's controls
  onWake: () => void;
}

export function MoreLikeThis({ items, index, infos, onIndex, onClose, faded, onWake }: Props) {
  const item = items[index];
  const [people, setPeople] = useState<{ names: string[]; videos: Map<string, string[]> } | null>(null);
  const [, setTick] = useState(0);
  const at = useMemo(() => new Map(items.map((e, i) => [e.path.toLowerCase(), i])), [items]);

  useEffect(() => {
    let live = true;
    setPeople(null);
    void api.videoFaces.related(item.path).then(r => {
      if (live) setPeople({ names: r.people.map(p => p.name), videos: new Map(r.videos.map(v => [v.path.toLowerCase(), v.people])) });
    }).catch(() => live && setPeople({ names: [], videos: new Map() }));
    return () => { live = false; };
  }, [item.path]);

  const byName = useMemo(() => similarByName(items, index), [items, index]);
  // Same people: videos those people were found in, and videos with a person's name in their file name.
  const samePeople = useMemo(() => {
    if (!people) return [];
    const out = new Map<number, string[]>();
    for (const [p, names] of people.videos) { const i = at.get(p); if (i !== undefined && i !== index) out.set(i, names); }
    for (const name of people.names.filter(isPerson)) {
      const need = words(name);
      if (!need.length) continue;
      items.forEach((e, i) => {
        if (i === index || e.kind !== 'video') return;
        const w = new Set(words(e.name));
        if (need.every(t => w.has(t))) out.set(i, [...new Set([...(out.get(i) ?? []), name])]);
      });
    }
    return [...out].map(([i, why]) => ({ i, why, score: why.length })).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, 30);
  }, [people, at, items, index]);
  const shownPeople = new Set(samePeople.map(h => h.i));
  const names = byName.filter(h => !shownPeople.has(h.i));

  // Thumbnails and lengths for what is listed.
  useEffect(() => {
    const want = [...samePeople, ...names].map(h => items[h.i]).filter(e => !infos.get(e.path)?.thumb);
    if (!want.length) return;
    let live = true;
    api.lib.thumbs(want.map(T.ref)).then(ready => { for (const i of ready) infos.set(i.path, i); if (live && ready.length) setTick(t => t + 1); }).catch(() => {});
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [samePeople, byName]);

  const row = (h: Hit | { i: number; why: string[] }, kind: 'people' | 'name') => {
    const e = items[h.i];
    const inf = infos.get(e.path);
    return (
      <button key={`${kind}${h.i}`} onClick={() => onIndex(h.i)} data-more={e.name} data-more-kind={kind} title={e.path}
        className="w-full flex gap-2.5 p-1.5 rounded-lg text-left hover:bg-white/10">
        <div className="relative w-28 shrink-0 aspect-video rounded-md overflow-hidden bg-white/10 flex items-center justify-center">
          {inf?.thumb ? <img src={inf.thumb} alt="" className="w-full h-full object-cover" draggable={false} loading="lazy" /> : <Icon name="video" size={16} className="text-white/50" />}
          {inf?.duration ? <span className="absolute bottom-0.5 right-0.5 text-[10px] px-1 rounded bg-black/75">{fmtClock(inf.duration)}</span> : null}
        </div>
        <div className="min-w-0 py-0.5">
          <div className="text-[13px] leading-snug line-clamp-2 break-words">{e.name}</div>
          <div className="text-[11px] text-white/55 mt-0.5 truncate">{kind === 'people' ? h.why.join(', ') : `“${h.why.join('”, “')}”`}</div>
        </div>
      </button>
    );
  };

  return (
    <div className={`absolute z-20 top-16 right-3 w-96 max-h-[calc(100%-11rem)] flex flex-col rounded-2xl bg-black/55 backdrop-blur-md border border-white/10 transition-opacity ${faded ? 'opacity-0 pointer-events-none' : ''}`}
      onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()} onMouseMove={onWake} onWheel={onWake}
      aria-label="More like this" data-testid="more-like-this">
      <div className="flex items-center px-4 pt-3 pb-2 text-sm font-medium">More like this
        <button className="ml-auto text-white/60 hover:text-white" onClick={onClose} aria-label="Close More like this"><Icon name="x" size={15} /></button>
      </div>
      <div className="overflow-y-auto min-h-0 px-2 pb-3 space-y-3">
        {people && samePeople.length > 0 && (
          <section data-testid="more-people">
            <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-white/50">Same people · {people.names.join(', ')}</div>
            {samePeople.map(h => row(h, 'people'))}
          </section>
        )}
        {names.length > 0 && (
          <section data-testid="more-names">
            <div className="px-2 pb-1 text-[11px] uppercase tracking-wide text-white/50">Similar names</div>
            {names.map(h => row(h, 'name'))}
          </section>
        )}
        {people && !samePeople.length && !names.length && <div className="px-2 text-sm text-white/60">No other videos with the same people or a similar name in this list.</div>}
        {people && !people.names.length && (
          <div className="px-2 text-[11px] text-white/45">People appear here once “People in this video” has looked at this video (Theatre, under the video).</div>
        )}
      </div>
    </div>
  );
}
