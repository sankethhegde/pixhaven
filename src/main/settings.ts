// JSON settings file in <userData>/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Settings } from '@shared/types';
import { log } from './logger';

const SETTINGS_VERSION = 4;
/** True on the first start after an update that switched writing labels into files on (v2.2). */
export let writeTurnedOn = false;

const DEFAULTS: Settings = {
  lowSpec: true,
  lowSpecAuto: true,
  tileSize: 192,
  threads: '1:2:2',
  gpuId: null,
  outputDir: null,
  theme: 'system',
  last: { size: { kind: 'scale', factor: 4 }, model: 'fast', format: 'png', jpgQuality: 92 },
  cpuOnly: false,
  skipExisting: true,
  firstRunDone: false,
  sort: { includeSubfolders: false, strictness: 0.34, minFaceSize: 40, noFacesFolder: false, minPhotos: 2, suggestUpscale: false },
  tidy: { includeSubfolders: false, match: 'same', blurThreshold: 150, by: 'date', dateDepth: 'month', placeDepth: 'city', useFileDate: true, unknownFolder: false },
  library: { showSystem: false, view: 'grid', size: 'm', sortBy: 'name', sortDesc: false, type: 'all', lastDir: null, dbPath: null, watched: [], writeToFiles: true },
  version: SETTINGS_VERSION,
};

let current: Settings | null = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

export function getSettings(): Settings {
  if (!current) {
    try {
      const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
      current = { ...DEFAULTS, ...saved, last: { ...DEFAULTS.last, ...saved.last }, sort: { ...DEFAULTS.sort, ...saved.sort }, tidy: { ...DEFAULTS.tidy, ...saved.tidy }, library: { ...DEFAULTS.library, ...saved.library } };
      // v2: the default "minimum photos per person" became 2, so one-off faces in group photos go to "Unsorted".
      if ((saved.version ?? 1) < 2) {
        if (current!.sort.minPhotos === 1) current!.sort.minPhotos = 2;
      }
      // v3 (PixHaven 0.7): stars and labels are kept in the files too, so they travel with them to other computers.
      if ((saved.version ?? 1) < 3) {
        if (!current!.library.writeToFiles) { current!.library.writeToFiles = true; writeTurnedOn = true; }
        // The new face model (ArcFace) has its own scale: 0.34 here is about as strict as 0.42 was, with far fewer mix-ups.
        current!.sort.strictness = DEFAULTS.sort.strictness;
      }
      // v4 (0.7.1): the strictness slider covers 0.28–0.42 for ArcFace; values outside it (0.46 split one person into
      // dozens of groups) go back to the tested default.
      if ((saved.version ?? 1) < 4 && (current!.sort.strictness < 0.28 || current!.sort.strictness > 0.42)) current!.sort.strictness = DEFAULTS.sort.strictness;
      delete (current!.sort as { useOcr?: boolean }).useOcr;
      current!.version = SETTINGS_VERSION;
    } catch {
      current = structuredClone(DEFAULTS);
    }
  }
  return current!;
}

/** Change settings for this run only, without saving them (used by command-line options). */
export function overrideSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch };
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...getSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(current, null, 2));
  } catch (e) {
    log('error', 'Could not save settings', e);
  }
  return current;
}
