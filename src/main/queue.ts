// GEN-01: one job queue for all heavy work (upscaling, face scans, apply/undo), run strictly one after another.
import crypto from 'node:crypto';
import type { QueueItem } from '@shared/types';
import { log } from './logger';

interface Entry extends QueueItem { run: () => Promise<void>; cancel: () => void; resolve: () => void; reject: (e: unknown) => void }

class TaskQueue {
  private items: Entry[] = [];
  private running = false;
  private listeners = new Set<(items: QueueItem[]) => void>();

  /** Adds a job; the promise settles when it has run (or was cancelled while waiting). */
  add(kind: QueueItem['kind'], label: string, run: () => Promise<void>, cancel: () => void): { id: string; done: Promise<void> } {
    const id = crypto.randomUUID();
    let resolve!: () => void, reject!: (e: unknown) => void;
    const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.items.push({ id, kind, label, state: 'queued', added: Date.now(), run, cancel, resolve, reject });
    this.changed();
    void this.pump();
    return { id, done };
  }

  cancel(id: string): void {
    const e = this.items.find(i => i.id === id);
    if (!e) return;
    if (e.state === 'queued') { e.state = 'cancelled'; e.resolve(); this.changed(); }
    else if (e.state === 'running') e.cancel();
  }

  list(): QueueItem[] {
    return this.items.filter(i => i.state === 'queued' || i.state === 'running')
      .map(({ id, kind, label, state, added }) => ({ id, kind, label, state, added }));
  }

  /** How many jobs are ahead of this one (0 = running now). */
  position(id: string): number {
    const active = this.items.filter(i => i.state === 'queued' || i.state === 'running');
    return active.findIndex(i => i.id === id);
  }

  onChange(cb: (items: QueueItem[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private changed(): void { const l = this.list(); for (const cb of this.listeners) cb(l); }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.items.find(i => i.state === 'queued');
    if (!next) { this.items = this.items.filter(i => i.state === 'queued' || i.state === 'running'); return; }
    this.running = true;
    next.state = 'running';
    this.changed();
    try { await next.run(); next.state = 'done'; next.resolve(); }
    catch (e) { next.state = 'failed'; log('error', `Job failed: ${next.label}`, e); next.reject(e); }
    this.running = false;
    this.changed();
    void this.pump();
  }
}

export const queue = new TaskQueue();
