// Backend: API traffic, speed and errors by route; background steps by kind; the job worker's heartbeat; queue and GPU
// history; the database (size, biggest tables, connections, slow queries); storage; payment webhooks; the app's health.

import { sql } from '../db.js';
import { config } from '../config.js';
import { storageQuotaBytes } from '../billing.js';
import { pingEngine } from './shared.js';
import { percentileMs, stepFor } from './stats.js';

/** Routes that are API calls (not page loads, static files or health checks). */
const API_ROUTE = () => sql`(route like '/v1/%' or route like '/webhooks/%' or route like '/files/%' or route = '(no such route)')`;

export async function backend(hours: number) {
  const step = stepFor(hours);
  const since = sql`now() - make_interval(hours => ${hours})`;
  const bucket = (col: string) => sql`to_timestamp(floor(extract(epoch from ${sql(col)}) / ${step}) * ${step})`;
  const [series, routes, statuses, [kinds], [apiTotal], jobs, jobFailures, health, gaps, [cover], engine, dbInfo, storage, hooks] = await Promise.all([
    sql`select ${bucket('minute')} as t, sum(n)::int n, coalesce(sum(n) filter (where status >= 500), 0)::int errors,
        coalesce(sum(n) filter (where status >= 400 and status < 500), 0)::int client_errors, sum(total_ms)::float total_ms, max(max_ms)::float max_ms,
        int_array_sum(hist) hist
      from api_minutes where minute > ${since} and ${API_ROUTE()} group by 1 order by 1`,
    sql`select route, method, sum(n)::int n, sum(total_ms)::float total_ms, max(max_ms)::float max_ms, int_array_sum(hist) hist,
        coalesce(sum(n) filter (where status >= 500), 0)::int errors, coalesce(sum(n) filter (where status >= 400 and status < 500), 0)::int client_errors,
        coalesce(sum(n) filter (where status = 429), 0)::int limited
      from api_minutes where minute > ${since} group by route, method order by n desc limit 60`,
    sql`select status, sum(n)::int n from api_minutes where minute > ${since} group by status order by status`,
    sql`select coalesce(sum(n) filter (where route = '(web page)'), 0)::int page_loads, coalesce(sum(n) filter (where route = '/health'), 0)::int health_checks
      from api_minutes where minute > ${since}`,
    sql`select coalesce(sum(n), 0)::int requests, coalesce(sum(n) filter (where status >= 500), 0)::int errors,
        coalesce(sum(n) filter (where status >= 400 and status < 500), 0)::int client_errors, coalesce(sum(n) filter (where status = 429), 0)::int limited,
        coalesce(max(max_ms), 0)::float max_ms, int_array_sum(hist) hist
      from api_minutes where minute > ${since} and ${API_ROUTE()}`,
    sql`select kind, count(*) filter (where status = 'done')::int done, count(*) filter (where status = 'failed')::int failed,
        count(*) filter (where status in ('queued', 'running'))::int active, count(*) filter (where attempts > 1)::int retried,
        percentile_cont(0.5) within group (order by extract(epoch from updated_at - created_at)) filter (where status = 'done') p50_secs,
        percentile_cont(0.95) within group (order by extract(epoch from updated_at - created_at)) filter (where status = 'done') p95_secs
      from jobs where updated_at > ${since} and kind not like 'system.%' group by kind order by kind`,
    sql`select j.id, j.kind, j.error, j.attempts, j.project_id, p.title, j.updated_at from jobs j left join projects p on p.id = j.project_id
      where j.status = 'failed' and j.updated_at > ${since} order by j.updated_at desc limit 20`,
    sql`select ${bucket('at')} as t, max(renders_waiting)::int renders_waiting, max(renders_running)::int renders_running,
        max(jobs_ready)::int jobs_ready, max(jobs_running)::int jobs_running, max(online)::int online, max(db_connections)::int db_connections,
        max(coalesce((gpu->'workers'->>'running')::int, 0) + coalesce((gpu->'workers'->>'idle')::int, 0))::int gpu_workers, count(*)::int samples
      from health_snapshots where at > ${since} group by 1 order by 1`,
    sql`select at, prev, round(extract(epoch from at - prev) / 60)::int minutes from (select at, lag(at) over (order by at) prev
        from health_snapshots where at > ${since}) x where at - prev > interval '3 minutes' order by at desc limit 10`,
    sql`select count(*)::int samples, min(at) first from health_snapshots where at > ${since}`,
    pingEngine(),
    database(),
    storageReport(),
    sql`select id, event_name, ok, status, error, ms, at from webhook_events where at > ${since} order by at desc limit 30`,
  ]);

  const routeRows = routes.map((r: any) => ({
    route: r.route, method: r.method, n: r.n, errors: r.errors, client_errors: r.client_errors, limited: r.limited,
    avg_ms: r.n ? Math.round(r.total_ms / r.n) : null, p95_ms: percentileMs(r.hist, 0.95, r.max_ms), max_ms: Math.round(r.max_ms),
  }));
  const apiRows = routeRows.filter((r) => /^\/(v1|webhooks|files)\//.test(r.route) || r.route === '(no such route)');
  // Expected samples: one a minute since the window began (or since the first snapshot, for a new deployment).
  const windowStart = Math.max(Date.now() - hours * 3_600_000, cover.first ? new Date(cover.first).getTime() : Date.now());
  const expected = Math.max(1, Math.round((Date.now() - windowStart) / 60_000));

  return {
    range: { hours, step_seconds: step },
    app: engine,
    api: {
      requests: apiTotal.requests, errors: apiTotal.errors, client_errors: apiTotal.client_errors, limited: apiTotal.limited,
      page_loads: kinds.page_loads, health_checks: kinds.health_checks,
      p50_ms: percentileMs(apiTotal.hist, 0.5, apiTotal.max_ms), p95_ms: percentileMs(apiTotal.hist, 0.95, apiTotal.max_ms),
      p99_ms: percentileMs(apiTotal.hist, 0.99, apiTotal.max_ms),
      series: series.map((s: any) => ({ t: new Date(s.t).toISOString(), n: s.n, errors: s.errors, client_errors: s.client_errors,
        avg_ms: s.n ? Math.round(s.total_ms / s.n) : null, p95_ms: percentileMs(s.hist, 0.95, s.max_ms) })),
      routes: apiRows.slice(0, 25),
      slowest: [...apiRows].filter((r) => r.n >= 10 && r.p95_ms !== null).sort((a, b) => (b.p95_ms ?? 0) - (a.p95_ms ?? 0)).slice(0, 10),
      failing: [...apiRows].filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 10),
      statuses,
    },
    jobs: { kinds: jobs.map((j: any) => ({ ...j, p50_secs: j.p50_secs === null ? null : Math.round(j.p50_secs), p95_secs: j.p95_secs === null ? null : Math.round(j.p95_secs) })), failures: jobFailures },
    heartbeat: { coverage_pct: cover.samples ? Math.min(100, Math.round((cover.samples / expected) * 100)) : 0, samples: cover.samples, gaps },
    history: health.map((h: any) => ({ ...h, t: new Date(h.t).toISOString() })),
    database: dbInfo,
    storage,
    webhooks: hooks,
  };
}

