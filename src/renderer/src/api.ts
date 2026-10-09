// Typed access to the preload bridge (window.clearup).
import type {
  ApplyProgress, ApplyResult, FolderStatus, GpuStatus, ImageInfo, JobItem, JobUpdate, ModelDownload, ModelId, PhotoRef,
  PowerStatus, QueueItem, ReviewData, SaveResult, ScanProgress, Settings, SortHistory, SortPlan, TidyResults, UpdateStatus, UpscaleOptions,
  FileWriteStatus, Playlist, WatchChange, WatchedFolder, WatchQuery, WatchResult,
  DriveInfo, FolderListing, MediaInfo, SearchUpdate, BackupInfo, ImportResult, LabelInfo, MediaTags, TaggedMedia, TagFilter, PlayerCaps, PlayInfo, PlayStream, RecentVideo, SubtitleCue, SubtitleTrack,
} from '@shared/types';

export interface AppInfo { version: string; gpu: GpuStatus; dedicated: boolean; settings: Settings; onBattery: boolean; pendingSort: string | null }
type Off = () => void;
interface SortApi {
  status(root: string): Promise<FolderStatus>;
  scan(root: string): Promise<string>;
  pause(paused: boolean): Promise<void>;
  cancel(): Promise<void>;
  regroup(fid: number): Promise<void>;
  review(fid: number): Promise<ReviewData>;
  person(pid: number): Promise<PhotoRef[]>;
  rename(pid: number, name: string, allowClash?: boolean): Promise<{ ok: boolean; clashWith?: { id: number; label: string } }>;
  merge(from: number, into: number): Promise<void>;
  removeFace(faceId: number): Promise<void>;
  split(pid: number, faceIds: number[]): Promise<number>;
  plan(fid: number): Promise<SortPlan>;
  apply(fid: number): Promise<ApplyResult>;
  finish(sortId: number): Promise<ApplyResult>;
  undo(sortId: number): Promise<{ restored: number; kept: { path: string; reason: string }[] }>;
  personFiles(pid: number): Promise<{ path: string; width: number; height: number }[]>;
  dataSize(): Promise<number>;
  deleteData(): Promise<void>;
}
export interface FolderScan { files: { path: string; width: number; height: number }[]; skipped: number; unreadable: string[] }
export type PathKind = 'folder' | 'image' | 'other' | 'missing';

interface TidyApi {
  status(root: string): Promise<{ folderId: number | null; scanned: number; history: SortHistory[] }>;
  scan(root: string): Promise<string>;
  results(fid: number): Promise<TidyResults>;
  organizePlan(fid: number): Promise<SortPlan>;
  setAsidePlan(fid: number, kind: 'duplicates' | 'blurry', ids: number[]): Promise<SortPlan>;
  apply(fid: number): Promise<ApplyResult>;
  undo(sortId: number): Promise<{ restored: number; kept: { path: string; reason: string }[] }>;
  trash(fid: number, ids: number[]): Promise<{ trashed: number; failed: { path: string; reason: string }[] }>;
}

interface LibApi {
  drives(): Promise<DriveInfo[]>;
  list(dir: string): Promise<FolderListing>;
  hasMedia(dirs: string[]): Promise<Record<string, boolean | null>>;
  thumbs(files: { path: string; size: number; mtime: number }[]): Promise<MediaInfo[]>;
  pauseThumbs(p: boolean): Promise<void>;
  preview(p: string): Promise<{ url: string; width: number; height: number; converted: boolean }>;
  search(root: string, q: string): Promise<number>;
  cancelSearch(): Promise<void>;
  cacheSize(): Promise<number>;
  clearCache(): Promise<void>;
}

interface PlayerApi {
  open(p: string, caps: PlayerCaps): Promise<PlayInfo>;
  seek(id: string, t: number, opts?: { audio?: number; fallback?: boolean }): Promise<PlayStream>;
  close(id: string): Promise<void>;
  subtitles(id: string, track: string): Promise<SubtitleCue[]>;
  loadSubtitle(id: string): Promise<{ tracks: SubtitleTrack[]; id: string } | null>;
  frame(p: string, t: number): Promise<string>;
  position(p: string, t: number, d: number): Promise<void>;
  playing(b: boolean): Promise<void>;
  recent(): Promise<RecentVideo[]>;
}

