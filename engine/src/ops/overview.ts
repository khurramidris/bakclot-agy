// The Overview (what you see when you open the dashboard) and Live (what's running this minute).

import { sql } from '../db.js';
import { config } from '../config.js';
import { isActiveStatus } from '../billing.js';
import { paymentsEnabled } from '../lemonsqueezy.js';
import { feed, gpuHealth, pingEngine, runpodBalance, WAITING, WORKING } from './shared.js';
import { needsYou, r2, runwayDays } from './stats.js';
import { budgetStatus } from './providers.js';

const today = () => sql`(now() at time zone 'utc')::date`;
const startOfToday = () => sql`(date_trunc('day', now() at time zone 'utc') at time zone 'utc')`;
const startOfMonth = () => sql`(date_trunc('month', now() at time zone 'utc') at time zone 'utc')`;

/** Paying, cancelling and failing subscriptions now (each customer's latest subscription decides). */
export async function subscriptionsNow() {
  const subs = await sql`select distinct on (owner_id) owner_id, status, ends_at from subscriptions order by owner_id, updated_at desc`;
  const paying = subs.filter((s: any) => isActiveStatus(s.status, s.ends_at)).length;
  return {
    paying,
    cancelling: subs.filter((s: any) => s.status === 'cancelled' && isActiveStatus(s.status, s.ends_at)).length,
    past_due: subs.filter((s: any) => s.status === 'past_due').length,
    mrr_usd: r2(paying * config.plan.priceUsd),
  };
}

/** Renders and background steps waiting and running now, with how long the oldest has waited. */
export async function queueNow() {
  const [[r], [j]] = await Promise.all([
    sql`select count(*) filter (where status = 'pending')::int waiting, count(*) filter (where status in ('submitted', 'running'))::int running,
        coalesce(extract(epoch from now() - min(created_at)) / 60, 0)::int oldest_minutes
      from takes where status in ('pending', 'submitted', 'running')`,
    sql`select count(*) filter (where status = 'queued' and run_after <= now())::int ready, count(*) filter (where status = 'running')::int running,
        coalesce(extract(epoch from now() - min(run_after) filter (where status = 'queued' and run_after <= now())) / 60, 0)::int oldest_minutes
      from jobs where status in ('queued', 'running')`,
  ]);
  return { renders: r, jobs: j };
}

