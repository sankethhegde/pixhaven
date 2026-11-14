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

// ---------------- v2.6 Image Generator ----------------
export type GenStyle = 'none' | 'photo' | 'illustration' | 'anime' | 'painting' | '3d';
export type GenSize = 'square' | 'portrait' | 'landscape';
export interface GeneratorSettings {
  outputDir: string | null;   // null = PicturesPixHaven
  style: GenStyle;
  size: GenSize;
  count: number;              // images per request, 1–4
  quality: 'fast' | 'better'; // 4 or 8 steps
  format: OutputFormat;       // v2.6: JPG (quality 92) by default; PNG or WEBP
}
export interface GenRequest {
  prompt: string; style: GenStyle; size: GenSize; count: number; quality: 'fast' | 'better'; seed: number | null; format?: OutputFormat;
  init?: string;        // v2.8: start from this picture (image to image); the shape follows it
  strength?: number;    // how much is redrawn: 0.35 close, 0.55 similar, 0.75 loose
}
export interface GenImage {
  id: string; path: string | null; url: string; prompt: string; style: GenStyle; seed: number;
  width: number; height: number; steps: number; created: number; hidden?: boolean;
  from?: string; strength?: number;   // v2.8: made from this picture (its file name), and how freely   // hidden: stopped by the safety filter (not saved)
}
export interface GenStatus {
  installed: boolean; bytes: number; device: 'dml' | 'cpu' | null; loaded: boolean; outputDir: string;
  encoder: { installed: boolean; bytes: number; download: { state: 'idle' | 'downloading' | 'error'; got: number; total: number; error?: string } };
  download: { state: 'idle' | 'downloading' | 'error'; got: number; total: number; error?: string };
  modelName: string; source: string; licence: string;
}
/** v2.7 "Describe a picture" */
export interface DescribeResult { prompt: string; style: GenStyle | null; short: string; paragraph: string; ms: number }
export interface DescribeStatus {
  installed: boolean; bytes: number; modelName: string; source: string;
  download: { state: 'idle' | 'downloading' | 'error'; got: number; total: number; error?: string };
}
export interface GenProgress { jobId: string; index: number; count: number; step: number; steps: number; phase: 'loading' | 'working' | 'done' | 'cancelled' | 'error'; error?: string; image?: GenImage }

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
  replaceInBatch: boolean;   // v2.5: batch upscales replace the originals (to the Recycle Bin) instead of adding _upscaled copies
  firstRunDone: boolean;     // first-run test upscale has run
  sort: SortSettings;
  tidy: TidySettings;
  library: LibrarySettings;
  generator: GeneratorSettings;
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
  suggestUpscale: boolean;      // v2.3: list low-resolution photos for upscaling in the review (off by default)
}

export interface ScanProgress {
  folder: string;
  phase: 'listing' | 'scanning' | 'grouping' | 'done' | 'cancelled' | 'error';
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
  label: string;               // "Person 3" (or the folder an earlier sort gave them)
  num: number;
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
  lowRes: (PhotoRef & { width: number; height: number })[];   // v2.3: worth upscaling (optional step)
  scanned: number;
}

export type SortOpKind = 'mkdir' | 'move' | 'copy' | 'tag';
export interface SortOp {
  kind: SortOpKind;
  pass: 0 | 1 | 2;             // 0 = folders, 1 = moves (+ copies in older plans), 2 = group originals last (older plans)
  from?: string;
  to: string;
  imageId?: number;
  personId?: number | null;
  bytes?: number;
  people?: string[];           // v2.2: everyone in the photo, written into it as tags (PersonInImage)
  alsoIn?: { label: string; dir: string }[];   // v2.2: other people's folders that show this photo
}

export interface SortTarget { key: string; label: string; dir: string; exists: boolean; personId: number | null }

export interface SortPlan {
  folderId: number;
  root: string;
  targets: SortTarget[];
  ops: SortOp[];
  stays: { path: string; reason: string }[];
  counts: { folders: number; moves: number; tagged: number; stays: number };
  freeBytes: number | null;
}

export interface ApplyProgress { sortId: number; done: number; total: number; current?: string; phase: 'pass1' | 'pass2' | 'tagging' | 'undo' | 'done' | 'error'; error?: string }

export interface ApplyResult {
  sortId: number;
  ok: boolean;
  moved: number;
  copied: number;
  groupMoved: number;
  tagged?: number;             // v2.2: photos also shown in other people's folders
  moves?: { from: string; to: string }[];
  files?: string[];            // v2.2: photos the people were written into (where they are now)
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
  /** v2.4: what was found renamed or moved outside the app since last time (paths updated). */
  reconciled?: { movedFrom: string | null; folders: { from: string; to: string }[]; photos: number } | null;
}

