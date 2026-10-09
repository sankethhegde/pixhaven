// Types shared by the main process, preload bridge and React UI.

export type ModelId = 'fast' | 'photo' | 'anime';
export type OutputFormat = 'png' | 'jpg' | 'webp';
export type Theme = 'system' | 'light' | 'dark';

/** Either a fixed factor, or "fit inside this box" (orientation-aware). */
export type SizeChoice =
  | { kind: 'scale'; factor: 2 | 4 }
  | { kind: 'target'; target: TargetId };

export type TargetId = '720p' | '1080p' | '1440p' | '4k';
export const TARGETS: Record<TargetId, { label: string; long: number; short: number }> = {
  '720p': { label: '720p (1280×720)', long: 1280, short: 720 },
  '1080p': { label: '1080p / HD (1920×1080)', long: 1920, short: 1080 },
  '1440p': { label: '1440p (2560×1440)', long: 2560, short: 1440 },
  '4k': { label: '4K (3840×2160)', long: 3840, short: 2160 },
};

export const MODELS: Record<ModelId, { label: string; hint: string }> = {
  fast: { label: 'Fast', hint: 'Compact model, about 10× quicker. Good for most photos and folders.' },
  photo: { label: 'General photo', hint: 'Best quality for real photos. Slow on integrated graphics.' },
  anime: { label: 'Anime / illustration', hint: 'Best for drawings, cartoons and anime.' },
};

export interface UpscaleOptions {
  size: SizeChoice;
  model: ModelId;
  format: OutputFormat;
  jpgQuality: number; // 1-100, also used for WEBP
}

export interface Settings {
  lowSpec: boolean;          // GEN-04
  lowSpecAuto: boolean;      // true until the user flips the toggle themselves
  tileSize: number;          // 0 = auto
  threads: string;           // load:proc:save
  gpuId: number | null;      // null = auto
  outputDir: string | null;  // null = next to the original, with _upscaled suffix (GEN-02)
  theme: Theme;
  last: UpscaleOptions;      // remembered upscale choices
  cpuOnly: boolean;          // GEN-03 manual override: run the engine on the CPU (SwiftShader)
  skipExisting: boolean;     // folder jobs skip images whose _upscaled file already exists (resume)
  firstRunDone: boolean;     // first-run test upscale has run
  sort: SortSettings;
  tidy: TidySettings;
  library: LibrarySettings;
  version: number;           // settings format (migrations in settings.ts)
}

export interface GpuInfo {
  name: string;
  integrated: boolean;
}
export interface GpuStatus {
  gpus: GpuInfo[];           // from Windows (WMI)
  vulkan: string[];          // devices the engine can use
  ok: boolean;               // engine found a Vulkan GPU
}

