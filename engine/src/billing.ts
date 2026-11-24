// Customer money: two credit buckets (monthly plan credit, and top-ups that never expire), atomic
// holds for renders, a ledger of every change, the subscription gate and the storage quota.
// Payments arrive through Lemon Squeezy (lemonsqueezy.ts). Provider costs (what we pay) live in usage_events.

import { sql, begin } from './db.js';
import { config } from './config.js';
import { PermanentError } from './queue.js';

type Tx = typeof sql | any; // postgres.js transaction handle

const round = (usd: number) => Math.round(usd * 10_000) / 10_000;

/** Customer price for rendered video. */
export const sellPrice = (resolution: string, seconds: number) =>
  round((config.credits.sellPerSecond[resolution] ?? config.credits.sellPerSecond['768P']) * seconds);

/** Create the account the first time we see a user, granting the signup credit exactly once. */
export async function ensureAccount(ownerId: string, email?: string | null) {
  // Also keeps the email (for support search) and last-seen time current. xmax = 0 only on a fresh insert.
  const [row] = await sql`insert into credit_accounts (owner_id, balance_usd, email) values (${ownerId}, ${config.credits.signupUsd}, ${email ?? null})
    on conflict (owner_id) do update set email = coalesce(excluded.email, credit_accounts.email), last_seen_at = now()
    returning (xmax = 0) as inserted`;
  const created = row?.inserted;
  if (created && config.credits.signupUsd > 0) await sql`insert into credit_events (owner_id, delta_usd, reason) values (${ownerId}, ${config.credits.signupUsd}, 'signup')`;
}

/** Plan credit (expires at renewal), top-up credit (never expires) and what can be spent now. */
export async function balances(ownerId: string) {
  const [a] = await sql`select plan_usd, balance_usd from credit_accounts where owner_id = ${ownerId}`;
  const plan = a ? Number(a.plan_usd) : 0, topup = a ? Number(a.balance_usd) : 0;
  return { plan, topup, total: round(plan + topup) };
}

export async function balanceOf(ownerId: string): Promise<number> {
  return (await balances(ownerId)).total;
}

/** How a debit splits across the buckets: plan credit first, then top-ups. Mirrors the SQL in debit(). */
export function splitDebit(plan: number, topup: number, usd: number) {
  if (plan + topup < usd) return null;
  const fromPlan = Math.min(plan, usd);
  return { plan: round(plan - fromPlan), topup: round(topup - (usd - fromPlan)) };
}

/**
 * Take credit in one statement, so concurrent requests can't spend the same balance. Plan credit goes first.
 * Postgres evaluates every right-hand side against the old row, so both buckets see the same starting values.
 * Returns what was taken.
 */
export async function debit(tx: Tx, ownerId: string, usd: number, reason: string, ref?: string, apiKeyId?: string | null): Promise<number> {
  usd = round(usd);
  if (!config.credits.enforce || usd <= 0) return 0;
  const [ok] = await tx`update credit_accounts set plan_usd = greatest(plan_usd - ${usd}, 0),
      balance_usd = balance_usd - greatest(${usd} - plan_usd, 0), updated_at = now()
    where owner_id = ${ownerId} and plan_usd + balance_usd >= ${usd} returning owner_id`;
  if (!ok) {
    // Read the balance on this same transaction, never on the shared pool: this transaction may hold the row's lock,
    // and waiting here for a second connection is how every connection ended up waiting on another (see db.ts).
    const [a] = await tx`select plan_usd, balance_usd from credit_accounts where owner_id = ${ownerId}`;
    const bal = a ? round(Number(a.plan_usd) + Number(a.balance_usd)) : 0;
    throw new PermanentError(`Not enough credit: this needs $${usd.toFixed(2)} and your balance is $${bal.toFixed(2)}.`, 'insufficient_credit');
  }
  await tx`insert into credit_events (owner_id, delta_usd, reason, ref, api_key_id) values (${ownerId}, ${-usd}, ${reason}, ${ref ?? null}, ${apiKeyId ?? null})`;
  return usd;
}