// ---------------- Job queue (GEN-01) ----------------
export interface QueueItem {
  id: string;
  kind: 'upscale' | 'scan' | 'regroup' | 'apply' | 'undo' | 'download' | 'generate' | 'combine' | 'convert';
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

export interface MediaEntry {
  name: string; path: string; kind: 'folder' | MediaKind; size: number; mtime: number;
  taggedFrom?: string;        // v2.2: a group photo shown in this person's folder, kept in the folder of this name
  alsoIn?: string[];          // v2.5: a group photo kept here that these other people's folders show too
  hidden?: boolean;           // v2.10: hidden, shown only while hidden items are unlocked
}
/** v2.5 Photos tab: a folder scanned or sorted before. */
export interface KnownFolder { path: string; people: number; photos: number; lastScan: number | null; sorted: number | null; id?: number; personFolders?: number }

// v2.8 Combine people across sorted folders (Photos tab): the same person sorted in several folders ends up in one.
export interface CombinePerson {
  id: number; folderId: number; folder: string;   // the sorted folder they belong to
  label: string; named: boolean;                  // folder name; false for automatic "Person 3" names
  dir: string; photos: number; faceUrls: string[];
  matchable: boolean;                             // has face fingerprints of the current model
}
export interface CombineGroup { members: number[]; score: number; sameName: boolean }
export interface CombineMatch { people: CombinePerson[]; groups: CombineGroup[]; ms: number }
export interface CombineRequest { dest: string; groups: { people: number[]; name: string }[] }
export interface CombineEstimate {
  files: number; bytes: number; people: number; sameDrive: boolean;
  wholeFolders: number;                           // person folders moved in one go (same drive, nothing to merge into)
  renamed: number;                                // photos whose person name inside changes
  seconds: number;
}
export interface CombineProgress { phase: 'matching' | 'moving' | 'naming' | 'finishing' | 'done' | 'error'; done: number; total: number; current?: string; error?: string }
export interface CombineResult { dest: string; people: number; moved: number; renamed: number; skipped: { path: string; reason: string }[] }

// v2.9 Photos → Merge into…: where each photo of a person belongs (by face), and the merge itself.
export interface MergePhoto { imageId: number; path: string; thumb: string | null; thumbUrl?: string }
export interface MergePlan {
  personId: number; label: string; photos: number;
  targets: { personId: number; label: string; photos: MergePhoto[]; score: number; faceUrl?: string }[];
  unmatched: MergePhoto[];
}
export interface MergeResult { merged: number; moved: number; renamed: number; left: number; removed: boolean; skipped: { path: string; reason: string }[] }

// v2.8: how long a scan will take, measured on a few of the folder's photos before it starts.
export interface ScanEstimate {
  files: number; toScan: number; cloud: number;
  sampled: number; msPerPhoto: number; facesPerPhoto: number; provider: string;
  scanSeconds: number; groupSeconds: number; seconds: number;
}
export interface FileOpResult { done: { from: string; to: string }[]; failed: { path: string; reason: string }[] }

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
export interface LabelInfo {
  id: number; name: string; color: string | null; count: number; hidden?: boolean;
  // 1.0.6: who made it. 'files' = a keyword already inside photos or videos (phone gallery, Windows Photos, Lightroom…),
  // picked up when PixHaven read them; originFile = where it was first seen. Labels from before 1.0.6 are worked out
  // once (originSure false when it is a best guess); null = not worked out yet.
  origin?: LabelOrigin | null; originFile?: string | null; originSure?: boolean;
}
export type LabelOrigin = 'you' | 'files' | 'backup' | 'unknown';
// v2.11 Video editor, phase 1: converting videos (and phone photos) to other formats — no upscaling.
export type ConvertTarget = 'mp4-h264' | 'mp4-hevc' | 'mp4-av1' | 'webm-vp9' | 'mov-prores' | 'mp3' | 'm4a' | 'gif' | 'jpg' | 'png';
export interface ConvertOptions {
  target: ConvertTarget;
  quality: 'small' | 'balanced' | 'best';
  resolution: 'keep' | 2160 | 1080 | 720 | 480;   // short side; only ever made smaller
  maxMB: number | null;                            // fit under this size (video)
  sound: boolean;                                   // keep the sound (video)
  outDir: string | null;                            // null: next to each original
  forceEncode?: boolean;                            // convert even when the video could just be copied
}
export interface ConvertFile {
  path: string; name: string; size: number; kind: 'video' | 'image' | 'audio' | 'other';
  duration?: number; width?: number; height?: number; codec?: string; audio?: string; error?: string;
}
export interface ConvertCaps { targets: Record<ConvertTarget, { ok: boolean; encoder: string | null; why?: string }> }
export interface ConvertProgress {
  jobId: string; index: number; total: number; file: string; percent: number;
  state: 'running' | 'done' | 'failed' | 'skipped' | 'cancelled' | 'finished';
  out?: string; outSize?: number; error?: string; speed?: number; etaSeconds?: number | null; note?: string;
}
export interface ConvertResult { done: { from: string; to: string; size: number; note?: string }[]; failed: { path: string; reason: string }[]; skipped: { path: string; reason: string }[]; cancelled: boolean }

// v2.11 Video editor, phase 2: quick edits of one video, and joining several.
export interface Range { start: number; end: number }
export interface EditSpec {
  trim: Range;                                  // seconds of the original kept (start/end)
  cuts: Range[];                                // parts taken out of the middle
  splits: number[];                             // split points: each piece becomes its own file
  exact: boolean;                               // cut exactly at the chosen frames (converts) instead of at keyframes
  rotate: 0 | 90 | 180 | 270; flipH: boolean; flipV: boolean;
  crop: { aspect: '9:16' | '1:1' | '4:5' | '16:9' | '4:3'; x: number; y: number } | null;   // x, y: 0–1 position of the box
  speed: number;                                // 0.25–4
  volume: number;                               // 0 (no sound) – 2
  music: { path: string; volume: number; mix: boolean } | null;   // mix: under the video's sound; else in its place
  brightness: number; contrast: number; saturation: number;       // −1…1, −1…1, 0…2 (1 = as is)
  stabilize: boolean;
  text: { value: string; position: 'top' | 'center' | 'bottom'; size: 's' | 'm' | 'l' } | null;
  fadeIn: number; fadeOut: number;              // seconds
  resolution: ConvertOptions['resolution'];
  output: { target: 'mp4-h264' | 'mp4-hevc' | 'mp4-av1' | 'webm-vp9' | 'mov-prores'; quality: ConvertOptions['quality'] };
  outDir: string | null;
}

// v2.10 Wallpaper recommended: photos that fit this computer's screen.
export interface WallScreen { id: number; width: number; height: number; primary: boolean; label: string }
export interface WallItem extends MediaEntry { width: number; height: number; crop: number; upscale: 1 | 2 | 4; sharp: number }
export interface WallResult { screen: WallScreen; ready: WallItem[]; upscale: WallItem[]; checked: number; blurry: number; cancelled: boolean; seconds: number }
export interface WallProgress { phase: 'listing' | 'checking' | 'done'; done: number; total: number; found?: number }
/** v2.10 hidden items: folders, photos, videos and labels kept out of sight until unlocked with a password. */
export interface PrivacyStatus { hasPassword: boolean; unlocked: boolean; items: number; labels: number }
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

/** v1.0.4: the details card next to the grid (Library and Photos). Fields are left out when the file does not say. */
export interface FileDetails {
  path: string; name: string; folder: string; kind: MediaKind | 'folder';
  size: number; modified: number; created: number;
  format?: string;                    // "JPEG", "MP4 (H.264)" …
  width?: number; height?: number;
  duration?: number;                  // seconds
  fps?: number; bitrate?: number;     // bits per second
  videoCodec?: string; audio?: string[];   // "AAC stereo (eng)"
  taken?: string;                     // as written in the photo ("2024:05:01 10:22:13")
  camera?: string; lens?: string; exposure?: string;   // "f/1.8 · 1/120 s · ISO 100 · 4.2 mm"
  people?: string[];
  error?: string;
}

// ---------- 1.0.7 Attic (the home file server) inside PixHaven ----------
/** none: never set up · offline: set up, not answering · unpaired: needs a code from Attic Hub · signed-out · connected. */
export interface AtticStatus {
  state: 'none' | 'offline' | 'unpaired' | 'signed-out' | 'connected';
  name?: string; address?: string; port?: number;
  account?: { displayName: string; username: string; type: 'master' | 'device' } | null;
  error?: string;
}
export interface AtticShareInfo { id: string; name: string; path: string }   // path: attic://<id>
export interface AtticListing { share: string; path: string; entries: MediaEntry[]; otherFiles: number }
/** Copying or moving between this PC and Attic. */
export interface AtticTransfer {
  id: string; kind: 'to-attic' | 'from-attic'; move: boolean;
  files: number; done: number; bytes: number; totalBytes: number; current: string | null;
  finished: boolean; failed: { path: string; reason: string }[]; moved: { from: string; to: string }[];
}
