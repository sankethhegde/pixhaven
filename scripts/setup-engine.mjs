// Downloads the upscaling engine, face models, OCR data and place names into resources/ (run once after npm install).
// Works on Windows and Linux; each fetches the engine build for its own platform.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const RELEASE = 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/';
const ENGINE_URL = RELEASE + (WIN ? 'realesrgan-ncnn-vulkan-20220424-windows.zip' : 'realesrgan-ncnn-vulkan-20220424-ubuntu.zip');
const FACE = {
  'yunet.onnx': 'https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  'sface.onnx': 'https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx',
};
const zip = WIN ? 'vendor/dl/realesrgan-win.zip' : 'vendor/dl/realesrgan-linux.zip';
const unpacked = WIN ? 'vendor/realesrgan' : 'vendor/realesrgan-linux';
const BIN_DIR = WIN ? 'resources/bin/win' : 'resources/bin/linux';
const EXE = WIN ? 'realesrgan-ncnn-vulkan.exe' : 'realesrgan-ncnn-vulkan';

/** Unzip with Windows' bsdtar, or "unzip" on Linux (GNU tar cannot read zip files). */
function unzip(file, dir, ...members) {
  if (WIN) execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', dir, ...members]);
  else execFileSync('unzip', ['-o', '-q', file, ...members.map(m => m + (m.includes('.') ? '' : '/*')), '-d', dir]);
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return;
  console.log('Downloading', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

fs.mkdirSync('vendor/dl', { recursive: true });
await download(ENGINE_URL, zip);
if (!fs.existsSync(`${unpacked}/${EXE}`)) {
  fs.mkdirSync(unpacked, { recursive: true });
  unzip(zip, unpacked);
}
for (const d of [BIN_DIR, 'resources/models/face', 'resources/models-quality', 'resources/ocr']) fs.mkdirSync(d, { recursive: true });
for (const f of WIN ? [EXE, 'vcomp140.dll'] : [EXE]) fs.copyFileSync(`${unpacked}/${f}`, `${BIN_DIR}/${f}`);
if (!WIN) fs.chmodSync(`${BIN_DIR}/${EXE}`, 0o755);
// Only the compact "Fast" model ships in the installer; quality models download on first use (dev keeps a copy).
for (const f of fs.readdirSync(`${unpacked}/models`)) {
  const dest = f.startsWith('realesr-animevideov3') ? 'resources/models' : 'resources/models-quality';
  fs.copyFileSync(`${unpacked}/models/${f}`, `${dest}/${f}`);
  if (dest === 'resources/models-quality') fs.rmSync(`resources/models/${f}`, { force: true });
}
for (const [name, url] of Object.entries(FACE)) await download(url, `resources/models/face/${name}`);
fs.copyFileSync('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', 'resources/ocr/eng.traineddata.gz');

// Offline place names for "sort by place": GeoNames cities with 15,000+ people (CC BY 4.0).
fs.mkdirSync('vendor/geo', { recursive: true });
fs.mkdirSync('resources/geo', { recursive: true });
await download('https://download.geonames.org/export/dump/cities15000.zip', 'vendor/geo/cities15000.zip');
await download('https://download.geonames.org/export/dump/countryInfo.txt', 'vendor/geo/countryInfo.txt');
unzip('vendor/geo/cities15000.zip', 'vendor/geo');
const countries = {};
for (const line of fs.readFileSync('vendor/geo/countryInfo.txt', 'utf8').split(/\r?\n/)) {
  if (!line || line.startsWith('#')) continue;
  const f = line.split('\t');
  countries[f[0]] = f[4];
}
// Skip city sections ("Paris 16 Passy", "Times Square"), historical, abandoned and destroyed places:
// folders should name real towns.
const SKIP = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH']);
const cities = fs.readFileSync('vendor/geo/cities15000.txt', 'utf8').split(/\r?\n/).filter(Boolean)
  .map(line => line.split('\t'))
  .filter(f => !SKIP.has(f[7]))
  .map(f => [f[1], f[8], Math.round(+f[4] * 1000) / 1000, Math.round(+f[5] * 1000) / 1000, +f[14]]);
fs.writeFileSync('resources/geo/places.json', JSON.stringify({ source: 'GeoNames cities15000, CC BY 4.0', countries, cities }));
console.log(`Places: ${cities.length} cities, ${Object.keys(countries).length} countries`);

// FFmpeg + FFprobe for the media library (video thumbnails and info, HEIC photos): LGPL build, shared libraries.
const FF = WIN ? 'ffmpeg-n9.0-latest-win64-lgpl-shared-9.0' : 'ffmpeg-n9.0-latest-linux64-lgpl-shared-9.0';
const ffArchive = `vendor/dl/${FF}${WIN ? '.zip' : '.tar.xz'}`;
await download(`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${FF}${WIN ? '.zip' : '.tar.xz'}`, ffArchive);
if (!fs.existsSync(`vendor/ffmpeg/${FF}`)) {
  fs.mkdirSync('vendor/ffmpeg', { recursive: true });
  if (WIN) unzip(ffArchive, 'vendor/ffmpeg');
  else execFileSync('tar', ['-xJf', ffArchive, '-C', 'vendor/ffmpeg']);
}
const ffDest = `${BIN_DIR}/ffmpeg`;
fs.rmSync(ffDest, { recursive: true, force: true });
if (WIN) {
  fs.mkdirSync(ffDest, { recursive: true });
  for (const f of fs.readdirSync(`vendor/ffmpeg/${FF}/bin`)) {
    if (f === 'ffmpeg.exe' || f === 'ffprobe.exe' || f.endsWith('.dll')) fs.copyFileSync(`vendor/ffmpeg/${FF}/bin/${f}`, `${ffDest}/${f}`);
  }
} else {
  // bin/ finds its libraries in ../lib (rpath $ORIGIN/../lib); cp -a keeps the .so symlinks.
  fs.mkdirSync(`${ffDest}/bin`, { recursive: true });
  for (const f of ['ffmpeg', 'ffprobe']) fs.copyFileSync(`vendor/ffmpeg/${FF}/bin/${f}`, `${ffDest}/bin/${f}`);
  execFileSync('cp', ['-a', `vendor/ffmpeg/${FF}/lib`, `${ffDest}/lib`]);
  for (const f of ['ffmpeg', 'ffprobe']) fs.chmodSync(`${ffDest}/bin/${f}`, 0o755);
}
fs.copyFileSync(`vendor/ffmpeg/${FF}/LICENSE.txt`, 'resources/licences/FFmpeg (LGPL-3.0).txt');

// ExifTool (v2.1, TAG-08: stars and labels written into files): the packaged builds from the exiftool-vendored
// project, pinned. Windows: a self-contained exiftool.exe; Linux: the Perl script (uses the system's perl).
const ET_VER = '13.59.3';
const etPkg = WIN ? 'exiftool-vendored.exe' : 'exiftool-vendored.pl';
const etArchive = `vendor/dl/${etPkg}-${ET_VER}.tgz`;
await download(`https://registry.npmjs.org/${etPkg}/-/${etPkg}-${ET_VER}.tgz`, etArchive);
const etDir = `vendor/exiftool-${WIN ? 'win' : 'linux'}`;
if (!fs.existsSync(`${etDir}/package`)) {
  fs.mkdirSync(etDir, { recursive: true });
  execFileSync(WIN ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xzf', etArchive, '-C', etDir]);
}
const etDest = `${BIN_DIR}/exiftool`;
fs.rmSync(etDest, { recursive: true, force: true });
fs.cpSync(`${etDir}/package/bin`, etDest, { recursive: true });
if (!WIN) fs.chmodSync(`${etDest}/exiftool`, 0o755);
fs.writeFileSync('resources/licences/ExifTool (Perl Artistic or GPL).txt', `ExifTool by Phil Harvey — https://exiftool.org
Packaged by the exiftool-vendored project (https://github.com/photostructure/exiftool-vendored.js), version ${ET_VER}.

This is free software; you can redistribute it and/or modify it under the same terms as Perl itself:
either the Artistic License (https://dev.perl.org/licenses/artistic.html) or the GNU General Public License
(https://www.gnu.org/licenses/gpl-1.0.html), at your option.
${WIN ? '\nThe Windows build bundles a Perl runtime (Strawberry Perl), distributed under the same terms as Perl.\n' : ''}`);
console.log('Ready: engine, Fast model, face models, OCR data, places, FFmpeg and ExifTool in resources/');
