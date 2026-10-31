// v2.11 Video editor. Convert (phase 1): videos to other formats (MP4 H.264 / HEVC / AV1, WebM, MOV ProRes), take the
// sound out (MP3, M4A), make a GIF, or turn phone photos (HEIC) into JPG / PNG. No upscaling. Files come from "Add
// files…", drag and drop, or the Library's "Convert…"; originals are never changed. Edit (phase 2): one video — see
// components/EditPanel.tsx. Join: several videos one after another.
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import type { ConvertCaps, ConvertFile, ConvertOptions, ConvertProgress, ConvertResult, ConvertTarget, EditSpec } from '@shared/types';
import { api, errorText, fmtBytes, fmtDuration } from '../api';
import { Button, Icon, Notice, ProgressBar, Segmented, Toggle } from '../components/ui';
import { EditPanel } from '../components/EditPanel';

interface Props { active: boolean; incoming: string[] | null; onConsumed: () => void }

const TARGETS: { id: ConvertTarget; title: string; hint: string; group: 'Video' | 'Sound' | 'Other' | 'Photo' }[] = [
  { id: 'mp4-h264', title: 'MP4 (H.264)', hint: 'Plays everywhere: phones, TVs, WhatsApp', group: 'Video' },
  { id: 'mp4-hevc', title: 'MP4 (HEVC)', hint: 'About half the size at the same quality', group: 'Video' },
  { id: 'mp4-av1', title: 'MP4 (AV1)', hint: 'Smallest files; newer devices and the web', group: 'Video' },
  { id: 'webm-vp9', title: 'WebM (VP9)', hint: 'For websites (slower to make)', group: 'Video' },
  { id: 'mov-prores', title: 'MOV (ProRes)', hint: 'For editing in other apps (very large)', group: 'Video' },
  { id: 'mp3', title: 'MP3', hint: 'Just the sound', group: 'Sound' },
  { id: 'm4a', title: 'M4A (AAC)', hint: 'Just the sound, a little better than MP3', group: 'Sound' },
  { id: 'gif', title: 'GIF', hint: 'A short clip as a moving picture', group: 'Other' },
  { id: 'jpg', title: 'JPG', hint: 'Photos (HEIC from iPhones and others)', group: 'Photo' },
  { id: 'png', title: 'PNG', hint: 'Photos, without any quality loss', group: 'Photo' },
];
const RES: { value: ConvertOptions['resolution']; label: string }[] = [
  { value: 'keep', label: 'Keep' }, { value: 2160, label: '4K' }, { value: 1080, label: '1080p' }, { value: 720, label: '720p' }, { value: 480, label: '480p' },
];
const LAST = 'conv.options';
const DEFAULTS: ConvertOptions = { target: 'mp4-h264', quality: 'balanced', resolution: 'keep', maxMB: null, sound: true, outDir: null };
const load = (): ConvertOptions => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LAST) ?? '{}') }; } catch { return DEFAULTS; } };
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const dirOf = (p: string) => p.replace(/[\\/][^\\/]*$/, '');

