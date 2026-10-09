// JSON settings file in <userData>/settings.json.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { Settings } from '@shared/types';
import { log } from './logger';

const SETTINGS_VERSION = 2;

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
  sort: { includeSubfolders: false, strictness: 0.42, minFaceSize: 40, noFacesFolder: false, minPhotos: 2, useOcr: true },
  tidy: { includeSubfolders: false, match: 'same', blurThreshold: 150, by: 'date', dateDepth: 'month', placeDepth: 'city', useFileDate: true, unknownFolder: false },
  library: { showSystem: false, view: 'grid', size: 'm', sortBy: 'name', sortDesc: false, type: 'all', lastDir: null, dbPath: null, watched: [], writeToFiles: false },
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
        current!.version = SETTINGS_VERSION;
      }
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