export interface ImageInfo {
  path: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  hasAlpha: boolean;
  previewUrl: string;        // clearup:// url of an oriented PNG/JPEG preview
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';

export interface JobItem {
  id: string;
  input: string;
  name: string;
  state: JobState;
  progress: number;          // 0-1
  output?: string;           // final saved (folder mode) or temp (single mode) file
  outputUrl?: string;
  beforeUrl?: string;
  outWidth?: number;
  outHeight?: number;
  error?: string;
  seconds?: number;
}

export interface JobUpdate {
  jobId: string;
  items: JobItem[];
  done: number;
  total: number;
  etaSeconds: number | null;
  finished: boolean;
}

export interface SaveResult {
  ok: boolean;
  path?: string;
  error?: string;
}

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff'];
export const LARGE_IMAGE_PX = 4000; // IMG-08

// ---------------- Sort by person ----------------

export interface SortSettings {
  includeSubfolders: boolean;   // FACE-01
  strictness: number;           // cosine similarity needed to call two faces the same person (GEN-05)
  minFaceSize: number;          // px on the ≤1280 working image (FACE-02)
  noFacesFolder: boolean;       // FACE-07 option
  minPhotos: number;            // FACE-16: smaller groups go to "Unsorted"
  useOcr: boolean;              // FACE-11
}

export type NameSource = 'typed' | 'file' | 'ocr';

export interface ScanProgress {
  folder: string;
  phase: 'listing' | 'scanning' | 'grouping' | 'naming' | 'done' | 'cancelled' | 'error';
  done: number;
  total: number;
  faces: number;
  people: number;
  current?: string;
  paused?: boolean;
  etaSeconds?: number | null;
  error?: string;
  skipped?: number;            // cloud-only / unreadable so far
}

export interface PersonSummary {
  id: number;
  label: string;               // name or "Person 03"
  name: string | null;
  num: number;
  source: NameSource | null;
  sourceDetail: string | null; // e.g. "from file name: Ravi_bday.jpg"
  photos: number;
  faceUrls: string[];          // up to 4 face thumbnails
  dir: string | null;          // folder on disk after Apply
  unsorted: boolean;           // fewer photos than minPhotos → "Unsorted"
}

export interface PhotoRef {
  imageId: number;
  faceId?: number;
  name: string;
  path: string;
  thumbUrl: string;
  faceUrl?: string;
  people?: number;             // recognised people in the photo
}

export interface ReviewData {
  folderId: number;
  folder: string;
  people: PersonSummary[];
  cantRecognise: PhotoRef[];   // faces found, none usable
  noFaces: PhotoRef[];
  skipped: { path: string; reason: string }[];
  nameClashes: { name: string; ids: number[] }[];
  scanned: number;
}

export type SortOpKind = 'mkdir' | 'move' | 'copy';
export interface SortOp {
  kind: SortOpKind;
  pass: 0 | 1 | 2;             // 0 = folders, 1 = moves + copies, 2 = group originals last
  from?: string;
  to: string;
  imageId?: number;
  personId?: number | null;
  bytes?: number;
}

export interface SortTarget { key: string; label: string; dir: string; exists: boolean; personId: number | null }

export interface SortPlan {
  folderId: number;
  root: string;
  targets: SortTarget[];
  ops: SortOp[];
  stays: { path: string; reason: string }[];
  counts: { folders: number; moves: number; copies: number; groupMoves: number; stays: number };
  copyBytes: number;
  freeBytes: number | null;
}

export interface ApplyProgress { sortId: number; done: number; total: number; current?: string; phase: 'pass1' | 'pass2' | 'undo' | 'done' | 'error'; error?: string }

export interface ApplyResult {
  sortId: number;
  ok: boolean;
  moved: number;
  copied: number;
  groupMoved: number;
  skipped: { path: string; reason: string }[];
}

export interface SortHistory {
  id: number;
  kind?: 'people' | TidyAction;
  created: number;
  state: 'applying' | 'done' | 'undone' | 'failed';
  summary: string;
}

export interface FolderStatus {
  folderId: number | null;
  scannedImages: number;
  people: number;
  lastScan: number | null;
  sorts: SortHistory[];
  interrupted: SortHistory | null;   // an Apply that didn't finish
}

// ---------------- Job queue (GEN-01) ----------------
export interface QueueItem {
  id: string;
  kind: 'upscale' | 'scan' | 'regroup' | 'apply' | 'undo' | 'download';
  label: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  added: number;
}

// ---------------- Updates, power, models ----------------
export interface UpdateStatus {
  state: 'idle' | 'not-configured' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error';
  version?: string;
  progress?: number;
  error?: string;
}
export interface PowerStatus { onBattery: boolean }
export interface ModelDownload { state: 'idle' | 'downloading' | 'done' | 'error'; progress: number; error?: string }

// ---------------- Tidy up (Phase 5): duplicates, blurry, by date or place ----------------
export interface TidySettings {
  includeSubfolders: boolean;
  match: 'identical' | 'same' | 'similar';   // duplicates: identical files / same picture resized or re-saved / also near-identical shots
  blurThreshold: number;                      // below = blurry (sharpness score)
  by: 'date' | 'place';
  dateDepth: 'year' | 'month';
  placeDepth: 'country' | 'city';
  useFileDate: boolean;
  unknownFolder: boolean;
}
export const MATCH_DISTANCE: Record<TidySettings['match'], number> = { identical: 0, same: 6, similar: 10 };

export interface TidyPhotoRef { id: number; path: string; name: string; size: number; width: number; height: number; blur: number; thumbUrl: string }
export interface TidyResults {
  folderId: number;
  folder: string;
  scanned: number;
  skipped: { path: string; reason: string }[];
  duplicates: { kind: 'exact' | 'similar'; keep: number; photos: TidyPhotoRef[] }[];
  blurry: TidyPhotoRef[];
  withDate: number;       // camera date found
  withPlace: number;      // GPS found
  history: SortHistory[]; // tidy actions on this folder (newest first), for Undo
}
export type TidyAction = 'duplicates' | 'blurry' | 'organize';

// ---------------- Media library (v2.0 Phase A) ----------------
/** LIB-03 */
export const RAW_EXTENSIONS = ['cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2'];
export const LIB_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'heic', 'heif', 'hif', 'avif', ...RAW_EXTENSIONS];
/** LIB-04 */
export const LIB_VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', '3gp', '3g2', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'vob', 'ogv'];
/** Formats Chromium shows directly; the rest get a converted preview for the viewer. */
export const BROWSER_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'jfif', 'png', 'webp', 'bmp', 'gif', 'avif'];

