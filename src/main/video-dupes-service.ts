// 1.1.0 Duplicate videos (Tidy up): every video in the watched folders is fingerprinted once (kept until the file
// changes), then the same videos (exact copies, renamed, another quality), longer versions and overlapping parts are
// found. Nothing happens until you apply your choices: copies are moved into "Removed duplicates" at the top of their
// drive (their folders kept), overlapping parts are put together first; stars, labels and the place a video was left
// go to the copy that stays.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app } from 'electron';
import type { DupeApplyProgress, DupeApplyResult, DupeChoices, DupeScanState, DupeVideo } from '@shared/types';
import type { FileRef } from './library/tags';
import { REMOVED_DUPLICATES } from '@shared/types';
import { fingerprint, fileHash, refineCut } from './dupes/fingerprint';
import { findPairs, planDupes, type Fingerprint } from './dupes/video-match';
import { allVideos } from './watch-service';
import { videos as atticVideos, move as atticMove, newFolder as atticNewFolder } from './attic-service';
import type { MediaEntry } from '@shared/types';
import * as tags from './tags-service';
import { combineParts } from './convert-service';
import { queue } from './queue';
import { log } from './logger';

const IS_WIN = process.platform === 'win32';
const isAttic = (p: string) => p.startsWith('attic://');
/** Inside a "Removed duplicates" folder (on Attic its index still lists them). */
const inRemoved = (p: string) => p.split(/[\\/]/).some(seg => seg.toLowerCase() === REMOVED_DUPLICATES.toLowerCase());
const key = (p: string) => (IS_WIN ? p.toLowerCase() : p);
const empty = (): DupeScanState => ({ state: 'idle', done: 0, total: 0, same: [], longer: [], combine: [] });
let state: DupeScanState = empty();
let db: DatabaseSync | null = null;
let stopScan: (() => void) | null = null;

