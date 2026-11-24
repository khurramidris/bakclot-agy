// Durable job queue on Postgres. Jobs survive restarts and deploys; any number of worker
// processes can run side by side (FOR UPDATE SKIP LOCKED guarantees one claimant per job).
//
// Work runs in lanes, each with its own number of slots, so one kind of work can never starve another: a burst of
// films being written (long Claude turns) doesn't delay collecting finished clips, and a pile of editing jobs
// (FFmpeg, CPU-bound) doesn't delay anything else.

import { hostname } from 'node:os';
import { sql } from './db.js';
import { config } from './config.js';
import { reportError } from './monitoring.js';

export interface Job {
  id: number; project_id: string | null; kind: string; payload: any;
  attempts: number; max_attempts: number;
}
export interface JobCtx {
  job: Job;
  progress(text: string): Promise<void>;
  /** Set for a failure hook (kind:failed): what made the job give up. */
  error?: unknown;
}
/** Returned by a handler to run again later without counting a failed attempt (polling). */
export interface Again { again: number; progress?: string }
export type Handler = (payload: any, ctx: JobCtx) => Promise<any | Again>;

/** An error that retrying will not fix (bad input, content refused, missing asset). */
export class PermanentError extends Error {
  code: string;
  constructor(message: string, code = 'permanent') { super(message); this.code = code; }
}

export type Lane = 'llm' | 'render' | 'assets' | 'media' | 'io';
/** Which lane a job runs in. Anything not listed is quick housekeeping and runs in `io`. */
const LANE_OF: Record<string, Lane> = {
  'project.autopilot': 'llm', 'project.breakdown': 'llm', 'episode.plan': 'llm', 'scene.rewrite': 'llm', 'shot.retake': 'llm',
  'take.submit': 'render', 'take.poll': 'render',
  'asset.generate': 'assets',
  'cut.assemble': 'media',
};
export const laneOf = (kind: string): Lane => LANE_OF[kind] ?? 'io';
/** The kinds that must wait because their lane has no free slot. */
export function blockedKinds(running: Record<string, number>, slots: Record<string, number>, kinds: string[]): string[] {
  return kinds.filter((k) => (running[laneOf(k)] ?? 0) >= (slots[laneOf(k)] ?? 1));
}

const handlers = new Map<string, Handler>();
export function register(kind: string, h: Handler) { handlers.set(kind, h); }
/** Runs after any job fails for good (after its own failure hook), e.g. to give back credit it still holds. */
let gaveUp: ((job: Job) => Promise<void>) | null = null;
export function onJobGaveUp(f: (job: Job) => Promise<void>) { gaveUp = f; }
/** Runs with every stale-job sweep (about once a minute), e.g. to repair work that lost its job. */
const recoverHooks: (() => Promise<void>)[] = [];
export function onRecover(f: () => Promise<void>) { recoverHooks.push(f); }

/** Queue a job. Pass `tx` to queue it inside a transaction, so it exists exactly when the rest of that work does. */
export async function enqueue(kind: string, payload: any, o: { projectId?: string | null; delaySec?: number; maxAttempts?: number; dedupeKey?: string; tx?: any } = {}) {
  const db = o.tx ?? sql;
  if (o.dedupeKey) {
    const [dup] = await db`select id from jobs where kind = ${kind} and status in ('queued','running') and payload->>'_dedupe' = ${o.dedupeKey} limit 1`;
    if (dup) return Number(dup.id);
    payload = { ...payload, _dedupe: o.dedupeKey };
  }
  const [row] = await db`
    insert into jobs (project_id, kind, payload, max_attempts, run_after)
    values (${o.projectId ?? null}, ${kind}, ${sql.json(payload)}, ${o.maxAttempts ?? 3}, now() + make_interval(secs => ${o.delaySec ?? 0}))
    returning id`;
  kick();
  return Number(row.id);
}

/** This process as jobs.locked_by names it. Unique per start: a restarted container keeps its hostname and pid. */
export const workerId = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;
const running: Record<string, number> = {};
const total = () => Object.values(running).reduce((a, b) => a + b, 0);
let stopping = false;
let wake: (() => void) | null = null;
function kick() { if (wake) { const w = wake; wake = null; w(); } }

async function claim(blocked: string[]): Promise<Job | null> {
  const [j] = await sql`
    update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, updated_at = now()
    where id = (
      select id from jobs where status = 'queued' and run_after <= now() ${blocked.length ? sql`and kind <> all(${blocked})` : sql``}
      order by run_after, id for update skip locked limit 1)
    returning id, project_id, kind, payload, attempts, max_attempts`;
  return j ? ({ ...j, id: Number(j.id) } as Job) : null;
}