export type MediaKind = 'image' | 'video';
export const mediaKind = (name: string): MediaKind | null => {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return LIB_IMAGE_EXTENSIONS.includes(ext) ? 'image' : LIB_VIDEO_EXTENSIONS.includes(ext) ? 'video' : null;
};

export interface LibrarySettings {
  showSystem: boolean;        // LIB-06: show Windows/program folders too
  view: 'grid' | 'list';
  size: 's' | 'm' | 'l';
  sortBy: 'name' | 'date' | 'size';
  sortDesc: boolean;
  type: 'all' | MediaKind;
  lastDir: string | null;
  dbPath: string | null;      // library.db (labels, stars, positions); null = library.db in the app data folder
  watched: string[];          // v2.1 LIB-08: folders indexed in the background
  writeToFiles: boolean;      // v2.1 TAG-08: also write stars and labels into the files (or .xmp sidecars)
}

export type DriveKind = 'fixed' | 'removable' | 'network' | 'cd' | 'place';
export interface DriveInfo { path: string; name: string; kind: DriveKind; total?: number; free?: number }

export interface MediaEntry { name: string; path: string; kind: 'folder' | MediaKind; size: number; mtime: number }
export interface FolderListing {
  dir: string;
  parent: string | null;
  entries: MediaEntry[];
  hiddenFiles: number;        // non-media files left out
  denied?: boolean;           // LIB-10
  error?: string;
}
/** Thumbnail + facts for one file, filled in the background. */
export interface MediaInfo {
  path: string;
  thumb: string | null;       // clearup://thumb/… url
  width?: number;
  height?: number;
  duration?: number;          // seconds (videos)
  codec?: string;
  error?: string;
}
export interface SearchUpdate { id: number; items: MediaEntry[]; scanned: number; done: boolean; truncated?: boolean; indexed?: boolean }

// ---------------- Video player (v2.0 Phase B) ----------------
/** What this computer's built-in (Chromium) player can decode, measured in the UI with canPlayType. */
export interface PlayerCaps { hevc: boolean; av1: boolean; mkv: boolean }
/** direct = the file itself (hardware decoding); remux = streams copied into MP4 on the fly; transcode = converted on the fly. */
export type PlayMode = 'direct' | 'remux' | 'transcode';
export interface AudioTrack { index: number; codec: string; channels: number; language?: string; title?: string }
export interface SubtitleTrack { id: string; label: string; source: 'embedded' | 'file'; text: boolean }
export interface PlayStream { url: string; base: number; mode: PlayMode; reason: string; encoder?: string }
export interface PlayInfo extends PlayStream {
  session: string;
  path: string;
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audio: AudioTrack[];
  subtitles: SubtitleTrack[];
  resumeAt: number | null;   // PLAY-05
}
export interface SubtitleCue { start: number; end: number; text: string }
export interface RecentVideo { path: string; position: number; duration: number; updated: number; size: number; mtime: number }

// ---------------- Labels and stars (v2.0 Phase C) ----------------
export interface LabelInfo { id: number; name: string; color: string | null; count: number }
export interface MediaTags { stars: number; labels: number[] }
export interface TagFilter { labels: number[]; mode: 'all' | 'any'; minStars: number }
/** A photo or video from the library database (any folder or drive); offline = its drive is not connected. */
export interface TaggedMedia extends MediaEntry, MediaTags { offline: boolean }
export interface ImportResult { labels: number; applied: number; waiting: number; skipped: number }
export interface BackupInfo { file: string; date: string; size: number }
export const LABEL_COLORS = ['#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];

// ---------------- Watched folders, playlists, writing into files (v2.1) ----------------
export interface WatchedFolder {
  path: string;
  files: number;              // photos and videos indexed
  state: 'indexing' | 'ready' | 'offline' | 'waiting' | 'paused';
  scanned: number;            // files seen so far in the current indexing pass
  lastScan: number | null;
  live: boolean;              // changes are picked up as they happen (false: network drives, rescanned now and then)
}
export interface WatchQuery { text: string; type: 'all' | MediaKind; filter: TagFilter; root: string | null; limit?: number }
export interface WatchResult { items: TaggedMedia[]; total: number; truncated: boolean; tags: Record<string, MediaTags> }
export interface WatchChange { dirs: string[]; added: number; removed: number; relinked: number }
export interface Playlist { id: number; name: string; filter: TagFilter; created: number }
export interface FileWriteStatus { pending: number; written: number; failed: { path: string; reason: string }[] }
