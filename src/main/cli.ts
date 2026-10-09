// Command-line mode (GEN-11): "pixhaven <command> …" runs the same engines as the app, without a window.
// Results go to stdout, progress to stderr. Exit codes: 0 ok, 1 failed, 2 bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { ModelId, OutputFormat, SizeChoice, TargetId, UpscaleOptions } from '@shared/types';
import { IMAGE_EXTENSIONS, MATCH_DISTANCE, TARGETS } from '@shared/types';
import { getSettings, overrideSettings } from './settings';
import { detectGpu } from './gpu-detect';
import { UpscaleJob, scanFolder as listUpscaleFolder, quickSize, setGpuWorks } from './upscale-job';
import { modelStatus, downloadQualityModels } from './models';
import * as sort from './sort-service';
import * as tidy from './tidy-service';
import { getDb } from './sort-service';
import { folderId } from './db';

const HELP = `PixHaven ${'{version}'} — command line

  pixhaven upscale <image|folder>… [--scale 2|4 | --target 720p|1080p|1440p|4k]
                  [--model fast|photo|anime] [--format png|jpg|webp] [--quality 1-100] [--out <folder>] [--cpu]
  pixhaven sort <folder> [--subfolders] [--apply]        find people; prints the plan, moves only with --apply
  pixhaven duplicates <folder> [--match identical|same|similar] [--subfolders] [--move]
  pixhaven blurry <folder> [--threshold 150] [--subfolders] [--move]
  pixhaven organize <folder> --by date|place [--depth year|month|country|city] [--unknown-folder] [--apply]
  pixhaven undo <folder>                                  undo the last PixHaven sort / tidy-up in that folder
  pixhaven --version | --help

Nothing is moved without --apply / --move. Every move can be undone with "pixhaven undo <folder>".`;

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s: string) => process.stderr.write(s + '\n');
let lastProgress = 0;
const progress = (label: string, done: number, total: number) => {
  const now = Date.now();
  if (now - lastProgress < 250 && done < total) return;
  lastProgress = now;
  process.stderr.write(`\r${label} ${done}/${total}${done >= total ? '\n' : ''}`);
};

class Usage extends Error {}

function parse(argv: string[]): { cmd: string; pos: string[]; opt: Record<string, string | true> } {
  const pos: string[] = [];
  const opt: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith('--') && ['scale', 'target', 'model', 'format', 'quality', 'out', 'match', 'threshold', 'by', 'depth'].includes(k)) { opt[k] = v; i++; }
      else opt[k] = true;
    } else pos.push(a);
  }
  return { cmd: pos.shift() ?? '', pos, opt };
}

const folderArg = (pos: string[]) => {
  const f = pos[0] ? path.resolve(pos[0]) : '';
  if (!f || !fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Usage('Please give a folder that exists.');
  return f;
};
const choice = <T extends string>(v: string | true | undefined, allowed: readonly T[], name: string, dflt: T): T => {
  if (v === undefined) return dflt;
  if (v === true || !allowed.includes(v as T)) throw new Usage(`--${name} must be one of: ${allowed.join(', ')}`);
  return v as T;
};

async function upscale(pos: string[], opt: Record<string, string | true>): Promise<number> {
  if (!pos.length) throw new Usage('Give at least one image or folder.');
  const size: SizeChoice = opt.target
    ? { kind: 'target', target: choice(opt.target, Object.keys(TARGETS) as TargetId[], 'target', '1080p') }
    : { kind: 'scale', factor: Number(choice(opt.scale, ['2', '4'] as const, 'scale', '4')) as 2 | 4 };
  const opts: UpscaleOptions = {
    size, model: choice(opt.model, ['fast', 'photo', 'anime'] as ModelId[], 'model', 'fast'),
    format: choice(opt.format, ['png', 'jpg', 'webp'] as OutputFormat[], 'format', 'png'),
    jpgQuality: opt.quality ? Math.max(1, Math.min(100, Number(opt.quality))) : 92,
  };
  if (!modelStatus()[opts.model]) {
    err('Downloading the model once (45 MB)…');
    await downloadQualityModels(f => progress('Download %', Math.round(f * 100), 100));
  }
  const files: { path: string; width: number; height: number }[] = [];
  for (const p of pos.map(x => path.resolve(x))) {
    if (!fs.existsSync(p)) { err(`Not found: ${p}`); continue; }
    if (fs.statSync(p).isDirectory()) files.push(...(await listUpscaleFolder(p)).files);
    else if (IMAGE_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase())) { const s = await quickSize(p); if (s) files.push({ path: p, ...s }); }
    else err(`Not a supported image: ${p}`);
  }
  if (!files.length) throw new Usage('No images to upscale.');
  const settings = { ...getSettings(), outputDir: typeof opt.out === 'string' ? path.resolve(opt.out) : getSettings().outputDir, cpuOnly: !!opt.cpu || getSettings().cpuOnly };
  const job = new UpscaleJob(files, opts, settings, 'folder', u => progress('Upscaling', u.done, u.total));
  await job.run();
  let failed = 0;
  for (const it of job.items) {
    if (it.state === 'done') out(`ok\t${it.input}\t${it.output}\t${it.outWidth}x${it.outHeight}\t${it.seconds?.toFixed(1)}s`);
    else if (it.state === 'skipped') out(`skip\t${it.input}\t${it.error}`);
    else { failed++; out(`fail\t${it.input}\t${it.error ?? it.state}`); }
  }
  err(`${job.items.filter(i => i.state === 'done').length} upscaled, ${failed} failed.`);
  return failed ? 1 : 0;
}

