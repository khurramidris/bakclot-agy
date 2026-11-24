// Authentication. The Lovable app signs users in with Supabase Auth and sends the user's
// access token as "Authorization: Bearer <jwt>". We verify it and use `sub` as owner_id.

import type { Context, Next } from 'hono';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hsKey = config.auth.supabaseJwtSecret ? new TextEncoder().encode(config.auth.supabaseJwtSecret) : null;
const jwks = config.auth.supabaseUrl ? createRemoteJWKSet(new URL(`${config.auth.supabaseUrl}/auth/v1/.well-known/jwks.json`)) : null;

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

// Last resort when the token can't be verified locally (e.g. Lovable Cloud exposes neither the JWT secret nor JWKS):
// ask Supabase who the token belongs to. Cached briefly so polling clients don't hit Supabase on every request.
type Who = { uid: string; email: string | null };
const emailOf = (v: any) => (typeof v === 'string' && v.includes('@') ? v : null);
const remoteCache = new Map<string, { who: Who | null; until: number }>();
async function userFromSupabase(token: string): Promise<Who | null> {
  if (!config.auth.supabaseUrl || !config.auth.supabaseAnonKey) return null;
  const hit = remoteCache.get(token);
  if (hit && hit.until > Date.now()) return hit.who;
  const r = await fetch(`${config.auth.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.auth.supabaseAnonKey, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!r || r.status >= 500) return null; // Supabase unreachable: don't cache
  const u: any = r.ok ? await r.json().catch(() => null) : null;
  const who = u && typeof u.id === 'string' && UUID.test(u.id) ? { uid: u.id as string, email: emailOf(u.email) } : null;
  if (remoteCache.size > 10_000) remoteCache.clear();
  remoteCache.set(token, { who, until: Date.now() + 60_000 });
  return who;
}

/** The signed-in user, and their email when the session carries one (used to pre-fill checkout). */
export async function userFromRequest(c: Context): Promise<Who | null> {
  // 1) Server-to-server: a trusted backend (e.g. a Supabase Edge Function) acting for a user.
  const svc = c.req.header('x-engine-key');
  if (svc && config.auth.serviceKey && eq(svc, config.auth.serviceKey)) {
    const uid = c.req.header('x-user-id') || '';
    return UUID.test(uid) ? { uid, email: null } : null;
  }
  const h = c.req.header('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (c.req.query('access_token') || '');
  if (!token) return null;
  // 2) Local development tokens.
  if (token.startsWith('dev:')) {
    const uid = token.slice(4);
    return config.auth.allowDevTokens && UUID.test(uid) ? { uid, email: null } : null;
  }
  // 3) Supabase JWT (legacy HS256 secret, or asymmetric keys via JWKS).
  const opts = { audience: 'authenticated' } as const;
  let payload: any = null;
  if (hsKey) payload = await jwtVerify(token, hsKey, opts).then((r) => r.payload, () => null);
  if (!payload && jwks) payload = await jwtVerify(token, jwks, opts).then((r) => r.payload, () => null);
  if (payload) return typeof payload.sub === 'string' && UUID.test(payload.sub) ? { uid: payload.sub, email: emailOf(payload.email) } : null;
  return userFromSupabase(token);
}

export async function requireUser(c: Context, next: Next) {
  const who = await userFromRequest(c);
  if (!who) return c.json({ error: { code: 'unauthorized', message: 'Sign in required.' } }, 401);
  c.set('uid', who.uid);
  c.set('email', who.email);
  await next();
}
