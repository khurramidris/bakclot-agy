// The company at a glance, for the admin dashboard: money in (payments), money out (what every provider cost us, the
// payment processor's fees and the monthly fixed costs), customers, what they made, what failed, and how the render
// pipeline and the GPUs are doing right now. One read-only report for a date range.

import { sql } from './db.js';
import { config } from './config.js';
import { isActiveStatus } from './billing.js';
import { endpointHealth } from './providers/runpod.js';
import { capacitySnapshot, runpodInUse } from './capacity.js';

const DAY_MS = 86_400_000;
const r2 = (v: number) => Math.round(v * 100) / 100;

export async function businessReport(daysIn: number) {
  const days = Math.min(365, Math.max(1, Math.round(daysIn) || 30));
  const since = sql`now() - make_interval(days => ${days})`;

  const [pay] = await sql`select coalesce(sum(amount_usd), 0)::float usd, count(*)::int n,
      coalesce(sum(amount_usd) filter (where id like 'ls:invoice:%'), 0)::float plans_usd,
      coalesce(sum(amount_usd) filter (where id like 'ls:order:%'), 0)::float topups_usd
    from payments where created_at > ${since}`;
  const fees = r2(pay.n * config.business.paymentFeeUsd + (pay.usd * config.business.paymentFeePct) / 100);

  const providers = await sql`select kind, coalesce(sum(cost_usd), 0)::float usd, coalesce(sum(units), 0)::float units, count(*)::int n,
      bool_or(estimated) estimated
    from usage_events where created_at > ${since} group by kind order by usd desc`;
  const [llm] = await sql`select coalesce(sum(cost_usd) filter (where ref_id = 'moderation'), 0)::float moderation_usd
    from usage_events where kind = 'llm' and created_at > ${since}`;
  const providerUsd = providers.reduce((t: number, p: any) => t + p.usd, 0);
  const fixed = config.business.fixedCosts.map((f) => ({ name: f.name, monthly_usd: f.usd, in_range_usd: r2((f.usd * days) / 30.44) }));
  const fixedUsd = fixed.reduce((t, f) => t + f.in_range_usd, 0);

  // What customers spent of their credit (charges minus refunds): usage revenue, earned as the work is delivered.
  const [spent] = await sql`select
      coalesce(-sum(delta_usd) filter (where delta_usd < 0 and reason not in ('plan_expired', 'admin_deduct')), 0)::float charged,
      coalesce(sum(delta_usd) filter (where reason in ('refund', 'render_refund')), 0)::float refunded
    from credit_events where created_at > ${since}`;
  const [owed] = await sql`select coalesce(sum(plan_usd), 0)::float plan_usd, coalesce(sum(balance_usd), 0)::float topup_usd from credit_accounts`;

  const [people] = await sql`select count(*)::int accounts,
      count(*) filter (where created_at > ${since})::int new, count(*) filter (where last_seen_at > ${since})::int active
    from credit_accounts`;
  const subs = await sql`select distinct on (owner_id) owner_id, status, ends_at, updated_at from subscriptions order by owner_id, updated_at desc`;
  const paying = subs.filter((s: any) => isActiveStatus(s.status, s.ends_at)).length;
  const sinceMs = Date.now() - days * DAY_MS;
  const ended = subs.filter((s: any) => !isActiveStatus(s.status, s.ends_at) && new Date(s.updated_at).getTime() > sinceMs).length;
  const cancelling = subs.filter((s: any) => s.status === 'cancelled' && isActiveStatus(s.status, s.ends_at)).length;
  const pastDue = subs.filter((s: any) => s.status === 'past_due').length;

  // Films and clips still in customers' accounts (a deleted video takes its rows with it).
  const [made] = await sql`select
      count(*) filter (where mode = 'vibe')::int films, count(*) filter (where mode = 'vibe' and stage = 'done')::int films_done,
      count(*) filter (where mode = 'vibe' and stage = 'failed')::int films_failed,
      count(*) filter (where mode = 'clip')::int clips, count(*) filter (where mode = 'clip' and stage = 'done')::int clips_done,
      count(*) filter (where mode = 'clip' and stage = 'failed')::int clips_failed
    from projects where created_at > ${since}`;
  // Finished renders come from the cost ledger, which keeps them after a customer deletes the video.
  const [video] = await sql`select count(*)::int ok, coalesce(sum(units), 0)::float seconds, coalesce(sum(cost_usd), 0)::float usd
    from usage_events where kind = 'video' and created_at > ${since}`;
  const [renders] = await sql`select count(*) filter (where status = 'failed' and error_code = 'sensitive_content')::int refused,
      count(*) filter (where status = 'failed' and coalesce(error_code, '') <> 'sensitive_content')::int failed,
      coalesce(avg(extract(epoch from finished_at - submitted_at)) filter (where status = 'succeeded'), 0)::float avg_render_seconds
    from takes where created_at > ${since}`;

  // One row per day (at most the last 90), for the chart.
  const span = Math.min(days, 90);
  const daily = await sql`with d as (select generate_series(date_trunc('day', now()) - make_interval(days => ${span - 1}), date_trunc('day', now()), interval '1 day') as t)
    select to_char(d.t, 'YYYY-MM-DD') as day,
      (select coalesce(sum(amount_usd), 0)::float from payments where created_at >= d.t and created_at < d.t + interval '1 day') revenue_usd,
      (select coalesce(sum(cost_usd), 0)::float from usage_events where created_at >= d.t and created_at < d.t + interval '1 day') cost_usd,
      (select count(*)::int from credit_accounts where created_at >= d.t and created_at < d.t + interval '1 day') signups,
      (select count(*)::int from projects where created_at >= d.t and created_at < d.t + interval '1 day') videos
    from d order by d.t`;

  const errors = await sql`select coalesce(error_code, 'error') code, count(*)::int n, (array_agg(error order by created_at desc))[1] latest
    from takes where status = 'failed' and created_at > ${since} group by 1 order by n desc limit 8`;
  const jobErrors = await sql`select kind, count(*)::int n, (array_agg(error order by updated_at desc))[1] latest
    from jobs where status = 'failed' and updated_at > ${since} group by kind order by n desc limit 8`;
  const failures = await sql`select p.id, p.title, p.mode, p.owner_id, a.email, p.stage_error, p.updated_at from projects p
    left join credit_accounts a on a.owner_id = p.owner_id where p.stage = 'failed' and p.updated_at > ${since} order by p.updated_at desc limit 10`;
  // Who costs the most: spots both the best customers and anyone abusing the service.
  const top = await sql`select u.owner_id, a.email, sum(u.cost_usd)::float cost_usd,
      (select coalesce(sum(amount_usd), 0)::float from payments x where x.owner_id = u.owner_id and x.created_at > ${since}) paid_usd
    from usage_events u left join credit_accounts a on a.owner_id = u.owner_id
    where u.created_at > ${since} group by u.owner_id, a.email order by cost_usd desc limit 10`;

  const [queue] = await sql`select count(*) filter (where status = 'pending')::int waiting,
      count(*) filter (where status in ('submitted', 'running'))::int rendering,
      coalesce(extract(epoch from now() - min(created_at)) / 60, 0)::float oldest_minutes
    from takes where status in ('pending', 'submitted', 'running')`;
  const [jobs] = await sql`select count(*) filter (where status = 'queued' and run_after <= now())::int ready,
      count(*) filter (where status = 'running')::int running,
      count(*) filter (where status = 'failed' and updated_at > now() - interval '24 hours')::int failed_24h,
      coalesce(extract(epoch from now() - min(run_after) filter (where status = 'queued' and run_after <= now())) / 60, 0)::float oldest_ready_minutes
    from jobs`;
  const [files] = await sql`select coalesce(sum(bytes), 0)::bigint bytes, count(*)::int n from files`;
  const gpu = runpodInUse() ? await endpointHealth().catch((e: any) => ({ error: String(e.message || e) })) : null;
  const capacity = await capacitySnapshot();

  // The public API: who uses it, how much, and how much it earns.
  const [apiUse] = await sql`select (select count(distinct owner_id)::int from api_keys where revoked_at is null) developers,
      (select count(*)::int from api_accounts where suspended_at is not null) suspended,
      (select count(*)::int from api_requests where created_at > ${since}) requests,
      (select count(*)::int from api_requests where created_at > ${since} and status >= 500) server_errors,
      (select count(*) filter (where mode = 'clip')::int from projects where origin = 'api' and created_at > ${since}) videos,
      (select count(*) filter (where mode = 'vibe')::int from projects where origin = 'api' and created_at > ${since}) films,
      (select coalesce(-sum(delta_usd), 0)::float from credit_events where api_key_id is not null and created_at > ${since}) spend_usd,
      (select count(*)::int from webhook_deliveries where status = 'failed' and created_at > ${since}) webhooks_failed`;
  const revenue = r2(pay.usd);
  const net = r2(revenue - fees);
  const profit = r2(net - providerUsd - fixedUsd);
  return {
    range: { days, from: new Date(Date.now() - days * DAY_MS).toISOString(), to: new Date().toISOString() },
    money: {
      revenue_usd: revenue, plans_usd: r2(pay.plans_usd), topups_usd: r2(pay.topups_usd), payments: pay.n,
      fees_usd: fees, net_revenue_usd: net, provider_costs_usd: r2(providerUsd), fixed_costs_usd: r2(fixedUsd),
      profit_usd: profit, margin_pct: net > 0 ? Math.round((profit / net) * 100) : null,
      credits_spent_usd: r2(spent.charged - spent.refunded), refunded_usd: r2(spent.refunded),
      credits_outstanding_usd: { plan: r2(owed.plan_usd), topup: r2(owed.topup_usd) },
    },
    costs: {
      providers: providers.map((p: any) => ({ kind: p.kind, usd: r2(p.usd), units: p.units, events: p.n, estimated: !!p.estimated })),
      moderation_usd: r2(llm.moderation_usd), fixed,
      gpu_note: config.videoProvider === 'runpod' ? 'GPU cost counts render time only; worker start-up and idle minutes are on your RunPod bill.' : null,
    },
    customers: {
      accounts: people.accounts, new: people.new, active: people.active, paying, mrr_usd: r2(paying * config.plan.priceUsd),
      ended, cancelling, past_due: pastDue,
    },
    usage: {
      ...made, renders_ok: video.ok, renders_failed: renders.failed, renders_refused: renders.refused,
      video_seconds: r2(video.seconds), avg_render_seconds: Math.round(renders.avg_render_seconds),
      video_cost_per_second_usd: video.seconds > 0 ? Math.round((video.usd / video.seconds) * 10000) / 10000 : null,
      sell_per_second_usd: config.credits.sellPerSecond['768P'],
    },
    daily: daily.map((d: any) => ({ ...d, revenue_usd: r2(d.revenue_usd), cost_usd: r2(d.cost_usd) })),
    problems: { render_errors: errors, job_errors: jobErrors, failed_projects: failures },
    api: { enabled: config.api.enabled, ...apiUse, spend_usd: r2(apiUse.spend_usd) },
    top_customers: top.map((t: any) => ({ ...t, cost_usd: r2(t.cost_usd), paid_usd: r2(t.paid_usd) })),
    health: {
      video_provider: config.videoProvider, renders_waiting: queue.waiting, renders_running: queue.rendering,
      oldest_render_minutes: Math.round(queue.oldest_minutes), jobs_ready: jobs.ready, jobs_running: jobs.running,
      jobs_failed_24h: jobs.failed_24h, oldest_job_wait_minutes: Math.round(jobs.oldest_ready_minutes),
      storage_bytes: Number(files.bytes), stored_files: files.n, gpu, capacity,
    },
  };
}
