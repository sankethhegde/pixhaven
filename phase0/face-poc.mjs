// Phase 0 face-grouping proof of concept: YuNet (detect) + SFace (fingerprint) + clustering.
// Usage: node face-poc.mjs <photo folder> [--strict 0.36] [--dml]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import ort from 'onnxruntime-node';

const args = process.argv.slice(2);
const folder = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MATCH = parseFloat(opt('--strict', '0.36'));   // cosine similarity needed to call two faces the same person
const MIN_FACE = 40;          // px (in the ≤1280 working image)
const SCORE = 0.85;           // detector confidence
const DET = 640;              // YuNet input is fixed 640×640
const MAX_SIDE = 1280;        // doc: photos resized to ~1280 px before detection
const ep = args.includes('--dml') ? ['dml', 'cpu'] : ['cpu'];
const IMG_EXT = /\.(jpe?g|png|webp|bmp|tiff?)$/i;

const so = { logSeverityLevel: 3, executionProviders: ep };
const yunet = await ort.InferenceSession.create(fileURLToPath(new URL('../vendor/face/yunet.onnx', import.meta.url)), so);
const sface = await ort.InferenceSession.create(fileURLToPath(new URL('../vendor/face/sface.onnx', import.meta.url)), so);

// ---------- detection ----------
async function detectIn(rgb, W, H, ox, oy, w, h) {
  // Crop (ox,oy,w,h) of the RGB image, letterbox-scale into 640×640, run YuNet, map boxes back.
  const s = Math.min(DET / w, DET / h);
  const input = new Float32Array(3 * DET * DET);
  for (let y = 0; y < DET; y++) for (let x = 0; x < DET; x++) {
    const sx = Math.floor(x / s) + ox, sy = Math.floor(y / s) + oy;
    if (sx >= ox + w || sy >= oy + h || sx >= W || sy >= H) continue;
    const i = (sy * W + sx) * 3, o = y * DET + x;
    input[o] = rgb[i + 2]; input[DET * DET + o] = rgb[i + 1]; input[2 * DET * DET + o] = rgb[i]; // BGR
  }
  const out = await yunet.run({ input: new ort.Tensor('float32', input, [1, 3, DET, DET]) });
  const faces = [];
  for (const st of [8, 16, 32]) {
    const cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data, kp = out['kps_' + st].data;
    const cols = DET / st;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < SCORE) continue;
      const c = i % cols, r = Math.floor(i / cols);
      const cx = (c + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st;
      const bw = Math.exp(bb[i * 4 + 2]) * st, bh = Math.exp(bb[i * 4 + 3]) * st;
      const kps = [];
      for (let k = 0; k < 5; k++) kps.push([(kp[i * 10 + 2 * k] + c) * st / s + ox, (kp[i * 10 + 2 * k + 1] + r) * st / s + oy]);
      faces.push({ x: (cx - bw / 2) / s + ox, y: (cy - bh / 2) / s + oy, w: bw / s, h: bh / s, score, kps });
    }
  }
  return faces;
}

const iou = (a, b) => {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
};
function nms(faces) {
  faces.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of faces) if (keep.every(k => iou(k, f) < 0.3)) keep.push(f);
  return keep;
}

async function detect(rgb, W, H) {
  let faces = await detectIn(rgb, W, H, 0, 0, W, H);
  // Large photos: also scan overlapping 640-px tiles so small faces in group shots are found.
  if (Math.max(W, H) > DET * 1.2) {
    const step = DET * 0.75;
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      const tx = Math.min(x, Math.max(0, W - DET)), ty = Math.min(y, Math.max(0, H - DET));
      faces.push(...await detectIn(rgb, W, H, tx, ty, Math.min(DET, W), Math.min(DET, H)));
      if (x + DET >= W) break;
    }
  }
  return nms(faces).filter(f => Math.min(f.w, f.h) >= MIN_FACE);
}

// ---------- alignment + fingerprint ----------
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

function similarity(src, dst) {
  // Least-squares similarity transform (Umeyama, 2D) mapping src -> dst. Returns [a,b,tx,ty]: x' = a x - b y + tx, y' = b x + a y + ty
  const n = src.length;
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; nx += dst[i][0]; ny += dst[i][1]; }
  mx /= n; my /= n; nx /= n; ny /= n;
  let sxx = 0, sab = 0, sad = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - nx, v = dst[i][1] - ny;
    sxx += x * x + y * y; sab += x * u + y * v; sad += x * v - y * u;
  }
  const a = sab / sxx, b = sad / sxx;
  return [a, b, nx - (a * mx - b * my), ny - (b * mx + a * my)];
}

