// Drives, folders and search for the media library (LIB-01, 02, 06, 07, 10). Read-only: never changes a file.
// No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mediaKind, type DriveInfo, type DriveKind, type FolderListing, type MediaEntry } from '../../shared/types';

const IS_WIN = process.platform === 'win32';

/** LIB-06: system and program folders, hidden unless "show system folders" is on. */
const WIN_SYSTEM = new Set(['windows', 'program files', 'program files (x86)', 'programdata', 'appdata', 'system volume information',
  'recovery', 'perflogs', 'config.msi', 'msocache', 'boot', 'documents and settings', 'onedrivetemp', 'windowsapps', 'node_modules',
  'intel', 'amd', 'nvidia', 'drivers', 'xboxgames', 'inetpub', 'esd']);
const LINUX_SYSTEM = new Set(['proc', 'sys', 'dev', 'run', 'boot', 'usr', 'bin', 'sbin', 'lib', 'lib32', 'lib64', 'libx32', 'etc', 'var',
  'snap', 'opt', 'srv', 'tmp', 'lost+found', 'cdrom', 'node_modules']);
// Folders PixHaven itself makes for its bookkeeping.
const ALWAYS_SKIP = new Set(['.clearup']);

export function isSystemName(name: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith('$') || n.startsWith('.') || n.startsWith('~')) return true;    // $Recycle.Bin, .git, ~temp
  return (IS_WIN ? WIN_SYSTEM : LINUX_SYSTEM).has(n);
}
export const skipDir = (name: string, showSystem: boolean) => ALWAYS_SKIP.has(name.toLowerCase()) || (!showSystem && isSystemName(name));

const denied = (e: unknown) => ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException)?.code ?? '');

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
}

// ---------- drives (LIB-01) ----------

let volumeNames = new Map<string, { name: string; kind: DriveKind }>();
let volumeKey = '';

/** Windows: which drive letters exist (fast, polled), plus names and types from WMI when the set changes. */
export async function listDrives(places: { name: string; path: string }[]): Promise<DriveInfo[]> {
  const out: DriveInfo[] = places.filter(p => fs.existsSync(p.path)).map(p => ({ ...p, kind: 'place' as const }));
  if (IS_WIN) {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const present = await Promise.all(letters.map(l => withTimeout(fs.promises.stat(`${l}:\\`).then(() => true, () => false), 1500, false)));
    const roots = letters.filter((_, i) => present[i]).map(l => `${l}:\\`);
    const key = roots.join('|');
    if (key !== volumeKey) { volumeKey = key; volumeNames = await windowsVolumes(); }
    for (const r of roots) {
      const v = volumeNames.get(r.slice(0, 2).toUpperCase());
      const space = await withTimeout(fs.promises.statfs(r).then(s => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }), () => null), 1500, null);
      const kind = v?.kind ?? 'fixed';
      const fallback = kind === 'removable' ? 'USB drive' : kind === 'network' ? 'Network drive' : kind === 'cd' ? 'CD/DVD drive' : 'Local Disk';
      out.push({ path: r, name: `${v?.name || fallback} (${r.slice(0, 2)})`, kind, ...(space ?? {}) });
    }
  } else {
    const mounts = ['/'];
    const user = process.env.USER ?? '';
    for (const base of [`/media/${user}`, `/run/media/${user}`, '/media', '/mnt']) {
      try { for (const d of fs.readdirSync(base)) { const p = path.join(base, d); if (d !== user && fs.statSync(p).isDirectory()) mounts.push(p); } } catch { /* none */ }
    }
    for (const m of [...new Set(mounts)]) {
      const space = await fs.promises.statfs(m).then(s => ({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }), () => null);
      out.push({ path: m, name: m === '/' ? 'Computer (/)' : path.basename(m), kind: m === '/' ? 'fixed' : 'removable', ...(space ?? {}) });
    }
  }
  return out;
}

function windowsVolumes(): Promise<Map<string, { name: string; kind: DriveKind }>> {
  const ps = 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,ProviderName | ConvertTo-Json -Compress';
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const map = new Map<string, { name: string; kind: DriveKind }>();
      if (!err) {
        try {
          const rows = [JSON.parse(stdout)].flat() as { DeviceID: string; DriveType: number; VolumeName: string | null; ProviderName: string | null }[];
          for (const r of rows) {
            const kind: DriveKind = r.DriveType === 2 ? 'removable' : r.DriveType === 4 ? 'network' : r.DriveType === 5 ? 'cd' : 'fixed';
            const share = r.ProviderName ? r.ProviderName.split('\\').filter(Boolean).pop() : null;
            map.set(r.DeviceID.toUpperCase(), { name: r.VolumeName || share || '', kind });
          }
        } catch { /* keep defaults */ }
      }
      resolve(map);
    });
  });
}

