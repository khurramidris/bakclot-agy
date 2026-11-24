// What the ops dashboard needs that the app doesn't keep by itself (migration 012): API traffic per minute, which
// customers were active each day, the platform's vital signs once a minute, and payment webhook deliveries. Requests
// are counted in memory and written once a minute, so a request costs nothing extra. Never customer content: only
// route patterns, timings, status codes and who was active.

import type { Context, Next } from 'hono';
import { matchedRoutes } from 'hono/route';
import { sql } from './db.js';
import { config } from './config.js';
import { enqueue, type Again } from './queue.js';
import { endpointHealth } from './providers/runpod.js';

/** Upper bounds (ms) of the latency histogram's buckets; one more bucket holds everything slower. */
export const LATENCY_BOUNDS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export function bucketOf(ms: number) {
  const i = LATENCY_BOUNDS.findIndex((b) => ms <= b);
  return i < 0 ? LATENCY_BOUNDS.length : i;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * The route a request is counted under: the pattern it matched (/v1/projects/:id), never the raw path, so ids don't
 * end up in the stats and random paths from bots can't grow the table.
 */
export function routeLabel(c: Context): string {
  try {
    const r = matchedRoutes(c).find((m: any) => m.method !== 'ALL' && m.path !== '*' && m.path !== '/*');
    if (r) return r.path;
  } catch { /* not routed through Hono's router */ }
  return pathLabel(c.req.path);
}

/** For requests no named route matched: the web app's files and pages, or "no such route". */
export function pathLabel(path: string) {
  if (path.startsWith('/assets/')) return '/assets/*';
  if (path.startsWith('/files/')) return '/files/*';
  if (/^\/(v1|webhooks|health|console|api)(\/|$)/.test(path)) return '(no such route)';
  return '(web page)';
}

type Bucket = { minute: string; route: string; method: string; status: number; n: number; total_ms: number; max_ms: number; hist: number[] };
const requests = new Map<string, Bucket>();
const seen = new Map<string, { owner_id: string; day: string; requests: number; last_at: Date }>();
const MAX_KEYS = 20_000; // if the database is unreachable for long, stop counting rather than grow without bound

export function recordRequest(route: string, method: string, status: number, ms: number, at = new Date()) {
  const minute = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  const key = `${minute}|${route}|${method}|${status}`;
  let b = requests.get(key);
  if (!b) {
    if (requests.size >= MAX_KEYS) return;
    b = { minute, route, method, status, n: 0, total_ms: 0, max_ms: 0, hist: new Array(LATENCY_BOUNDS.length + 1).fill(0) };
    requests.set(key, b);
  }
  b.n++; b.total_ms += ms; b.max_ms = Math.max(b.max_ms, ms); b.hist[bucketOf(ms)]!++;
}

export function recordActivity(ownerId: string, at = new Date()) {
  const day = at.toISOString().slice(0, 10); // UTC day, like every other date on the dashboard
  const key = `${ownerId}|${day}`;
  const s = seen.get(key);
  if (s) { s.requests++; s.last_at = at; return; }
  if (seen.size >= MAX_KEYS) return;
  seen.set(key, { owner_id: ownerId, day, requests: 1, last_at: at });
}

/** Hono middleware, first in the chain: times every request and notes the signed-in customer. */
export async function trackRequests(c: Context, next: Next) {
  const t0 = performance.now();
  try {
    await next();
  } finally {
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    recordRequest(routeLabel(c), c.req.method, c.res?.status ?? 500, ms);
    const uid = c.get('uid');
    if (typeof uid === 'string') recordActivity(uid);
  }
}

/** Write what's been counted since the last flush. Several instances add up: every write is an upsert. */
export async function flushTelemetry() {
  const reqRows = [...requests.values()];
  const seenRows = [...seen.values()];
  requests.clear(); seen.clear();
  try {
    if (reqRows.length) {
      await sql`insert into api_minutes ${sql(reqRows, 'minute', 'route', 'method', 'status', 'n', 'total_ms', 'max_ms', 'hist')}
        on conflict (minute, route, method, status) do update set n = api_minutes.n + excluded.n, total_ms = api_minutes.total_ms + excluded.total_ms,
          max_ms = greatest(api_minutes.max_ms, excluded.max_ms), hist = int_array_add(api_minutes.hist, excluded.hist)`;
    }
    if (seenRows.length) {
      await sql`insert into activity_days ${sql(seenRows, 'owner_id', 'day', 'requests', 'last_at')}
        on conflict (owner_id, day) do update set requests = activity_days.requests + excluded.requests,
          last_at = greatest(activity_days.last_at, excluded.last_at)`;
    }
  } catch (e: any) {
    console.error('[telemetry] could not save request stats:', e.message); // dropped: losing a minute of stats is fine
  }
}

let timer: NodeJS.Timeout | null = null;
/** Flush once a minute for as long as the process runs (call once, from the API process). */
export function startTelemetry() {
  if (!timer) timer = setInterval(() => void flushTelemetry(), 60_000).unref();
}

/** A payment webhook as it arrived. Never throws: a webhook must not fail because its log couldn't be written. */
export async function logWebhook(o: { source: string; event: string | null; ok: boolean; status: number; error?: string | null; ms: number }) {
  await sql`insert into webhook_events (source, event_name, ok, status, error, ms)
    values (${o.source}, ${o.event}, ${o.ok}, ${o.status}, ${o.error ? o.error.slice(0, 500) : null}, ${Math.round(o.ms)})`
    .catch((e) => console.error('[telemetry] webhook log:', e.message));
}

// ───────── vital signs, once a minute ─────────

const RETENTION_DAYS = { api_minutes: 35, health_snapshots: 35, webhook_events: 180 };
let lastCleanup = 0;

/** One row of health_snapshots: queue, jobs, who's online, database connections, and the GPUs when on RunPod. */
export async function snapshotTick(): Promise<Again> {
  const [q] = await sql`select count(*) filter (where status = 'pending')::int waiting,
      count(*) filter (where status in ('submitted', 'running'))::int running,
      coalesce(extract(epoch from now() - min(created_at)) / 60, 0)::int oldest
    from takes where status in ('pending', 'submitted', 'running')`;
  const [j] = await sql`select count(*) filter (where status = 'queued' and run_after <= now())::int ready,
      count(*) filter (where status = 'running')::int running,
      coalesce(extract(epoch from now() - min(run_after) filter (where status = 'queued' and run_after <= now())) / 60, 0)::int oldest,
      count(*) filter (where status = 'failed' and updated_at > now() - interval '1 minute')::int failed
    from jobs where status in ('queued', 'running') or (status = 'failed' and updated_at > now() - interval '1 minute')`;
  const [a] = await sql`select count(*)::int online from activity_days where day >= (now() - interval '1 day')::date and last_at > now() - interval '5 minutes'`;
  const [d] = await sql`select count(*)::int n from pg_stat_activity where datname = current_database()`.catch(() => [{ n: null }]);
  const gpu = config.videoProvider === 'runpod' && config.runpod.apiKey
    ? await endpointHealth().catch((e: any) => ({ error: String(e.message || e).slice(0, 200) })) : null;
  await sql`insert into health_snapshots (at, renders_waiting, renders_running, oldest_render_min, jobs_ready, jobs_running, oldest_job_min,
      jobs_failed, online, db_connections, gpu)
    values (date_trunc('minute', now()), ${q.waiting}, ${q.running}, ${q.oldest}, ${j.ready}, ${j.running}, ${j.oldest}, ${j.failed},
      ${a.online}, ${d.n}, ${gpu ? sql.json(gpu as any) : null})
    on conflict (at) do nothing`;
  if (Date.now() - lastCleanup > 3_600_000) {
    lastCleanup = Date.now();
    await sql`delete from api_minutes where minute < now() - make_interval(days => ${RETENTION_DAYS.api_minutes})`;
    await sql`delete from health_snapshots where at < now() - make_interval(days => ${RETENTION_DAYS.health_snapshots})`;
    await sql`delete from webhook_events where at < now() - make_interval(days => ${RETENTION_DAYS.webhook_events})`;
  }
  return { again: 60, progress: `${q.running} rendering, ${q.waiting} waiting · ${j.ready} jobs ready, ${j.running} running · ${a.online} online` };
}

/** One snapshot job for the whole deployment; enqueue dedupes if it's already scheduled. */
export const startSnapshots = () => enqueue('system.snapshot', {}, { dedupeKey: 'snapshot', maxAttempts: 1_000_000 });
