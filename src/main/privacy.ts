// v2.10 Hidden items: folders, photos, videos and labels kept out of sight inside PixHaven until unlocked with a
// password. Everything that lists files or labels for the window goes through here (index.ts), so a hidden thing can't
// slip through one screen. The files themselves are not changed or moved, and File Explorer still shows them.
// What is hidden and the password (salted scrypt) live in library.db, so they travel with it. Locked at every start.
import crypto from 'node:crypto';
import path from 'node:path';
import type { LabelInfo, MediaTags, Playlist, PrivacyStatus } from '@shared/types';
import { tagStore } from './tags-service';
import { log } from './logger';

let unlocked = false;
let onChange: (s: PrivacyStatus) => void = () => {};
export const setOnChange = (fn: (s: PrivacyStatus) => void) => { onChange = fn; };

const win = process.platform === 'win32';
const key = (p: string) => (win ? p.toLowerCase() : p);

// ---------- password ----------

function hashOf(password: string, salt: string): string {
  return crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}
const hasPassword = () => !!tagStore().meta('privacy.hash');
function check(password: string): boolean {
  const s = tagStore();
  const salt = s.meta('privacy.salt'), hash = s.meta('privacy.hash');
  if (!salt || !hash) return false;
  const a = Buffer.from(hashOf(password, salt), 'hex'), b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// A few wrong tries in a row slow the next ones down.
let fails = 0, waitUntil = 0;
function verify(password: string): void {
  if (Date.now() < waitUntil) throw new Error(`Too many wrong passwords. Try again in ${Math.ceil((waitUntil - Date.now()) / 1000)} s.`);
  if (check(password)) { fails = 0; return; }
  fails++;
  if (fails >= 5) waitUntil = Date.now() + Math.min(300, 15 * 2 ** (fails - 5)) * 1000;
  throw new Error('That password is not right.');
}

export function status(): PrivacyStatus {
  const s = tagStore();
  return { hasPassword: hasPassword(), unlocked: unlocked || !hasPassword(), items: s.hiddenItems().length, labels: s.hiddenLabelIds().length };
}
const changed = () => onChange(status());

/** First password, or a new one (the current one is needed to change it). */
export function setPassword(current: string | null, next: string): PrivacyStatus {
  if (next.length < 4) throw new Error('Use at least 4 characters.');
  if (hasPassword()) verify(current ?? '');
  const salt = crypto.randomBytes(16).toString('hex');
  const s = tagStore();
  s.setMeta('privacy.salt', salt);
  s.setMeta('privacy.hash', hashOf(next, salt));
  log('info', 'Hidden items: password set');
  changed();
  return status();
}

/** No password any more: nothing can stay hidden behind it, so everything is shown again. */
export function removePassword(current: string): PrivacyStatus {
  verify(current);
  const s = tagStore();
  s.unhideAll();
  s.setMeta('privacy.salt', null);
  s.setMeta('privacy.hash', null);
  unlocked = false;
  log('info', 'Hidden items: password removed, everything shown');
  changed();
  return status();
}

export function unlock(password: string): PrivacyStatus { verify(password); unlocked = true; changed(); return status(); }
export function lock(): PrivacyStatus { unlocked = false; changed(); return status(); }

// ---------- hiding ----------

export function hide(items: { path: string; folder: boolean }[], on: boolean): PrivacyStatus {
  if (on && !hasPassword()) throw new Error('Set a password first, so hidden items can be shown again only with it.');
  tagStore().setHidden(items, on);
  changed();
  return status();
}
export function hideLabel(id: number, on: boolean): PrivacyStatus {
  if (on && !hasPassword()) throw new Error('Set a password first, so hidden items can be shown again only with it.');
  tagStore().setLabelHidden(id, on);
  changed();
  return status();
}

// ---------- what the window may see ----------

/** Is this path hidden: itself, a folder above it, or a file with a hidden label. Built once per listing. */
function hiddenTest(): ((p: string) => boolean) | null {
  const s = tagStore();
  const items = s.hiddenItems();
  const labelled = s.hiddenLabelIds().length ? new Set(s.pathsWithHiddenLabels().map(key)) : new Set<string>();
  if (!items.length && !labelled.size) return null;
  const set = new Set(items.map(i => key(i.path)));
  return p => {
    const k = key(p);
    if (labelled.has(k)) return true;
    for (let d = k; ; d = key(path.dirname(d))) {
      if (set.has(d)) return true;
      if (path.dirname(d) === d) return false;
    }
  };
}

/** Locked: hidden ones left out. Unlocked: all of them, the hidden ones marked. */
export function entries<T extends { path: string; hidden?: boolean }>(list: T[]): T[] {
  const test = hiddenTest();
  if (!test) return list;
  if (unlocked) return list.map(e => (test(e.path) ? { ...e, hidden: true } : e));
  return list.filter(e => !test(e.path));
}
/** For lists of plain paths (and things keyed by a path under another name). */
export function paths<T>(list: T[], pathOf: (t: T) => string | null | undefined): T[] {
  if (unlocked) return list;
  const test = hiddenTest();
  return test ? list.filter(t => { const p = pathOf(t); return !p || !test(p); }) : list;
}
export const isVisible = (p: string) => { if (unlocked) return true; const test = hiddenTest(); return !test || !test(p); };

export function labels(list: LabelInfo[]): LabelInfo[] {
  return unlocked ? list : list.filter(l => !l.hidden);
}
/** Hidden labels taken off the tags of visible files. */
export function tags(t: Record<string, MediaTags>): Record<string, MediaTags> {
  if (unlocked) return t;
  const hid = new Set(tagStore().hiddenLabelIds());
  if (!hid.size) return t;
  const out: Record<string, MediaTags> = {};
  for (const [p, v] of Object.entries(t)) out[p] = { ...v, labels: v.labels.filter(l => !hid.has(l)) };
  return out;
}
export function playlists(list: Playlist[]): Playlist[] {
  if (unlocked) return list;
  const hid = new Set(tagStore().hiddenLabelIds());
  return hid.size ? list.filter(p => !p.filter.labels.some(l => hid.has(l))) : list;
}
/** A label filter that names a hidden label finds nothing while locked. */
export const filterAllowed = (labelIds: number[]) => unlocked || !labelIds.some(l => tagStore().hiddenLabelIds().includes(l));
export const isUnlocked = () => unlocked || !hasPassword();
