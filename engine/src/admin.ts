// Operator console (ADMIN_USER_IDS only): business overview, customer search, a customer's full picture, and
// credit adjustments for support. Mounted under /v1/admin, after sign-in.

import { Hono } from 'hono';
import { config } from './config.js';
import { sql, begin, plain } from './db.js';
import { PermanentError } from './queue.js';
import { balances, credit, isActiveStatus, planOf, storageUsed, storageQuotaBytes } from './billing.js';
import { businessReport } from './business.js';
import { setSuspended } from './api/access.js';

type Env = { Variables: { uid: string; email: string | null } };
export const admin = new Hono<Env>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Non-admins get the same 404 as a missing page: the console's existence isn't advertised.
admin.use('*', async (c, next) => {
  if (!config.admins.includes(c.get('uid'))) return c.json({ error: { code: 'not_found', message: 'page not found' } }, 404);
  await next();
});

/** The last 7 days at a glance: people, plans, films, failures, money in and provider costs out. */
admin.get('/overview', async (c) => {
  const [people] = await sql`select count(*)::int accounts,
      count(*) filter (where last_seen_at > now() - interval '7 days')::int active_7d,
      count(*) filter (where created_at > now() - interval '7 days')::int new_7d from credit_accounts`;
  const subs = await sql`select distinct on (owner_id) owner_id, status, ends_at from subscriptions order by owner_id, updated_at desc`;
  const paying = subs.filter((s: any) => isActiveStatus(s.status, s.ends_at)).length;
  const [films] = await sql`select count(*)::int created_7d,
      count(*) filter (where stage = 'done')::int finished_7d,
      count(*) filter (where stage = 'failed')::int failed_7d,
      count(*) filter (where stage not in ('done','failed','ready'))::int in_progress
    from projects where created_at > now() - interval '7 days'`;
  const spend = await sql`select kind, coalesce(sum(cost_usd), 0)::float usd from usage_events where created_at > now() - interval '7 days' group by kind order by usd desc`;
  const [money] = await sql`select coalesce(sum(amount_usd), 0)::float usd, count(*)::int n from payments where created_at > now() - interval '7 days'`;
  const failures = await sql`select p.id, p.title, p.owner_id, a.email, p.stage_error, p.updated_at from projects p
    left join credit_accounts a on a.owner_id = p.owner_id where p.stage = 'failed' order by p.updated_at desc limit 10`;
  return c.json(plain({
    people, subscriptions: { paying, mrr_usd: paying * config.plan.priceUsd },
    films, provider_spend_7d: spend, payments_7d: money, recent_failures: failures,
  }));
});

/** The company dashboard: money in and out, customers, usage, problems and live health for the last N days. */
admin.get('/business', async (c) => c.json(plain(await businessReport(Number(c.req.query('days') || 30)))));

/** Search by email (any part of it) or exact user id; empty search lists the most recently active. */
admin.get('/customers', async (c) => {
  const q = (c.req.query('q') || '').trim();
  const where = !q ? sql`true` : UUID.test(q) ? sql`a.owner_id = ${q}` : sql`lower(a.email) like ${'%' + q.toLowerCase().replace(/[%_\\]/g, '') + '%'}`;
  const rows = await sql`select a.owner_id, a.email, a.plan_usd::float plan_usd, a.balance_usd::float topup_usd, a.created_at, a.last_seen_at,
      (select status from subscriptions s where s.owner_id = a.owner_id order by updated_at desc limit 1) plan_status,
      (select count(*)::int from projects p where p.owner_id = a.owner_id) projects,
      (select coalesce(sum(bytes), 0)::bigint from files f where f.owner_id = a.owner_id) storage_bytes
    from credit_accounts a where ${where} order by a.last_seen_at desc limit 50`;
  return c.json(plain({ customers: rows }));
});

async function customer(ownerId: string) {
  if (!UUID.test(ownerId)) throw new PermanentError('customer not found', 'not_found');
  const [a] = await sql`select owner_id, email, created_at, last_seen_at from credit_accounts where owner_id = ${ownerId}`;
  if (!a) throw new PermanentError('customer not found', 'not_found');
  return a;
}

/** Everything support needs about one customer. */
admin.get('/customers/:id', async (c) => c.json(plain(await customerDetail(c.req.param('id')))));

