// Tidy up (Phase 5), main-process side: scan a folder for photo facts, find duplicates / blurry photos,
// and sort by date or place. Moves go through the same apply/undo machinery as Sort by person.
import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import type { ApplyResult, ScanProgress, SortHistory, SortPlan, TidyAction, TidyPhotoRef, TidyResults } from '@shared/types';
import { MATCH_DISTANCE } from '@shared/types';
import { folderId } from './db';
import { getSettings } from './settings';
import { resourcesDir } from './engine';
import { getDb, listImages, runWorker, sortDirs, cancelScan, type SortEvents } from './sort-service';
import { findDuplicates, findBlurry, type TidyPhoto } from './tidy/dupes';
import { buildOrganizePlan, buildSetAsidePlan } from './tidy/organize';
import { Places } from './tidy/geo';
import { fileUrl } from './upscale-job';
import { queue } from './queue';
import { log } from './logger';

export const SET_ASIDE: Record<'duplicates' | 'blurry', string> = { duplicates: 'PixHaven - Duplicates', blurry: 'PixHaven - Blurry' };

let places: Places | null = null;
const getPlaces = () => (places ??= Places.load(path.join(resourcesDir(), 'geo', 'places.json')));

const rootOf = (fid: number) => (getDb().prepare('SELECT path FROM folders WHERE id = ?').get(fid) as { path: string }).path;
const freeBytes = (root: string) => { try { const s = fs.statfsSync(root); return Number(s.bavail) * Number(s.bsize); } catch { return null; } };

/** Scan (or re-scan: only new/changed files are read) through the job queue. */
export function scanTidy(root: string, ev: Pick<SortEvents, 'scan'>): { queueId: string; done: Promise<{ folderId: number; cancelled?: boolean }> } {
  const fid = folderId(getDb(), root)!;
  let cancelled = false;
  const job = queue.add('scan', `Tidy up: scan ${path.basename(root)}`, async () => {
    if (cancelled) return;
    ev.scan({ folder: root, phase: 'listing', done: 0, total: 0, faces: 0, people: 0 });
    const files = await listImages(root, getSettings().tidy.includeSubfolders, sortDirs(fid));
    log('info', `Tidy scan ${root}: ${files.length} images`);
    const r = await runWorker({ task: 'inspect', folderId: fid, root, files, keepDirs: [] }, ev);
    cancelled = !!r?.cancelled;
  }, () => { cancelled = true; cancelScan(); });
  return { queueId: job.id, done: job.done.then(() => ({ folderId: fid, cancelled })) };
}

type Row = TidyPhoto & { thumb: string | null; taken: number | null; taken_src: string | null; lat: number | null; lon: number | null };
function rows(fid: number): Row[] {
  const dirs = sortDirs(fid).map(d => d.toLowerCase() + path.sep);
  return (getDb().prepare(`SELECT id, path, size, sha1, dhash, blur, width, height, thumb, taken, taken_src, lat, lon
    FROM photo_info WHERE folder_id = ? AND status = 'done' ORDER BY path`).all(fid) as unknown as Row[])
    .filter(r => fs.existsSync(r.path) && !dirs.some(d => r.path.toLowerCase().startsWith(d)));
}
const ref = (r: Row): TidyPhotoRef => ({ id: r.id, path: r.path, name: path.basename(r.path), size: r.size, width: r.width, height: r.height, blur: r.blur, thumbUrl: r.thumb ? fileUrl(r.thumb) : '' });

export function history(fid: number): SortHistory[] {
  return getDb().prepare("SELECT id, kind, created, state, summary FROM sorts WHERE folder_id = ? AND kind != 'people' ORDER BY id DESC LIMIT 10").all(fid) as unknown as SortHistory[];
}

