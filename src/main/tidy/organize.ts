// "Sort by date or place": a move plan into Year / Month or Country / City folders. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import type { SortOp, SortPlan, SortTarget } from '../../shared/types';
import { safeFolderName, uniqueIn } from '../sorter/plan';
import type { Places } from './geo';

export interface OrganizeOptions {
  by: 'date' | 'place';
  depth: 'year' | 'month' | 'country' | 'city';
  useFileDate: boolean;      // no camera date → use the file's modified date
  unknownFolder: boolean;    // no date / no location → "Unknown date" / "Unknown place" folder (else it stays)
}
export interface OrganizeRow { id: number; path: string; size: number; taken: number | null; taken_src: string | null; lat: number | null; lon: number | null }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Folder path parts for one photo, or null when its date/place is unknown. */
export function folderFor(r: OrganizeRow, o: OrganizeOptions, places: Places | null): string[] | null {
  if (o.by === 'date') {
    if (r.taken == null || (r.taken_src === 'file' && !o.useFileDate)) return null;
    const d = new Date(r.taken); // wall-clock time stored in UTC fields
    const y = String(d.getUTCFullYear());
    return o.depth === 'year' ? [y] : [y, `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`];
  }
  if (r.lat == null || r.lon == null || !places) return null;
  const p = places.lookup(r.lat, r.lon);
  if (!p) return null;
  return o.depth === 'country' || !p.city ? [safeFolderName(p.country)] : [safeFolderName(p.country), safeFolderName(p.city)];
}

export function buildOrganizePlan(fid: number, root: string, rows: OrganizeRow[], o: OrganizeOptions, places: Places | null, freeBytes: number | null): SortPlan {
  const unknown = o.by === 'date' ? 'Unknown date' : 'Unknown place';
  const taken = new Map<string, Set<string>>();
  const targets = new Map<string, SortTarget>();
  const ops: SortOp[] = [];
  const stays: SortPlan['stays'] = [];
  for (const r of rows) {
    const parts = folderFor(r, o, places);
    if (!parts && !o.unknownFolder) { stays.push({ path: r.path, reason: o.by === 'date' ? 'No date found' : 'No location in photo' }); continue; }
    const dir = path.join(root, ...(parts ?? [unknown]));
    if (path.dirname(r.path).toLowerCase() === dir.toLowerCase()) continue; // already in the right folder
    if (!targets.has(dir.toLowerCase())) targets.set(dir.toLowerCase(), { key: dir, label: path.relative(root, dir), dir, exists: fs.existsSync(dir), personId: null });
    ops.push({ kind: 'move', pass: 1, from: r.path, to: uniqueIn(dir, path.basename(r.path), taken), personId: null, bytes: r.size });
  }
  const list = [...targets.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  const mkdirs: SortOp[] = list.filter(t => !t.exists).map(t => ({ kind: 'mkdir', pass: 0, to: t.dir, personId: null }));
  return {
    folderId: fid, root, targets: list, ops: [...mkdirs, ...ops], stays,
    counts: { folders: mkdirs.length, moves: ops.length, copies: 0, groupMoves: 0, stays: stays.length },
    copyBytes: 0, freeBytes,
  };
}

/** Duplicates / blurry: move the chosen photos into one review folder (undoable, like every other sort). */
export function buildSetAsidePlan(fid: number, root: string, files: { path: string; size: number }[], folderName: string, freeBytes: number | null): SortPlan {
  const dir = path.join(root, folderName);
  const taken = new Map<string, Set<string>>();
  const ops: SortOp[] = files
    .filter(f => path.dirname(f.path).toLowerCase() !== dir.toLowerCase())
    .map(f => ({ kind: 'move', pass: 1, from: f.path, to: uniqueIn(dir, path.basename(f.path), taken), personId: null, bytes: f.size }));
  const exists = fs.existsSync(dir);
  return {
    folderId: fid, root, targets: [{ key: dir, label: folderName, dir, exists, personId: null }],
    ops: [...(exists || !ops.length ? [] : [{ kind: 'mkdir' as const, pass: 0 as const, to: dir, personId: null }]), ...ops], stays: [],
    counts: { folders: exists ? 0 : 1, moves: ops.length, copies: 0, groupMoves: 0, stays: 0 },
    copyBytes: 0, freeBytes,
  };
}
