// v2.1 end-to-end: two launches of the built app (tests/e2e-watch.mjs) with their own app-data folder.
//   1. watch    2. restart (a photo is added to a watched folder while the app is closed)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const out = path.resolve('e2e-output/watch');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const launch = step => spawnSync(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, CLEARUP_E2E: path.resolve('tests/e2e-watch.mjs'), CLEARUP_E2E_DIR: out, CLEARUP_E2E_STEP: step, CLEARUP_USER_DATA: path.join(out, 'appdata') },
}).status ?? 1;

let code = launch('watch');
if (code === 0) {
  fs.copyFileSync(path.join(out, 'Watched A', 'portrait.jpg'), path.join(out, 'Watched A', 'Goa 2024', 'added while closed.jpg'));
  code = launch('restart');
}
const all = ['watch', 'restart'].flatMap(s => { try { return JSON.parse(fs.readFileSync(path.join(out, `results-${s}.json`), 'utf8')); } catch { return []; } });
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(all, null, 1));
console.log(`e2e exit code ${code}: ${all.filter(r => r.pass).length}/${all.length} passed; output in ${out}`);
process.exit(code);
