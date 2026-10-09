// The app was called ClearUp until 0.6.0. Its data (settings, labels and stars, backups, face data, thumbnails, the
// watched-folder index) moves once from %APPDATA%\ClearUp to %APPDATA%\PixHaven, before anything opens it.
// Whatever can't be moved (e.g. the old version is still running) stays where it was. No Electron imports.
import fs from 'node:fs';
import path from 'node:path';

export interface MoveResult { moved: boolean; left: string[]; error?: string }

export function moveAppData(old: string, now: string): MoveResult {
  const res: MoveResult = { moved: false, left: [] };
  if (path.resolve(now).toLowerCase() === path.resolve(old).toLowerCase() || !fs.existsSync(old)) return res;
  if (fs.existsSync(path.join(now, 'settings.json')) || fs.existsSync(path.join(now, 'library.db'))) return res;   // already moved
  try {
    if (!fs.existsSync(now)) fs.renameSync(old, now);
    else {
      // The new folder has no settings or library yet, so whatever is in it (caches Electron made, a self-test's
      // scratch data) is disposable: the old data takes its place.
      for (const e of fs.readdirSync(old)) {
        const to = path.join(now, e);
        try {
          if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
          fs.renameSync(path.join(old, e), to);
        } catch { res.left.push(e); }
      }
      if (!res.left.length) fs.rmSync(old, { recursive: true, force: true });
    }
    res.moved = true;
  } catch (e) { res.error = (e as Error).message; }
  return res;
}
