// Builds the mixed-format test folder for the media library: one file per format in LIB-03 and LIB-04,
// plus things that must stay hidden (documents, a folder with no media, system folders).
// Videos are made with the bundled FFmpeg, HEIC with tests/make-heic.mjs, RAW files come from raw.pixls.us (CC0).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { makeHeic } from './make-heic.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const WIN = process.platform === 'win32';
export const FFMPEG_DIR = path.join(root, 'resources', 'bin', WIN ? 'win' : 'linux', 'ffmpeg', ...(WIN ? [] : ['bin']));
const ffmpeg = path.join(FFMPEG_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg');

const RAW = {
  'canon.cr2': 'Canon/EOS%20600D/_MG_2587.CR2',
  'canon.cr3': 'Canon/Canon%20EOS%20M200/_MG_2233.CR3',
  'nikon.nef': 'Nikon/D3400/DSC_0202.NEF',
  'sony.arw': 'Sony/ILCE-6000/DSC01542.ARW',
  'pixel.dng': 'Google/Pixel%203a/IMG_20190918_164153.dng',
  'olympus.orf': 'Olympus/E-M10/P3180165.ORF',
  'panasonic.rw2': 'Panasonic/DC-G9/P1000951.RW2',
};

/** Video formats: [file, extra ffmpeg args]. 4 s of test pattern with a tone. */
const VIDEOS = [
  ['clip h264.mp4', ['-c:v', 'libopenh264', '-c:a', 'aac']],
  ['clip.m4v', ['-c:v', 'libopenh264', '-c:a', 'aac']],
  ['clip hevc.mkv', ['-c:v', 'libkvazaar', '-c:a', 'libopus']],
  ['clip.avi', ['-c:v', 'mpeg4', '-c:a', 'libmp3lame']],
  ['clip.mov', ['-c:v', 'libopenh264', '-c:a', 'aac']],
  ['clip.wmv', ['-c:v', 'wmv2', '-c:a', 'wmav2']],
  ['clip.flv', ['-c:v', 'flv', '-c:a', 'libmp3lame', '-ar', '44100']],
  ['clip vp9.webm', ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus']],
  ['clip.3gp', ['-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '1', '-ar', '16000']],
  ['clip.mpg', ['-c:v', 'mpeg2video', '-c:a', 'mp2']],
  ['clip.ts', ['-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'mpegts']],
  ['clip.mts', ['-c:v', 'libopenh264', '-c:a', 'ac3', '-f', 'mpegts']],
  ['clip.m2ts', ['-c:v', 'libopenh264', '-c:a', 'ac3', '-f', 'mpegts']],
  ['clip.vob', ['-c:v', 'mpeg2video', '-c:a', 'mp2', '-f', 'vob']],
  ['clip.ogv', ['-c:v', 'libtheora', '-c:a', 'libvorbis']],
  ['clip av1.mp4', ['-c:v', 'libsvtav1', '-preset', '12', '-c:a', 'aac']],
];

async function fetchRaw(dir) {
  const cache = path.join(root, 'vendor', 'testmedia');
  fs.mkdirSync(cache, { recursive: true });
  for (const [name, url] of Object.entries(RAW)) {
    const local = path.join(cache, path.basename(decodeURIComponent(url)));
    if (!fs.existsSync(local)) {
      console.log('Downloading', url);
      const res = await fetch(`https://raw.pixls.us/data/${url}`);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const part = `${local}.${process.pid}.part`;
      fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
      try { fs.renameSync(part, local); } catch { fs.rmSync(part, { force: true }); }   // the other test file won the race
    }
    for (let i = 0; ; i++) {                     // Windows: busy for a moment while the other test file renames it
      try { fs.copyFileSync(local, path.join(dir, name)); break; } catch (e) { if (i > 20) throw e; await new Promise(r => setTimeout(r, 250)); }
    }
  }
}

/**
 * A real photo from phase0/testphotos when it was downloaded (phase0/fetch-test-photos.mjs), otherwise a made-up one
 * — a fresh clone (GitHub Actions) has no test photos.
 */
async function samplePhoto() {
  const dir = path.join(root, 'phase0', 'testphotos');
  const real = fs.existsSync(dir) && fs.readdirSync(dir).find(f => /^Angela Merkel/.test(f));
  if (real) return path.join(dir, real);
  const file = path.join(root, 'vendor', 'testmedia', 'sample-photo.jpg');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#7ab8ff"/><stop offset="1" stop-color="#ffd9a0"/></linearGradient></defs>
      <rect width="1600" height="1067" fill="url(#s)"/><circle cx="1150" cy="330" r="120" fill="#ffcf4a"/>
      <path d="M0 800 L400 420 L700 700 L1000 380 L1600 860 V1067 H0Z" fill="#3c6e47"/>
      <path d="M0 950 L500 760 L900 900 L1600 780 V1067 H0Z" fill="#24452c"/></svg>`;
    await sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toFile(file);
  }
  return file;
}

/** Returns the media files that must all show a thumbnail. */
export async function makeMediaFolder(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const src = await samplePhoto();
  const photo = () => sharp(src).resize(1200);
  await photo().jpeg().toFile(path.join(dir, 'photo.jpg'));
  // Stored 1200×800 with EXIF orientation 6 (camera held upright): shown 800×1200.
  await sharp(src).resize(1200, 800, { fit: 'cover' }).withMetadata({ orientation: 6 }).jpeg().toFile(path.join(dir, 'portrait.jpeg'));
  await photo().png().toFile(path.join(dir, 'photo.png'));
  await photo().webp().toFile(path.join(dir, 'photo.webp'));
  await photo().tiff().toFile(path.join(dir, 'photo.tif'));
  await photo().gif().toFile(path.join(dir, 'photo.gif'));
  await photo().avif({ effort: 0 }).toFile(path.join(dir, 'photo.avif'));
  // 24-bit BMP, written by hand (sharp has no BMP writer).
  {
    const { data, info } = await photo().resize(400).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const row = Math.ceil((info.width * 3) / 4) * 4, size = 54 + row * info.height, b = Buffer.alloc(size);
    b.write('BM'); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
    b.writeInt32LE(info.width, 18); b.writeInt32LE(info.height, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28);
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const s = (y * info.width + x) * 3, d = 54 + (info.height - 1 - y) * row + x * 3;
      b[d] = data[s + 2]; b[d + 1] = data[s + 1]; b[d + 2] = data[s];
    }
    fs.writeFileSync(path.join(dir, 'photo.bmp'), b);
  }
  makeHeic(ffmpeg, src, path.join(dir, 'phone.heic'));
  makeHeic(ffmpeg, src, path.join(dir, 'phone upright.heif'), true);
  await fetchRaw(dir);

  for (const [name, args] of VIDEOS) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-pix_fmt', 'yuv420p', ...args, '-shortest', path.join(dir, name)], { stdio: 'ignore' });
  }
  // A phone video filmed upright: stored 640×360 with a 90° rotation tag, shown 360×640.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-display_rotation', '90', '-i', path.join(dir, 'clip h264.mp4'), '-c', 'copy', path.join(dir, 'phone video.mp4')], { stdio: 'ignore' });

  // Must stay hidden: documents, a folder without media, system and dot folders.
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not media');
  fs.writeFileSync(path.join(dir, 'report.pdf'), '%PDF-1.4');
  fs.mkdirSync(path.join(dir, 'Documents only'));
  fs.writeFileSync(path.join(dir, 'Documents only', 'letter.txt'), 'hi');
  for (const d of ['AppData', '.cache', '$Recycle.Bin']) { fs.mkdirSync(path.join(dir, d)); fs.copyFileSync(path.join(dir, 'photo.jpg'), path.join(dir, d, 'hidden.jpg')); }
  // Shown: a folder whose photos are two levels down.
  fs.mkdirSync(path.join(dir, 'Goa trip', 'Day 1'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'photo.jpg'), path.join(dir, 'Goa trip', 'Day 1', 'beach sunset.jpg'));

  return fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile() && !/\.(txt|pdf)$/.test(f));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const files = await makeMediaFolder(path.resolve(process.argv[2] ?? 'e2e-output/media'));
  console.log(`${files.length} media files:`, files.join(', '));
}

/**
 * Phase B extras on top of the mixed folder: 4K HEVC and 4K AV1 (made on the GPU when it can), an MKV with two sound
 * tracks and a subtitle track, and a subtitle file next to "clip h264.mp4".
 */
export async function makePlayerFolder(dir) {
  const files = await makeMediaFolder(dir);
  const ff = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { stdio: 'ignore' });
  const try4k = (name, encoders) => {
    for (const enc of encoders) {
      try {
        ff(['-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=10', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=10',
          '-pix_fmt', 'nv12', ...enc, '-c:a', 'aac', '-shortest', path.join(dir, name)]);
        return;
      } catch { /* next encoder */ }
    }
    throw new Error(`Could not make ${name}`);
  };
  try4k('4k hevc.mp4', [['-c:v', 'hevc_qsv', '-global_quality', '25', '-tag:v', 'hvc1'], ['-c:v', 'libkvazaar', '-kvazaar-params', 'preset=ultrafast:period=30', '-tag:v', 'hvc1']]);
  try4k('4k av1.mp4', [['-c:v', 'av1_qsv', '-global_quality', '30'], ['-c:v', 'libsvtav1', '-preset', '12']]);
  const srt = path.join(dir, 'tracks.srt.tmp');
  fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:04,000\nEmbedded subtitle line\n\n2\n00:00:12,000 --> 00:00:15,000\nSecond embedded line\n');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20', '-i', srt,
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s', '-pix_fmt', 'yuv420p', '-c:v', 'libopenh264', '-g', '50', '-c:a', 'aac', '-c:s', 'srt',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:0', 'title=English', '-metadata:s:a:1', 'language=hin', '-metadata:s:a:1', 'title=Hindi',
    '-metadata:s:s:0', 'language=eng', '-t', '20', path.join(dir, 'two tracks.mkv')]);
  fs.rmSync(srt);
  fs.writeFileSync(path.join(dir, 'clip h264.srt'), '1\r\n00:00:00,500 --> 00:00:03,500\r\nHello from the subtitle file\r\n');
  return [...files, '4k hevc.mp4', '4k av1.mp4', 'two tracks.mkv'];
}