async function runOne(job: Job) {
  const h = handlers.get(job.kind);
  const ctx: JobCtx = {
    job,
    progress: async (text) => { await sql`update jobs set progress = ${text}, updated_at = now() where id = ${job.id}`; },
  };
  try {
    if (!h) throw new PermanentError(`no handler for job kind ${job.kind}`);
    const r = await h(job.payload, ctx);
    if (r && typeof r === 'object' && 'again' in r) {
      // Polling reschedule: give the attempt back.
      await sql`update jobs set status = 'queued', attempts = attempts - 1, locked_at = null, locked_by = null,
        run_after = now() + make_interval(secs => ${Math.max(1, (r as Again).again)}),
        progress = coalesce(${(r as Again).progress ?? null}, progress), updated_at = now() where id = ${job.id}`;
    } else {
      await sql`update jobs set status = 'done', result = ${sql.json(r ?? null)}, error = null, locked_at = null, updated_at = now() where id = ${job.id}`;
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 2000);
    const permanent = e instanceof PermanentError;
    const last = permanent || job.attempts >= job.max_attempts;
    const backoff = Math.min(300, 5 * 3 ** (job.attempts - 1));
    console.error(`[job ${job.id} ${job.kind}] ${last ? 'failed' : 'retrying'}: ${msg}`);
    if (last) reportError(e, { where: 'job', job_kind: job.kind, job_id: String(job.id), project_id: job.project_id ?? undefined });
    await sql`update jobs set status = ${last ? 'failed' : 'queued'}, error = ${msg}, locked_at = null, locked_by = null,
      run_after = now() + make_interval(secs => ${last ? 0 : backoff}), updated_at = now() where id = ${job.id}`;
    if (last) {
      const f = handlers.get(job.kind + ':failed');
      if (f) await f(job.payload, { ...ctx, error: e }).catch((x) => console.error(`[job ${job.id}] failure hook`, x));
      if (gaveUp) await gaveUp(job).catch((x) => console.error(`[job ${job.id}] give-up hook`, x));
    }
  }
}

/** Keep the jobs this process is running leased, so a long one (a Claude turn can take minutes) never goes to a second worker. */
export async function heartbeat() {
  await sql`update jobs set locked_at = now() where status = 'running' and locked_by = ${workerId}`;
}

/**
 * Put jobs whose worker died (a deploy, a crash: no heartbeat for 3 minutes) back in the queue. A job that has used every
 * attempt fails instead, with its failure hook, so one that keeps killing the process can't loop forever.
 */
export async function recoverStale() {
  const dead = await sql`update jobs set status = case when attempts >= max_attempts then 'failed' else 'queued' end,
      error = case when attempts >= max_attempts then 'Interrupted too many times: the server restarted while this step was running.' else error end,
      locked_at = null, locked_by = null, updated_at = now()
    where status = 'running' and locked_at < now() - interval '3 minutes'
    returning id, project_id, kind, payload, attempts, max_attempts, status`;
  for (const j of dead) {
    console.error(`[job ${j.id} ${j.kind}] worker stopped mid-job: ${j.status === 'failed' ? 'failed' : 'requeued'}`);
    const f = j.status === 'failed' && handlers.get(j.kind + ':failed');
    if (f) await f(j.payload, { job: { ...j, id: Number(j.id) } as Job, progress: async () => {} }).catch((x) => console.error(`[job ${j.id}] failure hook`, x));
    if (j.status === 'failed' && gaveUp) await gaveUp({ ...j, id: Number(j.id) } as Job).catch((x) => console.error(`[job ${j.id}] give-up hook`, x));
  }
  for (const hook of recoverHooks) await hook().catch((x) => console.error('[worker] repair sweep', x));
}

export function startWorker(slots: Record<string, number> = config.lanes) {
  console.log(`[worker] ${workerId} started, slots ${Object.entries(slots).map(([l, n]) => `${l}:${n}`).join(' ')}`);
  let lastRecover = 0;
  const beat = setInterval(() => heartbeat().catch((e) => console.error('[worker] heartbeat', e.message)), 30_000).unref();
  const kinds = () => [...handlers.keys()].filter((k) => !k.endsWith(':failed'));
  const loop = async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastRecover > 60_000) { lastRecover = Date.now(); await recoverStale(); }
        const known = kinds(), blocked = blockedKinds(running, slots, known);
        if (blocked.length === known.length && (running.io ?? 0) >= (slots.io ?? 1)) { await sleepOrWake(500); continue; }
        const job = await claim(blocked);
        if (!job) { await sleepOrWake(1000); continue; }
        const lane = laneOf(job.kind);
        running[lane] = (running[lane] ?? 0) + 1;
        runOne(job).finally(() => { running[lane]--; kick(); });
      } catch (e) {
        console.error('[worker] loop error', e);
        await sleepOrWake(3000);
      }
    }
  };
  loop();
  return {
    /**
     * Stop taking jobs; resolves when the running ones finish, or after graceMs. Whatever is still running then goes
     * straight back to the queue with its attempt returned, so the next instance picks it up at once and a deploy never
     * uses up a job's attempts. Exit right after.
     */
    stop: async (graceMs = 0) => {
      stopping = true; kick();
      for (const t0 = Date.now(); total() > 0 && Date.now() - t0 < graceMs;) await new Promise((r) => setTimeout(r, 200));
      clearInterval(beat);
      if (total() > 0) await sql`update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_at = null, locked_by = null,
          run_after = now(), updated_at = now() where status = 'running' and locked_by = ${workerId}`
        .catch((e) => console.error('[worker] could not hand jobs back (they resume once stale)', e.message));
    },
  };
}

function sleepOrWake(ms: number) {
  return new Promise<void>((res) => {
    const t = setTimeout(() => { wake = null; res(); }, ms);
    wake = () => { clearTimeout(t); res(); };
  });
}

/** Wait until no queued/running jobs remain for a project (used by tests and CLI). */
export async function drain(projectId?: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [r] = projectId
      ? await sql`select count(*)::int n from jobs where project_id = ${projectId} and status in ('queued','running')`
      : await sql`select count(*)::int n from jobs where status in ('queued','running') and kind not like 'system.%'`;
    if (!r.n) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('drain timeout');
}