async function sortCmd(pos: string[], opt: Record<string, string | true>): Promise<number> {
  const root = folderArg(pos);
  if (opt.subfolders) overrideSettings({ sort: { ...getSettings().sort, includeSubfolders: true } });
  const st = sort.folderStatus(root);
  if (st.interrupted) throw new Error('An earlier sort of this folder did not finish. Open PixHaven to finish or undo it, or run "pixhaven undo".');
  const { done } = sort.scanFolder(root, { scan: p => { if (p.phase === 'scanning') progress('Scanning', p.done, p.total); else if (p.phase !== 'done') err(p.phase === 'grouping' ? 'Grouping faces…' : p.phase === 'naming' ? 'Looking for names…' : ''); } });
  const r = await done;
  const rev = sort.review(r.folderId);
  out(`People in ${root}:`);
  for (const p of rev.people) out(`  ${p.label}\t${p.photos} photo(s)${p.unsorted ? '\t(→ Unsorted)' : ''}${p.sourceDetail ? `\t${p.sourceDetail}` : ''}`);
  const plan = sort.makePlan(r.folderId);
  out(`Plan: ${plan.counts.folders} folders to create, ${plan.counts.moves} moves, ${plan.counts.copies} copies, ${plan.counts.groupMoves} to "Group photos", ${plan.counts.stays} stay.`);
  if (!opt.apply) { out('Dry run only. Add --apply to move the files (review names in the app first if you like).'); return 0; }
  const res = await sort.applySort(r.folderId, { apply: p => progress('Applying', p.done, p.total) });
  out(`Done: ${res.moved} moved, ${res.copied} copied, ${res.groupMoved} group originals moved, ${res.skipped.length} left in place.`);
  for (const s of res.skipped) out(`  kept\t${s.path}\t${s.reason}`);
  return res.ok ? 0 : 1;
}

async function scanTidy(root: string, opt: Record<string, string | true>): Promise<number> {
  if (opt.subfolders) overrideSettings({ tidy: { ...getSettings().tidy, includeSubfolders: true } });
  const { done } = tidy.scanTidy(root, { scan: p => { if (p.phase === 'scanning') progress('Checking photos', p.done, p.total); } });
  return (await done).folderId;
}

async function dupesOrBlurry(kind: 'duplicates' | 'blurry', pos: string[], opt: Record<string, string | true>): Promise<number> {
  const root = folderArg(pos);
  const t = getSettings().tidy;
  if (kind === 'duplicates') overrideSettings({ tidy: { ...t, match: choice(opt.match, ['identical', 'same', 'similar'] as const, 'match', t.match) } });
  else if (opt.threshold) overrideSettings({ tidy: { ...t, blurThreshold: Number(opt.threshold) } });
  const fid = await scanTidy(root, opt);
  const r = tidy.tidyResults(fid);
  let ids: number[];
  if (kind === 'duplicates') {
    out(`${r.duplicates.length} duplicate group(s) (match: ${getSettings().tidy.match}, distance ${MATCH_DISTANCE[getSettings().tidy.match]}):`);
    for (const g of r.duplicates) {
      out(`  [${g.kind}]`);
      for (const p of g.photos) out(`    ${p.id === g.keep ? 'keep ' : 'extra'}\t${p.path}\t${p.width}x${p.height}`);
    }
    ids = r.duplicates.flatMap(g => g.photos.filter(p => p.id !== g.keep).map(p => p.id));
  } else {
    out(`${r.blurry.length} blurry photo(s) (sharpness below ${getSettings().tidy.blurThreshold}):`);
    for (const p of r.blurry) out(`  ${Math.round(p.blur)}\t${p.path}`);
    ids = r.blurry.map(p => p.id);
  }
  if (!opt.move || !ids.length) { if (ids.length) out(`Add --move to move ${ids.length} photo(s) into "${tidy.SET_ASIDE[kind]}" (undo with "pixhaven undo").`); return 0; }
  tidy.setAsidePlan(fid, kind, ids);
  const res = await tidy.applyTidy(fid, { apply: p => progress('Moving', p.done, p.total) });
  out(`Moved ${res.moved} photo(s) into "${tidy.SET_ASIDE[kind]}". ${res.skipped.length} left in place.`);
  return res.ok ? 0 : 1;
}

