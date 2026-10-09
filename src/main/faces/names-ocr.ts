// FACE-11: read a name from text inside a photo (caption, badge, ID card) with Tesseract.js, fully offline:
// the English language file ships in resources/ocr. No Electron imports (runs in the scan worker).
import sharp from 'sharp';
import { createWorker, type Worker } from 'tesseract.js';
import { nameFromOcrWords, type OcrWord } from './names-file';

export class NameReader {
  private worker: Worker | null = null;
  constructor(private langDir: string, private cacheDir: string) {}

  private async get(): Promise<Worker> {
    if (!this.worker) {
      this.worker = await createWorker('eng', 1, { langPath: this.langDir, cachePath: this.cacheDir, gzip: true, logger: () => {} });
      // "Sparse text" mode: finds scattered text (badges, captions) on busy photos; the default layout mode misses it.
      await this.worker.setParameters({ tessedit_pageseg_mode: '11' as never });
    }
    return this.worker;
  }

  /** Returns a name found in the photo, or null. */
  async read(file: string, decode: (f: string) => Promise<Buffer>): Promise<string | null> {
    const png = await sharp(await decode(file)).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).grayscale().png().toBuffer();
    const w = await this.get();
    const r = await w.recognize(png, {}, { blocks: true });
    const words: OcrWord[] = [];
    let line = 0;
    for (const b of r.data.blocks ?? []) for (const p of b.paragraphs) for (const l of p.lines) {
      line++;
      for (const wd of l.words) words.push({ text: wd.text, confidence: wd.confidence, line, box: wd.bbox });
    }
    return nameFromOcrWords(words);
  }

  async close(): Promise<void> { await this.worker?.terminate(); this.worker = null; }
}