export async function overview() {
  const [engine, gpu, balance, budgets, subs, q, [hb], [people], [money], [made], [fails], [api], [hooks], [checks], [costly], [db], trend, items] = await Promise.all([
    pingEngine(),
    gpuHealth(),
    runpodBalance(),
    budgetStatus(),
    subscriptionsNow(),
    queueNow(),
    sql`select extract(epoch from now() - max(at)) / 60 as minutes from health_snapshots`,
    sql`select (select count(*)::int from credit_accounts) accounts,
        (select count(distinct owner_id)::int from activity_days where day >= ${today()} - 1 and last_at > now() - interval '5 minutes') online,
        (select count(*)::int from activity_days where day = ${today()}) active_today,
        (select count(*)::int from activity_days where day = ${today()} - 1) active_yesterday,
        (select count(*)::int from credit_accounts where created_at >= ${startOfToday()}) signups_today,
        (select count(*)::int from credit_accounts where created_at >= ${startOfToday()} - interval '1 day' and created_at < ${startOfToday()}) signups_yesterday`,
    sql`select (select coalesce(sum(amount_usd), 0)::float from payments where created_at >= ${startOfToday()}) revenue_today,
        (select coalesce(sum(amount_usd), 0)::float from payments where created_at >= ${startOfMonth()}) revenue_month,
        (select count(*)::int from payments where created_at >= ${startOfMonth()}) payments_month,
        (select coalesce(sum(cost_usd), 0)::float from usage_events where created_at >= ${startOfMonth()}) cost_month,
        extract(epoch from now() - ${startOfMonth()}) / 86400 as month_days`,
    sql`select count(*) filter (where stage in ${sql(WORKING)})::int in_progress,
        count(*) filter (where stage in ${sql(WAITING)})::int waiting,
        count(*) filter (where stage in ${sql(WAITING)} and updated_at < now() - interval '1 day')::int waiting_1d
      from projects where stage in ${sql([...WORKING, ...WAITING])}`,
    sql`select count(*) filter (where stage = 'done' and at >= ${startOfToday()})::int done_today,
        count(*) filter (where stage = 'failed' and at > now() - interval '24 hours')::int failed_24h,
        (select count(*)::int from jobs where status = 'failed' and updated_at > now() - interval '24 hours' and kind not like 'system.%') jobs_failed_24h
      from stage_events where at > now() - interval '25 hours'`,
    sql`select coalesce(sum(n), 0)::int requests, coalesce(sum(n) filter (where status >= 500), 0)::int errors
      from api_minutes where minute > now() - interval '1 hour' and (route like '/v1/%' or route like '/webhooks/%' or route = '(no such route)')`,
    sql`select count(*) filter (where not ok and coalesce(error, '') <> 'bad signature')::int failed,
        count(*) filter (where error = 'bad signature')::int bad_signature, count(*) filter (where ok)::int ok, max(at) filter (where ok) last_ok
      from webhook_events where at > now() - interval '24 hours'`,
    sql`select count(*)::int checks, count(*) filter (where not allowed)::int refused from moderation_events where at > now() - interval '24 hours'`,
    sql`select count(*)::int n from (select u.owner_id from usage_events u where u.created_at > now() - interval '30 days' group by u.owner_id
        having sum(u.cost_usd) > coalesce((select sum(amount_usd) from payments x where x.owner_id = u.owner_id and x.created_at > now() - interval '30 days'), 0) + 1) c`,
    sql`select pg_database_size(current_database())::bigint bytes, (select count(*)::int from pg_stat_activity where datname = current_database()) connections`
      .catch(() => [{ bytes: null, connections: null }]),
    dailyTrend(30),
    feed(15),
  ]);

  const fees = money.payments_month * config.business.paymentFeeUsd + (money.revenue_month * config.business.paymentFeePct) / 100;
  const fixed = config.business.fixedCosts.reduce((t, f) => t + (f.usd * money.month_days) / 30.44, 0);
  const profitMonth = r2(money.revenue_month - fees - money.cost_month - fixed);
  const heartbeat = hb?.minutes === null || hb?.minutes === undefined ? null : Number(hb.minutes);
  const gpuError = gpu && 'error' in gpu ? String(gpu.error) : null;
  const rp = balance && 'balance_usd' in balance ? balance : null;
  const runpodRunway = rp && rp.spend_per_hour_usd > 0 ? runwayDays(rp.balance_usd, rp.spend_per_hour_usd * 24) : null;

  const needs = needsYou({
    engine, heartbeatMinutes: heartbeat, oldestRenderMinutes: q.renders.oldest_minutes, rendersWaiting: q.renders.waiting + q.renders.running,
    oldestJobMinutes: q.jobs.oldest_minutes, jobsFailed24h: fails.jobs_failed_24h, filmsFailed24h: fails.failed_24h, api: { requests: api.requests, errors: api.errors },
    webhookFailures24h: hooks.failed, webhookBadSignatures24h: hooks.bad_signature, webhookOk24h: hooks.ok, pastDue: subs.past_due, gpuError,
    budgets: budgets.filter((b) => b.budget_usd).map((b) => ({ provider: b.name, runwayDays: b.runway_days, left: b.left_usd ?? 0 })),
    runpodRunwayDays: runpodRunway, costlyCustomers: costly.n, waitingForApproval: made.waiting_1d,
    refusals24h: { checks: checks.checks, refused: checks.refused }, profitMonth, revenueMonth: money.revenue_month,
  });

  const workers = gpu && !gpuError ? gpu.workers || {} : null;
  const status = [
    { key: 'app', label: 'App and website', level: engine.ok ? 'ok' : 'bad', detail: engine.ok ? `Answers in ${engine.ms} ms` : `Not answering: ${engine.error}` },
    { key: 'database', label: 'Database', level: 'ok', detail: db.connections === null ? 'Connected' : `${db.connections} connections · ${(Number(db.bytes) / 1e6).toFixed(0)} MB` },
    { key: 'worker', label: 'Job worker', level: heartbeat === null ? 'warn' : heartbeat > 3 ? 'bad' : 'ok',
      detail: heartbeat === null ? 'No heartbeat yet' : heartbeat > 3 ? `Silent for ${Math.round(heartbeat)} min` : `${q.jobs.running} steps running · ${q.jobs.ready} waiting` },
    config.videoProvider === 'runpod'
      ? { key: 'video', label: 'GPUs (RunPod)', level: gpuError ? 'bad' : 'ok',
          detail: gpuError ? gpuError : `${workers?.running ?? 0} running · ${workers?.idle ?? 0} idle · ${workers?.initializing ?? 0} starting` }
      : { key: 'video', label: 'Video (MiniMax)', level: 'ok', detail: `${q.renders.running} rendering · ${q.renders.waiting} waiting` },
    !paymentsEnabled()
      ? { key: 'payments', label: 'Payments', level: 'off', detail: 'Lemon Squeezy isn’t set up' }
      : { key: 'payments', label: 'Payments', level: hooks.failed ? 'bad' : 'ok',
          detail: hooks.failed ? `${hooks.failed} webhook(s) failed in 24 h` : hooks.last_ok ? 'Webhooks arriving' : 'No webhooks in 24 h' },
  ];

  return {
    at: new Date().toISOString(),
    status, needs,
    kpis: {
      online: people.online, active_today: people.active_today, active_yesterday: people.active_yesterday,
      signups_today: people.signups_today, signups_yesterday: people.signups_yesterday, accounts: people.accounts,
      paying: subs.paying, cancelling: subs.cancelling, mrr_usd: subs.mrr_usd,
      revenue_today_usd: r2(money.revenue_today), revenue_month_usd: r2(money.revenue_month),
      cost_month_usd: r2(money.cost_month + fees + fixed), profit_month_usd: profitMonth,
      in_progress: made.in_progress, waiting_for_customer: made.waiting,
      renders_running: q.renders.running, renders_waiting: q.renders.waiting, videos_done_today: fails.done_today,
    },
    trend, feed: items,
  };
}

