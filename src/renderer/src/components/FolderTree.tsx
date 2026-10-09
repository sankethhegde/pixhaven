// Left-hand tree of the media library: places, then every drive (LIB-01); folders open on demand.
// Folders known to hold no photos or videos are left out (LIB-02); ones we may not open are greyed (LIB-10).
import { Fragment, useEffect, useState } from 'react';
import type { DriveInfo } from '@shared/types';
import { api, fmtBytes } from '../api';
import { Icon } from './ui';

interface Node { folders: string[] | null; denied?: boolean }

interface Props {
  drives: DriveInfo[];
  current: string | null;
  hasMedia: Record<string, boolean | null>;
  onHasMedia: (m: Record<string, boolean | null>) => void;
  onOpen: (dir: string) => void;
}

const DRIVE_ICON: Record<DriveInfo['kind'], string> = { fixed: 'drive', removable: 'usb', network: 'network', cd: 'disc', place: 'folder' };
const name = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
const same = (a: string | null, b: string) => !!a && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function FolderTree({ drives, current, hasMedia, onHasMedia, onOpen }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [nodes, setNodes] = useState<Record<string, Node>>({});

  async function load(dir: string) {
    const l = await api.lib.list(dir);
    const folders = l.entries.filter(e => e.kind === 'folder').map(e => e.path);
    setNodes(n => ({ ...n, [dir]: { folders, denied: l.denied } }));
    if (folders.length) api.lib.hasMedia(folders).then(onHasMedia);
  }
  const toggle = (dir: string) => {
    const next = !open[dir];
    setOpen(o => ({ ...o, [dir]: next }));
    if (next) void load(dir);
  };

  // Follow the folder shown in the middle: open its ancestors so it is visible.
  useEffect(() => {
    if (!current) return;
    const root = drives.filter(d => current.toLowerCase().startsWith(d.path.replace(/[\\/]+$/, '').toLowerCase())).sort((a, b) => b.path.length - a.path.length)[0];
    if (!root) return;
    const sep = current.includes('\\') ? '\\' : '/';
    const parts = current.slice(root.path.length).split(/[\\/]/).filter(Boolean);
    const chain = [root.path];
    let acc = root.path.replace(/[\\/]+$/, '');
    for (const p of parts.slice(0, -1)) { acc = `${acc}${sep}${p}`; chain.push(acc); }
    setOpen(o => { const n = { ...o }; for (const c of chain) n[c] = true; return n; });
    for (const c of chain) if (!nodes[c]) void load(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, drives]);

  // Plain render functions (not components), so React keeps the rows instead of remounting them.
  function branch(dir: string, depth: number) {
    const node = nodes[dir];
    if (!node) return <div className="text-xs text-muted py-1" style={{ paddingLeft: 28 + depth * 14 }}>Loading…</div>;
    if (node.denied) return <div className="text-xs text-muted py-1" style={{ paddingLeft: 28 + depth * 14 }}>No permission to open</div>;
    const shown = (node.folders ?? []).filter(f => hasMedia[f] !== false);
    if (!shown.length) return null;
    return <>{shown.map(f => row(f, name(f), 'folder', depth))}</>;
  }

  function row(dir: string, label: string, icon: string, depth: number, detail?: string) {
    const isOpen = !!open[dir];
    const active = same(current, dir);
    const denied = nodes[dir]?.denied;
    return (
      <Fragment key={dir}>
        <div className={`flex items-center h-8 rounded-md pr-2 text-sm ${active ? 'bg-accent-soft text-accent' : 'hover:bg-panel-2'} ${denied ? 'opacity-50' : ''}`}
          style={{ paddingLeft: 4 + depth * 14 }} title={denied ? 'You do not have permission to open this folder' : detail ? `${dir}\n${detail}` : dir}>
          <button className="h-6 w-6 flex items-center justify-center text-muted hover:text-fg shrink-0" aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
            aria-expanded={isOpen} onClick={() => toggle(dir)}>
            <Icon name="chevron" size={13} className={`transition ${isOpen ? 'rotate-90' : ''}`} />
          </button>
          <button className="flex items-center gap-1.5 min-w-0 flex-1 text-left h-full" onClick={() => onOpen(dir)} data-tree={dir}>
            <Icon name={denied ? 'lock' : icon} size={15} className={active ? '' : 'text-muted'} />
            <span className="truncate">{label}</span>
          </button>
        </div>
        {isOpen && branch(dir, depth + 1)}
      </Fragment>
    );
  }

  const places = drives.filter(d => d.kind === 'place');
  const disks = drives.filter(d => d.kind !== 'place');
  return (
    <div className="p-2 space-y-3" aria-label="Folders">
      <div>
        <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Quick access</div>
        {places.map(p => row(p.path, p.name, 'folder', 0))}
      </div>
      <div>
        <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Drives</div>
        {disks.map(d => row(d.path, d.name, DRIVE_ICON[d.kind], 0, d.total ? `${fmtBytes(d.free ?? 0)} free of ${fmtBytes(d.total)}` : undefined))}
      </div>
    </div>
  );
}
