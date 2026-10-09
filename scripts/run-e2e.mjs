// Launches the built app with the end-to-end script; screenshots + results.json land in e2e-output/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electron from 'electron';

const script = process.argv[2] ?? 'tests/e2e.mjs';
const out = path.resolve(process.argv[3] ?? 'e2e-output');
fs.mkdirSync(out, { recursive: true });
const r = spawnSync(electron, ['.'], {
  stdio: 'inherit',
  // Own app data, never the real one (it would also move a real ClearUp folder to PixHaven).
  env: { ...process.env, CLEARUP_E2E: path.resolve(script), CLEARUP_E2E_DIR: out, CLEARUP_USER_DATA: process.env.CLEARUP_USER_DATA ?? path.join(out, 'appdata') },
});
console.log(`e2e exit code ${r.status}; output in ${out}`);
process.exit(r.status ?? 1);
