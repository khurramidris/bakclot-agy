// GPU autoscaling for our own H3 on RunPod Serverless.
//
// RunPod's autoscaler adds workers when its queue backs up and removes idle ones, between the endpoint's floor
// (workersMin) and ceiling (workersMax). This controller moves the floor with demand, so GPUs are already starting
// when work arrives instead of after it has queued for a while:
//   nobody rendering for RUNPOD_WARM_MINUTES   → floor 0 (no GPU bill while idle)
//   customers active                           → floor ≥ RUNPOD_WARM_WORKERS (no multi-minute cold starts)
//   work waiting                               → one GPU per RUNPOD_JOBS_PER_WORKER renders that can run now
//                                                 (each customer counts for at most their own render slots)
// and the ceiling is always RUNPOD_MAX_WORKERS, the budget cap. The engine sends RunPod at most
// RUNPOD_MAX_WORKERS × RUNPOD_JOBS_PER_WORKER renders at once (VIDEO_MAX_INFLIGHT), so the queue RunPod sees is
// exactly what the ceiling can serve. When demand needs more GPUs than the ceiling allows, the dashboard says so.
//
// It runs as one job for the whole deployment, every RUNPOD_CAPACITY_TICK_SECONDS, and at once when new work arrives.

import { sql } from './db.js';
import { config } from './config.js';
import { enqueue, type Again } from './queue.js';
import { setWorkers } from './providers/runpod.js';

export function decideWorkersMin(o: { active: number; recent: number; warmWorkers: number; maxWorkers: number; jobsPerWorker: number }) {
  if (!o.active && !o.recent) return 0;
  return Math.min(o.maxWorkers, Math.max(o.warmWorkers, Math.ceil(o.active / Math.max(1, o.jobsPerWorker))));
}

/** GPUs the waiting work would need, uncapped: above the ceiling means customers are waiting for GPUs. */
export const workersNeeded = (active: number, jobsPerWorker: number) => Math.ceil(active / Math.max(1, jobsPerWorker));

/** Whether any rendering goes to our own GPUs: all video, or only image-to-video clips (CLIP_IMAGE_PROVIDER). */
export const runpodInUse = () => config.videoProvider === 'runpod' || config.clips.imageProvider === 'runpod';

export interface CapacityState {
  provider: string; floor: number; ceiling: number; needed: number; active: number; recent: number;
  waiting_seconds: number; at_ceiling: boolean; applied: boolean; note: string; at: string;
}
let applied: number | null = null; // last floor sent to RunPod by this process
let last: CapacityState | null = null;
let lastCeilingWarning = 0;
export const lastCapacity = () => last;

/** Renders that can run now (fair share per project and per customer), renders started recently, and the longest wait. */
async function demand() {
  // Only work that goes to RunPod counts: everything when it renders all video, otherwise image-to-video clips.
  const scope = config.videoProvider === 'runpod' ? sql`true` : sql`p.mode = 'clip' and p.brief->>'mode' = 'image'`;
  const [r] = await sql`select
      (select coalesce(sum(least(n, ${config.minimax.maxConcurrentPerUser})), 0) from
        (select sum(least(n, ${config.minimax.maxConcurrentPerProject})) n from
          (select p.owner_id, count(*) n from takes t join projects p on p.id = t.project_id
            where t.status in ('pending','submitted','running') and ${scope} group by p.owner_id, t.project_id) per_project
        group by owner_id) per_owner)::int active,
      (select count(*) from takes t join projects p on p.id = t.project_id
        where t.created_at > now() - make_interval(mins => ${config.runpod.warmMinutes}) and ${scope})::int recent,
      (select coalesce(extract(epoch from now() - min(t.submitted_at)), 0) from takes t join projects p on p.id = t.project_id
        where t.status = 'submitted' and t.provider = 'runpod' and ${scope})::int waiting_seconds`;
  return r as { active: number; recent: number; waiting_seconds: number };
}

