// Wallpaper e2e: "Set as wallpaper" writes the chosen picture to a file instead of changing the real desktop.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const out = path.resolve('e2e-output/wallpaper');
const r = spawnSync(process.execPath, ['scripts/run-e2e.mjs', 'tests/e2e-wallpaper.mjs', out], { stdio: 'inherit', env: { ...process.env, PIXHAVEN_WALL_FAKE: path.join(out, 'wallpaper-set.txt') } });
process.exit(r.status ?? 1);
