// Product (what customers make, where films stall or fail, how long each stage takes, how renders go) and Safety
// (content checks, repeat offenders, rate limits, sign-in noise, accounts that cost more than they pay).

import { sql } from '../db.js';
import { WAITING } from './shared.js';
import { r2 } from './stats.js';

/** Stage order of a film (step-by-step films stop at the *_review stages; clips go straight to rendering). */
export const STAGES = ['writing', 'story_review', 'script_review', 'breakdown', 'casting', 'cast_review', 'planning', 'ready', 'rendering', 'assembling', 'done'];

export async function product(days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const [made, reached, [approval], waitingNow, durations, failedAt, errors, [renders], renderErrors, byProvider, [retakes], [length]] = await Promise.all([
    sql`select mode, coalesce(case when mode = 'clip' then brief->>'mode' else brief->>'format' end, format) as kind,
        count(*)::int n, count(*) filter (where stage = 'done')::int done, count(*) filter (where stage = 'failed')::int failed,
        count(*) filter (where stage in ${sql(WAITING)})::int waiting
      from projects where created_at > ${since} group by 1, 2 order by n desc`,
    // How many films entered each stage in the range (each film counted once per stage).
    sql`select mode, stage, count(distinct project_id)::int n from stage_events where at > ${since} and project_id is not null group by 1, 2`,
    // The moment the price is shown ("Your approval") against how many then press "Make my video".
    sql`select count(*)::int reached, count(*) filter (where first_render is not null)::int started,
        percentile_cont(0.5) within group (order by extract(epoch from first_render - at)) filter (where first_render is not null) decide_secs
      from (select distinct on (r.project_id) r.project_id, r.at,
          (select min(x.at) from stage_events x where x.project_id = r.project_id and x.stage = 'rendering' and x.at >= r.at) first_render
        from stage_events r where r.stage = 'ready' and r.at > ${since} and r.project_id is not null order by r.project_id, r.at) y`,
    sql`select p.stage, count(*)::int n,
        count(*) filter (where s.since < now() - interval '1 hour')::int over_1h, count(*) filter (where s.since < now() - interval '1 day')::int over_1d,
        count(*) filter (where s.since < now() - interval '7 days')::int over_7d
      from projects p cross join lateral (select coalesce(max(e.at), p.updated_at) since from stage_events e where e.project_id = p.id) s
      where p.stage in ${sql(WAITING)} group by p.stage`,
    // Time spent in each stage: from entering it to entering the next one.
    sql`select mode, stage, count(*)::int n, percentile_cont(0.5) within group (order by secs) p50, percentile_cont(0.9) within group (order by secs) p90
      from (select mode, stage, extract(epoch from lead(at) over w - at) secs from stage_events
        where project_id is not null and project_id in (select project_id from stage_events where at > ${since})
        window w as (partition by project_id order by at, id)) x
      where secs is not null and stage <> 'failed' group by 1, 2`,
    sql`select mode, coalesce(prev, 'start') stage, count(*)::int n from (select mode, stage, at, lag(stage) over w prev from stage_events
        where project_id is not null and project_id in (select project_id from stage_events where at > ${since} and stage = 'failed')
        window w as (partition by project_id order by at, id)) x
      where stage = 'failed' and at > ${since} group by 1, 2 order by n desc`,
    sql`select coalesce(stage_error, 'No error recorded') error, count(*)::int n, max(updated_at) latest
      from projects where stage = 'failed' and updated_at > ${since} group by 1 order by n desc limit 10`,
    sql`select count(*)::int n, count(*) filter (where status = 'succeeded')::int ok, count(*) filter (where status = 'failed')::int failed,
        count(*) filter (where status in ('pending', 'submitted', 'running'))::int active,
        percentile_cont(0.5) within group (order by extract(epoch from finished_at - submitted_at)) filter (where status = 'succeeded') render_p50,
        percentile_cont(0.95) within group (order by extract(epoch from finished_at - submitted_at)) filter (where status = 'succeeded') render_p95,
        percentile_cont(0.5) within group (order by extract(epoch from submitted_at - created_at)) filter (where submitted_at is not null) wait_p50,
        percentile_cont(0.95) within group (order by extract(epoch from submitted_at - created_at)) filter (where submitted_at is not null) wait_p95,
        coalesce(sum(seconds) filter (where status = 'succeeded'), 0)::float seconds
      from takes where created_at > ${since}`,
    sql`select coalesce(error_code, 'error') code, count(*)::int n, (array_agg(error order by created_at desc))[1] latest
      from takes where status = 'failed' and created_at > ${since} group by 1 order by n desc limit 10`,
    sql`select provider, coalesce(resolution, 'unknown') resolution, count(*)::int n, count(*) filter (where status = 'failed')::int failed,
        percentile_cont(0.5) within group (order by extract(epoch from finished_at - submitted_at)) filter (where status = 'succeeded') render_p50
      from takes where created_at > ${since} group by 1, 2 order by n desc`,
    sql`select coalesce(avg(n), 0)::float per_shot, count(*) filter (where n > 1)::int retaken, count(*)::int shots
      from (select shot_id, count(*) n from takes where created_at > ${since} group by shot_id) x`,
    sql`select coalesce(avg(secs), 0)::float avg_secs, count(*)::int films from (select p.id, sum(s.duration) secs from projects p join shots s on s.project_id = p.id
        where p.mode = 'vibe' and p.stage = 'done' and p.created_at > ${since} group by p.id) x`,
  ]);

  const round = (v: any) => (v === null || v === undefined ? null : Math.round(Number(v)));
  return {
    range: { days },
    made,
    stages: STAGES,
    reached,
    approval: {
      reached: approval.reached, started: approval.started,
      started_pct: approval.reached ? Math.round((approval.started / approval.reached) * 100) : null,
      decide_minutes_p50: approval.decide_secs === null ? null : Math.round(Number(approval.decide_secs) / 60),
    },
    waiting_now: waitingNow,
    durations: durations.map((d: any) => ({ mode: d.mode, stage: d.stage, n: d.n, p50_secs: round(d.p50), p90_secs: round(d.p90) })),
    failed_at: failedAt,
    errors,
    renders: {
      n: renders.n, ok: renders.ok, failed: renders.failed, active: renders.active,
      success_pct: renders.ok + renders.failed ? Math.round((renders.ok / (renders.ok + renders.failed)) * 100) : null,
      render_p50_secs: round(renders.render_p50), render_p95_secs: round(renders.render_p95),
      wait_p50_secs: round(renders.wait_p50), wait_p95_secs: round(renders.wait_p95),
      video_minutes: r2(renders.seconds / 60),
      errors: renderErrors,
      by_provider: byProvider.map((b: any) => ({ ...b, render_p50: round(b.render_p50) })),
      takes_per_shot: Math.round(retakes.per_shot * 100) / 100, shots_retaken: retakes.retaken, shots: retakes.shots,
    },
    film_minutes_avg: length.films ? Math.round((length.avg_secs / 60) * 10) / 10 : null,
  };
}

