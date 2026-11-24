// What a developer may do right now: not suspended, under their key's monthly cap, within the account's limits, able
// to pay, and only while we sell video above what it costs us. Limits are counted in the database, so every instance
// of the engine agrees on them.

import { sql } from '../db.js';
import { config } from '../config.js';
import { balanceOf } from '../billing.js';
import { reportError } from '../monitoring.js';
import { ApiError } from './errors.js';
import { keySpendThisMonth } from './keys.js';

export interface ApiCaller { uid: string; keyId: string; keyName: string; monthlyLimit: number | null; suspended: string | null }

const usd = (n: number) => `$${n.toFixed(2)}`;
const retry = (e: ApiError, seconds: number) => Object.assign(e, { retryAfter: seconds });

/** The checks before any paid work starts. `cost` is what the request will take at most. */
export async function checkAccess(who: ApiCaller, o: { cost: number; kind: 'video' | 'film' }) {
  if (who.suspended) throw new ApiError(403, 'permission_error', 'account_suspended', `API access is suspended (${who.suspended}). Contact support to have it reviewed.`);
  const guard = await priceGuard();
  if (!guard.ok) throw retry(new ApiError(503, 'service_unavailable', 'pricing_unavailable', 'Video can’t be made through the API right now. Please try again later.'), 600);
  const [r] = await sql`select count(*) filter (where created_at > now() - interval '1 minute')::int recent,
      count(*) filter (where mode = 'clip' and stage = 'rendering')::int videos,
      count(*) filter (where mode = 'vibe' and stage not in ('ready','done','failed','expired'))::int films
    from projects where owner_id = ${who.uid} and origin = 'api' and created_at > now() - interval '3 days'`;
  if (r.recent >= config.api.createsPerMinute) throw retry(new ApiError(429, 'rate_limited', 'rate_limited', `At most ${config.api.createsPerMinute} new videos and films a minute per account.`), 30);
  if (o.kind === 'video' && r.videos >= config.api.maxActive) throw retry(new ApiError(429, 'rate_limited', 'too_many_in_progress', `At most ${config.api.maxActive} videos may be in progress at once. Wait for some to finish.`), 20);
  if (o.kind === 'film' && r.films >= config.api.maxActiveFilms) throw retry(new ApiError(429, 'rate_limited', 'too_many_in_progress', `At most ${config.api.maxActiveFilms} films may be in the making at once.`), 60);
  await checkKeyLimit(who, o.cost);
  if (config.credits.enforce) {
    const bal = await balanceOf(who.uid);
    if (bal + 1e-9 < o.cost) throw new ApiError(402, 'insufficient_credit', 'insufficient_credit', `This costs ${usd(o.cost)} and your balance is ${usd(bal)}. Add credit on the Billing page.`);
  }
}

/** The key's own monthly cap, if it has one. */
export async function checkKeyLimit(who: ApiCaller, cost: number) {
  if (who.monthlyLimit == null) return;
  const spent = await keySpendThisMonth(who.keyId);
  if (spent + cost > who.monthlyLimit + 1e-9) {
    throw new ApiError(403, 'permission_error', 'key_limit_reached', `This key has spent ${usd(spent)} of its ${usd(who.monthlyLimit)} monthly limit; this needs ${usd(cost)}. Raise the limit on the Developers page.`);
  }
}

// ───────── the price guard ─────────

export interface Guard { ok: boolean; cost_per_second: number | null; sell_per_second: number; source: string }
let cached: { at: number; value: Guard } | null = null;

/**
 * We must never sell video below what it costs us. On MiniMax that's its list price; on our own GPUs it's what renders
 * cost over the last week (counted only once there's a minute of video to judge by).
 */
export async function priceGuard(fresh = false): Promise<Guard> {
  if (!fresh && cached && Date.now() - cached.at < 300_000) return cached.value;
  const sell = config.credits.sellPerSecond['768P'];
  let cost: number | null = null, source: string;
  if (config.videoProvider === 'runpod') {
    const [m] = await sql`select coalesce(sum(u.cost_usd), 0)::float usd, coalesce(sum(u.units), 0)::float secs from usage_events u
      join takes t on t.id::text = u.ref_id where u.kind = 'video' and t.provider = 'runpod' and u.created_at > now() - interval '7 days'`;
    if (m.secs >= 60) { cost = m.usd / m.secs; source = 'what your own GPUs cost over the last 7 days'; }
    else source = 'not measured yet: fewer than 60 seconds made on your own GPUs this week';
  } else { cost = config.pricing.videoPerSecond['768P']; source = 'MiniMax’s list price at 768P'; }
  const value = { ok: cost == null || cost < sell, cost_per_second: cost == null ? null : Math.round(cost * 10_000) / 10_000, sell_per_second: sell, source };
  cached = { at: Date.now(), value };
  return value;
}

// ───────── abuse ─────────

/** A request the content check refused. Too many in a day suspends the account's API access until an admin lifts it. */
export async function recordRefusal(uid: string, category: string) {
  await sql`insert into api_refusals (owner_id, category) values (${uid}, ${category})`;
  const [{ n }] = await sql`select count(*)::int n from api_refusals where owner_id = ${uid} and created_at > now() - interval '24 hours'`;
  if (n < config.api.refusalsBeforeSuspend) return;
  const reason = `${n} requests refused by the content check in 24 hours`;
  const [s] = await sql`update api_accounts set suspended_at = now(), suspended_reason = ${reason} where owner_id = ${uid} and suspended_at is null returning owner_id`;
  if (s) {
    console.warn(`[api] suspended ${uid}: ${reason}`);
    reportError(new Error(`API access suspended: ${reason}`), { where: 'api', owner_id: uid });
  }
}

export async function setSuspended(uid: string, suspended: boolean, reason = 'suspended by an admin') {
  await sql`insert into api_accounts (owner_id, webhook_secret) values (${uid}, ${'whsec_pending'}) on conflict (owner_id) do nothing`;
  await sql`update api_accounts set suspended_at = ${suspended ? sql`now()` : null}, suspended_reason = ${suspended ? reason : null} where owner_id = ${uid}`;
  if (!suspended) await sql`delete from api_refusals where owner_id = ${uid}`; // a fresh start
}
