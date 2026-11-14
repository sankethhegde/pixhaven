// 1.0.7: Attic inside PixHaven — the connection (kept encrypted with Windows' own protection), the Attic tab's
// listings, Attic videos for the Videos tab, the player and thumbnails reading Attic files over the home network,
// and copying or moving between this PC and Attic (labels and stars follow; a move removes the original only once
// the copy is complete and the same size: on this PC to the Recycle Bin, on Attic to Attic's 30-day trash).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, safeStorage, shell } from 'electron';
import type { AtticListing, AtticShareInfo, AtticStatus, AtticTransfer, MediaEntry } from '@shared/types';
import { mediaKind } from '@shared/types';
import { log } from './logger';
import { AtticClient, AtticError, atticPath, findServers, isAttic, parseAttic, type AtticConn, type AtticEntry } from './attic/client';
import { setInputResolver } from './library/ffmpeg';
import { setRemoteReader } from './library/thumbs';
import { tagStore } from './tags-service';
import { freeName } from './library/file-ops';

const file = () => path.join(app.getPath('userData'), 'attic.json');
let client: AtticClient | null = null;
let last: AtticStatus = { state: 'none' };
let onStatus: (s: AtticStatus) => void = () => {};
let onTransfer: (t: AtticTransfer) => void = () => {};
export function setHooks(status: (s: AtticStatus) => void, transfer: (t: AtticTransfer) => void) { onStatus = status; onTransfer = transfer; }

// ---------- the saved connection (address, pairing and session tokens; never the password) ----------
function load(): AtticConn | null {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const text = j.enc && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(j.enc, 'base64')) : j.plain ? JSON.stringify(j.plain) : null;
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}
function save(c: AtticConn | null) {
  if (!c) { fs.rmSync(file(), { force: true }); return; }
  const data = safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(JSON.stringify(c)).toString('base64') } : { plain: c };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data));
}
const use = (c: AtticConn) => { client = new AtticClient(c, save); save(c); return client; };
const need = () => { if (!client) throw new AtticError(0, 'NONE', 'Attic is not set up in PixHaven yet.'); return client; };

export function init(): void {
  const c = load();
  if (c) client = new AtticClient(c, save);
  // FFmpeg and FFprobe read Attic files straight from Attic, signed in with the session cookie.
  setInputResolver(f => {
    if (!isAttic(f) || !client) return null;
    const { share, rel } = parseAttic(f);
    return ['-headers', `Cookie: ${client.cookie()}\r\n`, '-i', client.fileUrl(share, rel)];
  });
  setRemoteReader(f => {
    if (!isAttic(f)) return null;
    const { share, rel } = parseAttic(f);
    return need().read(share, rel);
  });
  setInterval(() => { if (client) void status(); }, 30_000).unref();
}

// ---------- status, finding, pairing, signing in ----------
function changed(s: AtticStatus): AtticStatus {
  const was = JSON.stringify(last);
  last = s;
  if (JSON.stringify(s) !== was) onStatus(s);
  return s;
}
export const current = () => last;
export async function status(): Promise<AtticStatus> {
  if (!client) return changed({ state: 'none' });
  const c = client.conn;
  const where = { name: c.name, address: c.address, port: c.port };
  try {
    const hello = await client.hello();
    if (c.serverId && hello.serverId !== c.serverId) return changed({ state: 'offline', ...where, error: `Another Attic answers at ${c.address}. Find Attic again.` });
    const p = await client.pairing();
    if (p.required && !p.paired) return changed({ state: 'unpaired', ...where });
    const who = await client.whoami();
    if (!who) return changed({ state: 'signed-out', ...where });
    return changed({ state: 'connected', ...where, account: { displayName: who.displayName, username: who.username, type: who.type } });
  } catch (e) {
    return changed({ state: 'offline', ...where, error: (e as Error).message });
  }
}
/** Attic servers on this network, plus the one set up before if it answers. */
export async function find() {
  const list = await findServers(1500);
  return list.map(s => ({ name: s.name, address: s.address, port: s.port, serverId: s.serverId }));
}
/** Use the Attic at this address (from Find, or typed: "192.168.1.200" or "192.168.1.200:8080"). */
export async function connect(address: string, port = 8080): Promise<AtticStatus> {
  const m = /^\s*([^\s:/]+)(?::(\d+))?\s*$/.exec(address);
  if (!m) throw new Error('Type the HP\'s address, like 192.168.1.200.');
  const probe = new AtticClient({ address: m[1], port: m[2] ? Number(m[2]) : port });
  const hello = await probe.hello().catch(() => { throw new Error(`Nothing answers at ${m[1]}. Is Attic running on the HP, and is this PC on the same Wi-Fi?`); });
  if (hello?.app !== 'Attic') throw new Error(`What answers at ${m[1]} is not Attic.`);
  const old = client?.conn;
  const same = old?.serverId === hello.serverId;
  use({ address: probe.conn.address, port: probe.conn.port, serverId: hello.serverId, name: hello.name, device: same ? old?.device : undefined, session: same ? old?.session : undefined });
  log('info', `Attic: using ${hello.name} at ${probe.conn.address}:${probe.conn.port}`);
  return status();
}
export async function pair(code: string): Promise<AtticStatus> {
  await need().claim(code, `PixHaven on ${os.hostname()}`);
  log('info', 'Attic: paired');
  return status();
}
/** The password goes to Attic once; PixHaven keeps only the session Attic gives back (30 days, renewed by use). */
export async function signIn(username: string, password: string, master: boolean): Promise<AtticStatus> {
  await need().signIn(username, password, master);
  log('info', `Attic: signed in as ${username}`);
  return status();
}
export async function signOut(): Promise<AtticStatus> { await need().signOut().catch(() => {}); return status(); }
/** Forget Attic on this PC (the pairing stays listed in Attic Hub until it is removed there). */
export function forget(): AtticStatus { client = null; save(null); return changed({ state: 'none' }); }

