// v2.6 Image Generator: describe a picture, get images made on this computer (offline, free). LCM Dreamshaper v7 runs
// on the graphics card; images are saved with their prompt inside, and can go straight to Upscale.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenImage, GenProgress, GenSize, GenStatus, GenStyle, Settings } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import { Button, Icon, Notice, ProgressBar, Segmented } from '../components/ui';

interface Props {
  settings: Settings;
  onSettings: (s: Settings) => void;
  active: boolean;
  onUpscale: (paths: string[]) => void;
}

const STYLES: { value: GenStyle; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'photo', label: 'Photo' }, { value: 'illustration', label: 'Illustration' },
  { value: 'anime', label: 'Anime' }, { value: 'painting', label: 'Painting' }, { value: '3d', label: '3D' },
];
const SIZES: { value: GenSize; label: string; title: string }[] = [
  { value: 'square', label: 'Square', title: '512 × 512' }, { value: 'portrait', label: 'Portrait', title: '512 × 768' }, { value: 'landscape', label: 'Landscape', title: '768 × 512' },
];
const IDEAS = [
  'A cozy wooden cabin by a misty lake at sunrise',
  'A cute corgi astronaut floating in space',
  'A bowl of steaming ramen on a dark wooden table',
  'An old lighthouse on a cliff during a storm',
  'A futuristic city street at night with neon signs and rain',
];
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private */ } } };

