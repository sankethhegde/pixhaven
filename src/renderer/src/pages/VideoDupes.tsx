// 1.1.0 Tidy up → Duplicate videos: the same video more than once (exact copies, renamed, another quality), longer
// versions, and two parts that overlap. You look them over and choose; nothing is touched until you apply. Copies go
// to "Removed duplicates" at the top of their drive (folders kept), so you can check them before deleting.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DupeApplyProgress, DupeApplyResult, DupeChoices, DupeScanState, DupeVideo, MediaInfo } from '@shared/types';
import { REMOVED_DUPLICATES } from '@shared/types';
import { api, errorText, fmtBytes, fmtClock } from '../api';
import { Button, Icon, Notice, ProgressBar } from '../components/ui';
import * as T from '../tags';

const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');
const quality = (v: DupeVideo) => (v.width && v.height ? `${Math.min(v.width, v.height)}p` : '');
const k = (p: string) => p.toLowerCase();

export function VideoDupes({ header }: { header: ReactNode }) {
  const [s, setS] = useState<DupeScanState | null>(null);
  const [keep, setKeep] = useState<Record<string, string | null>>({});      // same group id → path kept
  const [off, setOff] = useState<Set<string>>(new Set());                    // ids left out
  const [infos, setInfos] = useState<Map<string, MediaInfo>>(new Map());
  const [applyP, setApplyP] = useState<DupeApplyProgress | null>(null);
  const [result, setResult] = useState<DupeApplyResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.vdupes.status().then(setS);
    const offs = [api.onDupesState(setS), api.onDupesApply(setApplyP),
      api.onLibThumb(i => setInfos(m => { if (!m.has(i.path) && !i.thumb) return m; const n = new Map(m); n.set(i.path, i); return n; }))];   // thumbnails made later
    return () => offs.forEach(o => o());
  }, []);
  // A fresh result: the suggested copy to keep (none where you choose), everything included.
  useEffect(() => {
    if (s?.state !== 'done') return;
    setKeep(Object.fromEntries(s.same.map(g => [g.id, g.keep])));
    setOff(new Set());
    setConfirm(false);
  }, [s?.state, s?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(() => !s ? [] : [...s.same.flatMap(g => g.videos), ...s.longer.flatMap(l => [l.longer, l.shorter]), ...s.combine.flatMap(c => [c.first, c.second])], [s]);
  useEffect(() => {
    const want = all.filter(v => !infos.get(v.path)?.thumb);
    if (!want.length) return;
    let live = true;
    api.lib.thumbs(want.map(T.ref)).then(r => { if (live && r.length) setInfos(m => { const n = new Map(m); for (const i of r) n.set(i.path, i); return n; }); }).catch(() => {});
    return () => { live = false; };
  }, [all]); // eslint-disable-line react-hooks/exhaustive-deps

  // What applying does, from your choices.
  const choices = useMemo((): DupeChoices & { bytes: number; undecided: number } => {
    const c: DupeChoices & { bytes: number; undecided: number } = { remove: [], combine: [], bytes: 0, undecided: 0 };
    if (!s) return c;
    const stays = new Map<string, string>();        // a copy set aside → the one kept in its group
    for (const g of s.same) {
      const kp = keep[g.id];
      if (!kp) { c.undecided++; continue; }
      if (off.has(g.id)) continue;
      for (const v of g.videos) if (v.path !== kp) { c.remove.push({ path: v.path, keptAs: kp }); c.bytes += v.size; stays.set(k(v.path), kp); }
    }
    const kept = (p: string) => stays.get(k(p)) ?? p;
    for (const l of s.longer) {
      if (off.has(l.id) || stays.has(k(l.shorter.path))) continue;
      c.remove.push({ path: l.shorter.path, keptAs: kept(l.longer.path) }); c.bytes += l.shorter.size;
    }
    for (const x of s.combine) {
      if (off.has(x.id) || stays.has(k(x.first.path)) || stays.has(k(x.second.path))) continue;
      c.combine.push({ first: x.first.path, second: x.second.path, cut: x.cut }); c.bytes += x.first.size + x.second.size;
    }
    return c;
  }, [s, keep, off]);
  const toggle = (id: string) => setOff(o => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const apply = async () => {
    setConfirm(false); setError(null); setResult(null);
    setApplyP({ state: 'running', step: 'Starting…', done: 0, total: choices.remove.length + choices.combine.length });
    try { setResult(await api.vdupes.apply({ remove: choices.remove, combine: choices.combine })); }
    catch (e) { setError(errorText(e)); }
    finally { setApplyP(null); void api.vdupes.status().then(setS); }
  };

  const busy = s?.state === 'scanning' || s?.state === 'matching';
  const found = s ? s.same.length + s.longer.length + s.combine.length : 0;
  const thumb = (v: DupeVideo) => infos.get(v.path)?.thumb ?? undefined;

  const Row = ({ v, tag, tone, radio }: { v: DupeVideo; tag?: string; tone?: 'keep' | 'remove' | 'new'; radio?: { name: string; checked: boolean; onChange: () => void } }) => (
    <div className={`flex items-center gap-3 p-2 rounded-lg ${tone === 'remove' ? 'opacity-70' : ''}`} data-dupe-video={v.name} data-tone={tone}>
      {radio && <input type="radio" name={radio.name} checked={radio.checked} onChange={radio.onChange} aria-label={`Keep ${v.name}`} className="accent-[var(--color-accent)]" />}
      <div className="w-32 shrink-0 aspect-video rounded-md overflow-hidden bg-panel-2 flex items-center justify-center relative">
        {thumb(v) ? <img src={thumb(v)} alt="" className="w-full h-full object-cover" draggable={false} /> : <Icon name="video" size={18} className="text-muted" />}
        {v.duration ? <span className="absolute bottom-1 right-1 text-[10px] px-1 rounded bg-black/75 text-white">{fmtClock(v.duration)}</span> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm truncate" title={v.path}>{v.name}</div>
        <div className="text-xs text-muted truncate" title={folderOf(v.path)}>{folderOf(v.path)}</div>
        <div className="text-xs text-muted">{[quality(v), fmtBytes(v.size)].filter(Boolean).join(' · ')}</div>
      </div>
      {tag && <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${tone === 'keep' ? 'bg-accent-soft text-accent' : tone === 'new' ? 'bg-accent text-accent-fg' : 'bg-panel-2 text-muted'}`}>{tag}</span>}
      <button className="text-muted hover:text-fg shrink-0" onClick={() => void api.showItem(v.path)} title="Show in Explorer" aria-label={`Show ${v.name} in Explorer`}><Icon name="external" size={14} /></button>
    </div>
  );
  const Card = ({ id, title, note, children, needsChoice }: { id: string; title: string; note?: string; children: ReactNode; needsChoice?: boolean }) => (
    <div className={`rounded-xl border bg-panel p-3 ${needsChoice ? 'border-[#f5b301]/60' : 'border-line'} ${off.has(id) ? 'opacity-50' : ''}`} data-dupe-card={id}>
      <div className="flex items-center gap-2 px-2 pb-1">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={!off.has(id)} onChange={() => toggle(id)} aria-label={`Include: ${title}`} />{title}
        </label>
        {note && <span className={`text-xs ${needsChoice ? 'text-[#b88400]' : 'text-muted'}`}>{note}</span>}
      </div>
      {children}
    </div>
  );

  return (
    <div className="h-full overflow-auto p-8" data-testid="video-dupes">
      <div className="max-w-4xl mx-auto space-y-5">
        {header}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
          <div className="flex items-start gap-4">
            <div className="rounded-full p-3 bg-accent-soft text-accent"><Icon name="video" size={24} /></div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="font-semibold">Duplicate videos</div>
              <p className="text-sm text-muted">PixHaven looks at what is in each video, so it also finds renamed copies, the same video in a lower quality,
                longer versions, and two parts that overlap. You choose what happens; copies are moved to a “{REMOVED_DUPLICATES}” folder, not deleted.</p>
              <p className="text-xs text-muted">It checks the videos in the Videos tab. The first check reads every video once; later checks only read new ones.</p>
            </div>
            {busy ? <Button onClick={() => void api.vdupes.cancel()}><Icon name="x" size={15} />Stop</Button>
              : <Button variant="primary" onClick={() => void api.vdupes.scan().then(setS)} disabled={!!applyP} data-testid="dupes-check"><Icon name="search" size={15} />{s?.at ? 'Check again' : 'Check my videos'}</Button>}
          </div>
          {busy && s && (
            <div className="space-y-1.5" role="status" data-testid="dupes-progress">
              <div className="text-sm text-muted">{s.state === 'matching' ? 'Comparing videos…' : `Reading videos… ${s.done} of ${s.total}${s.current ? ` · ${s.current}` : ''}`}</div>
              <ProgressBar value={s.state === 'matching' ? 100 : s.total ? Math.round((s.done / s.total) * 100) : 0} />
            </div>
          )}
          {s?.state === 'error' && <Notice tone="danger">The check stopped: {s.error}</Notice>}
          {s?.state === 'cancelled' && <div className="text-sm text-muted">Stopped. What was read so far is kept: “Check again” goes on from there.</div>}
          {s?.state === 'done' && (
            <div className="text-sm" data-testid="dupes-summary">
              {found ? <>Found <b>{s.same.length}</b> video{s.same.length === 1 ? '' : 's'} with copies, <b>{s.longer.length}</b> longer version{s.longer.length === 1 ? '' : 's'} and <b>{s.combine.length}</b> pair{s.combine.length === 1 ? '' : 's'} to combine.</>
                : 'No duplicate videos found.'}
              {s.failed ? <span className="text-muted"> {s.failed} video{s.failed === 1 ? '' : 's'} could not be read.</span> : null}
            </div>
          )}
        </div>

        {result && (
          <div className="rounded-xl border border-line bg-panel p-4 space-y-1 text-sm" role="status" data-testid="dupes-result">
            <div className="font-medium">Done: {result.moved.length} video{result.moved.length === 1 ? '' : 's'} moved to “{REMOVED_DUPLICATES}” ({fmtBytes(result.freed)}){result.combined.length ? `, ${result.combined.length} combined` : ''}.</div>
            {result.combined.map(c => <div key={c.out} className="text-muted truncate">New video: {c.out}</div>)}
            {result.failed.map(f => <div key={f.path} className="text-danger truncate">Not done: {f.path}: {f.reason}</div>)}
            {result.moved[0] && <Button className="!h-8 mt-1" variant="ghost" onClick={() => void api.showItem(result.moved[0].to)}><Icon name="folder" size={14} />Open “{REMOVED_DUPLICATES}”</Button>}
          </div>
        )}

        {s && s.state !== 'scanning' && s.state !== 'matching' && found > 0 && (
          <>
            {s.same.length > 0 && (
              <section className="space-y-2" data-testid="dupes-same">
                <h2 className="font-semibold">Same video <span className="text-sm text-muted font-normal">· keep one, the others are moved</span></h2>
                {s.same.map(g => {
                  const kp = keep[g.id];
                  return (
                    <Card key={g.id} id={g.id} title={`${g.videos.length} copies${g.exact ? ' (exactly the same files)' : ''}`}
                      note={kp ? 'The best quality is chosen to keep; you can change it.' : 'Same quality: choose the one to keep.'} needsChoice={!kp}>
                      {g.videos.map(v => <Row key={v.path} v={v} tone={kp === v.path ? 'keep' : kp ? 'remove' : undefined} tag={kp === v.path ? 'Keep' : kp ? 'Move' : undefined}
                        radio={{ name: g.id, checked: kp === v.path, onChange: () => setKeep(m => ({ ...m, [g.id]: v.path })) }} />)}
                    </Card>
                  );
                })}
              </section>
            )}
            {s.longer.length > 0 && (
              <section className="space-y-2" data-testid="dupes-longer">
                <h2 className="font-semibold">Longer versions <span className="text-sm text-muted font-normal">· the longer video holds all of the shorter one</span></h2>
                {s.longer.map(l => (
                  <Card key={l.id} id={l.id} title={`${l.longer.name} holds all of ${l.shorter.name}`} note={`from ${fmtClock(l.at)}`}>
                    <Row v={l.longer} tone="keep" tag="Keep" />
                    <Row v={l.shorter} tone="remove" tag="Move" />
                  </Card>
                ))}
              </section>
            )}
            {s.combine.length > 0 && (
              <section className="space-y-2" data-testid="dupes-combine">
                <h2 className="font-semibold">Parts to combine <span className="text-sm text-muted font-normal">· the end of one is the start of the other</span></h2>
                {s.combine.map(c => (
                  <Card key={c.id} id={c.id} title={`${c.first.name} + ${c.second.name}`}
                    note={`They share ${fmtClock(c.overlapSec)}. One new video is made (the first part, then the second from ${fmtClock(c.cut)}); both parts are moved.`}>
                    <Row v={c.first} tag="Part 1" />
                    <Row v={c.second} tag="Part 2" />
                  </Card>
                ))}
              </section>
            )}
            <div className="sticky bottom-0 -mx-2 px-4 py-3 rounded-xl bg-panel border border-line shadow-lg flex items-center gap-3 flex-wrap" data-testid="dupes-apply-bar">
              {applyP ? (
                <div className="flex-1 min-w-0 space-y-1" role="status">
                  <div className="text-sm truncate">{applyP.step} ({applyP.done} of {applyP.total})</div>
                  <ProgressBar value={applyP.percent ?? (applyP.total ? (applyP.done / applyP.total) * 100 : 0)} />
                </div>
              ) : (
                <>
                  <div className="text-sm flex-1 min-w-0">
                    {choices.remove.length || choices.combine.length
                      ? <>{choices.remove.length} video{choices.remove.length === 1 ? '' : 's'} moved{choices.combine.length ? `, ${choices.combine.length} pair${choices.combine.length === 1 ? '' : 's'} combined (then moved)` : ''} · {fmtBytes(choices.bytes)}</>
                      : 'Nothing chosen yet.'}
                    {choices.undecided ? <span className="text-[#b88400]"> · {choices.undecided} group{choices.undecided === 1 ? '' : 's'} waiting for you to choose</span> : null}
                  </div>
                  {confirm
                    ? <><Button variant="ghost" onClick={() => setConfirm(false)}>Back</Button><Button variant="primary" onClick={() => void apply()} data-testid="dupes-confirm">Yes, move them</Button></>
                    : <Button variant="primary" disabled={!choices.remove.length && !choices.combine.length} onClick={() => setConfirm(true)} data-testid="dupes-apply">Apply</Button>}
                </>
              )}
            </div>
            {confirm && <div className="text-sm text-muted text-right">Moved videos go to “{REMOVED_DUPLICATES}” at the top of their drive, in the same folders. Nothing is deleted.</div>}
          </>
        )}
      </div>
    </div>
  );
}
