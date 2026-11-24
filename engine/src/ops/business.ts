// Business (money, unit economics, the last 12 months) and Customers (growth: funnel, active customers, retention,
// paying customers gone quiet; the customer list and one customer's whole story).

import { sql } from '../db.js';
import { config } from '../config.js';
import { isActiveStatus } from '../billing.js';
import { businessReport } from '../business.js';
import { customerDetail } from '../admin.js';
import { PermanentError } from '../queue.js';
import { cohortMatrix, r2 } from './stats.js';

const today = () => sql`(now() at time zone 'utc')::date`;

export async function business(days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const [base, unit, monthly, [m30], subs] = await Promise.all([
    businessReport(days),
    // Per film and per clip: what the customer was charged (setup fee net of refunds, plus render holds kept) against what
    // the providers cost us. Videos the customer deleted drop out, as on the customer page.
    sql`with p as (select id, mode, stage from projects where created_at > ${since} and mode in ('vibe', 'clip')),
      c as (select project_id, sum(cost_usd) usd from usage_events where project_id in (select id from p) group by project_id),
      f as (select ref, -sum(delta_usd) usd from credit_events where ref in (select id::text from p) group by ref),
      h as (select project_id, sum(hold_usd) filter (where status <> 'failed') usd from takes where project_id in (select id from p) group by project_id)
      select p.mode, count(*)::int videos, count(*) filter (where p.stage = 'done')::int finished,
        coalesce(sum(c.usd), 0)::float cost_usd, coalesce(sum(coalesce(f.usd, 0) + coalesce(h.usd, 0)), 0)::float charged_usd
      from p left join c on c.project_id = p.id left join f on f.ref = p.id::text left join h on h.project_id = p.id group by p.mode`,
    sql`with m as (select generate_series(date_trunc('month', now() at time zone 'utc') - interval '11 months', date_trunc('month', now() at time zone 'utc'), interval '1 month') as m)
      select to_char(m.m, 'YYYY-MM') as month,
        (select coalesce(sum(amount_usd), 0)::float from payments where created_at >= m.m at time zone 'utc' and created_at < (m.m + interval '1 month') at time zone 'utc') revenue_usd,
        (select coalesce(sum(cost_usd), 0)::float from usage_events where created_at >= m.m at time zone 'utc' and created_at < (m.m + interval '1 month') at time zone 'utc') cost_usd,
        (select count(*)::int from credit_accounts where created_at >= m.m at time zone 'utc' and created_at < (m.m + interval '1 month') at time zone 'utc') signups,
        (select count(*)::int from subscriptions where created_at >= m.m at time zone 'utc' and created_at < (m.m + interval '1 month') at time zone 'utc') new_subscriptions,
        (select count(*)::int from subscriptions where status in ('cancelled', 'expired') and updated_at >= m.m at time zone 'utc' and updated_at < (m.m + interval '1 month') at time zone 'utc') cancellations
      from m order by m.m`,
    sql`select coalesce(sum(amount_usd), 0)::float revenue from payments where created_at > now() - interval '30 days'`,
    sql`select distinct on (owner_id) owner_id, status, ends_at, updated_at from subscriptions order by owner_id, updated_at desc`,
  ]);

  // The last 30 days, whatever range is picked: revenue per paying customer, monthly churn and the lifetime it implies.
  const paying = subs.filter((s: any) => isActiveStatus(s.status, s.ends_at)).length;
  const ended30 = subs.filter((s: any) => !isActiveStatus(s.status, s.ends_at) && new Date(s.updated_at).getTime() > Date.now() - 30 * 86_400_000).length;
  const churn = paying + ended30 > 0 ? ended30 / (paying + ended30) : null;
  const arpu = paying > 0 ? m30.revenue / paying : null;

  return {
    ...base,
    unit_economics: unit.map((u: any) => ({
      mode: u.mode, videos: u.videos, finished: u.finished,
      charged_usd: r2(u.charged_usd), cost_usd: r2(u.cost_usd),
      charged_each_usd: u.videos ? r2(u.charged_usd / u.videos) : 0, cost_each_usd: u.videos ? r2(u.cost_usd / u.videos) : 0,
      margin_pct: u.charged_usd > 0 ? Math.round(((u.charged_usd - u.cost_usd) / u.charged_usd) * 100) : null,
    })),
    monthly: monthly.map((m: any) => ({ ...m, revenue_usd: r2(m.revenue_usd), cost_usd: r2(m.cost_usd) })),
    last_30_days: {
      revenue_usd: r2(m30.revenue), arpu_usd: arpu === null ? null : r2(arpu),
      churn_pct: churn === null ? null : Math.round(churn * 1000) / 10,
      lifetime_value_usd: arpu !== null && churn ? r2(arpu / churn) : null,
    },
  };
}

