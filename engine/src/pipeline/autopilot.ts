// Autopilot for vibe projects: one job walks a project from the customer's prompt to finished
// episodes, stopping once ("ready") before the paid render. It only decides what happens next;
// every step is the existing pipeline code. It reschedules itself with the queue's {again}
// mechanism, so waiting costs nothing and a restart resumes where it left off.

import { sql, begin } from '../db.js';
import { PermanentError, enqueue, type Again, type JobCtx } from '../queue.js';
import { credit } from '../billing.js';
import { writeStep } from './writer.js';
import { runBreakdown } from './breakdown.js';
import { queueAllAssets, approveAsset } from './assets.js';
import { planEpisode } from './shots.js';
import { queueRender, refreshEpisodeStatus } from './render.js';
import { queueCut } from './assemble.js';
import { projectEvent, mayAutoApprove } from '../events.js';

// Step-by-step projects (brief.review) also stop for the customer at story_review (pick a take), script_review (read and
// edit the screenplay) and cast_review (check every face and set); "ready" (the price) is the last stop for everyone.
export type Stage = 'writing' | 'story_review' | 'script_review' | 'breakdown' | 'casting' | 'cast_review' | 'planning' | 'ready' | 'rendering' | 'assembling' | 'done' | 'failed';
const BEFORE_READY: Stage[] = ['writing', 'breakdown', 'casting', 'planning'];
/** Stages where the project waits for the customer. */
export const WAITING: Stage[] = ['story_review', 'script_review', 'cast_review', 'ready'];

const again = (sec: number, progress?: string): Again => ({ again: sec, progress });

async function patchState(projectId: string, patch: Record<string, any>) {
  await sql`update projects set autopilot = autopilot || ${sql.json(patch)}, updated_at = now() where id = ${projectId}`;
}
async function setStage(projectId: string, stage: Stage, patch: Record<string, any> = {}) {
  await sql`update projects set stage = ${stage}, stage_error = null, autopilot = autopilot || ${sql.json(patch)}, updated_at = now() where id = ${projectId}`;
}

/** Start or resume the autopilot. Safe to call repeatedly: at most one runs per project. */
export const startAutopilot = (projectId: string) =>
  enqueue('project.autopilot', { projectId }, { projectId, maxAttempts: 5, dedupeKey: `ap:${projectId}` });

export async function runAutopilot(projectId: string, ctx: JobCtx): Promise<any | Again> {
  const [p] = await sql`select * from projects where id = ${projectId}`;
  if (!p || p.mode !== 'vibe') return { skipped: 'not a vibe project' };
  const st = p.autopilot || {};
  switch (p.stage as Stage) {
    case 'writing': { // pitch → bible → cards → scenes → notes → rewrites, one step per run
      const step = await writeStep(p.id, ctx);
      if (step.pause === 'story') { await setStage(p.id, 'story_review', { repitch_fee: null }); return { stage: 'story_review' }; }
      if (!step.done) return again(step.wait || 0, step.progress);
      if (p.brief?.review) { await setStage(p.id, 'script_review'); return { stage: 'script_review' }; }
      await setStage(p.id, 'breakdown');
      return again(0, 'Script written');
    }
    case 'breakdown':
      await runBreakdown(p.id, ctx, { force: true });
      await queueAllAssets(p.id, { covered: true }); // the setup fee pays for the first pass
      await setStage(p.id, 'casting');
      return again(3, 'Casting characters and sets');
    case 'casting': return casting(p, st);
    case 'planning': return planning(p, st, ctx);
    case 'rendering': return rendering(p, st);
    case 'assembling': return assembling(p, st);
    default: return { stage: p.stage }; // ready (waiting for the customer), done, failed
  }
}

