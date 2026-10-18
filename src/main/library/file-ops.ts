// v2.5 Photos tab: copy, move (cut/paste), new folder and rename for files and folders. Never overwrites: a name that is
// taken gets " (2)". Moves across drives copy, check and then remove. An .xmp sidecar travels with its photo.
// `onMoved` hears every file that moved (also the ones inside a moved folder), so labels, the people list and face
// data can follow. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';
import { writeTarget } from './xmp';

export interface OpResult { done: { from: string; to: string }[]; failed: { path: string; reason: string }[] }
/** Files that moved; `dir` when a whole folder moved or was renamed (folder names in the people list follow). */
export type MovedHook = (pairs: { from: string; to: string }[], dir?: { from: string; to: string }) => Promise<void> | void;

const BAD_NAME = /[<>:"/\\|?*\x00-\x1f]|^\.+$|[. ]$/;
const key = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const isInside = (p: string, dir: string) => key(p) === key(dir) || key(p).startsWith(key(dir) + path.sep);

export function checkName(name: string): string {
  const n = name.trim();
  if (!n || BAD_NAME.test(n)) throw new Error('That name has characters Windows does not allow (< > : " / \\ | ? *).');
  return n;
}

/** "beach.jpg" → "beach (2).jpg"; folders → "Trip (2)". */
export function freeName(p: string, isDir = false): string {
  if (!fs.existsSync(p)) return p;
  const ext = isDir ? '' : path.extname(p), stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) { const c = `${stem} (${i})${ext}`; if (!fs.existsSync(c)) return c; }
}

/** Every file below a folder, as paths relative to it. */
function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name));
      else out.push(path.join(rel, e.name));
    }
  };
  walk(dir, '');
  return out;
}

async function sidecar(from: string, to: string, move: boolean): Promise<void> {
  const a = writeTarget(from), b = writeTarget(to);
  if (!a.sidecar || !fs.existsSync(a.target) || fs.existsSync(b.target)) return;
  await fs.promises.copyFile(a.target, b.target, fs.constants.COPYFILE_EXCL).catch(() => {});
  if (move) await fs.promises.rm(a.target, { force: true }).catch(() => {});
}

async function moveOne(from: string, to: string, isDir: boolean): Promise<void> {
  try { await fs.promises.rename(from, to); return; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; }
  // Another drive: copy everything, check the sizes, then remove the original.
  if (isDir) {
    await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    const a = filesIn(from), b = new Set(filesIn(to));
    if (a.some(f => !b.has(f) || fs.statSync(path.join(from, f)).size !== fs.statSync(path.join(to, f)).size)) {
      await fs.promises.rm(to, { recursive: true, force: true });
      throw new Error('The copy on the other drive did not match, so nothing was moved');
    }
    await fs.promises.rm(from, { recursive: true });
  } else {
    await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    const st = await fs.promises.stat(from);
    if ((await fs.promises.stat(to)).size !== st.size) { await fs.promises.rm(to, { force: true }); throw new Error('The copy did not match'); }
    await fs.promises.utimes(to, st.atime, st.mtime).catch(() => {});
    await fs.promises.rm(from);
  }
}

/** Paste: copy or move files and folders into `dest`. */
export async function pasteItems(paths: string[], dest: string, mode: 'copy' | 'move', onMoved: MovedHook): Promise<OpResult> {
  const res: OpResult = { done: [], failed: [] };
  if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) throw new Error('The folder to paste into is not there any more.');
  for (const from of paths) {
    try {
      const st = await fs.promises.stat(from).catch(() => null);
      if (!st) throw new Error('It is not there any more');
      const isDir = st.isDirectory();
      if (isDir && isInside(dest, from)) throw new Error('A folder cannot go inside itself');
      if (mode === 'move' && key(path.dirname(from)) === key(dest)) continue;     // already here
      const to = freeName(path.join(dest, path.basename(from)), isDir);
      if (mode === 'move') {
        const inside = isDir ? filesIn(from) : [];
        await moveOne(from, to, isDir);
        if (!isDir) await sidecar(from, to, true);
        await onMoved(isDir ? inside.map(f => ({ from: path.join(from, f), to: path.join(to, f) })) : [{ from, to }], isDir ? { from, to } : undefined);
      } else if (isDir) {
        await fs.promises.cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      } else {
        await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        await fs.promises.utimes(to, st.atime, st.mtime).catch(() => {});
        await sidecar(from, to, false);
      }
      res.done.push({ from, to });
    } catch (e) { res.failed.push({ path: from, reason: (e as Error).message }); }
  }
  return res;
}

export function newFolder(parent: string, name: string): string {
  const p = freeName(path.join(parent, checkName(name)), true);
  fs.mkdirSync(p);
  return p;
}

/** Rename a folder (files: see tags-service renameFile, which keeps the file type). */
export async function renameFolder(from: string, name: string, onMoved: MovedHook): Promise<string> {
  const to = path.join(path.dirname(from), checkName(name));
  if (to === from) return to;
  if (key(to) !== key(from) && fs.existsSync(to)) throw new Error(`There is already something called "${name.trim()}" here.`);
  const inside = filesIn(from);
  await fs.promises.rename(from, to);
  await onMoved(inside.map(f => ({ from: path.join(from, f), to: path.join(to, f) })), { from, to });
  return to;
}
