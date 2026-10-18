// v2.5: keeps the File Explorer shortcuts of group photos (sorter/shortcuts.ts) in step, using Windows shortcuts
// (.lnk) through Electron. Other systems: nothing (PixHaven still shows the photos in every person's folder).
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { syncShortcuts, type LinkApi } from './sorter/shortcuts';
import { manifestRootOf } from './sorter/people-manifest';
import { log } from './logger';

const links: LinkApi = {
  write: (lnk, target, description) => {
    try { return shell.writeShortcutLink(lnk, 'create', { target, description }); } catch { return false; }
  },
  read: lnk => {
    try { const r = shell.readShortcutLink(lnk); return { target: r.target, description: r.description ?? '' }; } catch { return null; }
  },
};

/** Shortcuts of one sorted folder made to match its people.json (`removeAll`: all of PixHaven's taken out). */
export function syncGroupLinks(root: string, removeAll = false): void {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(path.join(root, '.clearup'))) return;     // never sorted: nothing of ours in it
  try {
    const r = syncShortcuts(root, links, removeAll);
    if (r.made || r.removed) log('info', `Group photo shortcuts in ${root}: ${r.made} made, ${r.removed} removed`);
  } catch (e) { log('warn', `Could not update group photo shortcuts in ${root}`, e); }
}

/** After files were renamed or moved in the app: the sorted folders they were in or went to. */
export function syncGroupLinksFor(paths: string[]): void {
  const roots = new Map<string, string>();
  for (const p of paths) { const r = manifestRootOf(p); if (r) roots.set(r.toLowerCase(), r); }
  for (const r of roots.values()) syncGroupLinks(r);
}