// ───────── customers ─────────

const SORTS = {
  recent: () => sql`last_seen_at desc`,
  newest: () => sql`created_at desc`,
  paid: () => sql`paid_usd desc, last_seen_at desc`,
  cost: () => sql`cost_usd desc, last_seen_at desc`,
  videos: () => sql`videos desc, last_seen_at desc`,
};
export type Sort = keyof typeof SORTS;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Search by any part of an email or an exact user id; sorted by last seen, newest, money paid, cost or videos. */
export async function customers(q: string, sort: string) {
  const s = (sort in SORTS ? sort : 'recent') as Sort;
  const term = q.trim();
  const where = !term ? sql`true` : UUID.test(term) ? sql`a.owner_id = ${term}` : sql`lower(a.email) like ${'%' + term.toLowerCase().replace(/[%_\\]/g, '') + '%'}`;
  const rows = await sql`select * from (select a.owner_id, a.email, a.created_at, a.last_seen_at, (a.plan_usd + a.balance_usd)::float credits_usd,
        s.status plan_status, s.ends_at,
        (select count(*)::int from projects p where p.owner_id = a.owner_id) videos,
        (select coalesce(sum(amount_usd), 0)::float from payments x where x.owner_id = a.owner_id) paid_usd,
        (select coalesce(sum(cost_usd), 0)::float from usage_events u where u.owner_id = a.owner_id) cost_usd,
        (select count(*)::int from activity_days d where d.owner_id = a.owner_id and d.day > ${today()} - 30) active_days_30,
        (select coalesce(sum(bytes), 0)::bigint from files f where f.owner_id = a.owner_id) storage_bytes
      from credit_accounts a
      left join lateral (select status, ends_at from subscriptions s where s.owner_id = a.owner_id order by updated_at desc limit 1) s on true
      where ${where}) c order by ${SORTS[s]()} limit 100`;
  return { sort: s, customers: rows.map((r: any) => ({ ...r, paid_usd: r2(r.paid_usd), cost_usd: r2(r.cost_usd), paying: isActiveStatus(r.plan_status, r.ends_at) })) };
}

/** Everything about one customer: the support picture, plus their activity, every stage their videos went through and
 * any content refusals (category and the reason they were shown, never what they wrote). */
export async function customer(ownerId: string) {
  if (!UUID.test(ownerId)) throw Object.assign(new PermanentError('customer not found', 'not_found'), { status: 404 });
  const base = await customerDetail(ownerId).catch((e) => {
    throw e instanceof PermanentError ? Object.assign(e, { status: 404 }) : e;
  });
  const [activity, timeline, refusals, [totals]] = await Promise.all([
    sql`select to_char(day, 'YYYY-MM-DD') as day, requests from activity_days where owner_id = ${ownerId} and day > ${today()} - 90 order by day`,
    sql`select e.at, e.stage, e.mode, e.project_id, p.title from stage_events e left join projects p on p.id = e.project_id
      where e.owner_id = ${ownerId} order by e.at desc, e.id desc limit 60`,
    sql`select m.at, m.category, mo.reason, m.project_id, p.title from moderation_events m left join moderations mo on mo.hash = m.hash
      left join projects p on p.id = m.project_id where m.owner_id = ${ownerId} and not m.allowed order by m.at desc limit 20`,
    sql`select (select coalesce(sum(amount_usd), 0)::float from payments where owner_id = ${ownerId}) paid_usd,
        (select coalesce(sum(cost_usd), 0)::float from usage_events where owner_id = ${ownerId}) cost_usd,
        (select count(*)::int from activity_days where owner_id = ${ownerId}) active_days`,
  ]);
  return { ...base, activity, timeline, refusals, totals: { ...totals, paid_usd: r2(totals.paid_usd), cost_usd: r2(totals.cost_usd) } };
}

/** Growth for customers who signed up in the range: the funnel, active customers per day, weekly retention, and paying
 * customers who haven't been back in two weeks. */