export async function safety(days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const span = Math.min(days, 90);
  const [[checks], categories, daily, latest, repeat, [providerRefusals], limited, [auth], costly, busiest] = await Promise.all([
    sql`select count(*)::int checks, count(*) filter (where not allowed)::int refused, count(*) filter (where cached)::int cached
      from moderation_events where at > ${since}`,
    sql`select coalesce(category, 'other') category, count(*)::int n from moderation_events where not allowed and at > ${since} group by 1 order by n desc`,
    sql`with d as (select generate_series((now() at time zone 'utc')::date - ${span - 1}::int, (now() at time zone 'utc')::date, interval '1 day')::date as day),
      m as (select (at at time zone 'utc')::date as day, count(*) checks, count(*) filter (where not allowed) refused from moderation_events
        where at > now() - make_interval(days => ${span + 1}) group by 1)
      select to_char(d.day, 'YYYY-MM-DD') as day, coalesce(m.checks, 0)::int checks, coalesce(m.refused, 0)::int refused from d left join m using (day) order by d.day`,
    sql`select m.at, m.owner_id, a.email, m.category, mo.reason, m.cached, m.project_id, p.title
      from moderation_events m left join moderations mo on mo.hash = m.hash left join credit_accounts a on a.owner_id = m.owner_id
      left join projects p on p.id = m.project_id where not m.allowed and m.at > ${since} order by m.at desc limit 40`,
    sql`select m.owner_id, a.email, count(*) filter (where not m.allowed)::int refused, count(*)::int checks, max(m.at) last_at
      from moderation_events m left join credit_accounts a on a.owner_id = m.owner_id where m.at > ${since}
      group by m.owner_id, a.email having count(*) filter (where not m.allowed) >= 2 order by refused desc limit 20`,
    sql`select count(*)::int n from takes where error_code = 'sensitive_content' and created_at > ${since}`,
    sql`select route, sum(n)::int n from api_minutes where status = 429 and minute > ${since} group by route order by n desc limit 10`,
    sql`select coalesce(sum(n) filter (where status = 401), 0)::int unauthorized, coalesce(sum(n) filter (where status = 403), 0)::int forbidden,
        (select count(*)::int from webhook_events where error = 'bad signature' and at > ${since}) bad_webhook_signatures
      from api_minutes where minute > ${since}`,
    // Lifetime cost against lifetime payments: free credit you granted shows here too.
    sql`select u.owner_id, a.email, sum(u.cost_usd)::float cost_usd, coalesce(max(x.paid), 0)::float paid_usd
      from usage_events u left join (select owner_id, sum(amount_usd) paid from payments group by owner_id) x on x.owner_id = u.owner_id
      left join credit_accounts a on a.owner_id = u.owner_id
      group by u.owner_id, a.email having sum(u.cost_usd) > coalesce(max(x.paid), 0) + 1 order by sum(u.cost_usd) - coalesce(max(x.paid), 0) desc limit 20`,
    sql`select p.owner_id, a.email, count(*)::int videos from projects p left join credit_accounts a on a.owner_id = p.owner_id
      where p.created_at > now() - interval '24 hours' group by p.owner_id, a.email order by videos desc limit 10`,
  ]);
  return {
    range: { days },
    checks: { ...checks, refused_pct: checks.checks ? Math.round((checks.refused / checks.checks) * 100) : null },
    categories, daily, latest, repeat,
    provider_refusals: providerRefusals.n,
    rate_limited: limited,
    auth,
    costly: costly.map((c: any) => ({ ...c, cost_usd: r2(c.cost_usd), paid_usd: r2(c.paid_usd) })),
    busiest_24h: busiest,
  };
}
