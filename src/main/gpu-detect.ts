// GPU detection (GEN-03): Windows' list of display adapters + the Vulkan devices the engine can use.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import sharp from 'sharp';
import type { GpuInfo, GpuStatus } from '@shared/types';
import { listVulkanDevices } from './engine';
import { log } from './logger';

/** Heuristic: integrated GPUs share system RAM. Dedicated Intel Arc cards are "Arc(TM) A…/B…". */
export function isIntegrated(name: string): boolean {
  const n = name.toLowerCase();
  if (n.includes('nvidia')) return false;
  if (n.includes('intel')) return !/arc\(tm\) [ab]\d|arc [ab]\d/.test(n);
  if (n.includes('amd') || n.includes('radeon')) return !/\brx\b|radeon pro|firepro/.test(n);
  if (n.includes('microsoft basic')) return true;
  return false;
}

function windowsAdapters(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]); // Linux: the Vulkan device names are used instead
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_VideoController).Name'], { windowsHide: true, timeout: 15000 },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  });
}

let cached: Promise<GpuStatus> | null = null;

/** Detects once and shares the result; force=true runs a fresh check. */
export function detectGpu(force = false): Promise<GpuStatus> {
  if (!cached || force) cached = runDetection();
  return cached;
}

async function runDetection(): Promise<GpuStatus> {
  const tmp = path.join(app.getPath('temp'), 'clearup-probe');
  fs.mkdirSync(tmp, { recursive: true });
  const probe = path.join(tmp, 'probe.png');
  if (!fs.existsSync(probe)) await sharp({ create: { width: 8, height: 8, channels: 3, background: '#808080' } }).png().toFile(probe);

  const [names, vulkan] = await Promise.all([windowsAdapters(), listVulkanDevices(probe, tmp)]);
  const gpus: GpuInfo[] = names.map(name => ({ name, integrated: isIntegrated(name) }));
  // If WMI failed, fall back to the Vulkan names.
  if (!gpus.length) for (const name of vulkan) gpus.push({ name, integrated: isIntegrated(name) });
  const status = { gpus, vulkan, ok: vulkan.length > 0 };
  log('info', 'GPU detection', status);
  return status;
}

export function hasDedicatedGpu(s: GpuStatus): boolean {
  return s.gpus.some(g => !g.integrated && !/microsoft basic/i.test(g.name));
}