export function tidyResults(fid: number): TidyResults {
  const s = getSettings().tidy;
  const all = rows(fid);
  const byId = new Map(all.map(r => [r.id, r]));
  const groups = findDuplicates(all, MATCH_DISTANCE[s.match]);
  const inGroups = new Set(groups.flatMap(g => g.photos.map(p => p.id)));
  const skipped = getDb().prepare("SELECT path, error FROM photo_info WHERE folder_id = ? AND status IN ('skipped', 'error') ORDER BY path").all(fid) as { path: string; error: string | null }[];
  return {
    folderId: fid, folder: rootOf(fid), scanned: all.length,
    skipped: skipped.map(x => ({ path: x.path, reason: x.error ?? 'Skipped' })),
    duplicates: groups.map(g => ({ kind: g.kind, keep: g.keep, photos: g.photos.map(p => ref(byId.get(p.id)!)) })),
    // A photo already offered as a duplicate isn't listed again as blurry.
    blurry: findBlurry(all.filter(r => !inGroups.has(r.id)), s.blurThreshold).map(p => ref(byId.get(p.id)!)),
    withDate: all.filter(r => r.taken_src === 'exif').length,
    withPlace: all.filter(r => r.lat != null).length,
    history: history(fid),
  };
}

const pending = new Map<number, { kind: TidyAction; plan: SortPlan }>();

/** Dry run for "sort by date or place". */
export function organizePlan(fid: number): SortPlan {
  const s = getSettings().tidy;
  const root = rootOf(fid);
  const plan = buildOrganizePlan(fid, root, rows(fid), {
    by: s.by, depth: s.by === 'date' ? s.dateDepth : s.placeDepth, useFileDate: s.useFileDate, unknownFolder: s.unknownFolder,
  }, s.by === 'place' ? getPlaces() : null, freeBytes(root));
  pending.set(fid, { kind: 'organize', plan });
  return plan;
}

/** Dry run for setting chosen duplicates / blurry photos aside in a review folder. */
export function setAsidePlan(fid: number, kind: 'duplicates' | 'blurry', ids: number[]): SortPlan {
  const root = rootOf(fid);
  const wanted = new Set(ids);
  const files = rows(fid).filter(r => wanted.has(r.id)).map(r => ({ path: r.path, size: r.size }));
  const plan = buildSetAsidePlan(fid, root, files, SET_ASIDE[kind], freeBytes(root));
  pending.set(fid, { kind, plan });
  return plan;
}

export function applyTidy(fid: number, ev: Pick<SortEvents, 'apply'>): Promise<ApplyResult> {
  const p = pending.get(fid);
  if (!p) throw new Error('Nothing to apply. Please preview again.');
  const d = getDb();
  if (d.prepare("SELECT 1 FROM sorts WHERE folder_id = ? AND state = 'applying'").get(fid)) throw new Error('An earlier action on this folder did not finish. Finish or undo it first.');
  pending.delete(fid);
  const sortId = Number(d.prepare("INSERT INTO sorts (folder_id, created, state, plan, kind) VALUES (?, ?, 'applying', ?, ?)").run(fid, Date.now(), JSON.stringify(p.plan), p.kind).lastInsertRowid);
  let result: ApplyResult | null = null;
  const label = p.kind === 'organize' ? 'sort by date/place' : `set aside ${p.kind}`;
  return queue.add('apply', `Tidy up: ${label} in ${path.basename(p.plan.root)}`, async () => {
    result = await runWorker({ task: 'apply', folderId: fid, root: p.plan.root, files: [], keepDirs: [], sortId, plan: p.plan }, ev);
  }, () => {}).done.then(() => result!);
}

/** Send photos to the Windows Recycle Bin (restorable from there; not tracked by PixHaven's Undo). */
export async function trashPhotos(fid: number, ids: number[]): Promise<{ trashed: number; failed: { path: string; reason: string }[] }> {
  const wanted = new Set(ids);
  const failed: { path: string; reason: string }[] = [];
  let trashed = 0;
  for (const r of rows(fid).filter(x => wanted.has(x.id))) {
    try { await shell.trashItem(r.path); getDb().prepare('DELETE FROM photo_info WHERE id = ?').run(r.id); trashed++; }
    catch (e) { failed.push({ path: r.path, reason: String((e as Error).message ?? e) }); }
  }
  log('info', `Recycle Bin: ${trashed} photos from ${rootOf(fid)}`);
  return { trashed, failed };
}

export const tidyStatus = (root: string) => {
  const fid = folderId(getDb(), root, false);
  if (fid == null) return { folderId: null, scanned: 0, history: [] as SortHistory[] };
  const scanned = (getDb().prepare("SELECT COUNT(*) AS n FROM photo_info WHERE folder_id = ? AND status = 'done'").get(fid) as { n: number }).n;
  return { folderId: fid, scanned, history: history(fid) };
};
