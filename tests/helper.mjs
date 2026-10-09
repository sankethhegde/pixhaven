// Bundles the pure main-process modules (no Electron) so node:test can import them.
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function load(mod) {
  const outfile = path.join(root, 'tests/.build', `${mod.replace(/[/]/g, '_')}.mjs`);
  await build({
    entryPoints: [path.join(root, 'src/main', `${mod}.ts`)], outfile, bundle: true, platform: 'node', format: 'esm',
    alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'error', packages: 'external',
  });
  return import(pathToFileURL(outfile).href + `?t=${Date.now()}`);
}
