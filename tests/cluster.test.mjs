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

test('two faces in the same photo are never merged', () => {
  const a = near(0, 0.1), b = near(0, 0.1);
  const { groups } = cluster([{ id: 1, imageId: 9, emb: a }, { id: 2, imageId: 9, emb: b }], 0.42);
  assert.equal(groups.length, 2);
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
