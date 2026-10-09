// Builds a phone-style HEIC test file: a grid of 512×512 HEVC tiles (like an iPhone photo), optionally rotated.
// Tiles are encoded with the bundled FFmpeg (libkvazaar); the HEIF boxes are written here.
// Usage: node tests/make-heic.mjs <ffmpeg> <source image> <out.heic> [--rotate]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TILE = 512, COLS = 3, ROWS = 2, OUT_W = 1400, OUT_H = 1000;

const u8 = n => Buffer.from([n & 255]);
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);

/** Annex B stream → NAL units. */
function nals(buf) {
  const out = [];
  let i = 0, start = -1;
  while (i + 3 <= buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && (buf[i + 2] === 1 || (buf[i + 2] === 0 && buf[i + 3] === 1))) {
      if (start >= 0) out.push(buf.subarray(start, i));
      i += buf[i + 2] === 1 ? 3 : 4;
      start = i;
    } else i++;
  }
  if (start >= 0) out.push(buf.subarray(start));
  return out.map(n => { let e = n.length; while (e > 0 && n[e - 1] === 0) e--; return n.subarray(0, e); });
}
const nalType = n => (n[0] >> 1) & 0x3f;

function hvcC(params) {
  const sps = params.find(n => nalType(n) === 33);
  const ptl = sps.subarray(3, 15);                     // general profile_tier_level (12 bytes) after the NAL header + 1 byte
  const arrays = [32, 33, 34].map(t => {
    const list = params.filter(n => nalType(n) === t);
    return Buffer.concat([u8(0x80 | t), u16(list.length), ...list.flatMap(n => [u16(n.length), n])]);
  });
  return box('hvcC', u8(1), ptl.subarray(0, 1), ptl.subarray(1, 5), ptl.subarray(5, 11), ptl.subarray(11, 12),
    u16(0xf000), u8(0xfc), u8(0xfd), u8(0xf8), u8(0xf8), u16(0), u8(0x0f), u8(arrays.length), ...arrays);
}

export function makeHeic(ffmpeg, source, out, rotate = false) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-'));
  const tiles = [];
  let params = null;
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const f = path.join(tmp, `t${r}${c}.hevc`);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', source, '-vf',
      `scale=${COLS * TILE}:${ROWS * TILE},crop=${TILE}:${TILE}:${c * TILE}:${r * TILE},format=yuv420p`,
      '-frames:v', '1', '-c:v', 'libkvazaar', '-f', 'hevc', f], { stdio: 'ignore' });
    const units = nals(fs.readFileSync(f));
    params ??= units.filter(n => nalType(n) >= 32 && nalType(n) <= 34);
    tiles.push(Buffer.concat(units.filter(n => nalType(n) < 32).flatMap(n => [u32(n.length), n])));
  }
  fs.rmSync(tmp, { recursive: true, force: true });

  const GRID = 1, first = 2, ids = tiles.map((_, i) => first + i);
  const gridData = Buffer.concat([u8(0), u8(0), u8(ROWS - 1), u8(COLS - 1), u16(OUT_W), u16(OUT_H)]);
  const payloads = [[GRID, gridData], ...ids.map((id, i) => [id, tiles[i]])];

  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('mif1heic'));
  const build = mdatStart => {
    let off = mdatStart + 8;
    const entries = payloads.map(([id, data]) => { const e = Buffer.concat([u16(id), u16(0), u16(1), u32(off), u32(data.length)]); off += data.length; return e; });
    const props = [hvcC(params), full('ispe', 0, 0, u32(TILE), u32(TILE)), full('ispe', 0, 0, u32(OUT_W), u32(OUT_H))];
    if (rotate) props.push(box('irot', u8(1)));            // 90° anticlockwise, like a phone held upright
    const assoc = (id, list) => Buffer.concat([u16(id), u8(list.length), ...list.map(([idx, ess]) => u8((ess ? 0x80 : 0) | idx))]);
    const ipma = full('ipma', 0, 0, u32(1 + ids.length),
      assoc(GRID, rotate ? [[3, false], [4, true]] : [[3, false]]), ...ids.map(id => assoc(id, [[1, true], [2, false]])));
    return box('meta', u8(0), u8(0), u16(0),
      full('hdlr', 0, 0, u32(0), Buffer.from('pict'), u32(0), u32(0), u32(0), u8(0)),
      full('pitm', 0, 0, u16(GRID)),
      full('iloc', 0, 0, u8(0x44), u8(0), u16(payloads.length), ...entries),
      full('iinf', 0, 0, u16(payloads.length),
        full('infe', 2, 0, u16(GRID), u16(0), Buffer.from('grid'), u8(0)),
        ...ids.map(id => full('infe', 2, 1, u16(id), u16(0), Buffer.from('hvc1'), u8(0)))),
      full('iref', 0, 0, box('dimg', u16(GRID), u16(ids.length), ...ids.map(u16))),
      box('iprp', box('ipco', ...props), ipma));
  };
  const meta = build(ftyp.length + build(0).length);
  const body = Buffer.concat(payloads.map(p => p[1]));
  fs.writeFileSync(out, Buffer.concat([ftyp, meta, u32(8 + body.length), Buffer.from('mdat'), body]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'))) {
  const [ffmpeg, source, out] = process.argv.slice(2);
  makeHeic(ffmpeg, source, out, process.argv.includes('--rotate'));
  console.log('Wrote', out);
}