// ---------- browsing ----------
const entryPath = (e: AtticEntry) => atticPath(e.share, e.path ? `${e.path}/${e.name}` : e.name);
const toEntry = (e: AtticEntry): MediaEntry | null => {
  const kind = e.kind === 'folder' ? 'folder' : mediaKind(e.name);
  return kind ? { name: e.name, path: entryPath(e), kind, size: e.size, mtime: Date.parse(e.modifiedAt) || 0 } : null;
};
export async function shares(): Promise<AtticShareInfo[]> {
  return (await need().shares()).map(s => ({ id: s.id, name: s.name, path: atticPath(s.id, '') }));
}
/** A folder on Attic: its folders, photos and videos (other files are counted, not shown — like the Library). */
export async function list(p: string): Promise<AtticListing> {
  const { share, rel } = parseAttic(p);
  const r = await need().folder(share, rel);
  const entries = r.items.map(toEntry).filter((e): e is MediaEntry => !!e);
  return { share, path: atticPath(share, r.path), entries, otherFiles: r.items.length - entries.length };
}
let videoCache: { at: number; list: MediaEntry[] } | null = null;
/** Every video on Attic the account can see (its index), for the Videos tab. Kept for a minute. */
export async function videos(fresh = false): Promise<MediaEntry[]> {
  if (!client || last.state !== 'connected') return [];
  if (!fresh && videoCache && Date.now() - videoCache.at < 60_000) return videoCache.list;
  const idx = await need().index(fresh);
  const list = idx.entries.filter(e => mediaKind(e.name) === 'video').map(toEntry).filter((e): e is MediaEntry => !!e);
  videoCache = { at: Date.now(), list };
  return list;
}
const forgetVideos = () => { videoCache = null; };

// ---------- changes on Attic ----------
export async function newFolder(parent: string, name: string): Promise<string> {
  const { share, rel } = parseAttic(parent);
  const r = await need().makeFolder(share, rel, name);
  return atticPath(share, r.path);
}
/** Rename, or move into another Attic folder. Labels and stars follow. */
export async function move(p: string, toFolder: string, name?: string): Promise<string> {
  const from = parseAttic(p), to = parseAttic(toFolder);
  const r = await need().move(from.share, from.rel, { share: to.share, folder: to.rel, name });
  const now = atticPath(r.share, r.path);
  const s = tagStore();
  s.moved(p, now); s.movedTree(p, now);
  forgetVideos();
  return now;
}
/** To Attic's trash (30 days). Labels and stars of what went are let go. */
export async function trash(paths: string[]): Promise<{ done: string[]; failed: { path: string; reason: string }[] }> {
  const done: string[] = [], failed: { path: string; reason: string }[] = [];
  for (const p of paths) {
    const { share, rel } = parseAttic(p);
    try { await need().trash(share, rel); done.push(p); } catch (e) { failed.push({ path: p, reason: (e as Error).message }); }
  }
  forgetVideos();
  return { done, failed };
}

