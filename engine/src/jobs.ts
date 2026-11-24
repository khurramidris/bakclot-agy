// Every background step is a job. Register handlers once; the worker runs them.

import { register, type Handler } from './queue.js';
import { runBreakdown } from './pipeline/breakdown.js';
import { generateAsset } from './pipeline/assets.js';
import { planEpisode, reviseShot } from './pipeline/shots.js';
import { submitTake, pollTake, takeFailedHook, queueRender } from './pipeline/render.js';
import { assembleCut } from './pipeline/assemble.js';
import { runAutopilot, autopilotFailed } from './pipeline/autopilot.js';
import { capacityTick, startCapacityController } from './capacity.js';
import { cleanup, startCleanup } from './maintenance.js';
import { snapshotTick, startSnapshots } from './telemetry.js';
import { sql } from './db.js';
import { config } from './config.js';
import { jobKey, paidForProject, releaseCharges } from './billing.js';
import { onJobGaveUp, onRecover } from './queue.js';
import { repairRenders } from './pipeline/render.js';
import { rewriteScene } from './pipeline/writer.js';
import { breakdownFee, planFee, projectScenes, episodeScenes } from './pipeline/limits.js';
import { registerApi } from './api/register.js';

/**
 * Fairness between customers inside a lane: at most `max` of these jobs run at once for one customer. A job over that
 * steps aside for a moment (without using up an attempt), so one customer's hundred-episode series or pile of edits
 * never holds up everyone else's work. The ones further back in the customer's own line wait a little longer.
 */
const fair = (kinds: string[], max: number, h: Handler): Handler => async (payload, ctx) => {
  if (!ctx.job.project_id) return h(payload, ctx);
  const [r] = await sql`select count(*) filter (where j.status = 'running' and j.id <> ${ctx.job.id})::int running,
      count(*) filter (where j.status = 'queued' and j.id < ${ctx.job.id} and j.run_after <= now() + interval '30 seconds')::int ahead
    from jobs j join projects p on p.id = j.project_id
    where j.kind in ${sql(kinds)} and j.status in ('queued','running') and p.owner_id = (select owner_id from projects where id = ${ctx.job.project_id})`;
  if (r.running >= max) return { again: 3 + 2 * Math.min(r.ahead, 30) };
  return h(payload, ctx);
};
const LLM = ['project.autopilot', 'project.breakdown', 'episode.plan', 'scene.rewrite', 'shot.retake'];

export function registerJobs() {
  registerApi(); // webhooks, automatic approval and retention for the public API (needed wherever jobs run)
  // A job that gives up for good returns whatever it still holds; the periodic sweep repairs renders left half done.
  onJobGaveUp((job) => releaseCharges(job.id));
  onRecover(() => repairRenders());
  // Both design fees grow with the script's length (limits.ts), so a long script is never redone below cost.
  register('project.breakdown', async (p, ctx) => paidForProject(p.projectId, breakdownFee(await projectScenes(p.projectId)), 'breakdown', () => runBreakdown(p.projectId, ctx, { force: p.force }), jobKey(ctx.job, 'breakdown')));
  register('project.breakdown:failed', async (p, ctx) => {
    await sql`update projects set status = 'imported', updated_at = now() where id = ${p.projectId} and status = 'breaking_down'`;
  });
  register('asset.generate', fair(['asset.generate'], config.fairness.assets, (p, ctx) => generateAsset(p.assetId, ctx, { note: p.note, covered: !!p.covered })));
  register('asset.generate:failed', async (p) => {
    await sql`update assets set status = 'failed', updated_at = now() where id = ${p.assetId} and status in ('generating','planned')`;
  });
  register('episode.plan', async (p, ctx) => {
    const [e] = await sql`select project_id from episodes where id = ${p.episodeId}`;
    return paidForProject(e?.project_id, planFee(await episodeScenes(p.episodeId)), 'shot_plan', () => planEpisode(p.episodeId, ctx, { force: p.force }), jobKey(ctx.job, 'shot_plan'));
  });
  register('take.submit', (p) => submitTake(p.takeId));
  register('take.poll', (p) => pollTake(p.takeId));
  register('take.submit:failed', takeFailedHook);
  register('take.poll:failed', takeFailedHook);
  register('shot.retake', async (p, ctx) => {
    if (p.note) {
      await ctx.progress('Revising the shot from the note');
      const [sh] = await sql`select project_id from shots where id = ${p.shotId}`;
      await paidForProject(sh?.project_id, config.credits.actions.revision, 'revision', () => reviseShot(p.shotId, p.note), jobKey(ctx.job, 'revision'));
    }
    return queueRender(p.shotId, { resolution: p.resolution });
  });
  register('shot.retake:failed', async (p) => {
    await sql`update shots set status = case when approved_take_id is null then 'failed' else status end, error = 'retake could not be prepared', updated_at = now() where id = ${p.shotId}`;
  });
  register('cut.assemble', fair(['cut.assemble'], config.fairness.media, (p, ctx) => assembleCut(p.cutId, ctx.progress)));
  register('scene.rewrite', async (p, ctx) => {
    const [e] = await sql`select project_id from episodes where id = ${p.episodeId}`;
    await ctx.progress(`Rewriting scene ${p.scene}`);
    return paidForProject(e?.project_id, config.credits.actions.scene, 'scene_rewrite', () => rewriteScene(p.episodeId, p.scene - 1, p.note), jobKey(ctx.job, 'scene_rewrite'));
  });
  register('project.autopilot', fair(LLM, config.fairness.llm, (p, ctx) => runAutopilot(p.projectId, ctx)));
  register('project.autopilot:failed', autopilotFailed);
  register('system.capacity', () => capacityTick());
  register('system.cleanup', () => cleanup());
  register('system.snapshot', () => snapshotTick());
}

/** The deployment-wide jobs that reschedule themselves for ever: GPU capacity, housekeeping and ops snapshots. Safe to call on every start. */
export async function startSystemJobs() {
  await startCapacityController();
  await startCleanup();
  await startSnapshots();
}