async function organize(pos: string[], opt: Record<string, string | true>): Promise<number> {
  const root = folderArg(pos);
  const by = choice(opt.by, ['date', 'place'] as const, 'by', 'date');
  const t = getSettings().tidy;
  const depth = opt.depth ? choice(opt.depth, (by === 'date' ? ['year', 'month'] : ['country', 'city']) as string[], 'depth', '') : undefined;
  overrideSettings({ tidy: { ...t, by, unknownFolder: !!opt['unknown-folder'],
    ...(by === 'date' && depth ? { dateDepth: depth as 'year' | 'month' } : {}), ...(by === 'place' && depth ? { placeDepth: depth as 'country' | 'city' } : {}) } });
  const fid = await scanTidy(root, opt);
  const plan = tidy.organizePlan(fid);
  for (const tg of plan.targets) out(`  ${tg.label}\t${plan.ops.filter(o => o.kind === 'move' && o.to.toLowerCase().startsWith(tg.dir.toLowerCase() + path.sep)).length} photo(s)`);
  out(`Plan: ${plan.counts.moves} moves into ${plan.targets.length} folder(s); ${plan.counts.stays} stay.`);
  if (!opt.apply) { out('Dry run only. Add --apply to move the files.'); return 0; }
  const res = await tidy.applyTidy(fid, { apply: p => progress('Moving', p.done, p.total) });
  out(`Done: ${res.moved} moved, ${res.skipped.length} left in place.`);
  return res.ok ? 0 : 1;
}

async function undo(pos: string[]): Promise<number> {
  const root = folderArg(pos);
  const fid = folderId(getDb(), root, false);
  const last = fid == null ? undefined : getDb().prepare("SELECT id, kind FROM sorts WHERE folder_id = ? AND state IN ('done', 'applying', 'failed') ORDER BY id DESC").get(fid) as { id: number; kind: string } | undefined;
  if (!last) { out('Nothing to undo in this folder.'); return 0; }
  const r = await sort.undoSortJob(last.id, { apply: p => progress('Undoing', p.done, p.total) });
  out(`Undid the last ${last.kind === 'people' ? 'sort by person' : 'tidy-up'}: ${r.restored} change(s) reversed.`);
  for (const k of r.kept) out(`  kept\t${k.path}\t${k.reason}`);
  return r.kept.length ? 1 : 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, pos, opt } = parse(argv);
  if (opt.version) { out(app.getVersion()); return 0; }
  if (!cmd || opt.help || cmd === 'help') { out(HELP.replace('{version}', app.getVersion())); return cmd || opt.help ? 0 : 2; }
  try {
    const gpu = await detectGpu();
    setGpuWorks(gpu.ok);
    if (!gpu.ok) err('No usable Vulkan graphics: upscaling runs on the CPU (slower).');
    switch (cmd) {
      case 'upscale': return await upscale(pos, opt);
      case 'sort': return await sortCmd(pos, opt);
      case 'duplicates': return await dupesOrBlurry('duplicates', pos, opt);
      case 'blurry': return await dupesOrBlurry('blurry', pos, opt);
      case 'organize': return await organize(pos, opt);
      case 'undo': return await undo(pos);
      default: throw new Usage(`Unknown command "${cmd}". Run "pixhaven --help".`);
    }
  } catch (e) {
    err(`Error: ${(e as Error).message}`);
    return e instanceof Usage ? 2 : 1;
  }
}
