import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { load } from './helper.mjs';

const { findDuplicates, findBlurry, hamming, bestOf } = await load('tidy/dupes');
const { Places } = await load('tidy/geo');
const { folderFor, buildOrganizePlan } = await load('tidy/organize');

const photo = (id, sha1, dhash, extra = {}) => ({ id, path: `C:/p/${id}.jpg`, size: 1000, sha1, dhash, blur: 900, width: 400, height: 300, ...extra });

test('hamming distance on 64-bit hex hashes', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('ff00000000000000', '0000000000000000'), 8);
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
});

test('identical files and resized copies group; different photos do not', () => {
  const groups = findDuplicates([
    photo(1, 'a', '00000000000000ff'), photo(2, 'a', '00000000000000ff'),                     // identical files
    photo(3, 'b', 'f0f0f0f0f0f0f0f0', { width: 800, height: 600 }), photo(4, 'c', 'f0f0f0f0f0f0f0f1'), // same picture, resized
    photo(5, 'd', '0f0f0f0f0f0f0f0f'),                                                         // different
    photo(6, 'e', 'f0f0f0f0f0f0f0f3', { width: 300, height: 400 }),                            // same hash, other shape
  ], 6);
  assert.equal(groups.length, 2);
  const exact = groups.find(g => g.kind === 'exact'), similar = groups.find(g => g.kind === 'similar');
  assert.deepEqual(exact.photos.map(p => p.id), [1, 2]);
  assert.deepEqual(similar.photos.map(p => p.id).sort(), [3, 4]);
  assert.equal(similar.keep, 3);                       // keep the larger one
  assert.equal(findDuplicates([photo(3, 'b', 'f0f0f0f0f0f0f0f0'), photo(4, 'c', 'f0f0f0f0f0f0f0f1')], 0).length, 0); // exact only
});

test('keeper prefers more pixels, then sharper', () => {
  assert.equal(bestOf([photo(1, 'a', '0', { blur: 100 }), photo(2, 'b', '0', { blur: 500 })]).id, 2);
  assert.equal(bestOf([photo(1, 'a', '0', { width: 4000, height: 3000, blur: 100 }), photo(2, 'b', '0', { blur: 500 })]).id, 1);
});

test('blurry photos below the threshold, blurriest first', () => {
  const r = findBlurry([photo(1, 'a', '0', { blur: 900 }), photo(2, 'b', '0', { blur: 40 }), photo(3, 'c', '0', { blur: 12 })], 150);
  assert.deepEqual(r.map(p => p.id), [3, 2]);
});

test('offline place lookup', () => {
  const places = new Places({ countries: { IN: 'India', FR: 'France' }, cities: [['Bengaluru', 'IN', 12.972, 77.594, 8e6], ['Mysuru', 'IN', 12.296, 76.639, 9e5], ['Paris', 'FR', 48.853, 2.349, 2e6]] });
  assert.equal(places.lookup(12.93, 77.62).city, 'Bengaluru');
  assert.equal(places.lookup(12.3, 76.65).city, 'Mysuru');
  assert.equal(places.lookup(48.86, 2.35).country, 'France');
  const far = places.lookup(14.5, 75.0);                // countryside, >75 km from any town
  assert.deepEqual([far.city, far.country], [null, 'India']);
});

test('date and place folders', () => {
  const r = { id: 1, path: 'C:/p/a.jpg', size: 1, taken: Date.UTC(2023, 11, 25, 9, 15), taken_src: 'exif', lat: 12.97, lon: 77.59 };
  const places = new Places({ countries: { IN: 'India' }, cities: [['Bengaluru', 'IN', 12.972, 77.594, 8e6]] });
  assert.deepEqual(folderFor(r, { by: 'date', depth: 'month', useFileDate: true, unknownFolder: false }, null), ['2023', '2023-12 December']);
  assert.deepEqual(folderFor(r, { by: 'date', depth: 'year', useFileDate: true, unknownFolder: false }, null), ['2023']);
  assert.equal(folderFor({ ...r, taken_src: 'file' }, { by: 'date', depth: 'year', useFileDate: false, unknownFolder: false }, null), null);
  assert.deepEqual(folderFor(r, { by: 'place', depth: 'city', useFileDate: true, unknownFolder: false }, places), ['India', 'Bengaluru']);
  assert.equal(folderFor({ ...r, lat: null, lon: null }, { by: 'place', depth: 'city', useFileDate: true, unknownFolder: false }, places), null);
});

test('organize plan: moves into folders, unknowns stay or go to "Unknown date"', () => {
  const root = path.join('C:', 'nowhere-test');
  const rows = [
    { id: 1, path: path.join(root, 'a.jpg'), size: 5, taken: Date.UTC(2021, 0, 2), taken_src: 'exif', lat: null, lon: null },
    { id: 2, path: path.join(root, 'b.jpg'), size: 5, taken: Date.UTC(2021, 0, 9), taken_src: 'exif', lat: null, lon: null },
    { id: 3, path: path.join(root, 'c.jpg'), size: 5, taken: null, taken_src: null, lat: null, lon: null },
  ];
  const o = { by: 'date', depth: 'month', useFileDate: true, unknownFolder: false };
  const p = buildOrganizePlan(1, root, rows, o, null, null);
  assert.deepEqual([p.counts.folders, p.counts.moves, p.counts.stays], [1, 2, 1]);
  assert.equal(p.ops[1].to, path.join(root, '2021', '2021-01 January', 'a.jpg'));
  const p2 = buildOrganizePlan(1, root, rows, { ...o, unknownFolder: true }, null, null);
  assert.ok(p2.ops.some(op => op.to === path.join(root, 'Unknown date', 'c.jpg')));
});