export function VideoEditor({ active, incoming, onConsumed }: Props) {
  const [files, setFiles] = useState<ConvertFile[]>([]);
  const [caps, setCaps] = useState<ConvertCaps | null>(null);
  const [o, setO] = useState<ConvertOptions>(load);
  const [fit, setFit] = useState(o.maxMB !== null);
  const [progress, setProgress] = useState<Record<string, ConvertProgress>>({});
  const [job, setJob] = useState<string | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  // v2.11 phase 2: Edit one video, Join several.
  const [mode, setMode] = useState<'convert' | 'edit' | 'join'>('convert');
  const [editing, setEditing] = useState<ConvertFile | null>(null);
  const [joinSel, setJoinSel] = useState<string[]>([]);
  const [joinOut, setJoinOut] = useState<EditSpec['output']>({ target: 'mp4-h264', quality: 'balanced' });

  useEffect(() => { if (active && !caps) void api.conv.caps().then(setCaps).catch(e => setError(errorText(e))); }, [active, caps]);
  useEffect(() => { try { localStorage.setItem(LAST, JSON.stringify(o)); } catch { /* not remembered */ } }, [o]);
  useEffect(() => {
    const offs = [
      api.onConvProgress(p => setProgress(s => (p.state === 'finished' ? s : { ...s, [p.file + '|' + p.index]: p }))),
      api.onConvDone(r => { setJob(j => (j === r.jobId ? null : j)); setResult(r); }),
    ];
    return () => offs.forEach(f => f());
  }, []);

  const add = async (paths: string[]) => {
    if (!paths.length) return;
    setError(null); setResult(null); setProgress({});
    const known = new Set(files.map(f => f.path.toLowerCase()));
    const fresh = await api.conv.inspect(paths.filter(p => !known.has(p.toLowerCase())));
    setFiles(f => [...f, ...fresh]);
    // Photos only: the photo formats are what makes sense.
    if (fresh.length && fresh.every(f => f.kind === 'image') && !['jpg', 'png'].includes(o.target)) setO(x => ({ ...x, target: 'jpg' }));
  };
  useEffect(() => { if (incoming?.length) { void add(incoming); onConsumed(); } }, [incoming]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDrag(false);
    void add([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean));
  };
  const target = TARGETS.find(t => t.id === o.target)!;
  const forPhotos = target.group === 'Photo';
  const usable = files.filter(f => !f.error && (forPhotos ? f.kind === 'image' : target.group === 'Sound' ? f.kind === 'video' || f.kind === 'audio' : f.kind === 'video'));
  const totalSeconds = useMemo(() => usable.reduce((n, f) => n + (f.duration ?? 0), 0), [usable]);

  const videos = files.filter(f => f.kind === 'video' && !f.error);
  const joinFiles = joinSel.map(p => videos.find(v => v.path === p)).filter((v): v is ConvertFile => !!v);
  const startJoin = async () => {
    setError(null); setResult(null); setProgress({});
    try { setJob(await api.conv.join(joinFiles.map(f => f.path), { output: joinOut, outDir: o.outDir })); } catch (e) { setError(errorText(e)); }
  };
  const move = (p: string, by: number) => setJoinSel(l => { const i = l.indexOf(p), j = i + by; if (i < 0 || j < 0 || j >= l.length) return l; const n = [...l]; [n[i], n[j]] = [n[j], n[i]]; return n; });

  const startNow = async () => {
    setError(null); setResult(null); setProgress({});
    try { setJob(await api.conv.start(usable.map(f => f.path), { ...o, maxMB: fit ? o.maxMB : null })); } catch (e) { setError(errorText(e)); }
  };
  /** Progress of a file in the running (or last) job: keyed by its place among the files sent. */
  const stateOf = (f: ConvertFile) => progress[`${f.name}|${usable.indexOf(f)}`];

  if (mode === 'edit' && editing) {
    return (
      <div className="h-full overflow-auto"><div className="max-w-5xl mx-auto p-8">
        <EditPanel source={{ path: editing.path, name: editing.name, duration: editing.duration ?? 0, width: editing.width ?? 0, height: editing.height ?? 0, audio: !!editing.audio }}
          caps={caps} onClose={() => setEditing(null)} />
      </div></div>
    );
  }
  return (
    <div className="h-full overflow-auto" onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className="max-w-5xl mx-auto p-8 space-y-5">
        <div className="flex items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-2xl font-semibold">Video editor</h1>
            <p className="text-sm text-muted mt-1">Convert videos to other formats, trim and edit them, or join several. The originals are never changed.</p>
          </div>
          <Segmented label="Mode" value={mode} onChange={m => { setMode(m); setResult(null); }} options={[{ value: 'convert', label: 'Convert' }, { value: 'edit', label: 'Edit' }, { value: 'join', label: 'Join' }]} />
          <Button variant="primary" className="h-10 shrink-0 whitespace-nowrap" disabled={!!job} onClick={async () => void add(await api.conv.pickFiles())}><Icon name="video" size={16} />Add files…</Button>
        </div>
        {error && <Notice tone="danger">{error}</Notice>}

        {/* files */}
        <section className={`rounded-2xl border ${drag ? 'border-accent bg-accent-soft' : 'border-line bg-panel'} p-4 space-y-2`} data-testid="conv-files">
          {files.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted">Drop videos or photos here, press “Add files…”, or select them in the Library and choose Convert….</div>
          ) : (
            <>
              <div className="flex items-center text-sm">
                <span className="font-medium mr-auto">{files.length} file{files.length === 1 ? '' : 's'}{usable.length !== files.length ? ` · ${usable.length} can become ${target.title}` : ''}{totalSeconds ? ` · ${fmtDuration(totalSeconds)} of video` : ''}</span>
                <Button className="!h-8" variant="ghost" disabled={!!job} onClick={() => { setFiles([]); setProgress({}); setResult(null); }}>Clear list</Button>
              </div>
              <div className="divide-y divide-line">
                {files.map(f => {
                  const p = stateOf(f);
                  const skip = mode === 'convert' ? !usable.includes(f) : f.kind !== 'video' || !!f.error;
                  const order = joinSel.indexOf(f.path);
                  return (
                    <div key={f.path} className={`flex items-center gap-3 py-2 ${skip ? 'opacity-50' : ''}`} data-conv-file={f.name}>
                      {mode === 'join' && f.kind === 'video' && !f.error
                        ? <input type="checkbox" checked={order >= 0} aria-label={`Join ${f.name}`} onChange={ev => setJoinSel(l => (ev.target.checked ? [...l, f.path] : l.filter(x => x !== f.path)))} />
                        : <Icon name={f.kind === 'image' ? 'image' : 'video'} size={18} className="text-muted shrink-0" />}
                      {mode === 'join' && order >= 0 && <span className="text-xs font-semibold text-accent w-5">{order + 1}</span>}
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate" title={f.path}>{f.name}</div>
                        <div className="text-xs text-muted truncate">
                          {f.error ?? [f.codec?.toUpperCase(), f.width ? `${f.width}×${f.height}` : '', f.duration ? fmtDuration(f.duration) : '', fmtBytes(f.size)].filter(Boolean).join(' · ')}
                          {skip && !f.error && mode === 'convert' ? (forPhotos ? ' · not a photo' : f.kind === 'image' ? ' · a photo: choose JPG or PNG' : '') : ''}
                        </div>
                        {p && p.state === 'running' && <ProgressBar value={p.percent / 100} className="mt-1" />}
                      </div>
                      {mode === 'edit' && f.kind === 'video' && !f.error && <Button className="!h-8" onClick={() => setEditing(f)} data-edit={f.name}><Icon name="video" size={14} />Edit</Button>}
                      {mode === 'join' && order >= 0 && <span className="flex gap-0.5"><Button className="!h-7 !px-2" variant="ghost" onClick={() => move(f.path, -1)} aria-label="Earlier">↑</Button><Button className="!h-7 !px-2" variant="ghost" onClick={() => move(f.path, 1)} aria-label="Later">↓</Button></span>}
                      <div className="text-xs text-right w-56 shrink-0" data-conv-state={p?.state ?? ''}>
                        {p?.state === 'running' && <span className="text-muted tabular-nums">{Math.round(p.percent)}%{p.speed ? ` · ${p.speed.toFixed(1)}×` : ''}{p.etaSeconds ? ` · ${fmtDuration(p.etaSeconds)} left` : ''}</span>}
                        {p?.state === 'done' && <button className="text-accent hover:underline truncate max-w-full" title={p.out} onClick={() => p.out && void api.showItem(p.out)}>✓ {baseName(p.out ?? '')} · {fmtBytes(p.outSize ?? 0)}</button>}
                        {p?.state === 'failed' && <span className="text-danger" title={p.error}>Failed: {p.error}</span>}
                        {p?.state === 'skipped' && <span className="text-muted">{p.error}</span>}
                        {p?.state === 'cancelled' && <span className="text-muted">Stopped</span>}
                        {!p && !job && <button className="text-muted hover:text-fg" onClick={() => setFiles(l => l.filter(x => x.path !== f.path))} aria-label={`Remove ${f.name}`}><Icon name="x" size={14} /></button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>

        {mode === 'edit' && <Notice tone="info">Press Edit on a video above to trim it, cut parts out, split it, rotate or crop it, change its speed, sound or look, add text or fades, or save frames.</Notice>}
        {mode === 'join' && (
          <section className="rounded-2xl border border-line bg-panel p-5 space-y-3" data-testid="join-panel">
            <div className="text-sm">{joinFiles.length < 2 ? 'Tick two or more videos above, in the order they should play (↑ ↓ to change it).' : `${joinFiles.length} videos, ${fmtDuration(joinFiles.reduce((n, f) => n + (f.duration ?? 0), 0))} in all. Each takes the size of the first (with black bars if needed).`}</div>
            <div className="flex items-center gap-3 flex-wrap text-sm">
              <label className="flex items-center gap-2">Save as
                <select value={joinOut.target} onChange={ev => setJoinOut({ ...joinOut, target: ev.target.value as EditSpec['output']['target'] })} aria-label="Join as" className="h-9 rounded-lg bg-panel-2 border border-line px-2">
                  {(['mp4-h264', 'mp4-hevc', 'mp4-av1', 'webm-vp9', 'mov-prores'] as const).map(t => <option key={t} value={t} disabled={caps ? !caps.targets[t].ok : false}>{TARGETS.find(x => x.id === t)!.title}</option>)}
                </select>
              </label>
              <Segmented label="Join quality" value={joinOut.quality} onChange={v => setJoinOut({ ...joinOut, quality: v })} options={[{ value: 'small', label: 'Small file' }, { value: 'balanced', label: 'Balanced' }, { value: 'best', label: 'Best' }]} />
            </div>
            {!job ? <Button variant="primary" className="h-10" disabled={joinFiles.length < 2} onClick={() => void startJoin()}><Icon name="video" size={16} />Join {joinFiles.length || ''} videos</Button>
              : <Button variant="danger" className="h-10" onClick={() => void api.conv.cancel()}>Stop</Button>}
            {job && Object.values(progress).filter(p => p.state === 'running').map(p => <div key={p.file} className="space-y-1"><div className="text-xs text-muted">{p.file} · {Math.round(p.percent)}%{p.etaSeconds ? ` · ${fmtDuration(p.etaSeconds)} left` : ''}</div><ProgressBar value={p.percent / 100} /></div>)}
          </section>
        )}

        {/* options */}
        {mode === 'convert' && <section className="rounded-2xl border border-line bg-panel p-5 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Convert to</div>
          <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }} role="radiogroup" aria-label="Convert to">
            {TARGETS.map(t => {
              const c = caps?.targets[t.id];
              const off = !!c && !c.ok;
              return (
                <button key={t.id} role="radio" aria-checked={o.target === t.id} disabled={off || !!job} title={c?.why}
                  onClick={() => setO({ ...o, target: t.id })} data-conv-target={t.id}
                  className={`text-left rounded-xl border p-3 transition ${o.target === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-panel-2'} disabled:opacity-40 disabled:cursor-not-allowed`}>
                  <div className="flex items-center gap-2 text-sm font-medium">{t.title}<span className="ml-auto text-[10px] uppercase tracking-wide text-muted">{t.group}</span></div>
                  <div className="text-xs text-muted mt-0.5">{off ? c?.why : t.hint}</div>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <label className="flex items-center gap-2 text-sm">Quality
              <Segmented label="Quality" value={o.quality} onChange={v => setO({ ...o, quality: v })} options={[{ value: 'small', label: 'Small file' }, { value: 'balanced', label: 'Balanced' }, { value: 'best', label: 'Best' }]} />
            </label>
            {!forPhotos && target.group !== 'Sound' && (
              <label className="flex items-center gap-2 text-sm">Resolution
                <select value={String(o.resolution)} onChange={e => setO({ ...o, resolution: e.target.value === 'keep' ? 'keep' : (Number(e.target.value) as ConvertOptions['resolution']) })}
                  aria-label="Resolution" className="h-9 rounded-lg bg-panel-2 border border-line px-2 text-sm">
                  {RES.map(r => <option key={String(r.value)} value={String(r.value)}>{r.label}</option>)}
                </select>
              </label>
            )}
            {target.group === 'Video' && (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <Toggle label="Fit under a size" checked={fit} onChange={v => { setFit(v); if (v && !o.maxMB) setO({ ...o, maxMB: 25 }); }} />Fit under
                  <input type="number" min={1} max={100000} value={o.maxMB ?? 25} disabled={!fit} aria-label="Size in MB"
                    onChange={e => setO({ ...o, maxMB: Math.max(1, Number(e.target.value) || 1) })}
                    className="w-20 h-9 rounded-lg bg-panel-2 border border-line px-2 text-sm disabled:opacity-50" />MB
                </label>
                <label className="flex items-center gap-2 text-sm"><Toggle label="Keep the sound" checked={o.sound} onChange={v => setO({ ...o, sound: v })} />Keep the sound</label>
              </>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted">Save to:</span>
            <span className="truncate" title={o.outDir ?? undefined}>{o.outDir ?? 'next to each original'}</span>
            <Button className="!h-8" variant="ghost" onClick={async () => { const d = await api.openFolder('Save converted files in…'); if (d) setO({ ...o, outDir: d }); }}>Choose…</Button>
            {o.outDir && <Button className="!h-8" variant="ghost" onClick={() => setO({ ...o, outDir: null })}>Next to originals</Button>}
          </div>
          <div className="flex items-center gap-3">
            {!job
              ? <Button variant="primary" className="h-10" disabled={!usable.length || !caps} onClick={() => void startNow()}><Icon name="sparkle" size={16} />Convert {usable.length || ''} to {target.title}</Button>
              : <Button className="h-10" variant="danger" onClick={() => void api.conv.cancel()}>Stop</Button>}
            {target.group === 'Video' && <span className="text-xs text-muted">Same format and nothing to change: the video is copied in seconds, with no quality lost.</span>}
          </div>
        </section>}

        {result && !job && (
          <Notice tone={result.failed.length ? 'warn' : 'info'}>
            {result.cancelled ? 'Stopped. ' : ''}{result.done.length} converted{result.failed.length ? `, ${result.failed.length} failed` : ''}{result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.
            {result.done[0] && <> <button className="underline" onClick={() => void api.showItem(result.done[0].to)}>Show in folder</button> ({dirOf(result.done[0].to)})</>}
          </Notice>
        )}
      </div>
    </div>
  );
}