export function ImageGenerator({ settings, onSettings, active, onUpscale }: Props) {
  const g = settings.generator;
  const [status, setStatus] = useState<GenStatus | null>(null);
  const [prompt, setPrompt] = useState(() => store.get('gen.prompt') ?? '');
  const [seed, setSeed] = useState('');
  const [tokens, setTokens] = useState(0);
  const [job, setJob] = useState<string | null>(null);
  const [prog, setProg] = useState<GenProgress | null>(null);
  const [fresh, setFresh] = useState<GenImage[]>([]);
  const [arrived, setArrived] = useState(0);   // images of the running request so far
  const [earlier, setEarlier] = useState<GenImage[]>([]);
  const [open, setOpen] = useState<GenImage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobRef = useRef<string | null>(null);

  // Merged with what is saved now: the output folder is changed by the main process ("Change…").
  const set = async (patch: Partial<Settings['generator']>) => onSettings(await api.setSettings({ generator: { ...(await api.getSettings()).generator, ...patch } }));
  const refresh = useCallback(async () => {
    setStatus(await api.gen.status());
    const h = await api.gen.history();
    setEarlier(h);
  }, []);

  useEffect(() => { if (active) void refresh(); }, [active, refresh]);
  useEffect(() => {
    const offs = [
      api.onGenStatus(setStatus),
      api.onGenProgress(p => {
        if (p.jobId !== jobRef.current) return;
        setProg(p);
        if (p.image) { setFresh(f => [p.image!, ...f]); setArrived(a => a + 1); }
        if (p.phase === 'error') setError(p.error ?? 'Something went wrong.');
        if (p.phase === 'done' || p.phase === 'cancelled' || p.phase === 'error') { jobRef.current = null; setJob(null); void api.gen.status().then(setStatus); }
      }),
    ];
    return () => offs.forEach(o => o());
  }, []);
  useEffect(() => store.set('gen.prompt', prompt), [prompt]);
  // Prompt length: only the first 75 tokens count.
  useEffect(() => {
    if (!status?.installed || !status.loaded || !prompt.trim()) { setTokens(0); return; }
    const t = setTimeout(() => void api.gen.tokens(prompt).then(setTokens), 400);
    return () => clearTimeout(t);
  }, [prompt, status?.installed, status?.loaded]);

  const running = !!job;
  const start = async () => {
    if (!prompt.trim() || running) return;
    setError(null); setProg(null); setArrived(0);
    const s = seed.trim() === '' ? null : Math.abs(Math.floor(Number(seed))) % 2 ** 31;
    try {
      const id = await api.gen.generate({ prompt, style: g.style, size: g.size, count: g.count, quality: g.quality, format: g.format, seed: Number.isFinite(s as number) ? s : null });
      jobRef.current = id; setJob(id);
      setProg({ jobId: id, index: 0, count: g.count, step: 0, steps: 5, phase: 'loading' });
    } catch (e) { setError(errorText(e)); }
  };
  const reuse = (im: GenImage) => { setPrompt(im.prompt); setSeed(String(im.seed)); void set({ style: im.style }); setOpen(null); };
  const forget = async (im: GenImage) => { await api.gen.forget(im.id); setFresh(f => f.filter(x => x.id !== im.id)); setEarlier(e => e.filter(x => x.id !== im.id)); setOpen(null); };

  // ---------- first: the model download ----------
  if (status && !status.installed) {
    const d = status.download;
    return (
      <div className="h-full overflow-auto p-8">
        <div className="max-w-3xl mx-auto space-y-5">
          <Title />
          <div className="rounded-2xl border border-line bg-panel p-6 space-y-4" data-testid="gen-download">
            <div className="flex items-start gap-4">
              <div className="rounded-full p-3 bg-accent-soft text-accent"><Icon name="wand" size={24} /></div>
              <div className="flex-1 space-y-1">
                <div className="font-semibold">One-time download: {status.modelName} ({fmtBytes(status.bytes)})</div>
                <div className="text-sm text-muted leading-relaxed">
                  The Image Generator runs entirely on this computer: free, no account, and your descriptions never leave it.
                  It needs a graphics card (DirectML). Each image takes a few seconds; the first one after installing takes about a minute while Windows prepares the graphics card.
                </div>
              </div>
            </div>
            <div className="rounded-xl bg-panel-2 p-4 text-sm space-y-2">
              <div className="font-medium">Model licence (CreativeML OpenRAIL-M) — please use it responsibly</div>
              <ul className="list-disc pl-5 space-y-1 text-muted">
                <li>Don’t use it to break the law, or to harm, harass, deceive or exploit people.</li>
                <li>Don’t make pictures meant to pass as real photos of real people, or to spread false information.</li>
                <li>Explicit images are blocked by a built-in safety filter.</li>
                <li>Pictures you make are yours to use, within these rules.</li>
              </ul>
              <button className="text-accent hover:underline text-sm" onClick={() => void api.gen.openLicence()}>Read the full licence</button>
            </div>
            {d.state === 'downloading' ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm"><span>Downloading…</span><span className="tabular-nums text-muted">{fmtBytes(d.got)} of {fmtBytes(d.total)}</span></div>
                <ProgressBar value={d.total ? d.got / d.total : 0} />
                <div className="flex items-center gap-3">
                  <Button className="h-8" variant="ghost" onClick={() => void api.gen.cancelDownload()}>Stop</Button>
                  <span className="text-xs text-muted">You can keep using PixHaven. If it stops, it continues where it stopped.</span>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {d.state === 'error' && <Notice tone="danger">{d.error}</Notice>}
                <Button variant="primary" className="h-10" onClick={() => void api.gen.download()}>
                  <Icon name="download" size={16} />{d.got > 0 ? 'Continue the download' : `Agree and download (${fmtBytes(status.bytes)})`}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ---------- the generator ----------
  const all = [...fresh, ...earlier.filter(e => !fresh.some(f => f.id === e.id))];
  const steps = g.quality === 'better' ? 8 : 4;
  const done = prog ? prog.index + prog.step / Math.max(1, prog.steps) : 0;
  return (
    <div className="h-full flex min-h-0">
      <aside className="w-[360px] shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
        <div className="flex-1 overflow-auto p-5 space-y-5">
          <Title small />
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="gen-prompt">Describe the picture</label>
            <textarea id="gen-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={5} placeholder={IDEAS[0]}
              onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void start(); } }}
              className="w-full rounded-lg bg-panel-2 border border-line p-3 text-sm outline-none focus:border-accent resize-none" />
            {tokens > 75 && <div className="text-xs text-warn">This description is long: only about the first 75 words and symbols are used.</div>}
            {!prompt.trim() && (
              <div className="flex flex-wrap gap-1.5">
                {IDEAS.map(i => <button key={i} onClick={() => setPrompt(i)} className="text-xs rounded-full border border-line px-2.5 py-1 text-muted hover:text-fg hover:bg-panel-2">{i}</button>)}
              </div>
            )}
          </div>
          <Field label="Style"><Wrap><Segmented label="Style" value={g.style} onChange={v => void set({ style: v })} options={STYLES} /></Wrap></Field>
          <Field label="Shape"><Segmented label="Shape" value={g.size} onChange={v => void set({ size: v })} options={SIZES} /></Field>
          <Field label="Images"><Segmented label="Images" value={String(g.count)} onChange={v => void set({ count: Number(v) })} options={['1', '2', '3', '4'].map(v => ({ value: v, label: v }))} /></Field>
          <Field label="Quality">
            <Segmented label="Quality" value={g.quality} onChange={v => void set({ quality: v })}
              options={[{ value: 'fast', label: 'Fast', title: '4 steps' }, { value: 'better', label: 'Better', title: '8 steps, about twice as long' }]} />
          </Field>
          <Field label="Format">
            <Segmented label="Format" value={g.format} onChange={v => void set({ format: v })}
              options={[{ value: 'jpg', label: 'JPG', title: 'Small files (quality 92)' }, { value: 'png', label: 'PNG', title: 'Lossless, about 5–10× bigger' }, { value: 'webp', label: 'WEBP', title: 'Smallest files' }]} />
          </Field>
          <Field label="Seed">
            <div className="flex gap-2">
              <input value={seed} onChange={e => setSeed(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))} placeholder="Random" aria-label="Seed" inputMode="numeric"
                className="flex-1 h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent tabular-nums" />
              {seed && <Button className="h-9" variant="ghost" onClick={() => setSeed('')}>Random</Button>}
            </div>
            <div className="text-xs text-muted">The same description, style and seed give the same picture.</div>
          </Field>
        </div>
        <div className="border-t border-line p-4 space-y-3">
          {error && <Notice tone="danger">{error}</Notice>}
          {running ? (
            <div className="space-y-2" data-testid="gen-progress">
              <div className="flex justify-between text-sm">
                <span>{prog?.phase === 'loading' ? 'Loading the model…' : `Making image ${Math.min((prog?.index ?? 0) + 1, g.count)} of ${prog?.count ?? g.count}…`}</span>
              </div>
              <ProgressBar value={prog ? done / prog.count : 0} />
              <Button variant="danger" className="w-full" onClick={() => job && void api.queueCancel(job)}><Icon name="x" size={16} />Stop</Button>
            </div>
          ) : (
            <Button variant="primary" className="w-full h-10" disabled={!prompt.trim()} onClick={() => void start()} title="Ctrl+Enter">
              <Icon name="wand" size={16} />Generate {g.count} image{g.count === 1 ? '' : 's'}
            </Button>
          )}
          <div className="text-xs text-muted leading-relaxed">
            {g.count} × {SIZES.find(s => s.value === g.size)?.title}, {steps} steps, {g.format.toUpperCase()}. Saved in <button className="text-accent hover:underline break-all text-left" onClick={() => status && void api.openPath(status.outputDir)}>{status?.outputDir}</button>
            {' · '}<button className="text-accent hover:underline" onClick={async () => { const f = await api.gen.chooseFolder(); if (f) { onSettings(await api.getSettings()); void refresh(); } }}>Change…</button>
          </div>
        </div>
      </aside>

      <section className="flex-1 min-w-0 overflow-auto p-6">
        {all.length === 0 && !running ? (
          <div className="h-full flex items-center justify-center text-center text-muted">
            <div className="max-w-sm space-y-2">
              <Icon name="wand" size={40} className="mx-auto opacity-60" />
              <div className="text-fg font-medium">Your pictures appear here</div>
              <div className="text-sm">Describe something, pick a style and press Generate. Everything is made on this computer.</div>
            </div>
          </div>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }} data-testid="gen-results">
            {running && prog && Array.from({ length: Math.max(0, prog.count - arrived) }).map((_, i) => (
              <div key={`p${i}`} className="aspect-square rounded-xl bg-panel-2 animate-pulse flex items-center justify-center text-xs text-muted">{i === 0 ? (prog.phase === 'loading' ? 'Loading the model…' : 'Working…') : 'Waiting…'}</div>
            ))}
            {all.map(im => (
              <figure key={im.id} className="group relative rounded-xl overflow-hidden bg-panel-2" data-gen-image={im.hidden ? 'hidden' : 'shown'}>
                <button className="block w-full" onClick={() => !im.hidden && setOpen(im)} disabled={im.hidden}>
                  <img src={im.url} alt={im.prompt} className="w-full object-cover" style={{ aspectRatio: `${im.width} / ${im.height}` }} loading="lazy" />
                </button>
                {im.hidden && <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-sm text-center p-4">Hidden by the safety filter. It was not saved.</div>}
                {!im.hidden && (
                  <figcaption className="absolute inset-x-0 bottom-0 p-2 flex gap-1 justify-end opacity-0 group-hover:opacity-100 focus-within:opacity-100 bg-gradient-to-t from-black/70 to-transparent">
                    <Button className="!h-7 !px-2 text-xs" onClick={() => im.path && onUpscale([im.path])} title="Make it bigger and sharper"><Icon name="sparkle" size={13} />Upscale</Button>
                    <Button className="!h-7 !px-2 text-xs" onClick={() => im.path && void api.showItem(im.path)} title="Show in folder"><Icon name="folder" size={13} /></Button>
                    <Button className="!h-7 !px-2 text-xs" onClick={() => reuse(im)} title="Use this description, style and seed again"><Icon name="refresh" size={13} /></Button>
                  </figcaption>
                )}
              </figure>
            ))}
          </div>
        )}
      </section>

      {open && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8" onClick={() => setOpen(null)} role="dialog" aria-label="Generated image">
          <div className="bg-panel rounded-2xl max-w-5xl w-full max-h-full flex flex-col md:flex-row overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <img src={open.url} alt={open.prompt} className="max-h-[80vh] object-contain bg-black md:w-2/3" />
            <div className="p-5 space-y-3 md:w-1/3 overflow-auto">
              <div className="text-sm selectable">{open.prompt}</div>
              <div className="text-xs text-muted space-y-0.5">
                <div>Style: {STYLES.find(s => s.value === open.style)?.label} · {open.width} × {open.height} · {open.steps} steps</div>
                <div className="selectable">Seed: {open.seed}</div>
                <div>{new Date(open.created).toLocaleString()}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => open.path && onUpscale([open.path])}><Icon name="sparkle" size={15} />Upscale</Button>
                <Button onClick={() => open.path && void api.showItem(open.path)}><Icon name="folder" size={15} />Show in folder</Button>
                <Button onClick={() => reuse(open)}><Icon name="refresh" size={15} />Use again</Button>
                <Button variant="ghost" onClick={() => void forget(open)} title="Remove from this list (the file stays)">Remove from list</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Title({ small }: { small?: boolean }) {
  return (
    <div>
      <h1 className={small ? 'text-lg font-semibold' : 'text-2xl font-semibold'}>Image Generator</h1>
      <p className="text-sm text-muted mt-1">Pictures from a description, made on this computer. Free and private.</p>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><div className="text-sm font-medium">{label}</div>{children}</div>;
}
function Wrap({ children }: { children: React.ReactNode }) { return <div className="[&>div]:flex-wrap [&>div]:flex">{children}</div>; }
