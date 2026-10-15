import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helper.mjs';

const { cluster } = await load('faces/cluster');

// Unit vectors near one of a few "identities", with noise.
function rnd(seed) { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; }
const r = rnd(7);
const norm = v => { const n = Math.hypot(...v); return Float32Array.from(v, x => x / n); };
const base = [0, 1, 2, 3].map(() => Array.from({ length: 128 }, () => r() - 0.5));
const near = (k, noise = 0.6) => norm(base[k].map(x => x + (r() - 0.5) * noise));

test('groups faces of the same identity together', () => {
  const faces = [];
  let id = 0;
  for (let k = 0; k < 4; k++) for (let i = 0; i < 6; i++) faces.push({ id: id++, imageId: id, emb: near(k), k });
  const { groups } = cluster(faces, 0.42);
  assert.equal(groups.length, 4);
  for (const g of groups) assert.equal(new Set(g.faceIds.map(i => faces[i].k)).size, 1);
});

test('two faces in one photo: the same person only when they clearly match (collages, mirror selfies)', () => {
  const twin = near(0, 0.1);
  const close = norm(base[0].map((x, i) => x * 0.53 + base[2][i]));            // about 0.47 alike: similar, not clearly the same
  const a = cluster([{ id: 1, imageId: 9, emb: twin }, { id: 2, imageId: 9, emb: near(0, 0.1) }], 0.42);
  assert.equal(a.groups.length, 1, 'same face twice in a collage');
  const b = cluster([{ id: 1, imageId: 9, emb: norm(base[0]) }, { id: 2, imageId: 9, emb: close }], 0.42);
  assert.equal(b.groups.length, 2, 'two different faces in one photo');
});

test('a person with very different looks stays one group (nearest-face linkage)', () => {
  // A kept person whose photos show four quite different looks (filters, make-up); new photos match one look closely
  // but sit far from the average of all four.
  const look = k => norm(base[0].map((x, i) => x + base[k][i] * 1.2));
  const jitter = v => norm([...v].map(x => x + (r() - 0.5) * 0.01));
  const faces = [];
  let id = 0;
  for (const k of [1, 2, 3, 0]) for (let i = 0; i < 6; i++) faces.push({ id: id++, imageId: id, emb: jitter(k ? look(k) : norm(base[1].map((x, j) => -x + base[2][j]))), anchor: 100 });
  const fresh = [];
  for (let i = 0; i < 3; i++) { fresh.push(id); faces.push({ id: id++, imageId: id, emb: jitter(look(1)) }); }
  const { groups } = cluster(faces, 0.6);
  const kept = groups.find(g => g.anchor === 100);
  assert.ok(fresh.every(i => kept.faceIds.includes(i)), groups.map(g => g.anchor + ':' + g.faceIds.length).join(' '));
});

test('a one-off photo joins the person it is clearly closest to, never one of two equally close people', () => {
  const faces = [];
  let id = 0;
  for (const k of [0, 1]) for (let i = 0; i < 5; i++) faces.push({ id: id++, imageId: id, emb: near(k, 0.3), quality: 0.9 });
  // Below the threshold for person 0, but nobody else is near.
  const clear = id; faces.push({ id: id++, imageId: id, emb: norm(base[0].map((x, i) => x + base[3][i] * 2.1)), quality: 0.9 });
  // Halfway between person 0 and person 1.
  const torn = id; faces.push({ id: id++, imageId: id, emb: norm(base[0].map((x, i) => x + base[1][i] + base[2][i] * 2.2)), quality: 0.9 });
  const { groups } = cluster(faces, 0.42);
  const of = i => groups.find(g => g.faceIds.includes(i));
  assert.ok(of(clear).faceIds.includes(0), 'joined person 0: ' + groups.map(g => g.faceIds.join(',')).join(' | '));
  assert.ok(!of(torn) || of(torn).faceIds.length === 1, 'not given to either person');
});

test('anchors keep their faces and attract new ones, but never merge with each other', () => {
  const faces = [
    { id: 1, imageId: 1, emb: near(0), anchor: 100 },
    { id: 2, imageId: 2, emb: near(0), anchor: 200 },   // user kept a split
    { id: 3, imageId: 3, emb: near(0) },
    { id: 4, imageId: 4, emb: near(1) },
  ];
  const { groups } = cluster(faces, 0.42);
  const a = groups.filter(g => g.anchor != null);
  assert.equal(a.length, 2);
  assert.ok(a.some(g => g.faceIds.includes(3)));
  assert.ok(groups.some(g => g.anchor == null && g.faceIds.join() === '4'));
});

test('weak faces (small, blurry, turned away) never start or link groups; they join only a clear match', () => {
  // Two different people, plus weak "in-between" faces that sit close to both: before v2.2 they chained them together.
  const mid = norm(base[0].map((x, i) => x + base[1][i]));
  const faces = [];
  let id = 0;
  for (let i = 0; i < 4; i++) faces.push({ id: id++, imageId: id, emb: near(0, 0.3), quality: 0.9, k: 0 });
  for (let i = 0; i < 4; i++) faces.push({ id: id++, imageId: id, emb: near(1, 0.3), quality: 0.9, k: 1 });
  for (let i = 0; i < 3; i++) faces.push({ id: id++, imageId: id, emb: mid, quality: 0.1, k: -1 });
  const clear = id; faces.push({ id: id++, imageId: id, emb: near(0, 0.2), quality: 0.1, k: 0 });
  const { groups } = cluster(faces, 0.42);
  assert.equal(groups.length, 2, 'weak faces make no group of their own');
  for (const g of groups) assert.equal(new Set(g.faceIds.map(i => faces[i].k)).size, 1, 'no mixed group');
  assert.ok(groups.some(g => g.faceIds.includes(clear)), 'a weak face that clearly matches still joins');
  assert.ok(!groups.some(g => g.faceIds.some(i => faces[i].k === -1)), 'unclear weak faces stay unassigned');
});