// ---------- the player and the viewer ----------
const MIME: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', '3gp': 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' };
/** clearup://media/attic… and clearup://img/attic…: the file from Attic, byte ranges passed through (seeking). */
export async function serve(req: Request, p: string): Promise<Response> {
  if (!client) return new Response('Not found', { status: 404 });
  const { share, rel } = parseAttic(p);
  const res = await client.stream(share, rel, req.headers.get('range')).catch(() => null);
  if (!res || !res.ok || !res.body) return new Response('Not found', { status: res?.status === 416 ? 416 : 404 });
  const h = new Headers({ 'Content-Type': MIME[path.extname(rel).slice(1).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' });
  for (const k of ['content-length', 'content-range']) { const v = res.headers.get(k); if (v) h.set(k, v); }
  return new Response(res.body, { status: res.status, headers: h });
}
/** For the details card: size and date from Attic, and the start of a photo in a temp file (EXIF). */
export function remoteFor(p: string) {
  if (!isAttic(p) || !client) return null;
  const { share, rel } = parseAttic(p);
  return {
    stat: async () => {
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const e = (await need().folder(share, dir)).items.find(i => i.name === rel.split('/').pop());
      if (!e) throw new Error('This file is no longer on Attic.');
      return { size: e.size, mtimeMs: Date.parse(e.modifiedAt) || 0 };
    },
    head: async () => {
      const tmp = path.join(os.tmpdir(), `pixhaven-attic-${crypto.randomBytes(6).toString('hex')}${path.extname(rel)}`);
      fs.writeFileSync(tmp, await need().read(share, rel, [0, 1024 * 1024 - 1]));
      return tmp;
    },
  };
}

// ---------- between this PC and Attic ----------
/** The original on this PC after a move: to the Recycle Bin (tests: PIXHAVEN_TEST_TRASH, so the real one is not touched). */
async function toRecycleBin(p: string): Promise<void> {
  const dir = process.env.PIXHAVEN_TEST_TRASH;
  if (!dir) return shell.trashItem(p);
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(p, freeName(path.join(dir, path.basename(p)), fs.statSync(p).isDirectory()));
}
/** A copy gets the original's stars and labels. */
async function copyTags(from: string, to: { path: string; size: number; mtime: number }): Promise<void> {
  const s = tagStore();
  const t = s.tagsFor([from])[from];
  if (!t || (!t.stars && !t.labels.length)) return;
  if (t.stars) await s.setStars([to], t.stars);
  const names = new Map(s.labels().map(l => [l.id, l.name]));
  for (const id of t.labels) { const n = names.get(id); if (n) await s.addLabel([to], n); }
}
const SKIP = /^(desktop\.ini|thumbs\.db|\.ds_store)$/i;
const jobs = new Map<string, AtticTransfer>();
function report(t: AtticTransfer) { onTransfer({ ...t, failed: [...t.failed], moved: [...t.moved] }); }

/** Files and folders from this PC into an Attic folder. Move: each original goes to the Recycle Bin once its copy on
 * Attic is complete and the same size; a folder only when everything in it arrived. */
export function toAttic(paths: string[], dest: string, moveIt: boolean): string {
  const c = need();
  const d = parseAttic(dest);
  const id = crypto.randomUUID();
  const t: AtticTransfer = { id, kind: 'to-attic', move: moveIt, files: 0, done: 0, bytes: 0, totalBytes: 0, current: null, finished: false, failed: [], moved: [] };
  jobs.set(id, t);
  const walk = (p: string): { file: string; size: number }[] => {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return SKIP.test(path.basename(p)) ? [] : [{ file: p, size: st.size }];
    return fs.readdirSync(p).flatMap(n => walk(path.join(p, n)));
  };
  void (async () => {
    try {
      for (const p of paths) for (const f of walk(p)) { t.files++; t.totalBytes += f.size; }
      report(t);
      let tick = 0;
      const sendOne = async (local: string, folderRel: string): Promise<boolean> => {
        const size = fs.statSync(local).size;
        t.current = path.basename(local);
        try {
          const e = await c.upload(local, d.share, folderRel, n => { t.bytes += n; if (Date.now() - tick > 250) { tick = Date.now(); report(t); } });
          if (e.size !== size) throw new Error(`Only ${e.size} of ${size} bytes arrived.`);
          const there = entryPath(e);
          t.done++;
          if (moveIt) { tagStore().moved(local, there); await toRecycleBin(local); t.moved.push({ from: local, to: there }); }
          else await copyTags(local, { path: there, size: e.size, mtime: Date.parse(e.modifiedAt) || Date.now() });
          return true;
        } catch (e) { t.failed.push({ path: local, reason: (e as Error).message }); return false; }
      };
      const sendFolder = async (dir: string, parentRel: string): Promise<boolean> => {
        const made = await c.makeFolder(d.share, parentRel, path.basename(dir));
        let all = true;
        for (const n of fs.readdirSync(dir)) {
          const p = path.join(dir, n);
          if (fs.statSync(p).isDirectory()) all = (await sendFolder(p, made.path)) && all;
          else if (!SKIP.test(n)) all = (await sendOne(p, made.path)) && all;
        }
        if (moveIt && all) await toRecycleBin(dir).catch(() => {});
        return all;
      };
      for (const p of paths) {
        if (fs.statSync(p).isDirectory()) await sendFolder(p, d.rel); else await sendOne(p, d.rel);
      }
    } catch (e) { t.failed.push({ path: dest, reason: (e as Error).message }); }
    t.finished = true; t.current = null;
    forgetVideos();
    log('info', `Attic: ${moveIt ? 'moved' : 'copied'} ${t.done} of ${t.files} file(s) to ${dest}${t.failed.length ? `, ${t.failed.length} failed` : ''}`);
    report(t);
  })();
  return id;
}

/** Files and folders from Attic into a folder on this PC (never overwriting: "clip (2).mp4"). Move: each one goes
 * to Attic's trash once its copy here is complete and the same size; a folder only when everything in it arrived. */
export function fromAttic(items: { path: string; kind: string; size: number }[], dest: string, moveIt: boolean): string {
  const c = need();
  const id = crypto.randomUUID();
  const t: AtticTransfer = { id, kind: 'from-attic', move: moveIt, files: 0, done: 0, bytes: 0, totalBytes: 0, current: null, finished: false, failed: [], moved: [] };
  jobs.set(id, t);
  const tree = async (p: string): Promise<{ path: string; size: number }[]> => {
    const { share, rel } = parseAttic(p);
    const r = await c.folder(share, rel);
    const out: { path: string; size: number }[] = [];
    for (const e of r.items) { if (e.kind === 'folder') out.push(...await tree(entryPath(e))); else out.push({ path: entryPath(e), size: e.size }); }
    return out;
  };
  void (async () => {
    try {
      for (const it of items) {
        if (it.kind === 'folder') for (const f of await tree(it.path)) { t.files++; t.totalBytes += f.size; }
        else { t.files++; t.totalBytes += it.size; }
      }
      report(t);
      let tick = 0;
      const getOne = async (p: string, size: number, dir: string): Promise<boolean> => {
        const { share, rel } = parseAttic(p);
        const to = freeName(path.join(dir, rel.split('/').pop()!));
        t.current = path.basename(to);
        try {
          const n = await c.download(share, rel, to, b => { t.bytes += b; if (Date.now() - tick > 250) { tick = Date.now(); report(t); } });
          if (n !== size) { fs.rmSync(to, { force: true }); throw new Error(`Only ${n} of ${size} bytes arrived.`); }
          t.done++;
          if (moveIt) { await c.trash(share, rel); tagStore().moved(p, to); t.moved.push({ from: p, to }); }
          else { const st = fs.statSync(to); await copyTags(p, { path: to, size: st.size, mtime: st.mtimeMs }); }
          return true;
        } catch (e) { t.failed.push({ path: p, reason: (e as Error).message }); return false; }
      };
      const getFolder = async (p: string, dir: string): Promise<boolean> => {
        const { share, rel } = parseAttic(p);
        const local = freeName(path.join(dir, rel.split('/').pop()!), true);
        fs.mkdirSync(local, { recursive: true });
        const r = await c.folder(share, rel);
        let all = true;
        for (const e of r.items) all = (e.kind === 'folder' ? await getFolder(entryPath(e), local) : await getOne(entryPath(e), e.size, local)) && all;
        if (moveIt && all) await c.trash(share, rel).catch(() => {});
        return all;
      };
      for (const it of items) { if (it.kind === 'folder') await getFolder(it.path, dest); else await getOne(it.path, it.size, dest); }
    } catch (e) { t.failed.push({ path: dest, reason: (e as Error).message }); }
    t.finished = true; t.current = null;
    forgetVideos();
    log('info', `Attic: ${moveIt ? 'moved' : 'copied'} ${t.done} of ${t.files} file(s) to ${dest}${t.failed.length ? `, ${t.failed.length} failed` : ''}`);
    report(t);
  })();
  return id;
}
