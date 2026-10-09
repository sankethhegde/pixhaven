// Upscale settings: size (IMG-02), model (IMG-03), output format (IMG-06) and output location (GEN-02).
import type { ModelId, OutputFormat, SizeChoice, TargetId, UpscaleOptions } from '@shared/types';
import { MODELS, TARGETS } from '@shared/types';
import { Field, Segmented } from './ui';

interface Props {
  opts: UpscaleOptions;
  onChange: (o: UpscaleOptions) => void;
  allow4k: boolean;
  disabled?: boolean;
  inputSize?: { width: number; height: number };
}

type SizeKey = '2' | '4' | TargetId;
const sizeKey = (s: SizeChoice): SizeKey => (s.kind === 'scale' ? (String(s.factor) as SizeKey) : s.target);
const fromKey = (k: SizeKey): SizeChoice => (k === '2' || k === '4' ? { kind: 'scale', factor: Number(k) as 2 | 4 } : { kind: 'target', target: k });

/** Same maths as the main process (plan.ts): fit inside the target box, keeping orientation. */
export function outputSize(w: number, h: number, s: SizeChoice) {
  let f: number;
  if (s.kind === 'scale') f = s.factor;
  else {
    const t = TARGETS[s.target];
    const [bw, bh] = w >= h ? [t.long, t.short] : [t.short, t.long];
    f = Math.min(bw / w, bh / h);
  }
  return { width: Math.round(w * f), height: Math.round(h * f), factor: f };
}

export function OptionsPanel({ opts, onChange, allow4k, disabled, inputSize }: Props) {
  const set = (patch: Partial<UpscaleOptions>) => onChange({ ...opts, ...patch });
  const key = sizeKey(opts.size);
  const out = inputSize ? outputSize(inputSize.width, inputSize.height, opts.size) : null;

  return (
    <fieldset disabled={disabled} className="space-y-6 disabled:opacity-60">
      <Field label="Size">
        <Segmented label="Scale factor" value={key === '2' || key === '4' ? key : ('' as SizeKey)}
          onChange={k => set({ size: fromKey(k) })}
          options={[{ value: '2', label: '2×' }, { value: '4', label: '4×' }]} />
        <select aria-label="Target size" value={key === '2' || key === '4' ? '' : key}
          onChange={e => e.target.value && set({ size: fromKey(e.target.value as SizeKey) })}
          className="w-full h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
          <option value="">…or a target size</option>
          {(Object.keys(TARGETS) as TargetId[]).filter(t => t !== '4k' || allow4k).map(t => (
            <option key={t} value={t}>{TARGETS[t].label}</option>
          ))}
        </select>
        {out && (
          <div className={`text-xs ${out.factor <= 1 ? 'text-warn' : 'text-muted'}`}>
            {out.factor <= 1
              ? 'The image is already this size or larger. Pick a bigger size.'
              : <>Result: <b className="text-fg">{out.width.toLocaleString()} × {out.height.toLocaleString()}</b> px ({out.factor.toFixed(out.factor % 1 ? 2 : 0)}×)</>}
          </div>
        )}
        {!allow4k && <div className="text-xs text-muted">4K is available with a dedicated graphics card, or with low-spec mode off.</div>}
      </Field>

      <Field label="Model" hint={MODELS[opts.model].hint}>
        <div className="grid gap-1.5" role="radiogroup" aria-label="Model">
          {(Object.keys(MODELS) as ModelId[]).map(m => (
            <label key={m} className={`flex items-center gap-2.5 rounded-lg border px-3 h-10 cursor-pointer transition
              ${opts.model === m ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-panel-2'}`}>
              <input type="radio" name="model" checked={opts.model === m} onChange={() => set({ model: m })} className="accent-[var(--accent)]" />
              <span className="font-medium">{MODELS[m].label}</span>
              {m === 'fast' && <span className="ml-auto text-[11px] font-semibold text-accent">QUICKEST</span>}
            </label>
          ))}
        </div>
      </Field>

      <Field label="Output format">
        <Segmented<OutputFormat> label="Output format" value={opts.format} onChange={format => set({ format })}
          options={[{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WEBP' }]} />
        {opts.format !== 'png' && (
          <label className="flex items-center gap-3 text-sm">
            <span className="text-muted w-14">Quality</span>
            <input type="range" min={50} max={100} value={opts.jpgQuality} onChange={e => set({ jpgQuality: Number(e.target.value) })} className="flex-1" />
            <span className="w-8 text-right tabular-nums">{opts.jpgQuality}</span>
          </label>
        )}
        {opts.format === 'jpg' && <div className="text-xs text-muted">JPG has no transparency: transparent areas become white.</div>}
      </Field>
    </fieldset>
  );
}