async function database() {
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [[size], tables, connections, slow, [cache], statements] = await Promise.all([
    safe(sql`select pg_database_size(current_database())::bigint bytes`, [{ bytes: null }] as any),
    safe(sql`select s.relname as name, pg_total_relation_size(s.relid)::bigint bytes, s.n_live_tup::bigint as rows
      from pg_stat_user_tables s order by 2 desc limit 12`, [] as any),
    safe(sql`select coalesce(nullif(application_name, ''), 'other') app, coalesce(state, 'unknown') state, count(*)::int n
      from pg_stat_activity where datname = current_database() group by 1, 2 order by 3 desc`, [] as any),
    safe(sql`select pid, round(extract(epoch from now() - query_start))::int secs, state, left(query, 160) query from pg_stat_activity
      where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid() and query_start < now() - interval '30 seconds'
      order by query_start limit 10`, [] as any),
    safe(sql`select round(100 * sum(blks_hit)::numeric / nullif(sum(blks_hit) + sum(blks_read), 0), 1)::float hit_pct
      from pg_stat_database where datname = current_database()`, [{ hit_pct: null }] as any),
    // Supabase has pg_stat_statements; elsewhere it may be missing or not readable.
    safe(sql`select calls::bigint, round(total_exec_time)::bigint total_ms, round(mean_exec_time::numeric, 1)::float mean_ms, left(query, 200) query
      from pg_stat_statements order by total_exec_time desc limit 10`, null as any),
  ]);
  return { bytes: size?.bytes ?? null, tables, connections, slow_queries: slow, cache_hit_pct: cache?.hit_pct ?? null, top_statements: statements };
}

async function storageReport() {
  const quota = storageQuotaBytes();
  const [[total], growth, top, [near]] = await Promise.all([
    sql`select coalesce(sum(bytes), 0)::bigint bytes, count(*)::int files, count(distinct owner_id)::int customers from files`,
    sql`select to_char((created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day, coalesce(sum(bytes), 0)::bigint bytes, count(*)::int files
      from files where created_at > now() - interval '30 days' group by 1 order by 1`,
    sql`select f.owner_id, a.email, sum(f.bytes)::bigint bytes from files f left join credit_accounts a on a.owner_id = f.owner_id
      group by f.owner_id, a.email order by 3 desc limit 10`,
    sql`select count(*)::int n from (select owner_id from files group by owner_id having sum(bytes) > ${Math.round(quota * 0.8)}) x`,
  ]);
  return { ...total, quota_bytes: quota, growth, top, near_quota: near.n, driver: config.storage.driver };
}