// ---------- folders (LIB-02, LIB-10) ----------

export async function listFolder(dir: string, showSystem: boolean): Promise<FolderListing> {
  const parent = path.dirname(dir) === dir ? null : path.dirname(dir);
  let dirents: fs.Dirent[];
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (denied(e)) return { dir, parent, entries: [], hiddenFiles: 0, denied: true };
    return { dir, parent, entries: [], hiddenFiles: 0, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'This folder no longer exists.' : String((e as Error).message) };
  }
  const entries: MediaEntry[] = [];
  let hiddenFiles = 0;
  const files: fs.Dirent[] = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      if (!skipDir(d.name, showSystem)) entries.push({ name: d.name, path: path.join(dir, d.name), kind: 'folder', size: 0, mtime: 0 });
    } else if (d.isFile() && mediaKind(d.name)) files.push(d);
    else if (!d.isSymbolicLink()) hiddenFiles++;
    // Windows junctions ("My Music", "Application Data") are old compatibility links that loop or deny access: skipped.
  }
  // stat in batches: fast on a 5,000-file folder without opening thousands of handles at once.
  for (let i = 0; i < files.length; i += 128) {
    const batch = files.slice(i, i + 128);
    const stats = await Promise.all(batch.map(d => fs.promises.stat(path.join(dir, d.name)).catch(() => null)));
    batch.forEach((d, j) => {
      const s = stats[j];
      if (s) entries.push({ name: d.name, path: path.join(dir, d.name), kind: mediaKind(d.name)!, size: s.size, mtime: s.mtimeMs });
    });
  }
  return { dir, parent, entries, hiddenFiles };
}

const hasMediaCache = new Map<string, { at: number; v: boolean | null }>();

/**
 * "Folders that contain them" (LIB-02): looks a few levels down for any photo or video, within a time and entry budget.
 * true = has some, false = none, null = too big to tell quickly (shown anyway).
 */
export async function folderHasMedia(dir: string, showSystem: boolean): Promise<boolean | null> {
  const hit = hasMediaCache.get(dir);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const end = Date.now() + 400;
  let budget = 4000;
  let queue = [dir];
  let result: boolean | null = false;
  for (let depth = 0; depth < 4 && queue.length && result === false; depth++) {
    const next: string[] = [];
    for (const d of queue) {
      if (Date.now() > end || budget <= 0) { result = null; break; }
      let list: fs.Dirent[];
      try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { continue; }
      budget -= list.length;
      if (list.some(e => e.isFile() && mediaKind(e.name))) { result = true; break; }
      for (const e of list) if (e.isDirectory() && !skipDir(e.name, showSystem)) next.push(path.join(d, e.name));
    }
    queue = next;
  }
  if (result === false && queue.length) result = null;                // deeper than we looked
  hasMediaCache.set(dir, { at: Date.now(), v: result });
  return result;
}

// ---------- search by name (LIB-07, Phase A: file names under a folder) ----------

export const SEARCH_LIMIT = 5000;

export async function searchNames(root: string, query: string, showSystem: boolean, signal: AbortSignal,
  onBatch: (items: MediaEntry[], scanned: number) => void): Promise<{ scanned: number; truncated: boolean }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (name: string) => { const n = name.toLowerCase(); return words.every(w => n.includes(w)); };
  const stack = [root];
  let scanned = 0, found = 0, batch: MediaEntry[] = [], last = Date.now();
  const flush = () => { if (batch.length) { onBatch(batch, scanned); batch = []; } last = Date.now(); };
  while (stack.length && !signal.aborted) {
    const dir = stack.pop()!;
    let list: fs.Dirent[];
    try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    const subdirs: string[] = [];
    for (const e of list) {
      if (e.isDirectory()) {
        if (skipDir(e.name, showSystem)) continue;
        subdirs.push(path.join(dir, e.name));
        if (match(e.name)) batch.push({ name: e.name, path: path.join(dir, e.name), kind: 'folder', size: 0, mtime: 0 });
      } else if (e.isFile()) {
        scanned++;
        const kind = mediaKind(e.name);
        if (!kind || !match(e.name)) continue;
        const p = path.join(dir, e.name);
        const s = await fs.promises.stat(p).catch(() => null);
        if (!s) continue;
        batch.push({ name: e.name, path: p, kind, size: s.size, mtime: s.mtimeMs });
        if (++found >= SEARCH_LIMIT) { flush(); return { scanned, truncated: true }; }
      }
    }
    stack.push(...subdirs.reverse());
    if (Date.now() - last > 150) flush();
  }
  flush();
  return { scanned, truncated: false };
}