const stateFile = () => path.join(app.getPath('userData'), 'video-dupes.json');
function store(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(path.join(app.getPath('userData'), 'video-dupes.db'));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS fp2 (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, duration REAL, width INTEGER, height INTEGER,
      hashes BLOB, centre BLOB, mirror BLOB, blank BLOB, error TEXT);
    CREATE TABLE IF NOT EXISTS sha (path TEXT PRIMARY KEY, size INTEGER, mtime INTEGER, hash TEXT);`);
  return db;
}

/** The last results (also after a restart), or where the check is. */
export function status(): DupeScanState {
  if (state.state === 'idle') {
    try { state = { ...empty(), ...JSON.parse(fs.readFileSync(stateFile(), 'utf8')) }; } catch { /* none yet */ }
    if (state.state === 'scanning' || state.state === 'matching') state.state = 'idle';
  }
  return state;
}
function save() { try { fs.writeFileSync(stateFile(), JSON.stringify(state)); } catch { /* not kept */ } }

type Row = { path: string; size: number; mtime: number; duration: number; width: number; height: number; hashes: Uint8Array | null; centre: Uint8Array | null; mirror: Uint8Array | null; blank: Uint8Array | null; error: string | null };
const u32 = (h: Uint8Array) => new Uint32Array(h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength));
const bytes = (h: Uint32Array) => new Uint8Array(h.buffer, h.byteOffset, h.byteLength);
const toFp = (r: Row): Fingerprint => {
  return { path: r.path, size: r.size, mtime: r.mtime, duration: r.duration, width: r.width, height: r.height,
    hashes: u32(r.hashes!), centre: u32(r.centre!), mirror: u32(r.mirror!), blank: new Uint8Array(r.blank!) };
};

/** Checks every video (new and changed ones are read; the rest come from before), then finds the duplicates. */
export function scan(send: (s: DupeScanState) => void): void {
  if (state.state === 'scanning' || state.state === 'matching') return;
  let cancelled = false;
  const kills = new Set<{ kill?: () => void }>();
  stopScan = () => { cancelled = true; for (const k of kills) k.kill?.(); };
  state = { ...state, state: 'scanning', done: 0, total: 0, current: undefined, error: undefined };
  send(state);
  queue.add('scan', 'Duplicate videos: check videos', async () => {
    try {
      const d = store();
      const attic = await atticVideos().catch(() => [] as MediaEntry[]);
      const videos = [...allVideos(), ...attic.filter(v => !inRemoved(v.path))];
      const get = d.prepare('SELECT size, mtime, error FROM fp2 WHERE path = ?');
      const todo = videos.filter(v => { const r = get.get(v.path) as { size: number; mtime: number } | undefined; return !r || r.size !== v.size || r.mtime !== Math.floor(v.mtime); });
      state = { ...state, total: todo.length, done: 0 };
      send(state);
      const put = d.prepare('INSERT OR REPLACE INTO fp2 (path, size, mtime, duration, width, height, hashes, centre, mirror, blank, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      let next = 0, last = 0;
      const t0 = Date.now();
      const worker = async () => {
        while (!cancelled && next < todo.length) {
          const v = todo[next++];
          const signal: { kill?: () => void } = {};
          kills.add(signal);
          try {
            const f = await fingerprint(v.path, signal, isAttic(v.path) ? { size: v.size, mtime: v.mtime } : undefined);
            put.run(v.path, v.size, Math.floor(v.mtime), f.duration, f.width, f.height, bytes(f.hashes), bytes(f.centre), bytes(f.mirror), f.blank, null);
          } catch (e) {
            if (!cancelled) put.run(v.path, v.size, Math.floor(v.mtime), 0, 0, 0, null, null, null, null, String((e as Error).message).slice(0, 300));
          } finally { kills.delete(signal); }
          state.done++;
          if (Date.now() - last > 300) { last = Date.now(); send({ ...state, current: v.name }); }
        }
      };
      await Promise.all([worker(), worker()]);
      if (cancelled) { state = { ...state, state: 'cancelled', current: undefined }; send(state); return; }
      if (todo.length) log('info', `Duplicate videos: read ${todo.length} video(s) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      state = { ...state, state: 'matching', current: undefined };
      send(state);
      await match(videos.map(v => v.path));
      send(state);
    } catch (e) {
      log('error', 'Duplicate videos', e);
      state = { ...state, state: 'error', error: (e as Error).message };
      send(state);
    } finally { stopScan = null; }
  }, () => stopScan?.());
}

export function cancel(): void { stopScan?.(); }

const video = (f: { path: string; size: number; mtime: number; duration: number; width: number; height: number }): DupeVideo =>
  ({ path: f.path, name: path.basename(f.path), size: f.size, mtime: f.mtime, duration: f.duration, width: f.width, height: f.height });

/** Finds the duplicates among these videos (fingerprints already read). */
async function match(paths: string[]): Promise<void> {
  const t0 = Date.now();
  const d = store();
  const want = new Set(paths.map(key));
  const rows = (d.prepare('SELECT * FROM fp2').all() as unknown as Row[]).filter(r => want.has(key(r.path)));
  const fps = rows.filter(r => !r.error && r.hashes && r.centre && (isAttic(r.path) || fs.existsSync(r.path))).map(toFp);
  // Exact copies: same size, then the same bytes (hashes kept until the file changes).
  const bySize = new Map<number, number[]>();
  fps.forEach((f, i) => bySize.set(f.size, [...(bySize.get(f.size) ?? []), i]));
  const getSha = d.prepare('SELECT size, mtime, hash FROM sha WHERE path = ?');
  const putSha = d.prepare('INSERT OR REPLACE INTO sha (path, size, mtime, hash) VALUES (?, ?, ?, ?)');
  const exact: [number, number][] = [];
  for (const g of bySize.values()) {
    if (g.length < 2 || g.some(i => isAttic(fps[i].path))) continue;   // Attic files would have to be downloaded: same picture is enough
    const h: string[] = [];
    for (const i of g) {
      const f = fps[i];
      const r = getSha.get(f.path) as { size: number; mtime: number; hash: string } | undefined;
      if (r && r.size === f.size && r.mtime === f.mtime) h.push(r.hash);
      else { const x = await fileHash(f.path).catch(() => `x${i}`); putSha.run(f.path, f.size, f.mtime, x); h.push(x); }
    }
    for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) if (h[x] === h[y]) exact.push([g[x], g[y]]);
  }
  const pairs = findPairs(fps);
  const plan = planDupes(fps, pairs, exact);
  state = {
    ...state, state: 'done', at: Date.now(), current: undefined, failed: rows.filter(r => r.error).length,
    same: plan.same.map((g, i) => ({ id: `s${i}`, videos: g.members.map(m => video(fps[m])), keep: g.keep === null ? null : fps[g.keep].path, exact: g.exact,
      notes: Object.fromEntries(Object.entries(g.notes).map(([m, n]) => [fps[Number(m)].path, n])) })),
    longer: plan.longer.map((l, i) => ({ id: `l${i}`, longer: video(fps[l.longer]), shorter: video(fps[l.shorter]), at: l.at, how: l.how })),
    combine: plan.combine.map((c, i) => ({ id: `c${i}`, first: video(fps[c.first]), second: video(fps[c.second]), cut: c.cut, overlapSec: c.overlapSec })),
  };
  save();
  log('info', `Duplicate videos: ${fps.length} videos compared in ${Date.now() - t0} ms: ${state.same.length} same, ${state.longer.length} longer, ${state.combine.length} to combine`);
}

