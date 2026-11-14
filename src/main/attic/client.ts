// 1.0.7: PixHaven as an Attic device. Talks to the Attic server on the home network (the HP): finds it (UDP
// broadcast, the Attic protocol), pairs with a 6-digit code from Attic Hub (Devices → Pair a device), signs in with
// the user's own Attic account (the password goes to Attic once and is never kept), then lists, streams, uploads,
// moves and deletes (to Attic's 30-day trash). Attic files are addressed as attic://<share>/<path>.
// No Electron imports: the caller stores the connection (encrypted) and passes it in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const SCHEME = 'attic://';
export const isAttic = (p: string) => typeof p === 'string' && p.startsWith(SCHEME);
export function parseAttic(p: string): { share: string; rel: string } {
  const rest = p.slice(SCHEME.length);
  const i = rest.indexOf('/');
  return i < 0 ? { share: rest, rel: '' } : { share: rest.slice(0, i), rel: rest.slice(i + 1).replace(/\/+$/, '') };
}
export const atticPath = (share: string, rel: string) => `${SCHEME}${share}/${rel}`.replace(/\/$/, '');

export interface AtticConn {
  address: string; port: number;
  serverId?: string; name?: string;
  device?: string;                 // the attic_device token (pairing)
  session?: string;                // the attic_session token (signed in, 30 days)
  account?: { id: string; displayName: string; username: string; type: 'master' | 'device' } | null;
}
export interface AtticEntry { id: string; kind: 'file' | 'folder'; share: string; path: string; name: string; size: number; modifiedAt: string; ownerId: string | null; uploadedBy: string | null }
export interface AtticShare { id: string; name: string; available?: boolean; drive?: string }

export class AtticError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const DISCOVERY_PORT = 41980;
function broadcastTargets(): string[] {
  const out = new Set(['255.255.255.255']);
  const toInt = (a: string) => a.split('.').reduce((n, x) => (n << 8) + Number(x), 0) >>> 0;
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    const ip = toInt(a.address), mask = toInt(a.netmask);
    if (!mask) continue;
    const b = ((ip & mask) | ~mask) >>> 0;
    out.add([b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.'));
  }
  return [...out];
}
/** Attic servers on the home network (Attic's discovery protocol). */
export function findServers(timeoutMs = 1500, port = DISCOVERY_PORT): Promise<{ serverId: string; name: string; address: string; port: number }[]> {
  return new Promise(resolve => {
    const nonce = crypto.randomBytes(12).toString('base64url');
    const found = new Map<string, { serverId: string; name: string; address: string; port: number }>();
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); });
    sock.on('message', buf => {
      let m: any; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (m?.attic !== 'here' || m.v !== 1 || m.nonce !== nonce || !/^[0-9a-f]{32}$/.test(m.serverId)) return;
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(m.address) || !Number.isInteger(m.port)) return;
      found.set(m.serverId, { serverId: m.serverId, name: String(m.name ?? '').slice(0, 64), address: m.address, port: m.port });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = Buffer.from(JSON.stringify({ attic: 'discover', v: 1, nonce }));
      for (const t of broadcastTargets()) sock.send(msg, port, t, () => {});
      setTimeout(() => { try { sock.close(); } catch { /* closed */ } resolve([...found.values()]); }, timeoutMs);
    });
  });
}

export class AtticClient {
  constructor(public conn: AtticConn, private onChange: (c: AtticConn) => void = () => {}) {}

  base = () => `http://${this.conn.address}:${this.conn.port}`;
  cookie = () => [this.conn.device && `attic_device=${this.conn.device}`, this.conn.session && `attic_session=${this.conn.session}`].filter(Boolean).join('; ');
  /** For FFmpeg: an Attic file's URL (shown in place, with byte ranges) and the header that signs it in. */
  fileUrl = (share: string, rel: string, inline = true) => `${this.base()}/api/shares/${encodeURIComponent(share)}/file?path=${encodeURIComponent(rel)}${inline ? '&inline=1' : ''}`;
  headers = () => ({ Cookie: this.cookie() });

