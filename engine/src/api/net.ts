// Fetching what a developer points us at (pictures, videos and voices by URL) and calling their webhook, without
// letting either reach our own network: a URL that leads to a private, loopback, link-local or reserved address (the
// cloud metadata service, the database, an admin port) is refused. The address is checked as it is resolved and the
// connection uses exactly that address, so DNS can't be switched between the check and the connection. Redirects are
// followed by hand and checked again. Sizes are capped while the bytes arrive, and everything has a deadline.

import { lookup as dnsLookup, promises as dns, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { isIP } from 'node:net';
import { config } from '../config.js';

export class FetchError extends Error { constructor(message: string, public code = 'fetch_failed') { super(message); } }

// ───────── which addresses are on the public internet ─────────

/** An IPv6 address as 16 bytes (accepts ::, embedded IPv4 and zone ids), or null. */
export function parseIPv6(input: string): number[] | null {
  let s = input.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!s.includes(':')) return null;
  const tail: number[] = [];
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    tail.push(...b);
    s = s.slice(0, s.length - v4[0].length);                          // "::ffff:1.2.3.4" → "::ffff:"
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);    // → "::ffff"
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (h: string) => (h ? h.split(':') : []);
  const left = words(halves[0]), right = halves.length === 2 ? words(halves[1]) : [];
  if ([...left, ...right].some((w) => !/^[0-9a-f]{1,4}$/i.test(w))) return null;
  const need = 8 - tail.length / 2;
  const fill = halves.length === 2 ? need - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== need)) return null;
  const all = [...left, ...Array(fill).fill('0'), ...right];
  const bytes: number[] = [];
  for (const w of all) { const v = parseInt(w, 16); bytes.push(v >> 8, v & 0xff); }
  bytes.push(...tail);
  return bytes.length === 16 ? bytes : null;
}

function publicV4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;        // this network, private, loopback, multicast and reserved
  if (a === 100 && (b & 0xc0) === 64) return false;                      // 100.64.0.0/10 carrier-grade NAT
  if (a === 169 && b === 254) return false;                              // link-local, including cloud metadata (169.254.169.254)
  if (a === 172 && (b & 0xf0) === 16) return false;                      // 172.16.0.0/12
  if (a === 192 && b === 168) return false;                              // 192.168.0.0/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;        // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false;                   // 6to4 relay
  if (a === 198 && (b & 0xfe) === 18) return false;                      // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return false;                  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false;                   // TEST-NET-3
  return true;
}

function publicV6(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return publicV4(b.slice(12)); // IPv4-mapped
  if (zero(0, 12)) return false;                                                       // ::, ::1, IPv4-compatible
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return zero(4, 12) ? publicV4(b.slice(12)) : false; // NAT64
  if ((b[0] & 0xe0) !== 0x20) return false;                  // only global unicast (2000::/3) is public: no ULA, link-local, multicast…
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return false; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xe0) === 0x00 && b[3] >= 0x10) return false; // ORCHID
  if (b[0] === 0x20 && b[1] === 0x02) return false;                                    // 6to4 (can tunnel to a private IPv4)
  return true;
}

/** Whether an IP address (v4 or v6, any notation Node accepts) is on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip.replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  if (v === 4) return publicV4(ip.split('.').map(Number));
  if (v === 6) { const b = parseIPv6(ip); return !!b && publicV6(b); }
  return false;
}

const allowPrivate = () => config.api.allowPrivateUrls;

/** A URL we may fetch or call: https (http only in local tests), no credentials, a reasonable length. */
export function checkUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 4096) throw new FetchError('The URL is missing or too long.', 'bad_url');
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchError('That is not a valid URL.', 'bad_url'); }
  if (u.protocol !== 'https:' && !(allowPrivate() && u.protocol === 'http:')) throw new FetchError('Only https:// URLs can be used.', 'bad_url');
  if (u.username || u.password) throw new FetchError('URLs with a user name or password can’t be used.', 'bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || (isIP(host) && !allowPrivate() && !isPublicAddress(host))) throw new FetchError('That address is not on the public internet.', 'blocked_address');
  if (!allowPrivate() && /(^|\.)(localhost|local|internal|home|lan|intranet|corp)$/i.test(host)) throw new FetchError('That address is not on the public internet.', 'blocked_address');
  return u;
}

/** Resolve a host now and make sure every address is public (used to check a webhook URL when it is given). */
export async function checkPublicHost(u: URL) {
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) || allowPrivate()) return;
  const addrs = await dns.lookup(host, { all: true }).catch(() => { throw new FetchError(`${host} doesn’t resolve.`, 'bad_url'); });
  if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address))) throw new FetchError('That address is not on the public internet.', 'blocked_address');
}