async function casting(p: any, st: any): Promise<Again> {
  const [{ busy }] = await sql`select count(*)::int busy from jobs where project_id = ${p.id} and kind = 'asset.generate' and status in ('queued','running')`;
  const rows = await sql`select id, kind, status from assets where project_id = ${p.id} and coalesce((meta->>'unused')::boolean, false) = false
    order by case kind when 'character' then 0 when 'location' then 1 else 2 end`;
  if (busy) return again(3, `Casting: ${rows.filter((r: any) => r.status === 'review' || r.status === 'approved').length} of ${rows.length} references ready`);

  // Lock everything that's ready. Approving a parent re-queues any child made from an older image.
  // Step by step, the customer checks the cast first: they approve, regenerate or upload, then press Continue.
  const step = !!p.brief?.review && !st.cast_confirmed;
  const review = rows.filter((r: any) => r.status === 'review');
  if (review.length && !step) {
    for (const r of review) await approveAsset(r.id, { covered: true });
    return again(1, 'Locking the cast and sets');
  }
  const retried = new Set<string>(st.retried_assets || []);
  const retry = rows.filter((r: any) => (r.status === 'failed' || r.status === 'planned') && !retried.has(r.id));
  if (retry.length) {
    for (const r of retry) {
      await sql`update assets set status = 'planned', error = null where id = ${r.id}`;
      await enqueue('asset.generate', { assetId: r.id, covered: true }, { projectId: p.id, dedupeKey: `asset:${r.id}`, maxAttempts: 3 });
    }
    await patchState(p.id, { retried_assets: [...retried, ...retry.map((r: any) => r.id)] });
    return again(3, 'Retrying references that failed');
  }
  // Faces and sets are what keep a film consistent: without them, stop before the customer pays to render.
  // Anything else still missing (a prop, an outfit, a voice) is skipped; its shots render without it.
  const missing = rows.filter((r: any) => (r.kind === 'character' || r.kind === 'location') && r.status !== 'approved');
  if (step && rows.some((r: any) => r.status === 'review' || r.status === 'approved')) { await setStage(p.id, 'cast_review'); return { stage: 'cast_review' } as any; }
  if (missing.length) throw new PermanentError(`${missing.length} of the main characters and sets could not be designed. Please try again.`, 'casting_failed');
  await setStage(p.id, 'planning');
  return again(0, 'Cast and sets locked');
}

async function planning(p: any, st: any, ctx: JobCtx): Promise<any> {
  const planned = new Set<string>(st.planned || []);
  const eps = await sql`select id, idx from episodes where project_id = ${p.id} order by idx`;
  const next = eps.find((e: any) => !planned.has(e.id));
  if (next) { // one episode per run keeps each run well inside the queue's stale-job window
    await planEpisode(next.id, ctx, { force: true });
    await patchState(p.id, { planned: [...planned, next.id] });
    return again(0, `Planned episode ${next.idx} of ${eps.length}`);
  }
  await setStage(p.id, 'ready');
  // A film made through the API may be allowed to start filming by itself (within its price cap); the app's wait here.
  if (await mayAutoApprove({ ...p, stage: 'ready' })) return again(0, 'Approved automatically');
  await projectEvent({ projectId: p.id, stage: 'ready' });
  return { stage: 'ready' };
}

async function rendering(p: any, st: any): Promise<any> {
  if (!st.render_queued) {
    const todo = await sql`select s.id from shots s join episodes e on e.id = s.episode_id
      where s.project_id = ${p.id} and s.status in ('planned','failed') order by e.idx, s.idx`;
    for (const s of todo) {
      try { await queueRender(s.id); } catch (e: any) {
        if (e instanceof PermanentError && e.code === 'insufficient_credit') { // pause at the checkpoint instead of failing
          await sql`update projects set stage = 'ready', stage_error = ${e.message}, updated_at = now() where id = ${p.id}`;
          await projectEvent({ projectId: p.id, stage: 'ready' });
          return { paused: 'insufficient_credit' };
        }
        throw e;
      }
    }
    await patchState(p.id, { render_queued: true }); // they render in story order (render.ts), so finished ones can be watched
    return again(10, `Filming ${todo.length} shots`);
  }

  // The customer reviews the finished film, not every clip: the newest good take of each shot is used.
  const shots = await sql`select id, status from shots where project_id = ${p.id}`;
  for (const s of shots.filter((x: any) => x.status === 'review')) {
    const [ok] = await sql`update shots set status = 'approved', updated_at = now(),
        approved_take_id = (select id from takes where shot_id = ${s.id} and status = 'succeeded' order by n desc limit 1)
      where id = ${s.id} and status = 'review' and exists (select 1 from takes where shot_id = ${s.id} and status = 'succeeded') returning id`;
    if (ok) { s.status = 'approved'; await refreshEpisodeStatus(s.id); }
  }
  // One automatic retry per failed shot. Blocked shots (content refused) aren't retried unchanged.
  const retried = new Set<string>(st.retried_shots || []);
  const retry = shots.filter((s: any) => s.status === 'failed' && !retried.has(s.id));
  for (const s of retry) {
    try { await queueRender(s.id); s.status = 'queued'; } catch (e: any) { if (!(e instanceof PermanentError)) throw e; }
  }
  if (retry.length) await patchState(p.id, { retried_shots: [...retried, ...retry.map((s: any) => s.id)] });

  const busy = shots.filter((s: any) => s.status === 'queued' || s.status === 'rendering').length;
  const done = shots.filter((s: any) => s.status === 'approved').length;
  if (busy) return again(10, `Filmed ${done} of ${shots.length} shots`);
  if (!done) { // nothing could be filmed (the video service is down, or every shot was refused): don't deliver a film of slates
    const refused = shots.every((s: any) => s.status === 'blocked');
    throw new PermanentError(refused
      ? 'The content check refused every shot of this film, so nothing was filmed. You weren’t charged for video.'
      : 'None of the shots could be filmed just now. You weren’t charged for video. Press Try again to film them again.', 'render_failed');
  }
  await setStage(p.id, 'assembling', { cuts: null });
  return again(0, 'Editing');
}

