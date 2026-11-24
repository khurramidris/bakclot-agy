// API keys and the developer's account. A key is shown once when it is made; we keep only its SHA-256 and a short
// prefix to show in lists. Each account has one webhook signing secret.

import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../config.js';
import { ApiError, invalid, notFound } from './errors.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** n random base-62 characters, without modulo bias (bytes ≥ 248 are skipped). */
export function base62(n: number): string {
  let out = '';
  while (out.length < n) for (const b of randomBytes(n * 2)) { if (b < 248 && out.length < n) out += B62[b % 62]; }
  return out;
}

export const KEY_PREFIX = 'bk_live_';
export const KEY_RX = /^bk_live_[0-9A-Za-z]{32}$/;
export const newKey = () => KEY_PREFIX + base62(32);
export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
/** What lists show: enough to recognise a key, never enough to use it. */
export const keyPreview = (key: string) => `${key.slice(0, KEY_PREFIX.length + 4)}…`;
export const newWebhookSecret = () => 'whsec_' + base62(32);

/** The developer's account row (made the first time it is needed), with its webhook signing secret. */
export async function ensureApiAccount(ownerId: string) {
  await sql`insert into api_accounts (owner_id, webhook_secret) values (${ownerId}, ${newWebhookSecret()}) on conflict (owner_id) do nothing`;
  const [a] = await sql`select * from api_accounts where owner_id = ${ownerId}`;
  return a;
}

export async function rotateWebhookSecret(ownerId: string) {
  await ensureApiAccount(ownerId);
  const [a] = await sql`update api_accounts set webhook_secret = ${newWebhookSecret()} where owner_id = ${ownerId} returning webhook_secret`;
  return a.webhook_secret as string;
}

const limitOf = (v: unknown, param: string) => {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) throw invalid('A monthly limit is a dollar amount above 0, or null for no limit.', param);
  return Math.round(n * 100) / 100;
};
const nameOf = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Make a key. Returns the full key: the only time it is ever available. */
export async function createKey(ownerId: string, o: { name?: unknown; monthly_limit_usd?: unknown }) {
  await ensureApiAccount(ownerId);
  const [{ n }] = await sql`select count(*)::int n from api_keys where owner_id = ${ownerId} and revoked_at is null`;
  if (n >= config.api.maxKeys) throw new ApiError(409, 'invalid_request', 'too_many_keys', `An account can have up to ${config.api.maxKeys} active keys. Revoke one first.`);
  const key = newKey();
  const [row] = await sql`insert into api_keys (owner_id, name, prefix, hash, monthly_limit_usd)
    values (${ownerId}, ${nameOf(o.name) || 'API key'}, ${keyPreview(key)}, ${keyHash(key)}, ${limitOf(o.monthly_limit_usd, 'monthly_limit_usd') ?? null}) returning *`;
  return { key, row: keyView(row) };
}

export async function listKeys(ownerId: string) {
  const rows = await sql`select k.*, coalesce((select -sum(e.delta_usd) from credit_events e where e.api_key_id = k.id and e.created_at >= date_trunc('month', now())), 0)::float spent
    from api_keys k where k.owner_id = ${ownerId} order by k.revoked_at nulls first, k.created_at desc limit 100`;
  return rows.map(keyView);
}

export async function updateKey(ownerId: string, id: string, o: { name?: unknown; monthly_limit_usd?: unknown }) {
  const [k] = await sql`select * from api_keys where id = ${id} and owner_id = ${ownerId}`;
  if (!k) throw notFound('key');
  const limit = limitOf(o.monthly_limit_usd, 'monthly_limit_usd');
  const [row] = await sql`update api_keys set name = ${o.name !== undefined ? nameOf(o.name) || k.name : k.name},
    monthly_limit_usd = ${limit === undefined ? k.monthly_limit_usd : limit} where id = ${id} returning *`;
  return keyView(row);
}

export async function revokeKey(ownerId: string, id: string) {
  const [row] = await sql`update api_keys set revoked_at = coalesce(revoked_at, now()) where id = ${id} and owner_id = ${ownerId} returning *`;
  if (!row) throw notFound('key');
  return keyView(row);
}

export const keyView = (k: any) => ({
  id: k.id, name: k.name, prefix: k.prefix, monthly_limit_usd: k.monthly_limit_usd == null ? null : Number(k.monthly_limit_usd),
  ...(k.spent !== undefined ? { spent_this_month_usd: Math.round(Number(k.spent) * 100) / 100 } : {}),
  created_at: k.created_at, last_used_at: k.last_used_at, revoked_at: k.revoked_at, active: !k.revoked_at,
});

/** What a key has spent this calendar month: charges minus refunds, wherever they were made (videos or films). */
export async function keySpendThisMonth(keyId: string): Promise<number> {
  const [r] = await sql`select coalesce(-sum(delta_usd), 0)::float spent from credit_events where api_key_id = ${keyId} and created_at >= date_trunc('month', now())`;
  return Math.max(0, Number(r.spent));
}