/** One row per UTC day: money in, provider costs, sign-ups, active customers and videos started. */
export async function dailyTrend(days: number) {
  const n = Math.min(90, Math.max(1, days));
  const rows = await sql`with d as (select generate_series(${today()} - ${n - 1}::int, ${today()}, interval '1 day')::date as day),
    rev as (select (created_at at time zone 'utc')::date as day, sum(amount_usd) v from payments where created_at > now() - make_interval(days => ${n + 1}) group by 1),
    cost as (select (created_at at time zone 'utc')::date as day, sum(cost_usd) v from usage_events where created_at > now() - make_interval(days => ${n + 1}) group by 1),
    sig as (select (created_at at time zone 'utc')::date as day, count(*) v from credit_accounts where created_at > now() - make_interval(days => ${n + 1}) group by 1),
    act as (select day, count(*) v from activity_days where day > ${today()} - ${n + 1}::int group by 1),
    vid as (select (created_at at time zone 'utc')::date as day, count(*) v from projects where created_at > now() - make_interval(days => ${n + 1}) group by 1)
    select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(rev.v, 0)::float revenue_usd, coalesce(cost.v, 0)::float cost_usd,
      coalesce(sig.v, 0)::int signups, coalesce(act.v, 0)::int active, coalesce(vid.v, 0)::int videos
    from d left join rev using (day) left join cost using (day) left join sig using (day) left join act using (day) left join vid using (day)
    order by d.day`;
  return rows.map((r: any) => ({ ...r, revenue_usd: r2(r.revenue_usd), cost_usd: r2(r.cost_usd) }));
}

export async function live() {
  const [online, working, waiting, renders, kinds, running, gpu, [controller], snapshots, items] = await Promise.all([
    sql`select * from (select distinct on (d.owner_id) d.owner_id, a.email, d.last_at, d.requests from activity_days d
        left join credit_accounts a on a.owner_id = d.owner_id
        where d.day >= ${today()} - 1 and d.last_at > now() - interval '5 minutes' order by d.owner_id, d.last_at desc) x
      order by last_at desc limit 50`,
    sql`select p.id, p.title, p.mode, p.stage, p.owner_id, a.email, p.created_at, p.updated_at,
        (select max(e.at) from stage_events e where e.project_id = p.id) stage_since,
        (select j.progress from jobs j where j.project_id = p.id and j.status = 'running' order by j.updated_at desc limit 1) progress,
        t.done, t.running, t.waiting, t.failed
      from projects p left join credit_accounts a on a.owner_id = p.owner_id
      left join lateral (select count(*) filter (where status = 'succeeded')::int done, count(*) filter (where status in ('submitted', 'running'))::int running,
        count(*) filter (where status = 'pending')::int waiting, count(*) filter (where status = 'failed')::int failed from takes where project_id = p.id) t on true
      where p.stage in ${sql(WORKING)} order by p.updated_at desc limit 50`,
    sql`select p.id, p.title, p.mode, p.stage, p.owner_id, a.email, coalesce((select max(e.at) from stage_events e where e.project_id = p.id), p.updated_at) since
      from projects p left join credit_accounts a on a.owner_id = p.owner_id
      where p.stage in ${sql(WAITING)} order by since asc limit 50`,
    sql`select t.id, t.status, t.provider, t.resolution, t.created_at, t.submitted_at, s.code shot, s.duration, p.id project_id, p.title, p.mode, p.owner_id, a.email
      from takes t join shots s on s.id = t.shot_id join projects p on p.id = t.project_id left join credit_accounts a on a.owner_id = p.owner_id
      where t.status in ('pending', 'submitted', 'running') order by t.created_at limit 100`,
    sql`select kind, count(*) filter (where status = 'running')::int running, count(*) filter (where status = 'queued' and run_after <= now())::int ready,
        count(*) filter (where status = 'queued' and run_after > now())::int scheduled
      from jobs where status in ('queued', 'running') and kind not like 'system.%' group by kind order by kind`,
    sql`select j.id, j.kind, j.progress, j.attempts, j.max_attempts, j.locked_by, j.created_at, j.updated_at, j.project_id, p.title
      from jobs j left join projects p on p.id = j.project_id where j.status = 'running' and j.kind not like 'system.%'
      order by j.updated_at desc limit 30`,
    gpuHealth(),
    sql`select progress, updated_at from jobs where kind = 'system.capacity' order by id desc limit 1`,
    sql`select at, renders_waiting, renders_running, jobs_ready, jobs_running, online,
        coalesce((gpu->'workers'->>'running')::int, 0) + coalesce((gpu->'workers'->>'idle')::int, 0) gpu_workers
      from health_snapshots where at > now() - interval '2 hours' order by at`,
    feed(60),
  ]);
  return {
    at: new Date().toISOString(),
    online, working, waiting, renders,
    jobs: { kinds, running },
    gpu: config.videoProvider === 'runpod' ? { health: gpu, controller: controller ?? null, manage_scaling: config.runpod.manageScaling } : null,
    snapshots, feed: items,
  };
}