type Ref = { path: string; size: number; mtime: number };
export type TagUpdate = { tags: Record<string, MediaTags>; labels: LabelInfo[] };
interface TagsApi {
  labels(): Promise<LabelInfo[]>;
  forFiles(files: Ref[]): Promise<{ tags: Record<string, MediaTags>; relinked: string[] }>;
  setStars(files: Ref[], stars: number): Promise<TagUpdate>;
  addLabel(files: Ref[], name: string, color: string | null): Promise<TagUpdate>;
  removeLabel(paths: string[], id: number): Promise<TagUpdate>;
  renameLabel(id: number, name: string): Promise<{ mergedInto: number | null; labels: LabelInfo[] }>;
  setColor(id: number, color: string | null): Promise<LabelInfo[]>;
  deleteLabel(id: number): Promise<LabelInfo[]>;
  query(filter: TagFilter, text: string): Promise<TaggedMedia[]>;
  renameFile(p: string, name: string): Promise<string>;
  moveFiles(paths: string[]): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; reason: string }[] } | null>;
  exportTo(format: 'json' | 'csv'): Promise<{ file: string; count: number } | null>;
  importFrom(): Promise<ImportResult | null>;
  findMoved(): Promise<number | null>;
  missing(): Promise<number>;
  backups(): Promise<BackupInfo[]>;
  backupNow(): Promise<BackupInfo>;
  restore(file: string): Promise<void>;
  location(): Promise<{ path: string; isDefault: boolean }>;
  chooseLocation(): Promise<{ dir: string; taken: boolean } | null>;
  setLocation(dir: string, mode: 'move' | 'use'): Promise<string>;
  playlists(): Promise<Playlist[]>;
  savePlaylist(name: string, filter: TagFilter, id?: number): Promise<Playlist[]>;
  deletePlaylist(id: number): Promise<Playlist[]>;
  writeStatus(): Promise<FileWriteStatus>;
  setWriteToFiles(on: boolean): Promise<number>;
}
interface WatchApi {
  list(): Promise<WatchedFolder[]>;
  choose(): Promise<WatchedFolder[] | null>;
  add(dir: string): Promise<WatchedFolder[]>;
  remove(dir: string): Promise<WatchedFolder[]>;
  reindex(dir: string): Promise<WatchedFolder[]>;
  query(q: WatchQuery): Promise<WatchResult>;
}

interface Api {
  lib: LibApi;
  tags: TagsApi;
  player: PlayerApi;
  onLibThumb(cb: (i: MediaInfo) => void): Off;
  onLibSearch(cb: (u: SearchUpdate) => void): Off;
  watch: WatchApi;
  onWatchStatus(cb: (s: WatchedFolder[]) => void): Off;
  onWatchChanged(cb: (c: WatchChange) => void): Off;
  onWriteStatus(cb: (s: FileWriteStatus) => void): Off;
  tidy: TidyApi;
  onTidyProgress(cb: (p: ScanProgress) => void): Off;
  onTidyScanned(cb: (r: { folderId: number; cancelled?: boolean }) => void): Off;
  onTidyApply(cb: (p: ApplyProgress) => void): Off;
  appInfo(): Promise<AppInfo>;
  takePendingSort(): Promise<string | null>;
  power(): Promise<PowerStatus>;
  queueList(): Promise<QueueItem[]>;
  queueCancel(id: string): Promise<void>;
  modelsStatus(): Promise<{ installed: Record<ModelId, boolean>; download: ModelDownload; sizeMb: number }>;
  downloadModels(): Promise<ModelDownload>;
  updateStatus(): Promise<UpdateStatus>;
  checkUpdates(): Promise<UpdateStatus>;
  installUpdate(): Promise<void>;
  sort: SortApi;
  onQueue(cb: (q: QueueItem[]) => void): Off;
  onPower(cb: (p: PowerStatus) => void): Off;
  onModels(cb: (d: ModelDownload) => void): Off;
  onUpdate(cb: (u: UpdateStatus) => void): Off;
  onSortProgress(cb: (p: ScanProgress) => void): Off;
  onSortScanned(cb: (r: { folderId: number; cancelled?: boolean }) => void): Off;
  onApplyProgress(cb: (p: ApplyProgress) => void): Off;
  onOpenSort(cb: (folder: string) => void): Off;
  detectGpu(): Promise<{ gpu: GpuStatus; dedicated: boolean }>;
  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;
  openImages(): Promise<string[]>;
  openFolder(title?: string): Promise<string | null>;
  pathKind(p: string): Promise<PathKind>;
  inspectImage(p: string): Promise<ImageInfo>;
  imageSize(p: string): Promise<{ width: number; height: number } | null>;
  scanFolder(p: string): Promise<FolderScan>;
  startJob(req: { files: { path: string; width: number; height: number }[]; opts: UpscaleOptions; mode: 'single' | 'folder' }): Promise<string>;
  cancelJob(id: string): Promise<void>;
  saveResult(req: { jobId: string; itemId: string; item: JobItem; saveAs: boolean }): Promise<SaveResult>;
  showItem(p: string): Promise<void>;
  openPath(p: string): Promise<string>;
  openLogs(): Promise<string>;
  licences(): Promise<{ name: string; text: string }[]>;
  pathForFile(f: File): string;
  onJobUpdate(cb: (u: JobUpdate) => void): () => void;
}

declare global { interface Window { clearup: Api } }
export const api = window.clearup;

/** Strip Electron's "Error invoking remote method 'x': Error: " prefix. */
export const errorText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const fmtBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
export function fmtDuration(s: number): string {
  if (s < 60) return `${Math.max(1, Math.round(s))} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

/** Is this file inside that folder? (Windows "\" or Linux "/" paths) */
export const isIn = (file: string, dir: string) => { const f = file.toLowerCase(), d = dir.toLowerCase(); return f.startsWith(d + '\\') || f.startsWith(d + '/'); };
/** Name of the bin deleted files go to on this system. */
export const binName = navigator.userAgent.includes('Windows') ? 'Recycle Bin' : 'Trash';
/** Video length as 1:05 or 1:02:03. */
export function fmtClock(s: number): string {
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
