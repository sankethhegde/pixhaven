# PixHaven

Offline AI image upscaler and photo organiser for Windows and Linux (Electron + React + TypeScript + Tailwind).
Upscaling runs on the GPU through [realesrgan-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)
(Intel Arc / Iris Xe, NVIDIA, AMD), or on the CPU through SwiftShader when no GPU works. "Sort by person" finds faces
with YuNet + ArcFace (ONNX Runtime, DirectML on the GPU), groups them into "Person 1", "Person 2"…, and moves each photo
into one folder per person — group photos are tagged for the other people instead of copied — after a review and a dry
run, with full undo.
"Tidy up" finds duplicate and blurry photos and sorts folders by date or place (offline GeoNames data).
The media library browses every drive showing only photos and videos, with thumbnails for phone HEIC, camera RAW
and every common video format (bundled FFmpeg), plays every video, and keeps labels, star ratings and playlists for
photos and videos; watched folders are indexed in the background. There is a command line too. Nothing is uploaded.

Status: **Phases 0–5, v2.0 Phases A (Browse), B (Play), C (Labels and stars) and v2.1 (watched folders and polish) done.** Renamed from ClearUp to **PixHaven** in 0.6.0 (new round icon). Not done: code signing and landing page (skipped by choice); auto-update is on (GitHub Releases); Linux packages must be built on Linux (WSL or the GitHub Actions workflow).

## Setup