function alignCrop(rgb, W, H, kps) {
  // Inverse-map every 112×112 output pixel back into the photo (bilinear), giving an RGB face chip.
  const [a, b, tx, ty] = similarity(kps, TEMPLATE);
  const det = a * a + b * b;
  const out = new Uint8Array(112 * 112 * 3);
  for (let v = 0; v < 112; v++) for (let u = 0; u < 112; u++) {
    const du = u - tx, dv = v - ty;
    const x = (a * du + b * dv) / det, y = (-b * du + a * dv) / det;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (let ch = 0; ch < 3; ch++) {
      const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : rgb[(yy * W + xx) * 3 + ch];
      const val = px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
      out[(v * 112 + u) * 3 + ch] = Math.round(val);
    }
  }
  return out;
}

async function fingerprint(chip) {
  const t = new Float32Array(3 * 112 * 112);
  for (let i = 0; i < 112 * 112; i++) { t[i] = chip[i * 3]; t[112 * 112 + i] = chip[i * 3 + 1]; t[2 * 112 * 112 + i] = chip[i * 3 + 2]; } // RGB
  const out = await sface.run({ data: new ort.Tensor('float32', t, [1, 3, 112, 112]) });
  const f = Float32Array.from(out.fc1.data);
  const norm = Math.hypot(...f);
  return f.map(x => x / norm);
}
const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

// ---------- clustering (average-linkage agglomerative) ----------
function cluster(faces) {
  let groups = faces.map((f, i) => [i]);
  const sim = faces.map(a => faces.map(b => cos(a.fp, b.fp)));
  for (;;) {
    let best = -1, bi = -1, bj = -1;
    for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
      let s = 0;
      for (const p of groups[i]) for (const q of groups[j]) s += sim[p][q];
      s /= groups[i].length * groups[j].length;
      if (s > best) { best = s; bi = i; bj = j; }
    }
    if (best < MATCH) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }
  return groups.sort((a, b) => b.length - a.length);
}

// ---------- run ----------
const files = fs.readdirSync(folder).filter(f => IMG_EXT.test(f)).sort();
const faces = [], noFace = [], failed = [];
const t0 = performance.now();
let tDet = 0, tRec = 0;
for (const file of files) {
  let img;
  try {
    img = await sharp(path.join(folder, file)).rotate()
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (e) { failed.push(file); continue; }
  const { data, info: { width: W, height: H } } = img;
  let t = performance.now();
  const found = await detect(data, W, H);
  tDet += performance.now() - t; t = performance.now();
  if (!found.length) noFace.push(file);
  for (const f of found) {
    const chip = alignCrop(data, W, H, f.kps);
    faces.push({ file, box: f, chip, fp: await fingerprint(chip) });
  }
  tRec += performance.now() - t;
}
const groups = cluster(faces);
const total = (performance.now() - t0) / 1000;

// Report
const people = groups.map((g, i) => ({ name: `Person ${String(i + 1).padStart(2, '0')}`, files: [...new Set(g.map(k => faces[k].file))], faces: g }));
console.log(`\n${files.length} images, ${faces.length} faces, ${people.length} groups, ${noFace.length} with no face, ${failed.length} unreadable`);
console.log(`time: ${total.toFixed(1)}s total (${(total / files.length * 1000).toFixed(0)} ms/image; detect ${(tDet / 1000).toFixed(1)}s, fingerprint ${(tRec / 1000).toFixed(1)}s) ep=${ep[0]} strict=${MATCH}\n`);
for (const p of people.filter(p => p.faces.length > 1)) console.log(`${p.name} (${p.faces.length} faces): ${p.files.join(' | ')}`);
console.log(`\nSingletons: ${people.filter(p => p.faces.length === 1).length}`);
console.log(`No face: ${noFace.join(' | ')}`);

// Contact sheet: one row of face chips per group (groups with 2+ faces first, max 14 per row)
const shown = people.filter(p => p.faces.length > 1);
const COLS = 14, CELL = 112;
const comps = [];
shown.forEach((p, r) => p.faces.slice(0, COLS).forEach((k, c) =>
  comps.push({ input: Buffer.from(faces[k].chip), raw: { width: 112, height: 112, channels: 3 }, left: c * CELL, top: r * CELL })));
if (shown.length) {
  await sharp({ create: { width: COLS * CELL, height: shown.length * CELL, channels: 3, background: '#222' } })
    .composite(comps).png().toFile('out/face-groups.png');
  console.log('\nContact sheet: out/face-groups.png');
}
fs.writeFileSync('out/face-groups.json', JSON.stringify(people.map(p => ({ name: p.name, files: p.files, faces: p.faces.length })), null, 1));
