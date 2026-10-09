// Appends timestamped lines to <userData>/logs/clearup.log (GEN-09).
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let file: string | null = null;
// CLI mode keeps the terminal for results: log lines then only go to the file.
const quiet = process.argv.includes('--cli');

export function logDir(): string {
  return path.join(app.getPath('userData'), 'logs');
}

function target(): string {
  if (!file) {
    fs.mkdirSync(logDir(), { recursive: true });
    file = path.join(logDir(), 'clearup.log');
    // Keep the log from growing forever: start fresh past 5 MB.
    try { if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, file + '.old'); } catch { /* no log yet */ }
  }
  return file;
}

export function log(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  const text = parts.map(p => (p instanceof Error ? p.stack ?? p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  const line = `${new Date().toISOString()} [${level}] ${text}\n`;
  if (!quiet) { if (level === 'error') console.error(line.trimEnd()); else console.log(line.trimEnd()); }
  try { fs.appendFileSync(target(), line); } catch { /* logging must never crash the app */ }
}
