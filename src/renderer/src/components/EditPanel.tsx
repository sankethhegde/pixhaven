// v2.11 Video editor, phase 2: quick edits of one video. A preview (the video itself when Chromium can play it, else
// still frames) with a timeline — trim, cut out parts, split points — and the edits around it: rotate / flip, crop,
// speed, sound and music, look, stabilise, text, fades, frames. Most edits show live on the preview (approximately);
// Export makes the real file through FFmpeg in the job queue.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { ConvertCaps, ConvertProgress, ConvertResult, EditSpec, PlayInfo } from '@shared/types';
import { cropBox, outputsOf } from '@shared/edit-math';
import { api, errorText, fmtBytes, fmtDuration } from '../api';
import { playerCaps } from './Player';
import { Button, Icon, Notice, ProgressBar, Segmented, Toggle } from './ui';

export interface EditSource { path: string; name: string; duration: number; width: number; height: number; audio: boolean }
interface Props { source: EditSource; caps: ConvertCaps | null; onClose: () => void }

const NEW = (d: number): EditSpec => ({
  trim: { start: 0, end: d }, cuts: [], splits: [], exact: false, rotate: 0, flipH: false, flipV: false, crop: null, speed: 1, volume: 1, music: null,
  brightness: 0, contrast: 0, saturation: 1, stabilize: false, text: null, fadeIn: 0, fadeOut: 0, resolution: 'keep',
  output: { target: 'mp4-h264', quality: 'balanced' }, outDir: null,
});
const clock = (t: number) => { const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
const VIDEO_TARGETS: { id: EditSpec['output']['target']; label: string }[] = [
  { id: 'mp4-h264', label: 'MP4 (H.264)' }, { id: 'mp4-hevc', label: 'MP4 (HEVC)' }, { id: 'mp4-av1', label: 'MP4 (AV1)' }, { id: 'webm-vp9', label: 'WebM (VP9)' }, { id: 'mov-prores', label: 'MOV (ProRes)' },
];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

export function EditPanel({ source, caps, onClose }: Props) {
  const D = source.duration;
  const [e, setE] = useState<EditSpec>(() => NEW(D));
  const set = (p: Partial<EditSpec>) => setE(x => ({ ...x, ...p }));
  const [info, setInfo] = useState<PlayInfo | null>(null);
  const [still, setStill] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [mark, setMark] = useState<number | null>(null);          // start of a part to cut out
  const [strip, setStrip] = useState<string[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [prog, setProg] = useState<ConvertProgress | null>(null);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [everyN, setEveryN] = useState(5);
  const video = useRef<HTMLVideoElement>(null);

  // Preview: the file itself when Chromium plays it directly; otherwise still frames as the playhead moves.
  useEffect(() => {
    let live = true, session: string | null = null;
    api.player.open(source.path, playerCaps()).then(i => { session = i.session; if (live) setInfo(i); else void api.player.close(i.session); }).catch(() => {});
    void Promise.all(Array.from({ length: 10 }, (_, i) => api.player.frame(source.path, (D * (i + 0.5)) / 10).catch(() => ''))).then(s => live && setStrip(s));
    return () => { live = false; if (session) void api.player.close(session); };
  }, [source.path, D]);
  const direct = info?.mode === 'direct';
  useEffect(() => {
    if (direct) return;
    const id = setTimeout(() => { void api.player.frame(source.path, t).then(setStill).catch(() => {}); }, 120);
    return () => clearTimeout(id);
  }, [t, direct, source.path]);
  useEffect(() => { if (video.current) video.current.playbackRate = e.speed; }, [e.speed, direct]);
  useEffect(() => { if (video.current) video.current.volume = Math.min(1, e.volume); }, [e.volume, direct]);

  useEffect(() => {
    const offs = [
      api.onConvProgress(p => { if (p.state !== 'finished') setProg(p); }),
      api.onConvDone(r => { setJob(j => { if (j === r.jobId) { setResult(r); return null; } return j; }); }),
    ];
    return () => offs.forEach(f => f());
  }, []);

  const seek = (to: number) => { const v = Math.max(0, Math.min(D, to)); setT(v); if (video.current) video.current.currentTime = v; };
  const outs = useMemo(() => outputsOf(e, D), [e, D]);
  const length = outs.reduce((n, g) => n + g.reduce((m, s) => m + s.end - s.start, 0), 0) / e.speed;
  const plain = !e.exact && !e.cuts.length && !e.rotate && !e.flipH && !e.flipV && !e.crop && e.speed === 1 && e.volume === 1 && !e.music
    && !e.brightness && !e.contrast && e.saturation === 1 && !e.stabilize && !e.text?.value.trim() && !e.fadeIn && !e.fadeOut && e.resolution === 'keep';
  const box = cropBox(source.width, source.height, e);
  const pct = (x: number) => `${(x / (D || 1)) * 100}%`;

  const onBar = (ev: MouseEvent<HTMLDivElement>) => { const r = ev.currentTarget.getBoundingClientRect(); seek(((ev.clientX - r.left) / r.width) * D); };
  const addCut = () => {
    if (mark === null) { setMark(t); setNote('Now move to where the part to take out ends, and press “…to here”.'); return; }
    const a = Math.min(mark, t), b = Math.max(mark, t);
    if (b - a > 0.05) set({ cuts: [...e.cuts, { start: a, end: b }] });
    setMark(null); setNote(null);
  };
  const exportNow = async () => {
    setError(null); setResult(null); setProg(null);
    try { setJob(await api.conv.edit(source.path, e)); } catch (err) { setError(errorText(err)); }
  };
  const frames = async (at: number | null, format: 'jpg' | 'png') => {
    setError(null);
    try { const r = await api.conv.frames(source.path, at, at === null ? everyN : null, format); setNote(`${r.files.length} frame${r.files.length === 1 ? '' : 's'} saved in “${baseName(r.dir)}”.`); void api.showItem(r.files[0]); }
    catch (err) { setError(errorText(err)); }
  };

  // Live preview (approximate): CSS for rotate / flip / look, an overlay for the crop box and the text.
  const view: CSSProperties = {
    transform: `rotate(${e.rotate}deg) scale(${e.flipH ? -1 : 1}, ${e.flipV ? -1 : 1})`,
    filter: `brightness(${1 + e.brightness * 0.5}) contrast(${1 + e.contrast * 0.5}) saturate(${e.saturation})`,
  };
  const turned = e.rotate === 90 || e.rotate === 270;
  const frameW = turned ? source.height : source.width, frameH = turned ? source.width : source.height;

  return (
    <div className="space-y-4" data-testid="edit-panel">
      <div className="flex items-center gap-3">
        <Button variant="ghost" className="!h-8" onClick={onClose} disabled={!!job}><Icon name="back" size={16} />Files</Button>
        <div className="min-w-0 mr-auto">
          <div className="font-semibold truncate">{source.name}</div>
          <div className="text-xs text-muted">{source.width}×{source.height} · {fmtDuration(D)}{direct === false && info ? ' · preview shows still frames for this format' : ''}</div>
        </div>
        <Button variant="ghost" className="!h-8" disabled={!!job} onClick={() => { setE(NEW(D)); setMark(null); }}>Start over</Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {note && <Notice tone="info"><div className="flex gap-2"><span className="flex-1">{note}</span><button onClick={() => setNote(null)} aria-label="Dismiss"><Icon name="x" size={14} /></button></div></Notice>}

      {/* preview */}
      <div className="rounded-2xl bg-black overflow-hidden relative flex items-center justify-center" style={{ height: 360 }}>
        <div className="relative" style={{ aspectRatio: `${frameW} / ${frameH}`, height: '100%', maxWidth: '100%' }}>
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
            {direct && info
              ? <video ref={video} src={info.url} className="max-w-none" style={{ ...view, width: turned ? `${(frameH / frameW) * 100}%` : '100%', height: turned ? 'auto' : '100%', objectFit: 'contain' }}
                  onTimeUpdate={ev => setT(ev.currentTarget.currentTime)} data-testid="edit-video" />
              : still ? <img src={still} alt="" style={{ ...view, width: turned ? `${(frameH / frameW) * 100}%` : '100%', objectFit: 'contain' }} /> : null}
          </div>
          {e.crop && (
            <div className="absolute border-2 border-white pointer-events-none" data-testid="crop-box"
              style={{ left: `${(box.x / frameW) * 100}%`, top: `${(box.y / frameH) * 100}%`, width: `${(box.w / frameW) * 100}%`, height: `${(box.h / frameH) * 100}%`, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }} />
          )}
          {e.text?.value.trim() && (
            <div className="absolute inset-x-0 text-center text-white font-semibold pointer-events-none px-2"
              style={{ [e.text.position === 'top' ? 'top' : 'bottom']: e.text.position === 'center' ? '45%' : '8%', fontSize: { s: 14, m: 22, l: 34 }[e.text.size], textShadow: '0 0 4px #000, 0 0 2px #000' }}>
              {e.text.value}
            </div>
          )}
        </div>
      </div>

      {/* timeline */}
      <div className="space-y-2">
        <div className="relative h-14 rounded-lg overflow-hidden bg-panel-2 cursor-pointer select-none" onClick={onBar} data-testid="edit-timeline">
          <div className="absolute inset-0 flex">{strip.map((s, i) => (s ? <img key={i} src={s} alt="" className="h-full flex-1 object-cover min-w-0" /> : <div key={i} className="flex-1" />))}</div>
          <div className="absolute inset-y-0 left-0 bg-black/70" style={{ width: pct(e.trim.start) }} />
          <div className="absolute inset-y-0 right-0 bg-black/70" style={{ width: `${100 - (e.trim.end / (D || 1)) * 100}%` }} />
          {e.cuts.map((c, i) => <div key={i} className="absolute inset-y-0 border-x-2" style={{ left: pct(c.start), width: pct(c.end - c.start), background: 'repeating-linear-gradient(135deg, rgba(229,72,77,0.85) 0 6px, rgba(0,0,0,0.6) 6px 12px)', borderColor: '#e5484d' }} title="Cut out" />)}
          {mark !== null && <div className="absolute inset-y-0 w-0.5" style={{ left: pct(mark), background: '#e5484d' }} />}
          {e.splits.map((s, i) => <div key={i} className="absolute inset-y-0 w-1 -ml-0.5 bg-accent" style={{ left: pct(s) }} />)}
          <div className="absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: pct(t) }} />
        </div>
        <div className="flex items-center gap-1 flex-wrap text-sm">
          {direct && <Button className="!h-8" onClick={() => { const v = video.current; if (v) { if (v.paused) void v.play(); else v.pause(); } }}><Icon name="play" size={14} />Play / pause</Button>}
          <Button className="!h-8" variant="ghost" onClick={() => seek(t - 1)}>−1 s</Button>
          <Button className="!h-8" variant="ghost" onClick={() => seek(t + 1)}>+1 s</Button>
          <span className="tabular-nums px-2" data-testid="edit-time">{clock(t)} / {clock(D)}</span>
          <span className="mx-1 h-5 w-px bg-line" />
          <Button className="!h-8" variant="ghost" onClick={() => set({ trim: { start: Math.min(t, e.trim.end - 0.1), end: e.trim.end } })} title="Keep from here">Start here</Button>
          <Button className="!h-8" variant="ghost" onClick={() => set({ trim: { start: e.trim.start, end: Math.max(t, e.trim.start + 0.1) } })} title="Keep up to here">End here</Button>
          <Button className="!h-8" variant="ghost" onClick={addCut}>{mark === null ? 'Cut out from here…' : '…to here'}</Button>
          <Button className="!h-8" variant="ghost" onClick={() => !e.splits.some(s => Math.abs(s - t) < 0.2) && set({ splits: [...e.splits, t].sort((a, b) => a - b) })}>Split here</Button>
        </div>
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted" data-testid="edit-summary">
          <span>Keep {clock(e.trim.start)}–{clock(e.trim.end)}</span>
          {e.cuts.map((c, i) => <Chip key={`c${i}`} onRemove={() => set({ cuts: e.cuts.filter((_, k) => k !== i) })}>cut {clock(c.start)}–{clock(c.end)}</Chip>)}
          {e.splits.map((s, i) => <Chip key={`s${i}`} onRemove={() => set({ splits: e.splits.filter((_, k) => k !== i) })}>split {clock(s)}</Chip>)}
          <span className="ml-auto text-fg">{outs.length > 1 ? `${outs.length} files, ` : ''}{fmtDuration(length)} long</span>
        </div>
      </div>

      {/* edits */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(290px, 1fr))' }}>
        <Card title="Rotate and flip">
          <div className="flex gap-1 flex-wrap">
            <Button className="!h-8" onClick={() => set({ rotate: (((e.rotate + 270) % 360) as EditSpec['rotate']) })}>⟲ Left</Button>
            <Button className="!h-8" onClick={() => set({ rotate: (((e.rotate + 90) % 360) as EditSpec['rotate']) })}>⟳ Right</Button>
            <Button className="!h-8" variant={e.flipH ? 'primary' : 'secondary'} onClick={() => set({ flipH: !e.flipH })}>Mirror ↔</Button>
            <Button className="!h-8" variant={e.flipV ? 'primary' : 'secondary'} onClick={() => set({ flipV: !e.flipV })}>Flip ↕</Button>
          </div>
        </Card>
        <Card title="Crop">
          <div className="flex gap-1 flex-wrap">
            {([null, '9:16', '1:1', '4:5', '4:3', '16:9'] as const).map(a => (
              <Button key={a ?? 'none'} className="!h-8" variant={(e.crop?.aspect ?? null) === a ? 'primary' : 'secondary'}
                onClick={() => set({ crop: a ? { aspect: a, x: e.crop?.x ?? 0.5, y: e.crop?.y ?? 0.5 } : null })}>{a ?? 'None'}</Button>
            ))}
          </div>
          {e.crop && (box.w < frameW || box.h < frameH) && (
            <label className="flex items-center gap-2 text-xs">Position
              <input type="range" min={0} max={1} step={0.01} className="flex-1" aria-label="Crop position"
                value={box.w < frameW ? e.crop.x : e.crop.y} onChange={ev => set({ crop: { ...e.crop!, ...(box.w < frameW ? { x: Number(ev.target.value) } : { y: Number(ev.target.value) }) } })} />
            </label>
          )}
          {e.crop && <div className="text-xs text-muted">{box.w}×{box.h}</div>}
        </Card>
        <Card title="Speed">
          <select value={String(e.speed)} onChange={ev => set({ speed: Number(ev.target.value) })} aria-label="Speed" className="h-9 w-full rounded-lg bg-panel-2 border border-line px-2 text-sm">
            {SPEEDS.map(s => <option key={s} value={String(s)}>{s === 1 ? 'Normal (1×)' : s < 1 ? `${s}× (slow motion)` : `${s}× (faster)`}</option>)}
          </select>
        </Card>
        <Card title="Sound">
          <label className="flex items-center gap-2 text-xs">Volume
            <input type="range" min={0} max={2} step={0.05} value={e.volume} className="flex-1" aria-label="Volume" disabled={!source.audio}
              onChange={ev => set({ volume: Number(ev.target.value) })} />
            <span className="w-12 text-right">{e.volume === 0 ? 'Off' : `${Math.round(e.volume * 100)}%`}</span>
          </label>
          {e.music ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs"><span className="truncate flex-1" title={e.music.path}>♪ {baseName(e.music.path)}</span><button onClick={() => set({ music: null })} aria-label="Remove music"><Icon name="x" size={13} /></button></div>
              <label className="flex items-center gap-2 text-xs"><Toggle label="Mix with the video's sound" checked={e.music.mix} onChange={v => set({ music: { ...e.music!, mix: v } })} />{e.music.mix ? 'Mixed under the video’s sound' : 'Instead of the video’s sound'}</label>
              <label className="flex items-center gap-2 text-xs">Music volume
                <input type="range" min={0.05} max={1.5} step={0.05} value={e.music.volume} className="flex-1" aria-label="Music volume" onChange={ev => set({ music: { ...e.music!, volume: Number(ev.target.value) } })} />
              </label>
            </div>
          ) : <Button className="!h-8" onClick={async () => { const m = await api.conv.pickMusic(); if (m) set({ music: { path: m, volume: 0.6, mix: source.audio } }); }}>♪ Add music…</Button>}
        </Card>
        <Card title="Look">
          {([['brightness', 'Brightness', -1, 1], ['contrast', 'Contrast', -1, 1], ['saturation', 'Colour', 0, 2]] as const).map(([k, label, min, max]) => (
            <label key={k} className="flex items-center gap-2 text-xs"><span className="w-16">{label}</span>
              <input type="range" min={min} max={max} step={0.05} value={e[k]} className="flex-1" aria-label={label} onChange={ev => set({ [k]: Number(ev.target.value) } as Partial<EditSpec>)} />
            </label>
          ))}
          <label className="flex items-center gap-2 text-xs"><Toggle label="Steady a shaky video" checked={e.stabilize} onChange={v => set({ stabilize: v })} />Steady a shaky video <span className="text-muted">(not in the preview)</span></label>
        </Card>
        <Card title="Text">
          <input value={e.text?.value ?? ''} placeholder="A title or caption" aria-label="Text on the video"
            onChange={ev => set({ text: ev.target.value ? { value: ev.target.value, position: e.text?.position ?? 'bottom', size: e.text?.size ?? 'm' } : null })}
            className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
          {e.text && (
            <div className="flex gap-2">
              <Segmented label="Text position" value={e.text.position} onChange={v => set({ text: { ...e.text!, position: v } })} options={[{ value: 'top', label: 'Top' }, { value: 'center', label: 'Middle' }, { value: 'bottom', label: 'Bottom' }]} />
              <Segmented label="Text size" value={e.text.size} onChange={v => set({ text: { ...e.text!, size: v } })} options={[{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }]} />
            </div>
          )}
        </Card>
        <Card title="Fades">
          {([['fadeIn', 'Fade in'], ['fadeOut', 'Fade out']] as const).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-xs"><span className="w-16">{label}</span>
              <input type="range" min={0} max={3} step={0.25} value={e[k]} className="flex-1" aria-label={label} onChange={ev => set({ [k]: Number(ev.target.value) } as Partial<EditSpec>)} />
              <span className="w-10 text-right">{e[k] ? `${e[k]} s` : 'Off'}</span>
            </label>
          ))}
        </Card>
        <Card title="Frames">
          <div className="flex gap-1 flex-wrap">
            <Button className="!h-8" onClick={() => void frames(t, 'jpg')}>Save this frame (JPG)</Button>
            <Button className="!h-8" variant="ghost" onClick={() => void frames(t, 'png')}>PNG</Button>
          </div>
          <label className="flex items-center gap-2 text-xs">One every
            <input type="number" min={0.5} step={0.5} value={everyN} onChange={ev => setEveryN(Math.max(0.5, Number(ev.target.value) || 1))} aria-label="Seconds between frames" className="w-16 h-8 rounded-lg bg-panel-2 border border-line px-2" />s
            <Button className="!h-8" variant="ghost" onClick={() => void frames(null, 'jpg')}>Save frames</Button>
          </label>
        </Card>
      </div>

      {/* export */}
      <section className="rounded-2xl border border-line bg-panel p-4 space-y-3">
        <div className="flex items-center gap-3 flex-wrap text-sm">
          <label className="flex items-center gap-2">Save as
            <select value={e.output.target} onChange={ev => set({ output: { ...e.output, target: ev.target.value as EditSpec['output']['target'] } })} aria-label="Save as" className="h-9 rounded-lg bg-panel-2 border border-line px-2">
              {VIDEO_TARGETS.map(v => <option key={v.id} value={v.id} disabled={caps ? !caps.targets[v.id].ok : false}>{v.label}</option>)}
            </select>
          </label>
          <Segmented label="Quality" value={e.output.quality} onChange={v => set({ output: { ...e.output, quality: v } })} options={[{ value: 'small', label: 'Small file' }, { value: 'balanced', label: 'Balanced' }, { value: 'best', label: 'Best' }]} />
          <select value={String(e.resolution)} onChange={ev => set({ resolution: ev.target.value === 'keep' ? 'keep' : (Number(ev.target.value) as EditSpec['resolution']) })} aria-label="Resolution" className="h-9 rounded-lg bg-panel-2 border border-line px-2">
            {(['keep', 2160, 1080, 720, 480] as const).map(r => <option key={String(r)} value={String(r)}>{r === 'keep' ? 'Same size' : r === 2160 ? '4K' : `${r}p`}</option>)}
          </select>
          <Button className="!h-8" variant="ghost" onClick={async () => { const d = await api.openFolder('Save in…'); if (d) set({ outDir: d }); }} title={e.outDir ?? 'Next to the original'}>Save to: {e.outDir ? baseName(e.outDir) : 'next to the original'}</Button>
        </div>
        {plain && <div className="text-xs text-muted">Only trimmed or split: saved without converting (instant, no quality lost; it starts at the nearest keyframe, which can be a moment earlier). <label className="inline-flex items-center gap-1 ml-2"><input type="checkbox" checked={e.exact} onChange={ev => set({ exact: ev.target.checked })} />Cut exactly (converts)</label></div>}
        <div className="flex items-center gap-3">
          {!job ? <Button variant="primary" className="h-10" disabled={!outs.length} onClick={() => void exportNow()}><Icon name="sparkle" size={16} />Export {outs.length > 1 ? `${outs.length} files` : ''}</Button>
            : <Button variant="danger" className="h-10" onClick={() => void api.conv.cancel()}>Stop</Button>}
          {job && prog && (
            <div className="flex-1 min-w-0 space-y-1">
              <div className="text-xs text-muted truncate">{prog.file} · {Math.round(prog.percent)}%{prog.speed ? ` · ${prog.speed.toFixed(1)}×` : ''}{prog.etaSeconds ? ` · ${fmtDuration(prog.etaSeconds)} left` : ''}{prog.note ? ` · ${prog.note}` : ''}</div>
              <ProgressBar value={prog.percent / 100} />
            </div>
          )}
        </div>
        {result && !job && (
          <Notice tone={result.failed.length ? 'warn' : 'info'}>
            <div data-testid="edit-result">
              {result.cancelled ? 'Stopped. ' : ''}{result.done.length ? `Saved ${result.done.map(d => `${baseName(d.to)} (${fmtBytes(d.size)})`).join(', ')}.` : ''}
              {result.done[0]?.note ? ` ${result.done[0].note}.` : ''}
              {result.failed.length ? ` Failed: ${result.failed[0].reason}` : ''}
              {result.done[0] && <> <button className="underline" onClick={() => void api.showItem(result.done[0].to)}>Show in folder</button></>}
            </div>
          </Notice>
        )}
      </section>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="rounded-xl border border-line bg-panel p-3 space-y-2"><div className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>{children}</section>;
}
function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return <span className="inline-flex items-center gap-1 rounded-full bg-panel-2 border border-line px-2 py-0.5 text-fg">{children}<button onClick={onRemove} aria-label="Remove"><Icon name="x" size={11} /></button></span>;
}