```bash
npm install
npm run setup:engine     # downloads the engine, models, face models, places, FFmpeg and ExifTool into resources/
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app with hot reload (F12 opens DevTools) |
| `npm test` | Unit tests: size planning, file naming, BMP reader, face grouping (weak faces), labels read back from files, dry run → apply → undo on real files |
| `npm run e2e` | Builds, opens the real app, drives the upscale UI and GPU engine (incl. queue, resume, cancel); screenshots + `results.json` in `e2e-output/` |
| `npm run e2e:tidy` | Phase 5: Home theme switch, duplicates & blurry, sort by date / place, undo |
| `npm run e2e:watch` | v2.1, two launches with their own app data: watch two folders, instant search from the index, keyboard shortcuts, labels and stars on a photo in the viewer, "Family, 4+ stars" over folders never opened, save a playlist and play it (goes on by itself), indexing paused during playback, live changes (new, moved with labels, renamed subfolder, deleted), photos not kept open, writing into MP4/JPG/.xmp and keeping it current; restart: everything kept, a file added while closed is found |
| `npm run test:scale` | Doc's scale test: indexes 100,000 files, cancels at 40,000, resumes, queries (≈ 10 s on the test laptop) |
| `npm run e2e:tags` | v2.0 Phase C, three launches: 5 labels on one video, bulk-label 52, stars from keys and grid, filter "Family AND 2024, 4+ stars", rename in and outside the app, manage labels, export; restart; then a fresh "laptop" with the videos elsewhere imports the export |
| `npm run e2e:player` | v2.0 Phase B: every test video plays (direct / repackaged / converted), 4K HEVC + AV1 on the hardware decoder with no dropped frames, sound tracks, subtitles, seeking, preview, speed, full screen, resume, recently played |
| `npm run e2e:library` | v2.0 Phase A: drives, media-only browsing, a thumbnail for every format, list view, search, viewer, no-permission folder, a drive appearing (subst), a 5,000-file folder |
| `node tests/make-media.mjs <folder>` | Builds the mixed-format test folder (17 photo formats incl. HEIC and 7 RAW, 17 video formats) |
| `npm run e2e:sort` | Same for Sort by person: scan → review → dry run → apply (no copies, people tagged, folders checked against the photos' real names) → re-scan → undo, on ~50 public test photos (`phase0/fetch-test-photos.mjs`, or set `CLEARUP_TESTPHOTOS`) |
| `npm run dist` | Type-check, build and make the Windows installer `dist/PixHaven-Setup-<version>.exe` |
| `PixHaven.exe --selftest out.json` | Installed app: GPU check, one real upscale, a face scan, a video thumbnail, an on-the-fly video conversion, labels export/import, ExifTool writing and reading back (labels, stars, people) and the folder index; JSON report, then exits. Add `--cpu` to test CPU mode, `--with-download` to test the model download |

## Command line

Installed app: `"%LOCALAPPDATA%\Programs\PixHaven\pixhaven.cmd" --help` (add that folder to PATH to type just `pixhaven`).
Development: `scripts\pixhaven-dev.cmd --help` after `npm run build`. Linux: `PixHaven-<version>.AppImage --cli --help`.

```
pixhaven upscale <image|folder>… [--scale 2|4 | --target 1080p] [--model fast|photo|anime] [--format png|jpg|webp] [--out <folder>] [--cpu]
pixhaven sort <folder> [--subfolders] [--apply]
pixhaven duplicates <folder> [--match identical|same|similar] [--move]
pixhaven blurry <folder> [--threshold 150] [--move]
pixhaven organize <folder> --by date|place [--depth year|month|country|city] [--unknown-folder] [--apply]
pixhaven undo <folder>
```

Nothing moves without `--apply` / `--move`; results go to stdout, progress to stderr; exit codes 0 ok, 1 failed, 2 bad usage.
Command-line options never change the app's saved settings.

## Linux

Code paths are platform-aware (engine binary, CPU fallback, GPU detection, unzip, Trash). Build on Linux:
`npm ci && node node_modules/electron/install.js && npm run setup:engine && npx electron-vite build && npx electron-builder --linux`
→ `dist/PixHaven-<version>-x86_64.AppImage` and `.deb` (needs `unzip`; GPU upscaling needs Vulkan drivers, e.g. `mesa-vulkan-drivers`).
`.github/workflows/build.yml` builds and tests Windows + Linux on every push once the project is on GitHub.

## Layout

```
src/main/            Electron main process
  index.ts             window, clearup:// image protocol, IPC, --selftest, --sort <folder> (Explorer menu), first-run test
  queue.ts             one job queue for all heavy work (GEN-01)
  engine.ts            realesrgan-ncnn-vulkan runner (progress, cancel, CPU via SwiftShader)
  upscale-job.ts       prepare → engine → resize/encode with EXIF; single + folder jobs, ETA, resume
  models.ts            quality models download on first use (pinned SHA-256)
  updater.ts           electron-updater (active once a publish target is configured)
  db.ts                face database (node:sqlite, built into Electron)
  sort-service.ts      Sort by person: file listing (skips OneDrive online-only), worker, review/merge/split
  faces/               detect.ts (YuNet + ArcFace, face quality), cluster.ts, pipeline.ts, sort-worker.ts
  sorter/              plan.ts (dry run), apply.ts (apply, people written into photos, log, undo),
                       people-manifest.ts (.clearup/people.json: group photos shown in other people's folders)
  tidy/                inspect.ts (SHA-1, dHash, blur, EXIF date/GPS), dupes.ts, organize.ts, geo.ts (offline places)
  tidy-service.ts      Tidy up: scan, results, previews, apply, Recycle Bin
  cli.ts               command-line mode (--cli)
  library-service.ts   media library: drives, folders, thumbnails, viewer previews, search
  tags-service.ts      labels and stars: library.db location, daily backups, export/import, rename/move in the app,
                       playlists, re-linking moved files, writing into files (TAG-08) and reading them back
  library/file-tags.ts reads stars, labels and people out of files and sidecars (one ExifTool process kept open)
  watch-service.ts     watched folders: background indexing, live changes (one recursive watch per folder), offline drives
  player-service.ts    video player: sessions, clearup://media (byte ranges) and clearup://stream (FFmpeg), resume
  library/             browse.ts (drives, listing, system folders, search), thumbs.ts (cache + queue),
                       ffmpeg.ts (video facts/frames, HEIC), raw.ts (camera RAW previews),
                       player.ts (direct / remux / transcode decision, stream arguments, keyframes, subtitles),
                       tags.ts (labels, stars, positions, playlists, fingerprints, re-linking, export/import, CSV),
                       media-index.ts (watched-folder index: resumable passes, folder re-reads, search),
                       xmp.ts (ExifTool: stars and labels into files or .xmp sidecars)
src/renderer/        React UI: Home (+ ☀️/🌙 theme switch), Library (tree, grid/list, viewer), Upscale, Sort, Tidy up, Settings
build/installer.nsh  adds/removes the folder right-click "Sort by person with PixHaven"
tests/               unit tests (node --test) + e2e scripts
phase0/              proof of concept + PHASE0-RESULTS.md
```

## Behaviour notes

- **Models:** Fast = `realesr-animevideov3` (bundled). General photo (`realesrgan-x4plus`) and Anime download once (45 MB).
- **Low-spec mode** turns on with integrated graphics: tile 192, threads 1:2:2, Fast pre-selected for folders, no 4K.
  GPU out-of-memory halves the tile size and retries. No working Vulkan GPU → CPU mode, with a warning.
- **Upscale output:** `name_upscaled.ext` next to the original (or a chosen folder), never overwriting. EXIF kept.
  Re-running a folder skips images that already have a result (Settings → Upscaling folders).
- **Sort by person (0.7):** fingerprints come from ArcFace ResNet-100 (ONNX Model Zoo, Apache-2.0, 8-bit, 65 MB), each
  face read as is and mirrored. On test faces made darker, brighter, side-lit, smaller or blurred it still matched the
  same person 97–100% of the time at the default strictness 0.34, against 84–97% for the old SFace at its 0.42 default,
  with almost no wrong matches (SFace made 10–70× more at looser settings). Every face gets a quality score (size,
  sharpness, light, head turn): weak faces never start or link groups — they only join a clear match (threshold + 0.05,
  and 0.07 ahead of the next person), otherwise their photo stays put ("Couldn't recognise"). Fingerprints from the old
  model are made again on the next scan; who-is-who the user settled (and sorted folders) is kept by face position.
  People are "Person 1", "Person 2"… — names are no longer read from file names or text, and folders are never renamed.
  A photo with several people moves once, to the person with the biggest face; everyone in it is written into the photo
  (XMP `PersonInImage`, read by Lightroom, digiKam…), and the other people's folders show it from
  `<folder>/.clearup/people.json` (relative paths, so it works on any drive or computer with PixHaven). No copies.
  Every action is logged in `<folder>/.clearup/sort-log.jsonl`; Undo replays it backwards and takes the people out of
  the photos again (photos without metadata of their own come back byte for byte). An interrupted Apply can be finished
  or undone next time. Folders made by a sort — on this computer or listed in `people.json` — are skipped by later scans.
- **Upscale low-resolution photos (0.7.4, optional; opt-in since 0.7.5):** with "Recommend low-resolution photos for
  upscaling" ticked on the folder screen, the review lists photos under 2 megapixels and under 1,600 px on the long side (JPG, PNG, WEBP), all ticked. "Upscale and replace" makes each 2× bigger (4× under 720 px) in
  the same format, with the Photo model when downloaded (else Fast). The result keeps the name, date, EXIF and XMP
  (people, labels); the original goes to the Recycle Bin. Face data and labels are updated, so nothing is scanned again.
- **Reopening a sorted folder (0.7.5):** choosing a folder scanned or sorted before opens straight on its people. Person
  folders (or the sorted folder itself) renamed or moved in Explorer are recognised from the photos inside (name and
  size): face data, the "also shown in" list and the undo log follow, so nothing is sorted twice and Undo still works.
  A renamed person folder renames the person: the name inside their photos (group photos kept elsewhere too) changes
  in the background, and Undo takes the new name out.
- **Group photos, both ways (0.7.6):** the folder keeping a group photo marks it "Also in · Person 4"; the other
  people's folders mark it "Kept in · Person 2" (grid, list and viewer). On Windows each other person's folder also gets
  a shortcut to it (`beach.jpg.lnk`, about 1 KB, description "PixHaven group photo"), so File Explorer shows it there
  too; PixHaven keeps these in step with `people.json` (retargeted on renames, removed by Undo) and never touches other
  shortcuts. Folders sorted on another computer get theirs when opened.
- **Photos tab (0.7.6):** lists folders sorted before (and opens any folder). A sorted folder opens on its people — person
  folders renamed in Explorer are recognised — and a person shows their folder, group photos included. The Folders
  view browses it with New folder (Ctrl+Shift+N), Cut / Copy / Paste (Ctrl+X / C / V, in-app clipboard), Rename (F2,
  files and folders), Move to… and Copy to…. Never overwrites (" (2)"), moves across drives copy-check-delete, RAW
  sidecars travel along; labels, the people list and the shortcuts follow moves, face data on the next open.
- **Batch upscale recommendation (0.7.6):** the batch list has a checkbox per image. Images already HD (shorter side
  720 px or more, i.e. 720p) start unticked with "Already HD · skip recommended" and a note saying why; "Include them
  anyway" / "Leave them out", Select all / none — the user decides.
- **Image Generator (0.8.0):** text → image, offline and free. Model: LCM Dreamshaper v7 (Stable Diffusion 1.5,
  ONNX/Olive fp16 for DirectML) from `huggingface.co/softwareweaver/LCM_Dreamshaper_v7_Olive_Onnx`, pinned revision
  `25bf953`; downloaded once on first use (2.7 GB: tokenizer, text encoder, UNet, VAE decoder, safety checker) into
  `%APPDATA%\PixHaven\models\generator`, each file checked against its SHA-256, resumed with HTTP ranges after a drop.
  Licence CreativeML OpenRAIL-M: its use rules are shown before the download and linked. Pipeline
  (`src/main/generator/pipeline.ts`): CLIP BPE tokenizer (75 tokens), LCM scheduler (4 steps 999/759/519/279, or 8),
  guidance-scale embedding w = 7, VAE decode, then the model's safety checker on a proper 224-px resize (a
  nearest-pixel resize gave false alarms); flagged images are not saved and show only as a blurred tile. Runs in a
  worker thread through the job queue; the worker (~5 GB) ends after 5 idle minutes. About 5–6 s per 512×512 image on
  Intel Arc integrated graphics; the very first image after installing takes about a minute (DirectML prepares
  shaders, then caches them). No negative prompt: LCM's guidance is built into the model. Styles add words to the
  prompt; shapes 512×512 / 512×768 / 768×512; seed (same description + style + seed = same picture). Images are saved
  as JPG (quality 92, default), PNG or WEBP in `Pictures\PixHaven` (changeable) with the prompt and settings inside (XMP description, all three formats); history in
  `generator-history.json`. Node 24 note: onnxruntime-node wraps fp16 data in a Float16Array its native side can't read,
  so the Uint16Array view is put back (`cpuData`). `PIXHAVEN_GEN_MODEL` points tests at a model folder;
  `PIXHAVEN_GEN_DL_TEST` downloads only the small files (resume/checksum test).
- **Batch upscale replaces the originals (0.7.7):** on by default ("Replace the originals" in the batch options, saved in
  settings as `replaceInBatch`). Each image is upscaled to a hidden temp file beside it, the original goes to the Recycle
  Bin, and the result takes its name and date (EXIF, colour profile, people and labels kept). Each keeps its own format;
  BMP and TIFF become PNG with the same name. Confirmed before starting. Off: "_upscaled" copies as before. Originals are
  read into memory, never opened by path (libvips keeps a JPEG open until GC, and Windows won't recycle an open file).
- **Face detection details (0.7.1–0.7.4):** a photo with no face at 0.85 confidence is read again at 0.72; detections with a
  weak fingerprint (tattoos, jewellery) and small detections inside a bigger face (close-ups seen through a tile) are dropped.
- **Tidy up:** duplicates = same SHA-1, or dHash within 6 bits ("same picture", catches resized/re-saved copies;
  different photos measured 15+ bits apart) or 10 bits ("near-identical"). The suggested keeper has the most pixels, then
  is sharpest. Blurry = sharpest 4×4 tile's Laplacian variance below 150 (sharp photos measured 580+). Dates come from
  EXIF (or the file date, optional); places from EXIF GPS → nearest town of 15,000+ people, preferring the biggest
  within 15 km (Eiffel Tower → Paris). Set-aside photos move into "PixHaven - Duplicates" / "PixHaven - Blurry".
- **Media library:** shows every drive (USB and network drives appear within 3 s) plus Pictures, Videos, Desktop,
  Downloads and Home. Only photos and videos are listed; folders found to hold none are hidden (checked a few levels
  down), as are system folders (Windows, Program Files, AppData, `$…`, `.…`; Settings can show them). Folders you may not
  open show a message. Thumbnails: sharp for JPG/PNG/WEBP/GIF/TIFF/AVIF, our BMP reader, FFmpeg for HEIC (phone tile
  grids and rotation) and videos (frame at 10 %, at most 30 s in), and the camera's own JPEG preview for RAW. On-screen
  files go first, then the rest of the folder, 2 at a time in low-spec mode (3 otherwise). The viewer shows JPG/PNG/WEBP/
  GIF/BMP/AVIF directly and a converted preview (max 4096 px) for HEIC, TIFF and RAW. Search by name filters the folder instantly; Enter searches all subfolders
  (5,000 results max).
- **Video player:** Chromium's player decodes H.264, HEVC, VP9 and AV1 on the GPU (D3D11; measured 0 dropped frames
  on 4K HEVC and AV1 with Intel Arc). MP4/MOV/M4V/3GP, WEBM and MKV with those codecs and AAC/MP3/Opus/Vorbis/FLAC sound
  play directly. The same video in another container (TS/MTS/M2TS, AVI…) or with other sound (AC-3, DTS, WMA) is
  *repackaged* by FFmpeg on the fly (video copied, sound to AAC). Other video (MPEG-2, MPEG-4 Part 2, WMV, FLV, Theora,
  10-bit H.264) is *converted* to H.264, at most 1080p, with Intel Quick Sync (else NVENC, AMF, Media Foundation,
  OpenH264). A direct file that fails steps down automatically. Streams restart on seek (copied streams on the keyframe
  before, then skip to the exact time). Other sound tracks play by repackaging. Subtitles: embedded text tracks, files
  next to the video ("Film.srt", "Film.en.srt", .ass, .vtt) or "Load subtitle file…"; old non-UTF-8 files are read as
  Windows-1252. Picture subtitles (DVD/Blu-ray) are not supported yet. Positions are saved every 5 s and offered on
  reopening; Home shows recently played videos. Keys: Space/K play, ←/→ 5 s (Shift 30 s), J/L 10 s, ↑/↓ volume, M, F,
  N/P next/previous, < > speed, Esc. Thumbnail work pauses while a video plays.
- **Labels and stars (photos and videos):** any number of labels per file (type to create, auto-complete), 0–5 stars; set from
  the grid or list, a selection (Ctrl+A, Ctrl/Shift-click → "Labels & stars", or L), the photo viewer or the player
  (side panel, keys 1–5, 0 clears, S opens the panel). Filters: labels all of / any of, minimum stars, in a folder or across everything ("Labels"
  at the top left lists everything labelled, wherever it is; files on unplugged drives show as offline). Manage labels:
  rename (onto an existing name merges), colour, delete everywhere. Saved instantly in `library.db` (inside the files
  only if TAG-08 is switched on, below), with a fingerprint per file (size + SHA-1 of the first and last MB): rename (F2) or move inside the app keeps
  them; renamed or moved outside the app, the file is found again when its folder is opened (or straight away inside a watched folder,
  or with Settings → "Find moved files"). Daily backup (last 7) in `%APPDATA%\PixHaven\backups`; Settings → Restore, Export (JSON with colours, or
  CSV for Excel), Import (also on another computer: files are matched by content, not by path — in watched folders without
  opening them), and "Change location" for library.db.
- **Playlists:** a filter (labels all of / any of, minimum stars) saved under a name, listed at the left; it stays up to
  date as you label and rate. "Play all" (P) / "Shuffle" play its videos one after another. Exported and imported with
  the labels.
- **Watched folders (Settings, or "Watch this folder" in the Library):** indexed into `library/index.db` (a rebuildable
  cache, ~65 MB per 100,000 files) one folder at a time, paused while a video plays, resumed where it stopped. Every start
  re-checks them in the background (≈ 4 s per 100,000 unchanged files) to catch changes made while PixHaven was closed;
  while it runs, Windows' change notifications (one recursive watch per folder) re-read just the folder that changed. Search
  inside a watched folder answers from the index at once; "All watched folders" filters by name, type, labels and stars
  without browsing; the open folder updates by itself. New files that are a labelled file moved or renamed (also between
  watched folders, or a renamed subfolder) keep their labels. A watched folder on an unplugged drive shows as offline,
  keeps its index and comes back when the drive does (checked every 30 s). Network drives that can't be watched are
  re-checked every 15 minutes.
- **Write into files (TAG-08, Settings, on by default since 0.7):** ExifTool writes stars (XMP Rating) and labels (XMP
  Subject) into JPG/PNG/WEBP/TIFF/HEIC/AVIF/GIF and MP4/MOV (plus Microsoft's rating and category, which Explorer shows as
  Rating and Tags; for JPG/TIFF also Explorer's EXIF Rating and XPKeywords); RAW files and other videos (MKV, AVI, WMV…)
  get `name.xmp` next to them, moved along when the file is renamed or moved in the app. File dates are kept. Changes are
  written 1.5 s after the last edit, in batches; a file open in the player waits; anything still waiting is written
  before PixHaven closes, and anything missed is written at the next start. Turning it off leaves files as they are.
- **Read from files (0.7):** stars, labels and people inside files (and `.xmp` sidecars) — from PixHaven on another
  computer, Explorer, Lightroom, a phone — are read when a folder is opened (in the background; only folders whose files
  changed) and for watched folders after indexing. They are merged into library.db so each label shows once, whichever
  fields or apps hold it: the first read adds them up, later reads apply only what changed in the file since. Storage:
  one line per folder read, no copy of the files' tags. The viewer shows the people in a photo.
- **Keyboard (Library):** arrows move (Shift selects), Enter opens, Space selects, 1–5/0 stars, L labels, F2 rename,
  Ctrl+F or / search, Backspace / Alt+← back, Alt+→, Alt+↑ up, F5 refresh, P play all, ? shows every shortcut (also in
  Settings).
- **Data:** `%APPDATA%\PixHaven` — settings.json, logs/, models/ (downloaded), facedata/ (face DB + thumbnails;
  Settings → Delete face data), library.db (labels, stars, playlists, playback positions), backups/, library/ (index.db for watched folders, thumbs.db and the thumbnail cache, trimmed to ~2 GB, oldest first; Settings → Clear).

## Renamed from ClearUp (0.6.0)

The 0.6.0 installer upgrades an installed ClearUp in place (same app id): the old version is removed, shortcuts and the
Explorer menu become PixHaven, and on first start `%APPDATA%ClearUp` (settings, labels, backups, face data, thumbnails,
watched-folder index) moves to `%APPDATA%PixHaven`. Label exports made by ClearUp still import. Internal names stay
as they were: the `clearup://` scheme, `.clearup` undo logs in sorted folders (so earlier sorts can still be undone).

## Releases and auto-update

Auto-update is on: installed copies (0.6.0 and later) check the GitHub Releases of
[sankethhegde/pixhaven](https://github.com/sankethhegde/pixhaven) 15 s after start, download a newer version in the
background and install it when PixHaven closes (Settings → Updates shows the state; "Restart and update" installs at once).

To release a new version:

1. Raise `"version"` in `package.json` (e.g. 0.6.1), commit and push.
2. Tag it and push the tag: `git tag v0.6.1` then `git push origin v0.6.1`.
3. GitHub Actions builds and tests Windows and Linux and uploads the installers to a **draft** release.
4. On GitHub → Releases, check the draft, write what changed, and press **Publish release**. Installed copies pick it
   up from then on. (Drafts are never offered as updates.)

From this laptop instead of GitHub Actions: `set GH_TOKEN=<a token with "repo" access>` then `npm run release`
(Windows installer only, also as a draft).

The repository is public: update checks need no token. Making it private would stop updates from reaching installed copies.

## Known limits

- Unsigned installer: SmartScreen shows "Unknown publisher" (More info → Run anyway). A certificate fixes it.
- Installer is ~250 MB: Electron (~100 MB), ONNX Runtime + DirectML (~65 MB), FFmpeg (~150 MB unpacked), ExifTool (~35 MB unpacked), face models (~65 MB), image library.
- A group photo moved or renamed outside PixHaven drops out of the other people's folders (its people stay inside the file).
- DNG files from phones often carry only a small preview (e.g. 672×504); RAW files are never developed from sensor data.
- Sort by person: "minimum photos per person" defaults to 2 (changed from the doc's 1 so one-off faces go to "Unsorted").
- "Send to Recycle Bin" can't be undone by PixHaven (restore from the bin); all moves can.
- The Explorer right-click entry appears only after installing with the setup program.