/** Add credit that never expires: top-ups, refunds, signup credit. `apiKeyId` ties a refund to the API key that was charged. */
export async function credit(tx: Tx, ownerId: string, usd: number, reason: string, ref?: string, apiKeyId?: string | null) {
  usd = round(usd);
  if (usd <= 0) return;
  await tx`insert into credit_accounts (owner_id, balance_usd) values (${ownerId}, ${usd})
    on conflict (owner_id) do update set balance_usd = credit_accounts.balance_usd + ${usd}, updated_at = now()`;
  await tx`insert into credit_events (owner_id, delta_usd, reason, ref, api_key_id) values (${ownerId}, ${usd}, ${reason}, ${ref ?? null}, ${apiKeyId ?? null})`;
}

/** Stop early with a clear 402 when the customer can't afford an action (the real charge happens when the work runs). */
export async function requireCredit(ownerId: string, usd: number) {
  if (!config.credits.enforce || usd <= 0) return;
  const bal = await balanceOf(ownerId);
  if (bal + 1e-9 < usd) throw new PermanentError(`This costs $${usd.toFixed(2)} and your balance is $${bal.toFixed(2)}. Add credits to continue.`, 'insufficient_credit');
}

/**
 * Charge for one piece of work, then run it. If it fails the customer is refunded, so retries, duplicate clicks and
 * provider errors never cost them. Pass usd 0 for work that the setup fee already covers.
 *
 * `key` names this charge (a background job passes `job:<id>:<reason>`). With a key the charge survives the process:
 * if the process dies after the debit and the job runs again, the earlier charge is reused instead of taken twice, and
 * a job that finally gives up gets it back (releaseCharges). A charge that was refunded is taken again on the next try.
 */
export async function paid<T>(ownerId: string, usd: number, reason: string, ref: string, work: () => Promise<T>, key?: string): Promise<T> {
  if (!key) {
    const taken = await begin((tx) => debit(tx, ownerId, usd, reason, ref));
    try { return await work(); } catch (e) {
      if (taken > 0) await begin((tx) => credit(tx, ownerId, taken, 'refund', ref));
      throw e;
    }
  }
  await begin(async (tx) => {
    await tx`insert into charges (key, owner_id, usd, reason, status) values (${key}, ${ownerId}, 0, ${reason}, 'refunded') on conflict (key) do nothing`;
    const [c] = await tx`select status from charges where key = ${key} for update`;
    if (c.status !== 'refunded') return; // held or kept: this work is already paid for
    const taken = await debit(tx, ownerId, usd, reason, ref);
    await tx`update charges set usd = ${taken}, status = 'held', updated_at = now() where key = ${key}`;
  });
  let out: T;
  try { out = await work(); } catch (e) { await refundCharge(key); throw e; }
  await sql`update charges set status = 'kept', updated_at = now() where key = ${key} and status = 'held'`;
  return out;
}

/** Give a held charge back, once. */
export async function refundCharge(key: string) {
  await begin(async (tx) => {
    const [c] = await tx`update charges set status = 'refunded', updated_at = now() where key = ${key} and status = 'held' returning owner_id, usd, reason`;
    if (c && Number(c.usd) > 0) await credit(tx, c.owner_id, Number(c.usd), 'refund', key);
  });
}

/** A job gave up for good (or its process died on the last try): every charge it still holds goes back. */
export async function releaseCharges(jobId: number | string) {
  const held = await sql`select key from charges where key like ${`job:${jobId}:%`} and status = 'held'`;
  for (const c of held) await refundCharge(c.key);
}

/** Like paid(), for a job that knows its project but not its owner. */
export async function paidForProject<T>(projectId: string, usd: number, reason: string, work: () => Promise<T>, key?: string): Promise<T> {
  const [p] = projectId ? await sql`select owner_id from projects where id = ${projectId}` : [];
  return p ? paid(p.owner_id, usd, reason, projectId, work, key) : work();
}

/** The charge key for a paid step inside a background job. */
export const jobKey = (job: { id: number } | undefined, reason: string) => (job ? `job:${job.id}:${reason}` : undefined);

/** Close a take's hold exactly once: a good take keeps it, anything else gets it back. */
export async function settleTake(takeId: string, succeeded: boolean) {
  await begin(async (tx) => {
    const [t] = await tx`update takes set settled = true where id = ${takeId} and not settled returning hold_usd, project_id`;
    if (!t || succeeded || !(Number(t.hold_usd) > 0)) return;
    const [p] = await tx`select owner_id, api_key_id from projects where id = ${t.project_id}`;
    if (p) await credit(tx, p.owner_id, Number(t.hold_usd), 'render_refund', takeId, p.api_key_id);
  });
}

