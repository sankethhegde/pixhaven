// Settings (GEN-03/04/05): GPU, low-spec mode, tile size, threads, output folder, theme, logs, licences.
import { useEffect, useState, type ReactNode } from 'react';
import type { GpuStatus, ModelDownload, ModelId, Settings, Theme, UpdateStatus } from '@shared/types';
import { api, errorText, fmtBytes } from '../api';
import { Button, Icon, Notice, Segmented, Toggle } from '../components/ui';
import { LabelsSettings } from '../components/LabelsSettings';
import { ShortcutsSettings, WatchedSettings } from '../components/WatchedSettings';

interface Props {
  settings: Settings;
  gpu: GpuStatus | null;
  dedicated: boolean;
  version: string;
  onSettings: (s: Settings) => void;
  onGpu: (g: GpuStatus, dedicated: boolean) => void;
}

export function SettingsPage({ settings, gpu, dedicated, version, onSettings, onGpu }: Props) {
  const [detecting, setDetecting] = useState(false);
  const [licences, setLicences] = useState<{ name: string; text: string }[]>([]);
  const [openLicence, setOpenLicence] = useState<string | null>(null);
  const [faceBytes, setFaceBytes] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [models, setModels] = useState<{ installed: Record<ModelId, boolean>; download: ModelDownload; sizeMb: number } | null>(null);
  const [upd, setUpd] = useState<UpdateStatus>({ state: 'idle' });
  const [thumbBytes, setThumbBytes] = useState<number | null>(null);
  useEffect(() => {
    api.licences().then(setLicences);
    api.sort.dataSize().then(setFaceBytes);
    api.modelsStatus().then(setModels);
    api.updateStatus().then(setUpd);
    api.lib.cacheSize().then(setThumbBytes);
    const offs = [api.onModels(() => api.modelsStatus().then(setModels)), api.onUpdate(setUpd)];
    return () => offs.forEach(o => o());
  }, []);
  const setSort = (patch: Partial<Settings['sort']>) => set({ sort: { ...settings.sort, ...patch } });

  const set = async (patch: Partial<Settings>) => onSettings(await api.setSettings(patch));
  const redetect = async () => {
    setDetecting(true);
    try { const r = await api.detectGpu(); onGpu(r.gpu, r.dedicated); } finally { setDetecting(false); }
  };
  const chooseOutput = async () => {
    const dir = await api.openFolder('Choose where upscaled images are saved');
    if (dir) set({ outputDir: dir });
  };

  return (
    <div className="h-full overflow-auto p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        <h1 className="text-2xl font-semibold">Settings</h1>

        <Card title="Graphics">
          {gpu === null ? <div className="text-sm text-muted">Detecting…</div> : (
            <div className="space-y-3">
              {gpu.gpus.map(g => (
                <div key={g.name} className="flex items-center gap-3 text-sm">
                  <Icon name="chip" size={18} className="text-muted" />
                  <span className="font-medium flex-1">{g.name}</span>
                  <span className="text-xs text-muted">{g.integrated ? 'Integrated (shares system memory)' : 'Dedicated'}</span>
                </div>
              ))}
              {!gpu.ok && <Notice tone="danger">The upscaling engine could not find a Vulkan graphics device. Update your graphics driver, then press Detect again.</Notice>}
              {gpu.vulkan.length > 1 && (
                <Row label="Use graphics" hint="Which device runs the AI model.">
                  <select aria-label="Graphics device" value={settings.gpuId ?? ''} onChange={e => set({ gpuId: e.target.value === '' ? null : Number(e.target.value) })}
                    className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
                    <option value="">Automatic</option>
                    {gpu.vulkan.map((n, i) => <option key={n} value={i}>{n}</option>)}
                  </select>
                </Row>
              )}
            </div>
          )}
          <div className="pt-1"><Button onClick={redetect} disabled={detecting}>{detecting ? 'Detecting…' : 'Detect again'}</Button></div>
        </Card>

        <Card title="Performance">
          <Row label="Low-spec mode" hint={`Smaller tiles, Fast model for folders, no 4K. ${settings.lowSpecAuto ? `Set automatically: ${dedicated ? 'dedicated GPU found, so off' : 'integrated graphics, so on'}.` : 'Set by you.'}`}>
            <Toggle label="Low-spec mode" checked={settings.lowSpec} onChange={v => set({ lowSpec: v, lowSpecAuto: false, tileSize: v ? 192 : 0 })} />
          </Row>
          <Row label="Tile size" hint="Smaller tiles use less graphics memory. PixHaven halves it automatically if memory runs out.">
            <select aria-label="Tile size" value={settings.tileSize} onChange={e => set({ tileSize: Number(e.target.value) })}
              className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
              <option value={0}>Automatic</option>
              {[512, 256, 192, 128, 64].map(t => <option key={t} value={t}>{t} px</option>)}
            </select>
          </Row>
          <Row label="Use the processor only (CPU mode)" hint={gpu && !gpu.ok ? 'On automatically: no usable Vulkan graphics was found.' : 'For PCs where the graphics driver misbehaves. About 20× slower.'}>
            <Toggle label="CPU mode" checked={settings.cpuOnly || (!!gpu && !gpu.ok)} onChange={v => set({ cpuOnly: v })} />
          </Row>
          <Row label="Threads" hint="Load : process : save. Higher can be faster but uses more memory.">
            <select aria-label="Threads" value={settings.threads} onChange={e => set({ threads: e.target.value })}
              className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
              {['1:1:1', '1:2:2', '2:2:2', '2:4:4'].map(t => <option key={t} value={t}>{t}{t === '1:2:2' ? ' (default)' : ''}</option>)}
            </select>
          </Row>
        </Card>

        <Card title="Output">
          <Row label="Save upscaled images" hint={settings.outputDir ? <span className="break-all">{settings.outputDir}</span> : 'Next to the original, with “_upscaled” added to the name.'}>
            <div className="flex gap-2">
              {settings.outputDir && <Button variant="ghost" onClick={() => set({ outputDir: null })}>Use original folder</Button>}
              <Button onClick={chooseOutput}><Icon name="folder" size={16} />Choose…</Button>
            </div>
          </Row>
        </Card>

        <Card title="Upscale models">
          {models && (['photo', 'anime'] as ModelId[]).map(m => (
            <Row key={m} label={m === 'photo' ? 'General photo (best quality)' : 'Anime / illustration'} hint={models.installed[m] ? 'Installed, works offline.' : `One-time ${models.sizeMb} MB download (both models together).`}>
              {models.installed[m] ? <span className="text-xs text-ok font-medium">Installed</span>
                : models.download.state === 'downloading' ? <span className="text-xs tabular-nums">{Math.round(models.download.progress * 100)}%</span>
                : <Button onClick={() => api.downloadModels()}><Icon name="download" size={16} />Download</Button>}
            </Row>
          ))}
        </Card>

        <Card title="Sort by person">
          <Row label="Face-match strictness" hint="Stricter keeps look-alikes apart but may split one person into two groups. Looser does the reverse. Applies the next time you scan a folder (scanning again is quick: only new photos are read).">
            <div className="flex items-center gap-2 text-xs text-muted">
              Looser
              <input type="range" min={0.3} max={0.55} step={0.01} value={settings.sort.strictness} aria-label="Face-match strictness"
                onChange={e => setSort({ strictness: Number(e.target.value) })} className="w-32" />
              Stricter
            </div>
          </Row>
          <Row label="Minimum face size" hint="Smaller faces (background people, crowds) are ignored.">
            <select aria-label="Minimum face size" value={settings.sort.minFaceSize} onChange={e => setSort({ minFaceSize: Number(e.target.value) })}
              className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
              {[24, 32, 40, 60, 80].map(v => <option key={v} value={v}>{v} px{v === 40 ? ' (default)' : ''}</option>)}
            </select>
          </Row>
          <Row label="Minimum photos per person" hint="People with fewer photos go to an “Unsorted” folder.">
            <select aria-label="Minimum photos per person" value={settings.sort.minPhotos} onChange={e => setSort({ minPhotos: Number(e.target.value) })}
              className="h-9 rounded-lg border border-line bg-panel px-2.5 text-sm">
              {[1, 2, 3, 5, 10].map(v => <option key={v} value={v}>{v}{v === 2 ? ' (default)' : ''}</option>)}
            </select>
          </Row>
          <Row label="Move photos without faces to “No faces”" hint="Off: they stay where they are.">
            <Toggle label="No faces folder" checked={settings.sort.noFacesFolder} onChange={v => setSort({ noFacesFolder: v })} />
          </Row>
          <Row label="Read names from text in photos" hint="Name badges, captions, ID cards. Offline, English. Slower on large folders.">
            <Toggle label="Read names from text" checked={settings.sort.useOcr} onChange={v => setSort({ useOcr: v })} />
          </Row>
          <Row label="Saved face data" hint={`Face fingerprints and thumbnails, kept only on this computer${faceBytes != null ? ` (${fmtBytes(faceBytes)})` : ''}. Deleting it does not touch your photos.`}>
            {confirmDelete ? (
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                <Button variant="danger" onClick={async () => {
                  setConfirmDelete(false);
                  try { await api.sort.deleteData(); setFaceBytes(0); setNote('Face data deleted.'); } catch (e) { setNote(errorText(e)); }
                }}>Delete</Button>
              </div>
            ) : <Button variant="danger" disabled={!faceBytes} onClick={() => setConfirmDelete(true)}>Delete face data</Button>}
          </Row>
          {note && <div className="text-xs text-muted">{note}</div>}
        </Card>

        <Card title="Upscaling folders">
          <Row label="Skip images already upscaled" hint="When a folder job is run again, images that already have an “_upscaled” file are skipped, so an interrupted job just continues.">
            <Toggle label="Skip images already upscaled" checked={settings.skipExisting} onChange={v => set({ skipExisting: v })} />
          </Row>
        </Card>

        <Card title="Media library">
          <Row label="Show system folders" hint="Windows, Program Files, AppData, the Recycle Bin and hidden folders. Off keeps the library to your own files.">
            <Toggle label="Show system folders" checked={settings.library.showSystem} onChange={v => set({ library: { ...settings.library, showSystem: v } })} />
          </Row>
          <Row label="Thumbnail cache" hint={<>Thumbnails are kept so folders open instantly next time (up to about 2 GB; the oldest are dropped first). {thumbBytes !== null && <>Now using <b>{fmtBytes(thumbBytes)}</b>.</>}</>}>
            <Button disabled={!thumbBytes} onClick={async () => { await api.lib.clearCache(); setThumbBytes(await api.lib.cacheSize()); }}>Clear</Button>
          </Row>
        </Card>

        <WatchedSettings />

        <LabelsSettings />

        <ShortcutsSettings />

        <Card title="Appearance">
          <Row label="Theme">
            <Segmented<Theme> label="Theme" value={settings.theme} onChange={theme => set({ theme })}
              options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
          </Row>
        </Card>

        <Card title="Updates">
          <Row label={`Version ${version}`} hint={
            upd.state === 'not-configured' ? 'Automatic updates switch on once releases are published on GitHub.'
            : upd.state === 'checking' ? 'Checking…' : upd.state === 'latest' ? 'You have the latest version.'
            : upd.state === 'downloading' ? `Downloading version ${upd.version}… ${Math.round((upd.progress ?? 0) * 100)}%`
            : upd.state === 'ready' ? `Version ${upd.version} is ready to install.` : upd.state === 'error' ? `Couldn't check: ${upd.error}` : 'Checks for a new version and offers to install it.'}>
            {upd.state === 'ready'
              ? <Button variant="primary" onClick={() => api.installUpdate()}>Restart and update</Button>
              : <Button disabled={upd.state === 'checking' || upd.state === 'downloading' || upd.state === 'not-configured'} onClick={async () => setUpd(await api.checkUpdates())}>Check for updates</Button>}
          </Row>
        </Card>

        <Card title="Help">
          <Row label="Logs" hint="Send these when reporting a problem.">
            <Button onClick={() => api.openLogs()}><Icon name="external" size={16} />Open logs folder</Button>
          </Row>
        </Card>

        <Card title={`About PixHaven ${version}`}>
          <p className="text-sm text-muted">Offline AI image upscaler. Uses Real-ESRGAN models through realesrgan-ncnn-vulkan. Open-source components and their licences:</p>
          <div className="divide-y divide-[var(--border)] rounded-lg border border-line">
            {licences.map(l => (
              <div key={l.name}>
                <button onClick={() => setOpenLicence(openLicence === l.name ? null : l.name)} className="w-full text-left px-3 h-9 text-sm hover:bg-panel-2 flex items-center">
                  <span className="flex-1">{l.name}</span><span className="text-xs text-muted">{openLicence === l.name ? 'Hide' : 'Show'}</span>
                </button>
                {openLicence === l.name && <pre className="selectable px-3 pb-3 text-xs text-muted whitespace-pre-wrap max-h-60 overflow-auto">{l.text}</pre>}
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5 space-y-4">
      <h2 className="font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5 leading-relaxed">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
