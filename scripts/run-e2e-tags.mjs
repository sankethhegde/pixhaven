// Phase C end-to-end: three launches of the built app (tests/e2e-tags.mjs).
//   1. tag      (app data A)  2. restart  (app data A again)
//   3. laptop   (app data B, videos copied to another folder, the original folder moved out of reach)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const out = path.resolve('e2e-output/tags');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const launch = (step, userData) => {
  const r = spawnSync(electron, ['.'], {
    stdio: 'inherit',
    env: { ...process.env, CLEARUP_E2E: path.resolve('tests/e2e-tags.mjs'), CLEARUP_E2E_DIR: out, CLEARUP_E2E_STEP: step, CLEARUP_USER_DATA: path.join(out, userData) },
  });
  return r.status ?? 1;
};

let code = launch('tag', 'appdata-A');
if (code === 0) code = launch('restart', 'appdata-A');
if (code === 0) {
  // "Another laptop": the same videos under another folder; the old folder is gone.
  const videos = path.join(out, 'Videos'), laptop = path.join(out, 'Laptop', 'D', 'My Videos'), away = path.join(out, 'Videos (old laptop)');
  fs.mkdirSync(laptop, { recursive: true });
  for (const f of fs.readdirSync(videos)) fs.copyFileSync(path.join(videos, f), path.join(laptop, f));
  fs.renameSync(videos, away);
  try { code = launch('laptop', 'appdata-B'); } finally { fs.renameSync(away, videos); }
}
const all = ['tag', 'restart', 'laptop'].flatMap(s => { try { return JSON.parse(fs.readFileSync(path.join(out, `results-${s}.json`), 'utf8')); } catch { return []; } });
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all, null, 1));
console.log(`e2e exit code ${code}: ${all.filter(r => r.pass).length}/${all.length} passed; output in ${out}`);
process.exit(code);
