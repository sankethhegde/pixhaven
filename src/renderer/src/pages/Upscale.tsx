// Upscale screen: one image (preview → upscale → compare → save) or a batch (folder / several files).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImageInfo, JobItem, JobUpdate, ModelDownload, ModelId, Settings, UpscaleOptions } from '@shared/types';
import { LARGE_IMAGE_PX } from '@shared/types';
import { api, errorText, fmtBytes, fmtDuration, type FolderScan } from '../api';
import { DropZone } from '../components/DropZone';
import { CompareSlider } from '../components/CompareSlider';
import { OptionsPanel, outputSize } from '../components/OptionsPanel';
import { Button, Icon, Notice, ProgressBar } from '../components/ui';

type Source =
  | { kind: 'single'; info: ImageInfo }
  | { kind: 'batch'; label: string; scan: FolderScan };

interface Props {
  settings: Settings;
  allow4k: boolean;
  cpuMode: boolean;
  initialPaths: string[] | null;
  onConsumedInitial: () => void;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

export function Upscale({ settings, allow4k, cpuMode, initialPaths, onConsumedInitial }: Props) {
  const [source, setSource] = useState<Source | null>(null);
  const [opts, setOpts] = useState<UpscaleOptions>(settings.last);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [update, setUpdate] = useState<JobUpdate | null>(null);
  const [resultOpts, setResultOpts] = useState<UpscaleOptions | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ text: string; actions: { label: string; run: () => void; primary?: boolean }[] } | null>(null);
  const [viewing, setViewing] = useState<JobItem | null>(null);
  const jobRef = useRef<string | null>(null);
  const [installed, setInstalled] = useState<Record<ModelId, boolean> | null>(null);
  const [dl, setDl] = useState<ModelDownload>({ state: 'idle', progress: 0 });
  const [dlSize, setDlSize] = useState(45);

  // Updates can arrive before startJob() returns the id (a job may even finish first): keep the latest per job.
  const latest = useRef(new Map<string, JobUpdate>());
  useEffect(() => api.onJobUpdate(u => { latest.current.set(u.jobId, u); if (u.jobId === jobRef.current) setUpdate(u); }), []);
  useEffect(() => {
    api.modelsStatus().then(s => { setInstalled(s.installed); setDl(s.download); setDlSize(s.sizeMb); });
    return api.onModels(d => { setDl(d); if (d.state === 'done') api.modelsStatus().then(s => setInstalled(s.installed)); });
  }, []);
  const needsModel = installed !== null && !installed[opts.model];
  useEffect(() => {
    if (initialPaths) { load(initialPaths); onConsumedInitial(); }
  }, [initialPaths]); // eslint-disable-line react-hooks/exhaustive-deps

  const running = !!jobId && !!update && !update.finished || (!!jobId && !update);
  const item = update?.items[0];

  function reset() {
    setSource(null); setJobId(null); jobRef.current = null; setUpdate(null); setSaved(null); setError(null); setResultOpts(null);
  }