async function assembling(p: any, st: any): Promise<any> {
  if (!st.cuts) {
    const eps = await sql`select e.id, count(s.id) filter (where s.status <> 'approved' or s.approved_take_id is null)::int missing
      from episodes e left join shots s on s.episode_id = e.id where e.project_id = ${p.id} group by e.id, e.idx order by e.idx`;
    const cuts: string[] = [];
    for (const e of eps) { // an episode with unrenderable shots still ships, with a slate where they'd be
      const { cut } = await queueCut(e.id, e.missing ? 'preview' : 'final', {});
      cuts.push(cut.id);
    }
    await patchState(p.id, { cuts, partial: eps.some((e: any) => e.missing > 0) });
    return again(5, 'Editing the final cut');
  }
  const rows = await sql`select status, error from cuts where id in ${sql(st.cuts as string[])}`;
  if (rows.some((r: any) => r.status === 'queued' || r.status === 'running')) return again(5, 'Editing the final cut');
  const bad = rows.find((r: any) => r.status === 'failed');
  if (bad) throw new PermanentError(`Editing failed: ${bad.error}`, 'cut_failed');
  await setStage(p.id, 'done');
  await projectEvent({ projectId: p.id, stage: 'done' });
  return { stage: 'done' };
}

/**
 * What a customer reads when their film stops. Our own refusals and explanations (PermanentErrors written for people)
 * are shown as they are; anything else (a provider outage, a bug, a missing key) gets a plain sentence, and the real
 * error stays on the job for the operator.
 */
export function customerMessage(error: unknown, jobError?: string | null): string {
  const internal = /^(llm_|config$|permanent$)/;
  if (error instanceof PermanentError && !internal.test(error.code)) return error.message.slice(0, 500);
  if (/^Interrupted too many times/.test(String(jobError || ''))) return 'The server restarted several times while your film was being made. Press Try again to continue where it stopped.';
  return 'Something went wrong while making your film. Press Try again to continue where it stopped.';
}

/** The autopilot gave up. Record where, and refund the setup fee if nothing was delivered yet. */
export async function autopilotFailed(payload: { projectId: string }, ctx: JobCtx) {
  const [p] = await sql`select * from projects where id = ${payload.projectId}`;
  if (!p || p.mode !== 'vibe') return;
  const [j] = await sql`select error from jobs where id = ${ctx.job.id}`;
  const st = p.autopilot || {};
  const shown = customerMessage(ctx.error, j?.error);
  await begin(async (tx) => {
    const refund = BEFORE_READY.includes(p.stage) && Number(st.setup_fee) > 0 && !st.setup_refunded;
    if (refund) await credit(tx, p.owner_id, Number(st.setup_fee), 'refund', p.id, p.api_key_id);
    if (Number(st.repitch_fee) > 0) await credit(tx, p.owner_id, Number(st.repitch_fee), 'refund', p.id); // new takes that never came
    await tx`update projects set stage = 'failed', stage_error = ${shown},
      autopilot = autopilot || ${tx.json({ failed_stage: p.stage, repitch_fee: null, ...(refund ? { setup_refunded: true } : {}) })}, updated_at = now() where id = ${p.id}`;
  });
  await projectEvent({ projectId: p.id, stage: 'failed' });
}
