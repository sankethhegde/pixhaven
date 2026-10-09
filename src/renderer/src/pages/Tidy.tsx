// Tidy up (Phase 5): find duplicate and blurry photos, sort a folder by date or place. Everything is undoable,
// except sending to the Recycle Bin / Trash (restore those from there).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ApplyProgress, ApplyResult, ScanProgress, Settings, SortHistory, SortPlan, TidyPhotoRef, TidyResults } from '@shared/types';
import { api, binName, errorText, fmtBytes, fmtDuration, isIn } from '../api';
import { Button, Icon, Notice, ProgressBar, Segmented, Toggle } from '../components/ui';

export type TidyTab = 'dupes' | 'organize';
type Step = 'pick' | 'scanning' | 'results' | 'preview' | 'applying' | 'done';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  tab: TidyTab;
  onTab: (t: TidyTab) => void;
  initialFolder?: string | null;
  onConsumedInitial?: () => void;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function Tidy({ settings, onSettings, tab, onTab, initialFolder, onConsumedInitial }: Props) {
  const [step, setStep] = useState<Step>('pick');
  const [folder, setFolder] = useState<string | null>(null);
  const [status, setStatus] = useState<{ folderId: number | null; scanned: number; history: SortHistory[] } | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [results, setResults] = useState<TidyResults | null>(null);
  const [plan, setPlan] = useState<SortPlan | null>(null);
  const [planKind, setPlanKind] = useState<'duplicates' | 'blurry' | 'organize'>('organize');
  const [applyP, setApplyP] = useState<ApplyProgress | null>(null);
  const [done, setDone] = useState<{ title: string; lines: string[]; kept?: { path: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selDup, setSelDup] = useState<Set<number>>(new Set());
  const [selBlur, setSelBlur] = useState<Set<number>>(new Set());
  const [confirmTrash, setConfirmTrash] = useState<{ ids: number[]; label: string } | null>(null);
  const folderRef = useRef<string | null>(null);
  const t = settings.tidy;

  useEffect(() => {
    const offs = [
      api.onTidyProgress(p => { if (p.folder === folderRef.current) { setProgress(p); if (p.phase === 'error') { setError(p.error ?? 'Scan failed'); setStep('pick'); } } }),
      api.onTidyScanned(r => { if (folderRef.current) { if (r.cancelled) setStep('pick'); else loadResults(r.folderId); } }),
      api.onTidyApply(setApplyP),
    ];
    return () => offs.forEach(o => o());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (initialFolder) { choose(initialFolder); onConsumedInitial?.(); } }, [initialFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  const setTidy = async (patch: Partial<Settings['tidy']>) => {
    const s = await api.setSettings({ tidy: { ...settings.tidy, ...patch } });
    onSettings(s);
    return s;
  };

  async function choose(f: string) {
    setError(null); setResults(null); setPlan(null); setDone(null);
    if ((await api.pathKind(f)) !== 'folder') { setError('Please choose a folder.'); return; }
    folderRef.current = f; setFolder(f); setStep('pick');
    setStatus(await api.tidy.status(f));
  }

  async function scan() {
    if (!folder) return;
    setError(null); setProgress({ folder, phase: 'listing', done: 0, total: 0, faces: 0, people: 0 }); setStep('scanning');
    try { await api.tidy.scan(folder); } catch (e) { setError(errorText(e)); setStep('pick'); }
  }

  async function loadResults(fid: number) {
    try {
      const r = await api.tidy.results(fid);
      setResults(r);
      // Extra copies are pre-selected (the suggested keeper never is); blurry photos are left for you to pick.
      setSelDup(new Set(r.duplicates.flatMap(g => g.photos.filter(p => p.id !== g.keep).map(p => p.id))));
      setSelBlur(new Set());
      setStep('results');
    } catch (e) { setError(errorText(e)); }
  }

  async function preview(kind: 'duplicates' | 'blurry' | 'organize') {
    if (!results) return;
    setError(null);
    try {
      const p = kind === 'organize' ? await api.tidy.organizePlan(results.folderId) : await api.tidy.setAsidePlan(results.folderId, kind, [...(kind === 'duplicates' ? selDup : selBlur)]);
      setPlan(p); setPlanKind(kind); setStep('preview');
    } catch (e) { setError(errorText(e)); }
  }

  async function apply() {
    if (!results) return;
    setApplyP(null); setStep('applying');
    try {
      const r: ApplyResult = await api.tidy.apply(results.folderId);
      setDone({
        title: planKind === 'organize' ? 'Photos sorted into folders' : `Photos moved to “${base(plan!.targets[0].dir)}”`,
        lines: [`${r.moved} photos moved.`, ...(r.skipped.length ? [`${r.skipped.length} left in place.`] : [])],
        kept: r.skipped,
      });
      setStep('done');
    } catch (e) { setError(errorText(e)); setStep('preview'); }
  }

  async function undo(h: SortHistory) {
    setApplyP(null); setStep('applying');
    try {
      const r = await api.tidy.undo(h.id);
      setDone({ title: 'Undo finished', lines: [`${r.restored} changes reversed.`], kept: r.kept });
      setStep('done');
    } catch (e) { setError(errorText(e)); setStep('pick'); }
  }

  async function trash(ids: number[]) {
    if (!results) return;
    setConfirmTrash(null);
    try {
      const r = await api.tidy.trash(results.folderId, ids);
      setDone({ title: `Sent to the ${binName}`, lines: [`${r.trashed} photos are in the ${binName}. Restore them from there if needed.`], kept: r.failed });
      setStep('done');
    } catch (e) { setError(errorText(e)); }
  }

  const header = (
    <div className="flex items-end gap-3 flex-wrap">
      <div className="mr-auto">
        <h1 className="text-2xl font-semibold">Tidy up</h1>
        <p className="text-sm text-muted mt-1">Find duplicate and blurry photos, or sort a folder by date or place.</p>
      </div>
      <Segmented<TidyTab> label="Tool" value={tab} onChange={onTab}
        options={[{ value: 'dupes', label: 'Duplicates & blurry' }, { value: 'organize', label: 'By date or place' }]} />
    </div>
  );

  // ---------- pick ----------
  if (step === 'pick') {
    const last = status?.history.find(h => h.state === 'done');
    return (
      <Page>
        {header}
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="rounded-full p-3 bg-accent-soft text-accent"><Icon name={tab === 'dupes' ? 'copy' : 'calendar'} size={24} /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{folder ? base(folder) : 'Choose a folder of photos'}</div>
              <div className="text-sm text-muted truncate selectable">{folder ?? (tab === 'dupes' ? 'PixHaven finds identical files, resized copies and blurry shots. You choose what to set aside.' : 'PixHaven sorts photos into Year / Month or Country / City folders, using the date and GPS saved in each photo.')}</div>
            </div>
            <Button onClick={async () => { const f = await api.openFolder('Choose a folder of photos'); if (f) choose(f); }}><Icon name="folder" size={16} />{folder ? 'Change…' : 'Choose folder…'}</Button>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Toggle label="Include subfolders" checked={t.includeSubfolders} onChange={v => setTidy({ includeSubfolders: v })} />
            Include subfolders <span className="text-muted">(folders made by PixHaven are always skipped)</span>
          </label>
          {status && status.scanned > 0 && <div className="text-sm text-muted">Scanned before: {status.scanned} photos. Scanning again only reads new or changed photos.</div>}
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" className="h-10" disabled={!folder} onClick={scan}><Icon name="sparkle" size={16} />Scan folder</Button>
            {last && <Button className="h-10" variant="danger" onClick={() => undo(last)}>Undo last tidy-up ({kindLabel(last.kind)})</Button>}
          </div>
        </div>
        <p className="text-xs text-muted">Nothing moves until you confirm a preview. Photos you set aside go into a folder inside the one you chose, and every move can be undone.</p>
      </Page>
    );
  }

  // ---------- scanning ----------
  if (step === 'scanning') {
    const p = progress;
    return (
      <Page>
        {header}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{!p || p.phase === 'listing' ? 'Looking for photos…' : 'Checking photos'}</span>
            <span className="text-muted tabular-nums">{p?.etaSeconds ? `about ${fmtDuration(p.etaSeconds)} left` : ''}</span>
          </div>
          <ProgressBar value={p && p.total ? p.done / p.total : 0} />
          <div className="text-sm tabular-nums">{p ? `${p.done} / ${p.total || '…'} photos` : ''}</div>
          {p?.current && <div className="text-xs text-muted truncate">{p.current}</div>}
          <Button variant="danger" onClick={() => api.sort.cancel()}>Cancel</Button>
        </div>
      </Page>
    );
  }

  // ---------- results ----------
  if (step === 'results' && results) {
    return (
      <Page wide>
        {header}
        <div className="flex items-center gap-3 text-sm text-muted flex-wrap">
          <Button variant="ghost" onClick={() => setStep('pick')}><Icon name="back" size={16} />{base(results.folder)}</Button>
          <span>{results.scanned} photos checked{results.skipped.length ? ` · ${results.skipped.length} skipped (online-only or unreadable)` : ''}</span>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        {tab === 'dupes'
          ? <Dupes results={results} settings={t} onSettings={async p => { await setTidy(p); loadResults(results.folderId); }}
              selDup={selDup} setSelDup={setSelDup} selBlur={selBlur} setSelBlur={setSelBlur}
              onMove={k => preview(k)} onTrash={(ids, label) => setConfirmTrash({ ids, label })} />
          : <Organize results={results} settings={t} onSettings={setTidy} onPreview={() => preview('organize')} />}
        {confirmTrash && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
            <div className="bg-panel rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
              <div className="flex gap-3">
                <Icon name="alert" size={22} className="text-warn mt-0.5" />
                <div className="text-sm leading-relaxed">Send {confirmTrash.ids.length} {confirmTrash.label} to the {binName}? You can restore them from the {binName}, but PixHaven's Undo can't bring them back.</div>
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setConfirmTrash(null)}>Cancel</Button>
                <Button variant="danger" onClick={() => trash(confirmTrash.ids)}>Send to {binName}</Button>
              </div>
            </div>
          </div>
        )}
      </Page>
    );
  }

  // ---------- preview (dry run) ----------
  if (step === 'preview' && plan) {
    const moves = plan.ops.filter(o => o.kind === 'move');
    return (
      <Page wide>
        <div className="flex items-end gap-3 flex-wrap">
          <h1 className="text-2xl font-semibold mr-auto">Preview: nothing has moved yet</h1>
          <Button variant="ghost" onClick={() => setStep('results')}><Icon name="back" size={16} />Back</Button>
          <Button variant="primary" disabled={!moves.length} onClick={apply}>Apply</Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-3 gap-3">
          <Stat label="Photos to move" value={String(moves.length)} />
          <Stat label="Folders to create" value={String(plan.counts.folders)} />
          <Stat label="Staying where they are" value={String(plan.counts.stays)} />
        </div>
        {!moves.length && <Notice tone="info">Nothing to move: everything is already in place.</Notice>}
        <div className="rounded-xl border border-line bg-panel divide-y divide-[var(--border)]">
          {plan.targets.map(tg => {
            const ops = moves.filter(o => isIn(o.to, tg.dir));
            return (
              <details key={tg.key}>
                <summary className="flex items-center gap-3 px-4 h-11 cursor-pointer list-none">
                  <Icon name="folder" size={16} className="text-muted" />
                  <span className="font-medium">{tg.label}</span>
                  <span className="text-xs text-muted">{tg.exists ? 'existing folder' : 'new folder'}</span>
                  <span className="ml-auto text-xs text-muted">{ops.length} photos</span>
                </summary>
                <ul className="px-4 pb-3 text-xs space-y-1 max-h-64 overflow-auto">{ops.map((o, i) => <li key={i} className="truncate selectable">{o.from}</li>)}</ul>
              </details>
            );
          })}
          {plan.stays.length > 0 && (
            <details>
              <summary className="flex items-center gap-3 px-4 h-11 cursor-pointer list-none"><Icon name="image" size={16} className="text-muted" /><span className="font-medium">Staying where they are</span><span className="ml-auto text-xs text-muted">{plan.stays.length}</span></summary>
              <ul className="px-4 pb-3 text-xs space-y-1 max-h-64 overflow-auto">{plan.stays.map(s => <li key={s.path} className="flex gap-2"><span className="truncate flex-1 selectable">{s.path}</span><span className="text-muted">{s.reason}</span></li>)}</ul>
            </details>
          )}
        </div>
      </Page>
    );
  }

  // ---------- applying ----------
  if (step === 'applying') {
    return (
      <Page>
        <h1 className="text-2xl font-semibold">{applyP?.phase === 'undo' ? 'Undoing…' : 'Moving photos…'}</h1>
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-3">
          <ProgressBar value={applyP && applyP.total ? applyP.done / applyP.total : 0} />
          <div className="text-xs text-muted truncate">{applyP?.current}</div>
        </div>
      </Page>
    );
  }

  // ---------- done ----------
  return (
    <Page>
      <h1 className="text-2xl font-semibold">{done?.title ?? 'Done'}</h1>
      <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
        {done?.lines.map(l => <div key={l} className="text-sm">{l}</div>)}
        {!!done?.kept?.length && (
          <Notice tone="warn"><ul className="text-xs space-y-0.5 max-h-40 overflow-auto">{done.kept.slice(0, 100).map((k, i) => <li key={i} className="selectable">{base(k.path)}: {k.reason}</li>)}</ul></Notice>
        )}
        <div className="flex gap-2 flex-wrap">
          {folder && <Button onClick={() => api.openPath(folder)}><Icon name="folder" size={16} />Open folder</Button>}
          {done?.title !== 'Undo finished' && done?.title !== `Sent to the ${binName}` && folder && (
            <Button variant="danger" onClick={async () => { const st = await api.tidy.status(folder); const h = st.history.find(x => x.state === 'done'); if (h) undo(h); }}>Undo</Button>
          )}
          <Button variant="ghost" onClick={() => folder && choose(folder)}>Done</Button>
        </div>
      </div>
    </Page>
  );
}

const kindLabel = (k?: string) => (k === 'organize' ? 'sorted by date/place' : k === 'blurry' ? 'blurry set aside' : 'duplicates set aside');

function Dupes({ results, settings, onSettings, selDup, setSelDup, selBlur, setSelBlur, onMove, onTrash }: {
  results: TidyResults; settings: Settings['tidy']; onSettings: (p: Partial<Settings['tidy']>) => void;
  selDup: Set<number>; setSelDup: (s: Set<number>) => void; selBlur: Set<number>; setSelBlur: (s: Set<number>) => void;
  onMove: (k: 'duplicates' | 'blurry') => void; onTrash: (ids: number[], label: string) => void;
}) {
  const [threshold, setThreshold] = useState(settings.blurThreshold);
  useEffect(() => setThreshold(settings.blurThreshold), [settings.blurThreshold]);
  const toggle = (set: Set<number>, put: (s: Set<number>) => void, id: number) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); put(n); };
  const dupBytes = useMemo(() => results.duplicates.flatMap(g => g.photos).filter(p => selDup.has(p.id)).reduce((a, p) => a + p.size, 0), [results, selDup]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold mr-auto">Duplicates <span className="text-muted font-normal">({results.duplicates.length} groups)</span></h2>
          <Segmented<Settings['tidy']['match']> label="Match" value={settings.match} onChange={match => onSettings({ match })}
            options={[{ value: 'identical', label: 'Identical files', title: 'Byte-for-byte copies only' }, { value: 'same', label: 'Same picture', title: 'Also resized or re-saved copies' }, { value: 'similar', label: 'Near-identical', title: 'Also shots taken a moment apart' }]} />
        </div>
        {!results.duplicates.length ? <div className="text-sm text-muted">No duplicates found.</div> : (
          <>
            <div className="space-y-3">
              {results.duplicates.map((g, gi) => (
                <div key={gi} className="rounded-xl border border-line bg-panel p-3">
                  <div className="text-xs text-muted mb-2">{g.kind === 'exact' ? 'Identical files' : 'Same picture'} · {g.photos.length} copies</div>
                  <div className="flex gap-3 overflow-x-auto pb-1">
                    {g.photos.map(p => (
                      <PhotoTile key={p.id} p={p} selected={selDup.has(p.id)} onClick={() => toggle(selDup, setSelDup, p.id)}
                        badge={p.id === g.keep ? 'Suggested keep' : undefined} detail={`${p.width}×${p.height} · ${fmtBytes(p.size)}`} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <ActionBar count={selDup.size} extra={`frees ${fmtBytes(dupBytes)}`} folder="PixHaven - Duplicates"
              onMove={() => onMove('duplicates')} onTrash={() => onTrash([...selDup], 'duplicate photos')} onNone={() => setSelDup(new Set())} />
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold mr-auto">Blurry photos <span className="text-muted font-normal">({results.blurry.length})</span></h2>
          <label className="flex items-center gap-2 text-xs text-muted">
            Only very blurry
            <input type="range" min={30} max={500} step={10} value={threshold} aria-label="Blur sensitivity"
              onChange={e => setThreshold(Number(e.target.value))} onPointerUp={() => onSettings({ blurThreshold: threshold })} onKeyUp={() => onSettings({ blurThreshold: threshold })} className="w-36" />
            Also slightly soft
          </label>
        </div>
        {!results.blurry.length ? <div className="text-sm text-muted">No blurry photos found at this setting.</div> : (
          <>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
              {results.blurry.map(p => <PhotoTile key={p.id} p={p} selected={selBlur.has(p.id)} onClick={() => toggle(selBlur, setSelBlur, p.id)} detail={`sharpness ${Math.round(p.blur)}`} />)}
            </div>
            <ActionBar count={selBlur.size} folder="PixHaven - Blurry" onAll={() => setSelBlur(new Set(results.blurry.map(p => p.id)))}
              onMove={() => onMove('blurry')} onTrash={() => onTrash([...selBlur], 'blurry photos')} onNone={() => setSelBlur(new Set())} />
          </>
        )}
      </section>
    </div>
  );
}

function ActionBar({ count, extra, folder, onMove, onTrash, onNone, onAll }: { count: number; extra?: string; folder: string; onMove: () => void; onTrash: () => void; onNone: () => void; onAll?: () => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap rounded-xl bg-panel-2 px-4 py-2.5">
      <span className="text-sm mr-auto">{count} selected{count && extra ? ` · ${extra}` : ''}</span>
      {onAll && <Button variant="ghost" className="h-8" onClick={onAll}>Select all</Button>}
      <Button variant="ghost" className="h-8" disabled={!count} onClick={onNone}>Select none</Button>
      <Button className="h-8" disabled={!count} onClick={onTrash}>Send to {binName}…</Button>
      <Button variant="primary" className="h-8" disabled={!count} onClick={onMove} title={`Undoable: moves them into “${folder}”`}>Move to “{folder}”…</Button>
    </div>
  );
}

function PhotoTile({ p, selected, onClick, badge, detail }: { p: TidyPhotoRef; selected: boolean; onClick: () => void; badge?: string; detail: string }) {
  return (
    <button onClick={onClick} aria-pressed={selected} title={p.path}
      className={`relative shrink-0 w-[150px] rounded-lg overflow-hidden border-2 text-left bg-panel ${selected ? 'border-danger' : 'border-transparent'}`}>
      <img src={p.thumbUrl} alt={p.name} loading="lazy" className="w-full aspect-square object-cover bg-panel-2" />
      {badge && <span className="absolute left-1.5 top-1.5 rounded bg-ok text-white text-[10px] font-semibold px-1.5 py-0.5">{badge}</span>}
      {selected && <span className="absolute right-1.5 top-1.5 rounded bg-danger text-white text-[10px] font-semibold px-1.5 py-0.5">Set aside</span>}
      <div className="px-1.5 py-1">
        <div className="text-xs truncate">{p.name}</div>
        <div className="text-[10px] text-muted truncate">{detail}</div>
      </div>
    </button>
  );
}

function Organize({ results, settings, onSettings, onPreview }: { results: TidyResults; settings: Settings['tidy']; onSettings: (p: Partial<Settings['tidy']>) => void; onPreview: () => void }) {
  const example = settings.by === 'date'
    ? (settings.dateDepth === 'year' ? '2024 \\ photo.jpg' : '2024 \\ 2024-05 May \\ photo.jpg')
    : (settings.placeDepth === 'country' ? 'India \\ photo.jpg' : 'India \\ Bengaluru \\ photo.jpg');
  return (
    <div className="rounded-2xl border border-line bg-panel p-6 space-y-5 max-w-3xl">
      <Row label="Sort by">
        <Segmented<'date' | 'place'> label="Sort by" value={settings.by} onChange={by => onSettings({ by })}
          options={[{ value: 'date', label: 'Date taken' }, { value: 'place', label: 'Place' }]} />
      </Row>
      {settings.by === 'date' ? (
        <>
          <Row label="Folders">
            <Segmented<'year' | 'month'> label="Date folders" value={settings.dateDepth} onChange={dateDepth => onSettings({ dateDepth })}
              options={[{ value: 'year', label: 'Year' }, { value: 'month', label: 'Year → Month' }]} />
          </Row>
          <Row label="Photos without a camera date" hint={`${results.withDate} of ${results.scanned} photos have a camera date.`}>
            <Segmented<'file' | 'skip'> label="No camera date" value={settings.useFileDate ? 'file' : 'skip'} onChange={v => onSettings({ useFileDate: v === 'file' })}
              options={[{ value: 'file', label: 'Use file date' }, { value: 'skip', label: 'Treat as unknown' }]} />
          </Row>
        </>
      ) : (
        <>
          <Row label="Folders" hint="Places come from GPS saved in the photo, looked up offline (towns of 15,000+ people).">
            <Segmented<'country' | 'city'> label="Place folders" value={settings.placeDepth} onChange={placeDepth => onSettings({ placeDepth })}
              options={[{ value: 'country', label: 'Country' }, { value: 'city', label: 'Country → City' }]} />
          </Row>
          <div className="text-sm text-muted">{results.withPlace} of {results.scanned} photos have a location.</div>
        </>
      )}
      <Row label={`Photos with no ${settings.by === 'date' ? 'date' : 'location'}`}>
        <Segmented<'stay' | 'folder'> label="Unknown" value={settings.unknownFolder ? 'folder' : 'stay'} onChange={v => onSettings({ unknownFolder: v === 'folder' })}
          options={[{ value: 'stay', label: 'Leave in place' }, { value: 'folder', label: `“Unknown ${settings.by}” folder` }]} />
      </Row>
      <div className="text-sm"><span className="text-muted">Example: </span><span className="font-mono text-xs">{base(results.folder)} \ {example}</span></div>
      <Button variant="primary" className="h-10" onClick={onPreview}>Preview</Button>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div className="flex-1 min-w-[200px]"><div className="text-sm font-medium">{label}</div>{hint && <div className="text-xs text-muted mt-0.5">{hint}</div>}</div>
      {children}
    </div>
  );
}

function Page({ wide, children }: { wide?: boolean; children: React.ReactNode }) {
  return <div className="h-full overflow-auto p-8"><div className={`${wide ? 'max-w-6xl' : 'max-w-3xl'} mx-auto space-y-5`}>{children}</div></div>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl bg-panel-2 px-4 py-3"><div className="text-2xl font-semibold tabular-nums">{value}</div><div className="text-xs text-muted mt-0.5">{label}</div></div>;
}