/** One customer's plan, credits, storage, subscriptions, credit ledger, payments and films (also used by the ops dashboard). */
export async function customerDetail(ownerId: string) {
  const a = await customer(ownerId);
  const id = a.owner_id;
  const [credits, plan, used, subscriptions, events, payments, projects] = await Promise.all([
    balances(id), planOf(id), storageUsed(id),
    sql`select id, status, variant_id, renews_at, ends_at, created_at, updated_at from subscriptions where owner_id = ${id} order by updated_at desc`,
    sql`select delta_usd::float delta_usd, reason, ref, created_at from credit_events where owner_id = ${id} order by id desc limit 50`,
    sql`select id, amount_usd::float amount_usd, created_at from payments where owner_id = ${id} order by created_at desc limit 20`,
    sql`select p.id, p.title, p.mode, p.stage, p.stage_error, p.created_at, p.updated_at,
        (select coalesce(sum(cost_usd), 0)::float from usage_events u where u.project_id = p.id) provider_cost_usd,
        -- setup fee (net of any refund) plus render holds kept: failed takes are refunded, so they don't count
        ((select coalesce(-sum(delta_usd), 0) from credit_events e where e.owner_id = p.owner_id and e.ref = p.id::text)
          + (select coalesce(sum(hold_usd) filter (where status <> 'failed'), 0) from takes t where t.project_id = p.id))::float charged_usd
      from projects p where p.owner_id = ${id} order by p.updated_at desc limit 50`,
  ]);
  const [api] = await sql`select a.suspended_at, a.suspended_reason,
      (select count(*)::int from api_keys k where k.owner_id = ${id} and k.revoked_at is null) active_keys,
      (select count(*)::int from api_requests r where r.owner_id = ${id} and r.created_at > now() - interval '30 days') requests_30d,
      (select count(*)::int from api_refusals x where x.owner_id = ${id} and x.created_at > now() - interval '24 hours') refusals_24h,
      (select coalesce(-sum(delta_usd), 0)::float from credit_events e where e.owner_id = ${id} and e.api_key_id is not null and e.created_at > now() - interval '30 days') spend_30d
    from (select 1) one left join api_accounts a on a.owner_id = ${id}`;
  return {
    customer: a, credits, plan, storage: { used_bytes: used, quota_bytes: storageQuotaBytes() },
    subscriptions, credit_events: events, payments, projects,
    api: { suspended: !!api.suspended_at, suspended_reason: api.suspended_reason, suspended_at: api.suspended_at, active_keys: api.active_keys,
      requests_30d: api.requests_30d, refusals_24h: api.refusals_24h, spend_30d_usd: Math.round(api.spend_30d * 100) / 100 },
  };
}

/** Suspend or lift a customer's API access (it is suspended automatically after repeated content refusals). */
admin.post('/customers/:id/api', async (c) => {
  const a = await customer(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  if (typeof b.suspended !== 'boolean') throw new PermanentError('Send suspended: true or false.', 'bad_input');
  await setSuspended(a.owner_id, b.suspended, String(b.reason || 'suspended by an admin').slice(0, 200));
  return c.json({ suspended: b.suspended });
});

/** Give credit (goodwill, a refund done by hand) or take it back. Top-up credit only: it never expires. */
admin.post('/customers/:id/credit', async (c) => {
  const a = await customer(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  const usd = Math.round(Number(b.usd) * 100) / 100;
  const note = String(b.note || '').trim().slice(0, 200);
  if (!usd || !Number.isFinite(usd) || Math.abs(usd) > 1000) throw new PermanentError('Enter an amount between -1000 and 1000 dollars.', 'bad_input');
  if (!note) throw new PermanentError('Add a short note saying why (it goes in the customer’s credit history).', 'bad_input');
  const ref = `admin:${c.get('uid')}: ${note}`.slice(0, 250);
  await begin(async (tx) => {
    if (usd > 0) return credit(tx, a.owner_id, usd, 'admin_grant', ref);
    const [row] = await tx`update credit_accounts set balance_usd = greatest(balance_usd - ${-usd}, 0), updated_at = now()
      where owner_id = ${a.owner_id} returning balance_usd`;
    if (row) await tx`insert into credit_events (owner_id, delta_usd, reason, ref) values (${a.owner_id}, ${usd}, 'admin_deduct', ${ref})`;
  });
  return c.json({ credits: await balances(a.owner_id) });
});