// ---------- applying ----------

/** Where a set-aside copy goes: "<drive>\Removed duplicates\<its folder>" (or beside it when the drive top is closed). */
export function removedDir(file: string): string {
  // Tests set CLEARUP_REMOVED_ROOT so nothing is made at the top of a real drive.
  const root = process.env.CLEARUP_REMOVED_ROOT ?? path.parse(file).root;
  const rel = path.relative(path.parse(file).root, path.dirname(file));
  return path.join(root, REMOVED_DUPLICATES, rel);
}

const ref = async (p: string): Promise<FileRef | null> => {
  if (isAttic(p)) { const r = store().prepare('SELECT size, mtime FROM fp2 WHERE path = ?').get(p) as { size: number; mtime: number } | undefined; return r ? { path: p, size: r.size, mtime: r.mtime } : null; }
  const s = await fs.promises.stat(p).catch(() => null);
  return s ? { path: p, size: s.size, mtime: s.mtimeMs } : null;
};

/** An Attic copy is set aside on Attic: "attic://<share>/Removed duplicates/<its folder>" (made as needed). */
async function moveOnAttic(p: string): Promise<string> {
  const m = /^attic:\/\/([^/]+)\/(.*)$/.exec(p);
  if (!m) throw new Error('Not an Attic path');
  const folders = [REMOVED_DUPLICATES, ...m[2].split('/').slice(0, -1)];
  let at = `attic://${m[1]}`;
  for (const name of folders) {
    const next = `${at}/${name}`;
    await atticNewFolder(at, name).catch(() => { /* there already */ });
    at = next;
  }
  return atticMove(p, at);
}

/** Stars (the highest), labels (all of them) and the place it was left go from `from` to `to`. */
async function carryOver(from: string[], to: string): Promise<void> {
  const target = await ref(to);
  if (!target) return;
  const store_ = tags.tagStore();
  const t = store_.tagsFor([...from, to]);
  const names = new Map(tags.labels().map(l => [l.id, l]));
  const stars = Math.max(...[...from, to].map(p => t[p]?.stars ?? 0));
  if (stars > (t[to]?.stars ?? 0)) await tags.setStars([target], stars);
  const have = new Set(t[to]?.labels ?? []);
  for (const id of new Set(from.flatMap(p => t[p]?.labels ?? []))) {
    const l = names.get(id);
    if (l && !have.has(id)) await tags.addLabel([target], l.name, l.color ?? null);
  }
  const pos = store_.positions([to, ...from]);
  if (!pos[to]) {
    const best = from.map(p => pos[p]).filter(Boolean).sort((a, b) => b!.position - a!.position)[0];
    const dur = (store().prepare('SELECT duration FROM fp2 WHERE path = ?').get(to) as { duration: number } | undefined)?.duration ?? 0;
    if (best && dur && Math.abs(best.duration - dur) < 3) store_.savePosition(to, best.position, best.duration);
  }
}