export async function capacityTick(): Promise<Again> {
  const rp = config.runpod;
  if (!runpodInUse()) return { again: 600, progress: 'video provider is not RunPod; nothing to manage' };
  const { active, recent, waiting_seconds } = await demand();
  const want = decideWorkersMin({ active, recent, warmWorkers: rp.warmWorkers, maxWorkers: rp.maxWorkers, jobsPerWorker: rp.jobsPerWorker });
  const needed = workersNeeded(active, rp.jobsPerWorker);
  let note = '';
  if (want !== applied) {
    if (rp.manageScaling) {
      try { await setWorkers(want, rp.maxWorkers); applied = want; note = 'applied'; }
      catch (e: any) { note = `not applied: ${e.message}`; console.error('[capacity]', e.message); }
    } else note = 'RUNPOD_MANAGE_SCALING is off: not applied';
  }
  const atCeiling = needed > rp.maxWorkers;
  if (atCeiling && Date.now() - lastCeilingWarning > 30 * 60_000) {
    lastCeilingWarning = Date.now();
    console.warn(`[capacity] demand needs ${needed} GPUs but RUNPOD_MAX_WORKERS is ${rp.maxWorkers}: customers are waiting. Raise RUNPOD_MAX_WORKERS (and the RunPod quota) if this persists.`);
  }
  last = { provider: 'runpod', floor: want, ceiling: rp.maxWorkers, needed, active, recent, waiting_seconds, at_ceiling: atCeiling,
    applied: applied === want, note, at: new Date().toISOString() };
  const progress = `workersMin=${want} max=${rp.maxWorkers} · ${active} renders can run now (${needed} GPUs needed${atCeiling ? ', AT CEILING' : ''}), ${recent} started in the last ${rp.warmMinutes} min${note ? ` (${note})` : ''}`;
  if (note) console.log(`[capacity] ${progress}`);
  // Busy: look again soon, so GPUs follow demand within seconds. Idle: the usual interval.
  return { again: active ? Math.min(rp.tickSeconds, 15) : rp.tickSeconds, progress };
}

/**
 * Rendering capacity right now, for the dashboard: how many renders are in flight against the cap, how many wait, and
 * (on our own GPUs) how many GPUs the waiting work needs against the ceiling. Computed live, so any instance answers.
 */
export async function capacitySnapshot() {
  const [q] = await sql`select count(*) filter (where status = 'pending')::int waiting, count(*) filter (where status in ('submitted','running'))::int in_flight,
      coalesce(extract(epoch from now() - min(created_at) filter (where status = 'pending')), 0)::int oldest_waiting_seconds
    from takes where status in ('pending','submitted','running')`;
  const cap = config.minimax.maxConcurrentVideo;
  const base = { provider: config.videoProvider, in_flight: q.in_flight, in_flight_cap: cap, waiting: q.waiting, oldest_waiting_seconds: q.oldest_waiting_seconds,
    at_cap: q.in_flight >= cap && q.waiting > 0 };
  if (!runpodInUse()) return { ...base, gpu: null };
  const d = await demand(), rp = config.runpod;
  const needed = workersNeeded(d.active, rp.jobsPerWorker);
  return { ...base, gpu: { floor: decideWorkersMin({ ...d, warmWorkers: rp.warmWorkers, maxWorkers: rp.maxWorkers, jobsPerWorker: rp.jobsPerWorker }),
    ceiling: rp.maxWorkers, needed, at_ceiling: needed > rp.maxWorkers, managed: rp.manageScaling, renders_ready: d.active, waiting_in_runpod_seconds: d.waiting_seconds } };
}

/** One controller job for the whole deployment; enqueue dedupes if it's already scheduled. */
export const startCapacityController = () => enqueue('system.capacity', {}, { dedupeKey: 'capacity', maxAttempts: 1_000_000 });

let lastKick = 0;
/** New render work arrived: let the controller look now rather than at its next tick (at most every 5 seconds). */
export async function kickCapacity() {
  if (!runpodInUse() || Date.now() - lastKick < 5000) return;
  lastKick = Date.now();
  await sql`update jobs set run_after = now() where kind = 'system.capacity' and status = 'queued' and run_after > now() + interval '5 seconds'`.catch(() => {});
}