/** A paid plan invoice: this period's plan credit replaces whatever was left of the last one. */
export async function resetPlanCredit(tx: Tx, ownerId: string, ref: string) {
  const usd = round(config.plan.creditsUsd);
  await tx`insert into credit_accounts (owner_id) values (${ownerId}) on conflict (owner_id) do nothing`;
  const [a] = await tx`select plan_usd from credit_accounts where owner_id = ${ownerId} for update`;
  const left = round(Number(a.plan_usd));
  await tx`update credit_accounts set plan_usd = ${usd}, updated_at = now() where owner_id = ${ownerId}`;
  if (left > 0) await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${ownerId}, ${-left}, 'plan_expired', ${ref})`;
  if (usd > 0) await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${ownerId}, ${usd}, 'plan_credit', ${ref})`;
  return usd;
}

/** The subscription ended: unused plan credit goes. Top-ups stay. */
export async function expirePlanCredit(tx: Tx, ownerId: string, ref: string) {
  const [a] = await tx`select plan_usd from credit_accounts where owner_id = ${ownerId} for update`;
  const left = a ? round(Number(a.plan_usd)) : 0;
  if (!(left > 0)) return;
  await tx`update credit_accounts set plan_usd = 0, updated_at = now() where owner_id = ${ownerId}`;
  await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${ownerId}, ${-left}, 'plan_expired', ${ref})`;
}

// ───────── subscription gate ─────────

export type Plan = { status: string | null; active: boolean; renews_at: string | null; ends_at: string | null };

/** Whether a Lemon Squeezy status still gives access: past_due is a grace period, cancelled lasts until ends_at. */
export function isActiveStatus(status: string | null | undefined, endsAt: Date | string | null | undefined, now = Date.now()) {
  if (status === 'active' || status === 'on_trial' || status === 'past_due') return true;
  return status === 'cancelled' && !!endsAt && new Date(endsAt).getTime() > now;
}

/** The subscription that decides access: an active one if there is any (an old one can still send late webhooks), else the latest. */
export async function currentSubscription(ownerId: string) {
  const rows = await sql`select id, status, renews_at, ends_at from subscriptions where owner_id = ${ownerId} order by updated_at desc limit 20`;
  return rows.find((r: any) => isActiveStatus(r.status, r.ends_at)) ?? rows[0] ?? null;
}

export async function planOf(ownerId: string): Promise<Plan> {
  const s = await currentSubscription(ownerId);
  if (!s) return { status: null, active: false, renews_at: null, ends_at: null };
  const iso = (d: any) => (d ? new Date(d).toISOString() : null);
  return { status: s.status, active: isActiveStatus(s.status, s.ends_at), renews_at: iso(s.renews_at), ends_at: iso(s.ends_at) };
}

// ───────── storage quota ─────────

const GB = 1024 ** 3;
export const storageQuotaBytes = () => Math.round(config.plan.storageGb * GB);

/** What a customer's own videos take up. Videos made through the API are kept for a few days and don't count. */
export async function storageUsed(ownerId: string): Promise<number> {
  const [r] = await sql`select coalesce(sum(f.bytes), 0)::bigint used from files f join projects p on p.id = f.project_id
    where f.owner_id = ${ownerId} and p.origin = 'app'`;
  return Number(r.used);
}

/**
 * Anything that creates work or stores files needs an active plan and room in storage. Only enforced with
 * ENFORCE_CREDITS (production), so local development and mock runs stay free. Renders already running are
 * never stopped: this is checked before new work starts.
 */
export async function requirePlan(ownerId: string, o: { storage?: boolean } = { storage: true }) {
  if (!config.credits.enforce) return;
  const plan = await planOf(ownerId);
  if (!plan.active) {
    throw new PermanentError(plan.status === 'expired' || plan.status === 'cancelled'
      ? `Your ${config.plan.name} plan has ended. Subscribe again to keep creating.`
      : `Subscribe to the ${config.plan.name} plan to start creating.`, 'subscription_required');
  }
  if (o.storage === false) return;
  const used = await storageUsed(ownerId), quota = storageQuotaBytes();
  if (used >= quota) {
    const gb = (b: number) => (Math.floor((b / GB) * 10) / 10).toString();
    throw new PermanentError(`You're using ${gb(used)} of ${gb(quota)} GB. Delete old videos to make room.`, 'storage_full');
  }
}