  async function load(paths: string[]) {
    reset();
    try {
      if (paths.length === 1) {
        const kind = await api.pathKind(paths[0]);
        if (kind === 'folder') {
          setLoading('Looking for images in the folder…');
          const scan = await api.scanFolder(paths[0]);
          if (!scan.files.length) throw new Error(scan.skipped ? 'This folder only has images that were already upscaled.' : 'No supported images (JPG, PNG, WEBP, BMP, TIFF) in this folder.');
          setSource({ kind: 'batch', label: paths[0], scan });
          if (settings.lowSpec) setOpts(o => ({ ...o, model: 'fast' })); // IMG-03: Fast pre-selected for batches
        } else if (kind === 'image') {
          setLoading('Opening image…');
          setSource({ kind: 'single', info: await api.inspectImage(paths[0]) });
        } else {
          throw new Error(kind === 'missing' ? 'That file no longer exists.' : 'This file type is not supported. Use JPG, PNG, WEBP, BMP or TIFF.');
        }
      } else {
        setLoading('Reading images…');
        const files: FolderScan['files'] = [];
        const unreadable: string[] = [];
        let other = 0;
        for (const p of paths) {
          if ((await api.pathKind(p)) !== 'image') { other++; continue; }
          const s = await api.imageSize(p);
          if (s) files.push({ path: p, ...s }); else unreadable.push(fileName(p));
        }
        if (!files.length) throw new Error('None of the dropped items are supported images.');
        setSource({ kind: 'batch', label: `${files.length} images`, scan: { files, skipped: other, unreadable } });
        if (settings.lowSpec) setOpts(o => ({ ...o, model: 'fast' }));
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(null);
    }
  }

  async function start(files: FolderScan['files']) {
    if (!source) return;
    setConfirm(null); setSaved(null); setError(null); setUpdate(null);
    try {
      const id = await api.startJob({ files, opts, mode: source.kind === 'single' ? 'single' : 'folder' });
      jobRef.current = id; setJobId(id); setResultOpts(opts);
      const early = latest.current.get(id);
      if (early) setUpdate(early);
    } catch (e) { setError(errorText(e)); }
  }

  function requestStart() {
    if (!source) return;
    if (source.kind === 'single') {
      const { width, height, path } = source.info;
      const out = outputSize(width, height, opts.size);
      const go = () => start([{ path, width, height }]);
      if (Math.max(width, height) > LARGE_IMAGE_PX) {
        setConfirm({
          text: `This image is ${width.toLocaleString()} × ${height.toLocaleString()} px. The result will be ${out.width.toLocaleString()} × ${out.height.toLocaleString()} px, which can take several minutes and a lot of memory.`,
          actions: [{ label: 'Upscale anyway', run: go, primary: true }],
        });
      } else go();
    } else {
      const all = source.scan.files;
      const small = all.filter(f => Math.max(f.width, f.height) <= LARGE_IMAGE_PX);
      if (small.length < all.length) {
        setConfirm({
          text: `${all.length - small.length} of ${all.length} images ${all.length - small.length === 1 ? 'is' : 'are'} larger than ${LARGE_IMAGE_PX.toLocaleString()} px. They can take several minutes each and use a lot of memory.`,
          actions: [
            ...(small.length ? [{ label: `Skip large (${small.length} left)`, run: () => start(small) }] : []),
            { label: 'Upscale all', run: () => start(all), primary: true },
          ],
        });
      } else start(all);
    }
  }

  async function save(saveAs: boolean) {
    if (!item || !jobId) return;
    try {
      const r = await api.saveResult({ jobId, itemId: item.id, item, saveAs });
      if (r.ok && r.path) setSaved(r.path);
    } catch (e) { setError(errorText(e)); }
  }

  const optsChanged = useMemo(() => !!resultOpts && JSON.stringify(resultOpts) !== JSON.stringify(opts), [resultOpts, opts]);
  const savedTo = settings.outputDir ?? 'the same folder as the original';

  // ---------- empty / loading ----------
  if (!source) {
    return (
      <div className="h-full overflow-auto p-8">
        <div className="max-w-3xl mx-auto space-y-4">
          <h1 className="text-2xl font-semibold">Upscale images</h1>
          {error && <Notice tone="danger">{error}</Notice>}
          {loading ? <div className="rounded-2xl border border-line bg-panel p-16 text-center text-muted">{loading}</div> : <DropZone onPaths={load} />}
        </div>
      </div>
    );
  }

  const side = (
    <aside className="w-[320px] shrink-0 border-l border-line bg-panel flex flex-col min-h-0">
      <div className="flex-1 overflow-auto p-5 space-y-6">
        <OptionsPanel opts={opts} onChange={setOpts} allow4k={allow4k} disabled={running}
          inputSize={source.kind === 'single' ? source.info : undefined} />
        {needsModel && (
          <Notice tone="info">
            <div className="space-y-2">
              <div>The {opts.model === 'photo' ? 'General photo' : 'Anime'} model needs a one-time {dlSize} MB download. After that it works offline.</div>
              {dl.state === 'downloading'
                ? <><ProgressBar value={dl.progress} /><div className="text-xs tabular-nums">{Math.round(dl.progress * 100)}%</div></>
                : <Button className="h-8" onClick={() => api.downloadModels()}><Icon name="download" size={15} />Download model</Button>}
              {dl.state === 'error' && <div className="text-danger text-xs">{dl.error}</div>}
            </div>
          </Notice>
        )}
        {cpuMode && <Notice tone="warn">No usable graphics card: upscaling runs on the processor, about 20× slower. Fast model recommended.</Notice>}
        <div className="text-xs text-muted leading-relaxed">
          Saved to {settings.outputDir ? <span className="text-fg break-all">{settings.outputDir}</span> : 'the same folder as the original'}, with “_upscaled” added to the name. Change this in Settings.
        </div>
      </div>
      <div className="border-t border-line p-4 space-y-3">
        {error && <Notice tone="danger">{error}</Notice>}
        {running ? (
          <Button variant="danger" className="w-full" onClick={() => jobId && api.cancelJob(jobId)}><Icon name="x" size={16} />Cancel</Button>
        ) : (
          <Button variant="primary" className="w-full h-10" onClick={requestStart}
            disabled={needsModel || (source.kind === 'single' && outputSize(source.info.width, source.info.height, opts.size).factor <= 1)}>
            <Icon name="sparkle" size={16} />{update?.finished && !optsChanged ? 'Upscale again' : source.kind === 'single' ? 'Upscale' : `Upscale ${source.scan.files.length} images`}
          </Button>
        )}
      </div>
    </aside>
  );

  // ---------- single image ----------
  if (source.kind === 'single') {
    const info = source.info;
    const done = item?.state === 'done';
    return (
      <div className="h-full flex min-h-0">
        <section className="flex-1 min-w-0 flex flex-col p-5 gap-3">
          <header className="flex items-center gap-3 min-w-0">
            <Button variant="ghost" onClick={reset} title="Choose another image"><Icon name="back" size={16} />New</Button>
            <div className="min-w-0">
              <div className="font-semibold truncate selectable" title={info.path}>{info.name}</div>
              <div className="text-xs text-muted">{info.width.toLocaleString()} × {info.height.toLocaleString()} px · {fmtBytes(info.bytes)}{info.hasAlpha ? ' · transparent' : ''}</div>
            </div>
          </header>
          <div className="flex-1 min-h-0 relative">
            <CompareSlider beforeUrl={done ? item!.beforeUrl! : info.previewUrl} afterUrl={done ? item!.outputUrl : undefined}
              width={done ? item!.outWidth! : info.width} height={done ? item!.outHeight! : info.height} />
            {running && (
              <div className="absolute inset-x-0 top-0 bottom-9 flex items-center justify-center rounded-xl bg-black/35">
                <div className="w-72 rounded-xl bg-panel p-5 shadow-xl space-y-3">
                  <div className="font-medium">{item?.state === 'queued' ? 'Waiting for another job to finish…' : 'Upscaling…'}</div>
                  <ProgressBar value={item?.progress ?? 0} />
                  <div className="text-xs text-muted tabular-nums">{Math.round((item?.progress ?? 0) * 100)}%{update?.etaSeconds ? ` · about ${fmtDuration(update.etaSeconds)} left` : ''}</div>
                </div>
              </div>
            )}
          </div>
          {item?.state === 'failed' && <Notice tone="danger">{item.error}</Notice>}
          {item?.state === 'cancelled' && <Notice tone="info">Cancelled. Nothing was saved.</Notice>}
          {done && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3">
              <div className="text-sm mr-auto min-w-0">
                {saved
                  ? <>Saved to <span className="selectable break-all">{saved}</span></>
                  : <>Done in {fmtDuration(item!.seconds ?? 0)}. {optsChanged ? <span className="text-warn">Settings changed: upscale again to apply them.</span> : <span className="text-muted">Not saved yet.</span>}</>}
              </div>
              {saved
                ? <Button onClick={() => api.showItem(saved)}><Icon name="folder" size={16} />Show in folder</Button>
                : <>
                    <Button onClick={() => save(true)}>Save as…</Button>
                    <Button variant="primary" onClick={() => save(false)} title={`Save to ${savedTo}`}><Icon name="save" size={16} />Save</Button>
                  </>}
            </div>
          )}
        </section>
        {side}
        {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
      </div>
    );
  }

  // ---------- batch ----------
  const scan = source.scan;
  const items = update?.items;
  const overall = update ? (update.items.reduce((a, i) => a + (i.state === 'running' ? i.progress : i.state === 'queued' ? 0 : 1), 0) / update.total) : 0;
  const okCount = items?.filter(i => i.state === 'done').length ?? 0;
  const failCount = items?.filter(i => i.state === 'failed').length ?? 0;
  const skipCount = items?.filter(i => i.state === 'skipped').length ?? 0;
  const firstOut = items?.find(i => i.output)?.output;

  return (
    <div className="h-full flex min-h-0">
      <section className="flex-1 min-w-0 flex flex-col p-5 gap-4">
        <header className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" onClick={reset} disabled={running}><Icon name="back" size={16} />New</Button>
          <div className="min-w-0">
            <div className="font-semibold truncate selectable" title={source.label}>{source.label}</div>
            <div className="text-xs text-muted">
              {scan.files.length} image{scan.files.length === 1 ? '' : 's'}
              {scan.skipped ? ` · ${scan.skipped} skipped (already upscaled or not images)` : ''}
              {scan.unreadable.length ? ` · ${scan.unreadable.length} unreadable` : ''}
            </div>
          </div>
        </header>

        {update && (
          <div className="rounded-xl border border-line bg-panel p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">
                {update.finished ? `Finished: ${okCount} upscaled${failCount ? `, ${failCount} failed` : ''}${skipCount ? `, ${skipCount} already done` : ''}` : !items?.some(i => i.state === 'running') && !update.done ? 'Waiting for another job to finish…' : `Upscaling ${Math.min(update.done + 1, update.total)} of ${update.total}`}
              </span>
              <span className="text-muted tabular-nums">
                {update.finished ? '' : `${Math.round(overall * 100)}%${update.etaSeconds ? ` · about ${fmtDuration(update.etaSeconds)} left` : ''}`}
              </span>
            </div>
            <ProgressBar value={overall} />
            {update.finished && firstOut && (
              <div className="pt-1 flex gap-2">
                <Button onClick={() => api.openPath(dirName(firstOut))}><Icon name="folder" size={16} />Open output folder</Button>
              </div>
            )}
          </div>
        )}
        {scan.unreadable.length > 0 && !update && (
          <Notice tone="warn">Can’t read: {scan.unreadable.slice(0, 5).join(', ')}{scan.unreadable.length > 5 ? ` and ${scan.unreadable.length - 5} more` : ''}. They will be skipped.</Notice>
        )}

        <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-line bg-panel divide-y divide-[var(--border)]">
          {(items ?? scan.files.map(f => ({ id: f.path, input: f.path, name: fileName(f.path), state: 'queued' as const, progress: 0 }))).map((it, idx) => {
            const f = scan.files.find(x => x.path === it.input);
            return (
              <button key={it.id} disabled={it.state !== 'done'} onClick={() => setViewing(it as JobItem)}
                className="w-full flex items-center gap-3 px-4 h-12 text-left enabled:hover:bg-panel-2 disabled:cursor-default">
                <StateDot state={it.state} />
                <span className="truncate flex-1 min-w-0">{it.name}</span>
                {it.state === 'skipped' && <span className="text-xs text-muted">Already upscaled · skipped</span>}
                {it.state === 'failed' && <span className="text-xs text-danger truncate max-w-[45%]" title={(it as JobItem).error}>{(it as JobItem).error}</span>}
                {it.state === 'running' && <ProgressBar value={it.progress} className="w-32" />}
                {it.state === 'done' && <span className="text-xs text-muted">{(it as JobItem).outWidth}×{(it as JobItem).outHeight} · {fmtDuration((it as JobItem).seconds ?? 0)} · View</span>}
                {it.state === 'queued' && f && <span className="text-xs text-muted tabular-nums">{f.width}×{f.height}{Math.max(f.width, f.height) > LARGE_IMAGE_PX ? ' · large' : ''}</span>}
                <span className="sr-only">{idx + 1}</span>
              </button>
            );
          })}
        </div>
      </section>
      {side}
      {confirm && <ConfirmDialog {...confirm} onCancel={() => setConfirm(null)} />}
      {viewing && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-8" onClick={() => setViewing(null)}>
          <div className="bg-panel rounded-2xl w-full h-full max-w-6xl flex flex-col p-4 gap-3 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="font-semibold truncate flex-1">{viewing.name}</div>
              <Button onClick={() => viewing.output && api.showItem(viewing.output)}><Icon name="folder" size={16} />Show in folder</Button>
              <Button variant="ghost" onClick={() => setViewing(null)} aria-label="Close"><Icon name="x" size={16} /></Button>
            </div>
            <div className="flex-1 min-h-0">
              <CompareSlider beforeUrl={viewing.beforeUrl!} afterUrl={viewing.outputUrl} width={viewing.outWidth!} height={viewing.outHeight!} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StateDot({ state }: { state: JobItem['state'] }) {
  if (state === 'done') return <Icon name="check" size={16} className="text-ok" />;
  if (state === 'failed') return <Icon name="alert" size={16} className="text-danger" />;
  if (state === 'cancelled' || state === 'skipped') return <Icon name="x" size={16} className="text-muted" />;
  if (state === 'running') return <span className="h-4 w-4 rounded-full border-2 border-accent border-t-transparent animate-spin" />;
  return <span className="h-2 w-2 mx-1 rounded-full bg-line" />;
}

function ConfirmDialog({ text, actions, onCancel }: { text: string; actions: { label: string; run: () => void; primary?: boolean }[]; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-6" role="dialog" aria-modal="true">
      <div className="bg-panel rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
        <div className="flex gap-3">
          <Icon name="alert" size={22} className="text-warn mt-0.5" />
          <div>
            <div className="font-semibold mb-1">Large image</div>
            <div className="text-sm text-muted leading-relaxed">{text}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          {actions.map(a => <Button key={a.label} variant={a.primary ? 'primary' : 'secondary'} onClick={a.run}>{a.label}</Button>)}
        </div>
      </div>
    </div>
  );
}