export async function growth(days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const span = Math.min(days, 90);
  const [[funnel], [ttf], active, cohortRows, cohortSizes, quiet, recent] = await Promise.all([
    sql`with a as (select owner_id from credit_accounts where created_at > ${since})
      select count(*)::int signed_up,
        count(*) filter (where exists (select 1 from subscriptions s where s.owner_id = a.owner_id))::int subscribed,
        count(*) filter (where exists (select 1 from stage_events e where e.owner_id = a.owner_id) or exists (select 1 from projects p where p.owner_id = a.owner_id))::int created,
        count(*) filter (where exists (select 1 from stage_events e where e.owner_id = a.owner_id and e.stage = 'done')
          or exists (select 1 from projects p where p.owner_id = a.owner_id and p.stage = 'done'))::int finished,
        count(*) filter (where (select count(*) from payments x where x.owner_id = a.owner_id) >= 2)::int paid_again
      from a`,
    sql`select percentile_cont(0.5) within group (order by extract(epoch from f.first - a.created_at)) secs
      from credit_accounts a join lateral (select min(e.at) as first from stage_events e where e.owner_id = a.owner_id and e.stage = 'done') f on f.first is not null
      where a.created_at > ${since}`,
    sql`with d as (select generate_series(${today()} - ${span - 1}::int, ${today()}, interval '1 day')::date as day)
      select to_char(d.day, 'YYYY-MM-DD') as day,
        (select count(*)::int from activity_days x where x.day = d.day) dau,
        (select count(distinct owner_id)::int from activity_days x where x.day > d.day - 7 and x.day <= d.day) wau,
        (select count(distinct owner_id)::int from activity_days x where x.day > d.day - 30 and x.day <= d.day) mau,
        (select count(*)::int from credit_accounts c where c.created_at >= d.day::timestamp at time zone 'utc' and c.created_at < (d.day + 1)::timestamp at time zone 'utc') signups
      from d order by d.day`,
    sql`with c as (select owner_id, date_trunc('week', created_at at time zone 'utc')::date wk from credit_accounts where created_at > now() - interval '10 weeks'),
      a as (select distinct owner_id, date_trunc('week', day::timestamp)::date wk from activity_days where day > ${today()} - 77)
      select to_char(c.wk, 'YYYY-MM-DD') cohort, ((a.wk - c.wk) / 7)::int week, count(distinct a.owner_id)::int active
      from c join a on a.owner_id = c.owner_id and a.wk >= c.wk group by c.wk, a.wk order by c.wk, a.wk`,
    sql`select to_char(date_trunc('week', created_at at time zone 'utc')::date, 'YYYY-MM-DD') cohort, count(*)::int size
      from credit_accounts where created_at > now() - interval '10 weeks' group by 1`,
    sql`select a.owner_id, a.email, a.last_seen_at, (a.plan_usd + a.balance_usd)::float credits_usd, s.status, s.ends_at, s.renews_at
      from credit_accounts a join lateral (select status, ends_at, renews_at from subscriptions s where s.owner_id = a.owner_id order by updated_at desc limit 1) s on true
      where a.last_seen_at < now() - interval '14 days' order by a.last_seen_at limit 200`,
    sql`select a.owner_id, a.email, a.created_at, (select count(*)::int from projects p where p.owner_id = a.owner_id) videos,
        exists (select 1 from subscriptions s where s.owner_id = a.owner_id) subscribed
      from credit_accounts a order by a.created_at desc limit 20`,
  ]);
  const sizes = Object.fromEntries(cohortSizes.map((r: any) => [r.cohort, r.size]));
  return {
    range: { days },
    funnel: [
      { key: 'signed_up', label: 'Signed up', n: funnel.signed_up },
      { key: 'subscribed', label: `Subscribed (${config.plan.name})`, n: funnel.subscribed },
      { key: 'created', label: 'Made a film or clip', n: funnel.created },
      { key: 'finished', label: 'Got a finished video', n: funnel.finished },
      { key: 'paid_again', label: 'Paid again (renewal or top-up)', n: funnel.paid_again },
    ],
    time_to_first_video_minutes: ttf?.secs === null || ttf?.secs === undefined ? null : Math.round(Number(ttf.secs) / 60),
    active,
    cohorts: cohortMatrix(cohortRows as any, sizes),
    quiet_paying: quiet.filter((q: any) => isActiveStatus(q.status, q.ends_at)).slice(0, 50),
    recent_signups: recent,
  };
}