/** dns.lookup that refuses private answers. The connection then uses exactly the checked address. */
function safeLookup(hostname: string, options: any, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { all: true }, (err, addrs: LookupAddress[]) => {
    if (err) return cb(err);
    if (!addrs?.length) return cb(new FetchError(`${hostname} doesn’t resolve.`, 'bad_url'));
    if (!allowPrivate() && addrs.some((a) => !isPublicAddress(a.address))) return cb(new FetchError('That address is not on the public internet.', 'blocked_address'));
    if (options?.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}

export interface SafeResponse { status: number; headers: IncomingHttpHeaders; body: Buffer; url: string }

function once(u: URL, o: { method: string; headers: Record<string, string>; body?: string | Buffer; maxBytes: number; timeoutMs: number; connectMs: number }): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const request = u.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const fail = (e: Error) => { if (!settled) { settled = true; reject(e); } };
    const req = request({
      protocol: u.protocol, hostname: host, port: u.port || undefined, path: `${u.pathname}${u.search}`, method: o.method, agent: false,
      headers: { 'user-agent': 'Backlot/1.0 (+https://backlot.app)', ...o.headers, ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}) },
      lookup: safeLookup as any, timeout: o.connectMs, ...(isIP(host) ? {} : { servername: host }),
    }, (res) => {
      const declared = Number(res.headers['content-length'] || 0);
      if (declared > o.maxBytes) { res.destroy(); return fail(new FetchError(`The file is over ${Math.floor(o.maxBytes / 1048576)} MB.`, 'too_large')); }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (d: Buffer) => {
        total += d.length;
        if (total > o.maxBytes) { res.destroy(); req.destroy(); return fail(new FetchError(`The file is over ${Math.floor(o.maxBytes / 1048576)} MB.`, 'too_large')); }
        chunks.push(d);
      });
      res.on('end', () => { if (!settled) { settled = true; resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() }); } });
      res.on('error', fail);
    });
    const deadline = setTimeout(() => req.destroy(new FetchError(`No complete answer within ${Math.round(o.timeoutMs / 1000)} seconds.`, 'timeout')), o.timeoutMs);
    req.on('timeout', () => req.destroy(new FetchError('The server didn’t answer in time.', 'timeout')));
    req.on('error', (e: any) => fail(e instanceof FetchError ? e : new FetchError(e?.code === 'ENOTFOUND' ? `${host} doesn’t resolve.` : `Couldn’t connect (${e?.code || e?.message || 'error'}).`)));
    req.on('close', () => clearTimeout(deadline));
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** One request to a URL someone else gave us. GET follows up to three redirects, each checked like the first URL. */
export async function safeRequest(input: string, o: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string | Buffer; maxBytes: number; timeoutMs: number; connectMs?: number; redirects?: number }): Promise<SafeResponse> {
  const method = o.method || 'GET';
  let url = input;
  for (let left = o.redirects ?? 3; ; left--) {
    const u = checkUrl(url);
    const res = await once(u, { method, headers: o.headers || {}, body: o.body, maxBytes: o.maxBytes, timeoutMs: o.timeoutMs, connectMs: o.connectMs ?? 5000 });
    const loc = res.headers.location;
    if (method === 'GET' && [301, 302, 303, 307, 308].includes(res.status) && loc) {
      if (left <= 0) throw new FetchError('Too many redirects.', 'too_many_redirects');
      url = new URL(String(loc), u).toString();
      continue;
    }
    return res;
  }
}

/** `data:<type>;base64,<data>` → the bytes. Anything else isn't a data URI and returns null. */
export function decodeDataUri(s: string, maxBytes: number): { mime: string; data: Buffer } | null {
  if (typeof s !== 'string' || !/^data:/i.test(s)) return null;
  const comma = s.indexOf(',');
  const head = comma > 0 && comma < 300 ? s.slice(5, comma) : '';
  if (!/;base64$/i.test(head)) throw new FetchError('A data URI must be base64: data:<type>;base64,<data>', 'bad_url');
  const b64 = s.slice(comma + 1);
  if ((b64.length * 3) / 4 > maxBytes + 3) throw new FetchError(`The file is over ${Math.floor(maxBytes / 1048576)} MB.`, 'too_large');
  if (!/^[A-Za-z0-9+/_-]*={0,2}\s*$/.test(b64)) throw new FetchError('The data URI is not valid base64.', 'bad_url');
  return { mime: head.split(';')[0] || 'application/octet-stream', data: Buffer.from(b64, 'base64') };
}

/** A media file the developer sent: a data URI, or a URL we download (5 s to connect, 30 s in all). */
export async function fetchMedia(spec: string, maxBytes: number): Promise<Buffer> {
  const inline = decodeDataUri(spec, maxBytes);
  if (inline) return inline.data;
  const res = await safeRequest(spec, { maxBytes, timeoutMs: 30_000, headers: { accept: 'image/*,video/*,audio/*,*/*;q=0.5' } });
  if (res.status < 200 || res.status > 299) throw new FetchError(`The URL answered ${res.status}.`, 'fetch_failed');
  if (!res.body.length) throw new FetchError('The URL returned an empty file.', 'fetch_failed');
  return res.body;
}
