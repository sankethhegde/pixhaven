import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './helper.mjs';

const { nameFromFileName, bestFileName, nameFromOcrWords } = await load('faces/names-file');

test('names from meaningful file names (doc examples)', () => {
  assert.equal(nameFromFileName('C:/photos/Ravi.jpg'), 'Ravi');
  assert.equal(nameFromFileName('ravi_bday_2.jpg'), 'Ravi');
  assert.equal(nameFromFileName('ravi1.jpg'), 'Ravi');
  assert.equal(nameFromFileName('Asha Kumar - final edited.png'), 'Asha Kumar');
  assert.equal(nameFromFileName('RaviKumar.jpeg'), 'Ravi Kumar');
  assert.equal(nameFromFileName('PM Modi 2015.jpg'), 'Modi');
});

test('camera, app, date and random names give no name', () => {
  for (const f of ['IMG_0042.jpg', 'DSC_1234.JPG', '20240512_183055.jpg', 'WhatsApp Image 2024-05-12 at 10.32.11.jpeg',
    'PXL_20240101_123456789.jpg', 'Screenshot 2024-01-01 101010.png', '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90.jpg',
    'a8f3k2l9x7q.jpg', 'deadbeefcafe.jpg', 'beach.jpg', 'birthday party.jpg', 'trip_beach_sunset_2023.jpg', 'xkcdq.png'])
    assert.equal(nameFromFileName(f), null, f);
});

test('most common name wins among a person\'s photos', () => {
  assert.deepEqual(bestFileName(['IMG_1.jpg', 'asha.jpg', 'ravi.jpg', 'Asha_2.jpg']), { name: 'Asha', from: 'asha.jpg' });
  assert.equal(bestFileName(['IMG_1.jpg', 'DSC_2.jpg']), null);
});

test('OCR words to a name', () => {
  const w = (text, confidence = 95, line = 1) => ({ text, confidence, line });
  assert.equal(nameFromOcrWords([w('ASHA')]), 'Asha');
  assert.equal(nameFromOcrWords([w('Hello', 95, 1), w('ASHA', 95, 2), w('KUMAR', 92, 2)]), 'Asha Kumar');
  assert.equal(nameFromOcrWords([w('asha')]), null);            // not capitalised
  assert.equal(nameFromOcrWords([w('ASHA', 60)]), null);        // low confidence
  assert.equal(nameFromOcrWords([w('BIRTHDAY'), w('PARTY')]), null);
  // Sparse mode: separate lines, but side by side on the page
  const b = (text, x0, line) => ({ text, confidence: 95, line, box: { x0, y0: 100, x1: x0 + 200, y1: 150 } });
  assert.equal(nameFromOcrWords([b('ASHA', 0, 1), b('KUMAR', 240, 2)]), 'Asha Kumar');
  assert.equal(nameFromOcrWords([b('ASHA', 0, 1), b('KUMAR', 900, 2)]), 'Asha');
});
