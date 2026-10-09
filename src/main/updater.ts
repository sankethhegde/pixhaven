// Auto-update via electron-updater + GitHub Releases. Active only in the installed app and only once a
// publish target is configured (electron-builder then writes resources/app-update.yml).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@shared/types';
import { log } from './logger';

const { autoUpdater } = electronUpdater;
let status: UpdateStatus = { state: 'idle' };
let notify: (s: UpdateStatus) => void = () => {};

const configured = () => app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
const set = (s: UpdateStatus) => { status = s; notify(s); };

export function initUpdater(onStatus: (s: UpdateStatus) => void): void {
  notify = onStatus;
  if (!configured()) { status = { state: 'not-configured' }; return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m: unknown) => log('info', 'updater', m), warn: (m: unknown) => log('warn', 'updater', m), error: (m: unknown) => log('error', 'updater', m), debug: () => {} } as never;
  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'latest', version: app.getVersion() }));
  autoUpdater.on('update-available', i => set({ state: 'downloading', version: i.version, progress: 0 }));
  autoUpdater.on('download-progress', p => set({ state: 'downloading', version: status.version, progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', i => set({ state: 'ready', version: i.version }));
  autoUpdater.on('error', e => set(failed(e)));
  setTimeout(() => { void checkForUpdates(); }, 15000);
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!configured()) return (status = { state: 'not-configured' });
  try { await autoUpdater.checkForUpdates(); } catch (e) { set(failed(e)); }
  return status;
}

/** No release published yet (or only drafts): that is "up to date", not an error. Offline: a short message. */
function failed(e: unknown): UpdateStatus {
  const msg = String((e as Error)?.message ?? e);
  if (/404|No published versions|Unable to find latest version|latest\.yml/i.test(msg)) return { state: 'latest', version: app.getVersion() };
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(msg)) return { state: 'error', error: 'no internet connection' };
  return { state: 'error', error: msg.split('\n')[0] };
}

export const updateStatus = () => status;
export function installUpdate(): void { if (status.state === 'ready') autoUpdater.quitAndInstall(); }
