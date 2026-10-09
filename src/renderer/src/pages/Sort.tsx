// Sort photos by person: pick folder → scan → review people → dry run → apply → (undo).
import { useEffect, useRef, useState } from 'react';
import type { ApplyProgress, ApplyResult, FolderStatus, ReviewData, ScanProgress, Settings, SortPlan } from '@shared/types';
import { api, errorText, fmtBytes, fmtDuration, isIn } from '../api';
import { Review } from '../components/Review';
import { Button, Icon, Notice, ProgressBar, Toggle } from '../components/ui';

type Step = 'pick' | 'scanning' | 'review' | 'dryrun' | 'applying' | 'done';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  initialFolder: string | null;
  onConsumedInitial: () => void;
  onUpscale: (paths: string[]) => void;
}

const base = (p: string) => p.split(/[\\/]/).pop() ?? p;
const PHASE: Record<ScanProgress['phase'], string> = {
  listing: 'Looking for photos…', scanning: 'Finding faces', grouping: 'Grouping faces into people…',
  naming: 'Looking for names', done: 'Done', cancelled: 'Cancelled', error: 'Error',
};

export function Sort({ settings, onSettings, initialFolder, onConsumedInitial, onUpscale }: Props) {
  const [step, setStep] = useState<Step>('pick');
  const [folder, setFolder] = useState<string | null>(null);
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [paused, setPaused] = useState(false);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [plan, setPlan] = useState<SortPlan | null>(null);
  const [applyP, setApplyP] = useState<ApplyProgress | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [undone, setUndone] = useState<{ restored: number; kept: { path: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const folderRef = useRef<string | null>(null);

  useEffect(() => {
    const offs = [
      api.onSortProgress(p => { if (p.folder === folderRef.current) { setProgress(p); if (p.phase === 'error') { setError(p.error ?? 'Scan failed'); setStep('pick'); } } }),
      api.onSortScanned(async r => {
        if (!folderRef.current) return;
        if (r.cancelled) { setStep('pick'); refreshStatus(folderRef.current); return; }
        await loadReview(r.folderId);
      }),
      api.onApplyProgress(setApplyP),
    ];
    return () => offs.forEach(o => o());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (initialFolder) { choose(initialFolder); onConsumedInitial(); } }, [initialFolder]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refreshStatus(f: string) { setStatus(await api.sort.status(f)); }

  async function choose(f: string) {
    setError(null); setReview(null); setPlan(null); setResult(null); setUndone(null);
    if ((await api.pathKind(f)) !== 'folder') { setError('Please choose a folder.'); return; }
    folderRef.current = f; setFolder(f); setStep('pick');
    await refreshStatus(f);
  }

  async function startScan() {
    if (!folder) return;
    setError(null); setProgress({ folder, phase: 'listing', done: 0, total: 0, faces: 0, people: 0 }); setPaused(false);
    setStep('scanning');
    try { await api.sort.scan(folder); } catch (e) { setError(errorText(e)); setStep('pick'); }
  }

  async function loadReview(fid: number) {
    try { setReview(await api.sort.review(fid)); setStep('review'); } catch (e) { setError(errorText(e)); }
  }

  async function toPlan() {
    if (!review) return;
    setBusy(true); setError(null);
    try { setPlan(await api.sort.plan(review.folderId)); setStep('dryrun'); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function apply() {
    if (!plan) return;
    setError(null); setApplyP(null); setStep('applying');
    try { setResult(await api.sort.apply(plan.folderId)); setStep('done'); }
    catch (e) { setError(errorText(e)); setStep('dryrun'); }
  }

  async function finishInterrupted(sortId: number) {
    setError(null); setApplyP(null); setStep('applying');
    try { setResult(await api.sort.finish(sortId)); setStep('done'); } catch (e) { setError(errorText(e)); setStep('pick'); }
  }

  async function undo(sortId: number) {
    setError(null); setApplyP(null); setStep('applying');
    try {
      setUndone(await api.sort.undo(sortId)); setResult(null);
      setStep('done');
      if (folder) refreshStatus(folder);
    } catch (e) { setError(errorText(e)); setStep('pick'); }
  }

  const setSort = async (patch: Partial<Settings['sort']>) => onSettings(await api.setSettings({ sort: { ...settings.sort, ...patch } }));

  // ---------- pick ----------
  if (step === 'pick') {
    const last = status?.sorts.find(s => s.state === 'done');
    return (
      <Page title="Sort photos by person">
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-5">
          <div className="flex items-center gap-3">
            <div className="rounded-full p-3 bg-accent-soft text-accent"><Icon name="people" size={24} /></div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold">{folder ? base(folder) : 'Choose a folder of photos'}</div>
              <div className="text-sm text-muted truncate selectable">{folder ?? 'PixHaven makes one folder per person. You review everything before any file moves.'}</div>
            </div>
            <Button onClick={async () => { const f = await api.openFolder('Choose a folder of photos to sort'); if (f) choose(f); }}>
              <Icon name="folder" size={16} />{folder ? 'Change…' : 'Choose folder…'}
            </Button>
          </div>
          <label className="flex items-center gap-3 text-sm">
            <Toggle label="Include subfolders" checked={settings.sort.includeSubfolders} onChange={v => setSort({ includeSubfolders: v })} />
            Include subfolders <span className="text-muted">(folders made by earlier sorts are always skipped)</span>
          </label>
          {status?.interrupted && (
            <Notice tone="warn">
              <div className="space-y-2">
                <div>The last sort of this folder was interrupted. Some photos may already be in person folders.</div>
                <div className="flex gap-2">
                  <Button className="h-8" variant="primary" onClick={() => finishInterrupted(status.interrupted!.id)}>Finish it</Button>
                  <Button className="h-8" onClick={() => undo(status.interrupted!.id)}>Undo it</Button>
                </div>
              </div>
            </Notice>
          )}
          {folder && status && status.folderId != null && status.scannedImages > 0 && (
            <div className="text-sm text-muted">
              Scanned before: {status.scannedImages} photos, {status.people} people
              {status.lastScan ? ` · ${new Date(status.lastScan).toLocaleString()}` : ''}.
              {last && <> Last sorted {new Date(last.created).toLocaleString()}.</>}
            </div>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button variant="primary" className="h-10" disabled={!folder || !!status?.interrupted} onClick={startScan}>
              <Icon name="sparkle" size={16} />{status?.scannedImages ? 'Scan for new photos' : 'Scan folder'}
            </Button>
            {status?.folderId != null && status.scannedImages > 0 && !status.interrupted && (
              <Button className="h-10" onClick={() => loadReview(status.folderId!)}>Review people</Button>
            )}
            {last && !status?.interrupted && <Button className="h-10" variant="danger" onClick={() => undo(last.id)}>Undo last sort</Button>}
          </div>
        </div>
        <p className="text-xs text-muted leading-relaxed">
          Photos and face data never leave this computer. Nothing is moved until you press Apply after the dry run, and every sort can be undone.
          Face-match strictness, minimum face size and the “No faces” folder are in Settings.
        </p>
      </Page>
    );
  }

  // ---------- scanning ----------
  if (step === 'scanning') {
    const p = progress;
    const frac = p && p.total ? p.done / p.total : 0;
    return (
      <Page title={`Scanning ${folder ? base(folder) : ''}`}>
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">{p ? PHASE[p.phase] : 'Starting…'}{paused ? ' (paused)' : ''}</span>
            <span className="text-muted tabular-nums">{p?.phase === 'scanning' && p.etaSeconds ? `about ${fmtDuration(p.etaSeconds)} left` : ''}</span>
          </div>
          <ProgressBar value={p?.phase === 'scanning' ? frac : p?.phase === 'naming' && p.total ? p.done / p.total : p?.phase === 'listing' ? 0 : 1} />
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Photos scanned" value={p ? `${p.phase === 'naming' ? p.total || p.done : p.done} / ${p.total || '…'}` : '…'} />
            <Stat label="Faces found" value={String(p?.faces ?? 0)} />
            <Stat label={p?.phase === 'scanning' ? 'People so far (estimate)' : 'People'} value={String(p?.people ?? 0)} />
          </div>
          {p?.current && p.phase === 'scanning' && <div className="text-xs text-muted truncate">{p.current}</div>}
          <div className="flex gap-2">
            {p?.phase === 'scanning' && (
              <Button onClick={async () => { await api.sort.pause(!paused); setPaused(!paused); }}>{paused ? 'Resume' : 'Pause'}</Button>
            )}
            <Button variant="danger" onClick={() => api.sort.cancel()}>Cancel</Button>
          </div>
          <p className="text-xs text-muted">Progress is saved after every photo. If you cancel or close PixHaven, the next scan continues where this one stopped.</p>
        </div>
      </Page>
    );
  }

  // ---------- review ----------
  if (step === 'review' && review) {
    const people = review.people.filter(p => !p.unsorted).length;
    return (
      <Page title={`People in ${base(review.folder)}`} wide
        actions={<>
          <Button variant="ghost" onClick={() => setStep('pick')}><Icon name="back" size={16} />Back</Button>
          <Button variant="primary" disabled={busy || !review.people.length} onClick={toPlan}>Next: dry run</Button>
        </>}
        subtitle={`${review.scanned} photos · ${people} people · ${review.cantRecognise.length} couldn't recognise · ${review.noFaces.length} without faces`}>
        {error && <Notice tone="danger">{error}</Notice>}
        {!review.people.length && <Notice tone="info">No people were found in this folder. Try a lower minimum face size in Settings, or a looser face-match strictness.</Notice>}
        <Review data={review} onChanged={() => loadReview(review.folderId)} onUpscale={onUpscale} />
      </Page>
    );
  }

  // ---------- dry run ----------
  if (step === 'dryrun' && plan) {
    const byTarget = plan.targets.map(t => ({ t, ops: plan.ops.filter(o => o.kind !== 'mkdir' && isIn(o.to, t.dir)) }));
    const lowSpace = plan.freeBytes != null && plan.copyBytes > plan.freeBytes - 50e6;
    const nothing = plan.counts.moves + plan.counts.copies + plan.counts.groupMoves === 0;
    return (
      <Page title="Dry run: nothing has moved yet" wide
        actions={<>
          <Button variant="ghost" onClick={() => setStep('review')}><Icon name="back" size={16} />Back</Button>
          <Button variant="primary" disabled={lowSpace || nothing} onClick={apply}>Apply</Button>
        </>}>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Folders to create" value={String(plan.counts.folders)} />
          <Stat label="Photos to move" value={String(plan.counts.moves)} />
          <Stat label="Copies (group photos)" value={String(plan.counts.copies)} />
          <Stat label="Originals to “Group photos” at the end" value={String(plan.counts.groupMoves)} />
        </div>
        <div className="text-sm text-muted">
          Copies use {fmtBytes(plan.copyBytes)}{plan.freeBytes != null ? `; ${fmtBytes(plan.freeBytes)} free on this drive` : ''}.
          {plan.counts.stays ? ` ${plan.counts.stays} photos stay where they are.` : ''}
        </div>
        {lowSpace && <Notice tone="danger">Not enough free disk space for the copies. Free up space and try again.</Notice>}
        {nothing && <Notice tone="info">Everything is already sorted. There is nothing to move.</Notice>}
        <div className="rounded-xl border border-line bg-panel divide-y divide-[var(--border)]">
          {byTarget.map(({ t, ops }) => (
            <details key={t.key} className="group">
              <summary className="flex items-center gap-3 px-4 h-11 cursor-pointer list-none">
                <Icon name="folder" size={16} className="text-muted" />
                <span className="font-medium">{base(t.dir)}</span>
                <span className="text-xs text-muted">{t.exists ? 'existing folder' : 'new folder'}</span>
                <span className="ml-auto text-xs text-muted">
                  {ops.filter(o => o.kind === 'move').length} moved{ops.some(o => o.kind === 'copy') ? `, ${ops.filter(o => o.kind === 'copy').length} copied` : ''}
                </span>
              </summary>
              <ul className="px-4 pb-3 text-xs space-y-1 max-h-64 overflow-auto">
                {ops.map((o, i) => (
                  <li key={i} className="flex gap-2 selectable">
                    <span className={`w-12 shrink-0 font-medium ${o.kind === 'copy' ? 'text-accent' : o.pass === 2 ? 'text-warn' : ''}`}>{o.kind === 'copy' ? 'copy' : o.pass === 2 ? 'last' : 'move'}</span>
                    <span className="truncate">{o.from} → {base(o.to)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {plan.stays.length > 0 && (
            <details>
              <summary className="flex items-center gap-3 px-4 h-11 cursor-pointer list-none">
                <Icon name="image" size={16} className="text-muted" /><span className="font-medium">Staying where they are</span>
                <span className="ml-auto text-xs text-muted">{plan.stays.length}</span>
              </summary>
              <ul className="px-4 pb-3 text-xs space-y-1 max-h-64 overflow-auto">
                {plan.stays.map(s => <li key={s.path} className="flex gap-2 selectable"><span className="truncate flex-1">{s.path}</span><span className="text-muted shrink-0">{s.reason}</span></li>)}
              </ul>
            </details>
          )}
        </div>
      </Page>
    );
  }

  // ---------- applying / undoing ----------
  if (step === 'applying') {
    const p = applyP;
    return (
      <Page title={p?.phase === 'undo' ? 'Undoing…' : 'Sorting…'}>
        <div className="rounded-2xl border border-line bg-panel p-6 space-y-3">
          <div className="text-sm font-medium">
            {!p ? 'Starting…' : p.phase === 'pass1' ? 'Moving photos and copying group photos' : p.phase === 'pass2' ? 'Moving group originals to “Group photos”' : p.phase === 'undo' ? 'Putting every file back' : 'Finishing…'}
          </div>
          <ProgressBar value={p && p.total ? p.done / p.total : 0} />
          <div className="text-xs text-muted truncate">{p?.current}</div>
          <p className="text-xs text-muted">Please keep PixHaven open. If it's interrupted, you can finish or undo it next time.</p>
        </div>
      </Page>
    );
  }

  // ---------- done ----------
  return (
    <Page title={undone ? 'Undo finished' : 'Photos sorted'}>
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="rounded-2xl border border-line bg-panel p-6 space-y-4">
        {result && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Moved to person folders" value={String(result.moved)} />
            <Stat label="Copies of group photos" value={String(result.copied)} />
            <Stat label="Originals in “Group photos”" value={String(result.groupMoved)} />
          </div>
        )}
        {undone && <div className="text-sm">{undone.restored} changes reversed. The folder is back the way it was{undone.kept.length ? ', except for the items below' : ''}.</div>}
        {(result?.skipped.length || undone?.kept.length) ? (
          <Notice tone="warn">
            <div className="font-medium mb-1">{result ? `${result.skipped.length} photos were left in place:` : 'Kept:'}</div>
            <ul className="text-xs space-y-0.5 max-h-40 overflow-auto">
              {(result?.skipped ?? undone!.kept).slice(0, 100).map((s, i) => <li key={i} className="selectable">{base(s.path)}: {s.reason}</li>)}
            </ul>
          </Notice>
        ) : null}
        <div className="flex gap-2 flex-wrap">
          {folder && <Button onClick={() => api.openPath(folder)}><Icon name="folder" size={16} />Open folder</Button>}
          {result && <Button variant="danger" onClick={async () => { if (folder) { const st = await api.sort.status(folder); const s = st.sorts.find(x => x.state === 'done'); if (s) undo(s.id); } }}>Undo this sort</Button>}
          <Button variant="ghost" onClick={() => folder && choose(folder)}>Done</Button>
        </div>
      </div>
    </Page>
  );
}

function Page({ title, subtitle, actions, wide, children }: { title: string; subtitle?: string; actions?: React.ReactNode; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className="h-full overflow-auto p-8">
      <div className={`${wide ? 'max-w-6xl' : 'max-w-3xl'} mx-auto space-y-5`}>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold">{title}</h1>
            {subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}
          </div>
          {actions && <div className="flex gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-panel-2 px-4 py-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted mt-0.5">{label}</div>
    </div>
  );
}