  private take(res: Response) {
    const set = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    let changed = false;
    for (const c of set) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      if (name === 'attic_device') { this.conn.device = value || undefined; changed = true; }
      if (name === 'attic_session') { this.conn.session = value || undefined; changed = true; }
    }
    if (changed) this.onChange(this.conn);
  }

  /** One request. Writes send JSON (Attic refuses anything else); errors come back as AtticError with Attic's message. */
  async call<T = any>(method: string, url: string, body?: unknown, timeoutMs = 15000): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.base() + url, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { ...this.headers(), ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
      });
    } catch (e) {
      throw new AtticError(0, 'OFFLINE', `Attic (${this.conn.name ?? this.conn.address}) is not answering. Is the HP on and on the same Wi-Fi?`);
    }
    this.take(res);
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) throw new AtticError(res.status, data?.code ?? 'ERROR', data?.message ?? `Attic answered ${res.status}.`);
    return data as T;
  }

  hello = () => this.call<{ app: string; serverId: string; name: string }>('GET', '/api/hello', undefined, 4000);
  pairing = () => this.call<{ required: boolean; paired: boolean; thisPC: boolean; device: { id: string; name: string } | null }>('GET', '/api/pairing', undefined, 5000);
  async claim(code: string, name: string) {
    return this.call('POST', '/api/pairing/claim', { code: code.replace(/[\s-]/g, ''), name, kind: 'laptop', os: process.platform === 'win32' ? 'Windows' : process.platform });
  }
  async signIn(username: string, password: string, master = false) {
    const r = await this.call<{ account: AtticConn['account'] }>('POST', '/api/session', { mode: master ? 'master' : 'device', username, password, stay: true, deviceType: 'laptop' });
    this.conn.account = r.account; this.onChange(this.conn);
    return r.account;
  }
  async whoami() {
    const r = await this.call<{ account?: AtticConn['account'] } | null>('GET', '/api/session', undefined, 5000);
    return r?.account ?? null;
  }
  async signOut() { try { await this.call('DELETE', '/api/session'); } finally { this.conn.session = undefined; this.conn.account = null; this.onChange(this.conn); } }

  shares = () => this.call<AtticShare[]>('GET', '/api/shares');
  folder = (share: string, rel: string) => this.call<{ share: { id: string; name: string }; path: string; items: AtticEntry[] }>('GET', `/api/shares/${encodeURIComponent(share)}/folder?path=${encodeURIComponent(rel)}`);
  index = (fresh = false) => this.call<{ generatedAt: string; entries: AtticEntry[] }>('GET', `/api/files${fresh ? '?fresh=1' : ''}`, undefined, 120000);
  makeFolder = (share: string, parent: string, name: string) => this.call<{ path: string }>('POST', `/api/shares/${encodeURIComponent(share)}/folder?path=${encodeURIComponent(parent)}`, { name });
  move = (share: string, rel: string, to: { share?: string; folder: string; name?: string }) =>
    this.call<{ share: string; path: string }>('POST', `/api/shares/${encodeURIComponent(share)}/move`, { path: rel, toShare: to.share, toFolder: to.folder, name: to.name });
  trash = (share: string, rel: string) => this.call<{ ok: boolean; files: number }>('POST', `/api/shares/${encodeURIComponent(share)}/trash`, { path: rel });

  /** Bytes of an Attic file (photos for thumbnails and the viewer); `range` reads only the start. */
  async read(share: string, rel: string, range?: [number, number]): Promise<Buffer> {
    const res = await fetch(this.fileUrl(share, rel), { headers: { ...this.headers(), ...(range ? { Range: `bytes=${range[0]}-${range[1]}` } : {}) }, signal: AbortSignal.timeout(120000) })
      .catch(() => { throw new AtticError(0, 'OFFLINE', 'Attic is not answering.'); });
    if (!res.ok) throw new AtticError(res.status, 'READ', res.status === 404 ? 'This file is no longer on Attic.' : `Attic answered ${res.status}.`);
    return Buffer.from(await res.arrayBuffer());
  }
  /** The player's byte ranges, passed through to Attic. */
  stream(share: string, rel: string, range: string | null) {
    return fetch(this.fileUrl(share, rel), { headers: { ...this.headers(), ...(range ? { Range: range } : {}) } });
  }

  /** A local file into an Attic folder (streamed; Attic never overwrites: "clip (1).mp4"). Answers the entry made. */
  async upload(file: string, share: string, folder: string, onBytes?: (n: number) => void, name = path.basename(file)): Promise<AtticEntry> {
    const size = (await fs.promises.stat(file)).size;
    if (size > 20 * 1024 ** 3) throw new AtticError(413, 'TOO_LARGE', `${name} is over 20 GB, Attic's limit per file.`);
    const src = fs.createReadStream(file);
    if (onBytes) src.on('data', c => onBytes((c as Buffer).length));
    let res: Response;
    try {
      res = await fetch(`${this.base()}/api/shares/${encodeURIComponent(share)}/file?path=${encodeURIComponent((folder ? folder + '/' : '') + name)}`, {
        method: 'PUT', body: Readable.toWeb(src) as unknown as ReadableStream, duplex: 'half',
        headers: { ...this.headers(), 'X-Attic-Upload': '1', 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      } as RequestInit);
    } catch { throw new AtticError(0, 'OFFLINE', `Attic stopped answering while ${name} was being sent.`); }
    finally { src.destroy(); }
    const data: any = await res.json().catch(() => null);
    if (!res.ok) throw new AtticError(res.status, data?.code ?? 'ERROR', data?.message ?? `Attic answered ${res.status}.`);
    return data as AtticEntry;
  }
  /** An Attic file to a local file (written to a temporary name, renamed when complete). Answers the bytes written. */
  async download(share: string, rel: string, dest: string, onBytes?: (n: number) => void): Promise<number> {
    const res = await fetch(this.fileUrl(share, rel, false), { headers: this.headers() }).catch(() => { throw new AtticError(0, 'OFFLINE', 'Attic is not answering.'); });
    if (!res.ok || !res.body) throw new AtticError(res.status, 'READ', res.status === 404 ? 'This file is no longer on Attic.' : `Attic answered ${res.status}.`);
    const part = `${dest}.pixhaven-part`;
    let n = 0;
    const body = Readable.fromWeb(res.body as any);
    body.on('data', c => { n += c.length; onBytes?.(c.length); });
    try { await pipeline(body, fs.createWriteStream(part, { flags: 'wx' })); await fs.promises.rename(part, dest); }
    catch (e) { await fs.promises.rm(part, { force: true }).catch(() => {}); throw e; }
    return n;
  }
}
