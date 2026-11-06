// v1.0.4: the details card — FFprobe facts for videos, ExifTool facts for photos, size and dates for anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { load } from './helper.mjs';
import { FFMPEG_DIR } from './make-media.mjs';

const D = await load('library/details');
D.setFfmpegDir(FFMPEG_DIR);
const EXIFTOOL = path.resolve(process.platform === 'win32' ? 'resources/bin/win/exiftool/exiftool.exe' : 'resources/bin/linux/exiftool/exiftool');
const ffmpeg = path.join(FFMPEG_DIR, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixhaven-details-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('video: length, resolution, codec, frame rate, bitrate and audio', async () => {
  const file = path.join(tmp, 'clip – café.mp4');
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', file]);
  if (r.status !== 0) {   // the LGPL build may lack libx264: fall back to MPEG-4
    const r2 = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2',
      '-c:v', 'mpeg4', '-c:a', 'aac', '-ac', '2', '-shortest', '-y', file]);
    assert.equal(r2.status, 0, String(r2.stderr));
  }
  const d = await D.fileDetails(file, { exiftool: null });
  assert.equal(d.kind, 'video');
  assert.equal(d.name, 'clip – café.mp4');
  assert.equal(d.width, 320); assert.equal(d.height, 240);
  assert.ok(Math.abs(d.duration - 2) < 0.2, `length ${d.duration}`);
  assert.equal(d.fps, 25);
  assert.match(d.videoCodec, /H\.264|MPEG-4/);
  assert.ok(d.bitrate > 0);
  assert.deepEqual(d.audio, ['AAC stereo']);
  assert.equal(d.size, fs.statSync(file).size);
  assert.equal(d.error, undefined);
});

test('photo: date taken, camera, lens and exposure from EXIF; turned photos report the size as shown', async () => {
  const file = path.join(tmp, 'photo ಕನ್ನಡ.jpg');
  await sharp({ create: { width: 400, height: 300, channels: 3, background: '#4a7' } }).jpeg().toFile(file);
  const args = path.join(tmp, 'w.args');
  fs.writeFileSync(args, ['-charset', 'filename=utf8', '-overwrite_original', '-Make=Canon', '-Model=Canon EOS R6', '-LensModel=RF24-105mm F4 L IS USM',
    '-DateTimeOriginal=2024:05:01 10:22:13', '-FNumber=4', '-ExposureTime=1/250', '-ISO=200', '-FocalLength=50', '-Orientation#=6', file].join('\n') + '\n', 'utf8');
  const w = spawnSync(EXIFTOOL, ['-@', args]);
  assert.equal(w.status, 0, String(w.stderr));
  const d = await D.fileDetails(file, { exiftool: EXIFTOOL, people: async () => ['Mom', 'Person 2'] });
  assert.equal(d.kind, 'image');
  assert.equal(d.format, 'JPEG');
  assert.equal(d.width, 300, 'Orientation 6: shown turned'); assert.equal(d.height, 400);
  assert.equal(d.taken, '2024:05:01 10:22:13');
  assert.equal(d.camera, 'Canon EOS R6', 'make not repeated');
  assert.equal(d.lens, 'RF24-105mm F4 L IS USM');
  assert.equal(d.exposure, 'f/4 · 1/250 s · ISO 200 · 50 mm');
  assert.deepEqual(d.people, ['Mom', 'Person 2']);
});

test('photo without EXIF or ExifTool: the size still comes from the image', async () => {
  const file = path.join(tmp, 'plain.png');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#123' } }).png().toFile(file);
  const d = await D.fileDetails(file, { exiftool: null, imageSize: async f => { const m = await sharp(f).metadata(); return { width: m.width, height: m.height, format: m.format }; } });
  assert.equal(d.width, 64); assert.equal(d.height, 48); assert.equal(d.format, 'PNG');
  assert.equal(d.camera, undefined);
});

test('a broken video still shows name, size and dates, with the reason', async () => {
  const file = path.join(tmp, 'broken.mp4');
  fs.writeFileSync(file, 'not a video');
  const d = await D.fileDetails(file, { exiftool: null });
  assert.equal(d.size, 11);
  assert.ok(d.modified > 0);
  assert.ok(d.error, 'reason given');
});

test('camera names: make and model joined only when the model does not already start with it', () => {
  assert.equal(D.photoFacts({ Make: 'Apple', Model: 'iPhone 15 Pro' }).camera, 'Apple iPhone 15 Pro');
  assert.equal(D.photoFacts({ Make: 'NIKON CORPORATION', Model: 'NIKON Z 6' }).camera, 'NIKON Z 6');
  assert.equal(D.photoFacts({ DateTimeOriginal: '0000:00:00 00:00:00' }).taken, undefined, 'empty date left out');
  assert.equal(D.videoFacts({ streams: [{ codec_type: 'video', codec_name: 'hevc', width: 1920, height: 1080, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] }], format: {} }).width, 1080, 'phone video shown upright');
});
