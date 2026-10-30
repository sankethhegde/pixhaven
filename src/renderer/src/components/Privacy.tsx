// v2.10 Hidden items in the window: the lock state for every screen (usePrivacy), one password dialog for all of them
// (<PrivacyHost/> in App, opened with askPassword), and hide / unhide helpers that ask for a password first when none
// is set. Hidden things are filtered in the main process; screens only list again when the state changes.
import { useEffect, useState } from 'react';
import type { PrivacyStatus } from '@shared/types';
import { api, errorText } from '../api';
import { Button, Icon } from './ui';
import * as T from '../tags';

let current: PrivacyStatus = { hasPassword: false, unlocked: true, items: 0, labels: 0 };
const subs = new Set<(s: PrivacyStatus) => void>();
const set = (s: PrivacyStatus) => {
  const was = current;
  current = s;
  for (const f of subs) f(s);
  // Labels, their files' tags and playlists differ when hidden ones come and go.
  if (was.unlocked !== s.unlocked || was.labels !== s.labels) { void T.reloadAll().catch(() => {}); void T.loadPlaylists().catch(() => {}); }
};
let started = false;
function start() {
  if (started) return;
  started = true;
  void api.privacy.status().then(set).catch(() => {});
  api.onPrivacy(set);
}

/** The lock state; screens list their files again when it changes (pass `privacy` in an effect's dependencies). */
export function usePrivacy(): PrivacyStatus {
  start();
  const [s, setS] = useState(current);
  useEffect(() => { subs.add(setS); setS(current); return () => { subs.delete(setS); }; }, []);
  return s;
}

// ---------- the password dialog ----------

type Mode = 'create' | 'unlock' | 'change' | 'remove';
let request: { mode: Mode; resolve: (ok: boolean) => void } | null = null;
let show: (r: typeof request) => void = () => {};
/** Opens the dialog; true when the password was set, accepted or removed. */
export function askPassword(mode: Mode): Promise<boolean> {
  return new Promise(resolve => { request?.resolve(false); request = { mode, resolve }; show(request); });
}

/** Hide or unhide paths (folders and files); a first password is made on the way when none is set. */
export async function hideItems(items: { path: string; folder: boolean }[], on: boolean): Promise<boolean> {
  if (on && !current.hasPassword && !(await askPassword('create'))) return false;
  set(await api.privacy.hide(items, on));
  return true;
}
export async function hideLabel(id: number, on: boolean): Promise<boolean> {
  if (on && !current.hasPassword && !(await askPassword('create'))) return false;
  set(await api.privacy.hideLabel(id, on));
  return true;
}
export async function toggleLock(): Promise<void> {
  if (current.unlocked) set(await api.privacy.lock());
  else await askPassword('unlock');
}

const TITLE: Record<Mode, string> = { create: 'Set a password for hidden items', unlock: 'Show hidden items', change: 'Change the password', remove: 'Remove the password' };

export function PrivacyHost() {
  const [req, setReq] = useState<typeof request>(null);
  const [pw, setPw] = useState(''), [next, setNext] = useState(''), [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { show = r => { setReq(r); setPw(''); setNext(''); setAgain(''); setError(null); }; return () => { show = () => {}; }; }, []);
  start();
  if (!req) return null;
  const close = (ok: boolean) => { req.resolve(ok); request = null; setReq(null); };
  const needsNew = req.mode === 'create' || req.mode === 'change';
  const needsOld = req.mode !== 'create';
  const submit = async () => {
    if (needsNew && next !== again) { setError('The two passwords are not the same.'); return; }
    setBusy(true); setError(null);
    try {
      if (req.mode === 'create') set(await api.privacy.setPassword(null, next));
      else if (req.mode === 'change') set(await api.privacy.setPassword(pw, next));
      else if (req.mode === 'unlock') set(await api.privacy.unlock(pw));
      else set(await api.privacy.removePassword(pw));
      close(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  const field = (label: string, v: string, onChange: (s: string) => void, auto = false) => (
    <input type="password" autoFocus={auto} value={v} placeholder={label} aria-label={label}
      onChange={e => { onChange(e.target.value); setError(null); }}
      onKeyDown={e => { if (e.key === 'Enter') void submit(); if (e.key === 'Escape') close(false); e.stopPropagation(); }}
      className="w-full h-9 rounded-lg bg-panel-2 border border-line px-3 text-sm outline-none focus:border-accent" />
  );
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center" onClick={() => close(false)}>
      <div className="w-[420px] rounded-2xl bg-panel border border-line shadow-2xl p-5 space-y-3" onClick={e => e.stopPropagation()} role="dialog" aria-label={TITLE[req.mode]}>
        <div className="flex items-center gap-2 font-semibold"><Icon name="lock" size={16} />{TITLE[req.mode]}</div>
        {needsOld && field(req.mode === 'unlock' ? 'Password' : 'Current password', pw, setPw, true)}
        {needsNew && field('New password', next, setNext, !needsOld)}
        {needsNew && field('New password again', again, setAgain)}
        <div className="text-xs text-muted leading-relaxed">
          {req.mode === 'create' && 'Hidden folders, photos, videos and labels stay out of every PixHaven screen until this password is entered. The files are not changed: File Explorer still shows them. There is no way to get the password back, so keep it somewhere safe.'}
          {req.mode === 'unlock' && 'Hidden items show (marked as hidden) until you lock them again or close PixHaven.'}
          {req.mode === 'remove' && 'Without a password nothing can stay hidden: every hidden folder, photo, video and label is shown again.'}
        </div>
        {error && <div className="text-sm text-danger" role="alert">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
          <Button variant={req.mode === 'remove' ? 'danger' : 'primary'} disabled={busy || (needsOld && !pw) || (needsNew && (!next || !again))} onClick={() => void submit()}>
            {req.mode === 'unlock' ? 'Show' : req.mode === 'remove' ? 'Remove password' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Sidebar switch: hidden items locked away or shown. */
export function LockButton() {
  const p = usePrivacy();
  if (!p.hasPassword) return null;
  return (
    <button onClick={() => void toggleLock()} data-testid="lock-button"
      className="flex items-center gap-2 w-full rounded-lg px-3 h-9 text-sm text-muted hover:text-fg hover:bg-panel-2"
      title={p.unlocked ? 'Hidden items are showing. Click to hide them again.' : 'Show hidden items (password)'}>
      <Icon name={p.unlocked ? 'unlock' : 'lock'} size={16} />{p.unlocked ? 'Hidden items shown' : 'Hidden items locked'}
    </button>
  );
}