let applying = false;
export function apply(choices: DupeChoices, send: (p: DupeApplyProgress) => void): Promise<DupeApplyResult> {
  if (applying) return Promise.reject(new Error('Already applying.'));
  applying = true;
  const res: DupeApplyResult = { moved: [], combined: [], failed: [], freed: 0 };
  const total = choices.combine.length + choices.remove.length;
  let done = 0;
  // Not a queue job itself: each combine is one (the queue runs one job at a time), moving files is quick.
  const run = async () => {
    const remove = [...choices.remove];
    // 1. Overlapping parts become one video; then both parts are set aside.
    for (const c of choices.combine) {
      const name = path.basename(c.first);
      send({ state: 'running', step: `Putting together ${name}`, done, total, percent: 0 });
      try {
        const dur = (store().prepare('SELECT duration FROM fp2 WHERE path = ?').get(c.first) as { duration: number } | undefined)?.duration ?? 0;
        const from = dur ? await refineCut(c.first, dur, c.second, c.cut) : c.cut;
        const r = await combineParts(c.first, c.second, from, p => { if (p.state === 'running') send({ state: 'running', step: `Putting together ${name}`, done, total, percent: p.percent }); }).done;
        const out = r.done[0]?.to;
        if (!out) throw new Error(r.failed[0]?.reason ?? 'Could not put the parts together');
        await carryOver([c.first, c.second], out);
        res.combined.push({ first: c.first, second: c.second, out });
        remove.push({ path: c.first, keptAs: out }, { path: c.second, keptAs: out });
        log('info', `Duplicate videos: combined ${c.first} + ${c.second} (from ${from.toFixed(2)} s) → ${out}`);
      } catch (e) {
        res.failed.push({ path: c.first, reason: (e as Error).message });
      }
      done++;
    }
    // 2. Copies are set aside (labels and stars first go to the one that stays).
    const seen = new Set<string>();
    for (const r of remove) {
      if (seen.has(key(r.path))) continue;
      seen.add(key(r.path));
      send({ state: 'running', step: `Moving ${path.basename(r.path)}`, done, total });
      try {
        const size = (await ref(r.path))?.size ?? 0;
        if (key(r.keptAs) !== key(r.path)) await carryOver([r.path], r.keptAs).catch(e => log('warn', 'Duplicate videos: labels not carried over', e));
        if (isAttic(r.path)) res.moved.push({ from: r.path, to: await moveOnAttic(r.path) });
        else {
          let dest = removedDir(r.path);
          try { fs.mkdirSync(dest, { recursive: true }); } catch { dest = path.join(path.dirname(r.path), REMOVED_DUPLICATES); fs.mkdirSync(dest, { recursive: true }); }
          const m = await tags.moveFiles([r.path], dest);
          if (m.failed.length) throw new Error(m.failed[0].reason);
          res.moved.push(...m.moved);
        }
        res.freed += size;
      } catch (e) {
        res.failed.push({ path: r.path, reason: (e as Error).message });
      }
      if (r.path) done = Math.min(total, done + (choices.remove.some(x => x.path === r.path) ? 1 : 0));
    }
    // What was done leaves the results.
    const gone = new Set(res.moved.map(m => key(m.from)));
    state = {
      ...state,
      same: state.same.map(g => ({ ...g, videos: g.videos.filter(v => !gone.has(key(v.path))) })).filter(g => g.videos.length > 1),
      longer: state.longer.filter(l => !gone.has(key(l.longer.path)) && !gone.has(key(l.shorter.path))),
      combine: state.combine.filter(c => !gone.has(key(c.first.path)) && !gone.has(key(c.second.path))),
    };
    save();
    send({ state: res.failed.length && !res.moved.length ? 'failed' : 'done', step: '', done: total, total });
    log('info', `Duplicate videos: moved ${res.moved.length}, combined ${res.combined.length}, failed ${res.failed.length}`);
  };
  return run().then(() => res).finally(() => { applying = false; });
}
