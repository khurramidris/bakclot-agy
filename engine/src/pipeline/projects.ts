// Things every kind of project (film, clip, app or API) does the same way.

import { sql, retryBusy } from '../db.js';
import { storage } from '../storage.js';
import { settleTake } from '../billing.js';
import { mm } from './render.js';

/**
 * Delete a project for good: credit held for renders that will never be delivered goes back, renders still running
 * are cancelled at the provider (so nobody pays for GPU time on a deleted video), every file is removed and the rows
 * go (episodes, shots, takes, cuts, jobs and webhook deliveries follow by cascade).
 */
export async function deleteProject(projectId: string) {
  await stopWork(projectId);
  await storage.delProject(projectId);
  // A film being deleted while its renders are still being queued can deadlock with them: try again until it's gone.
  await retryBusy(() => sql`delete from projects where id = ${projectId}`);
}

/** Give back credit held for renders that will never be delivered, and stop paying for the ones still running. */
async function stopWork(projectId: string) {
  const open = await sql`select id from takes where project_id = ${projectId} and not settled and hold_usd > 0`;
  for (const t of open) await settleTake(t.id, false);
  const running = await sql`select provider, provider_task_id from takes where project_id = ${projectId} and status in ('submitted','running') and provider_task_id is not null`;
  for (const t of running) await Promise.resolve(mm(t.provider).cancelVideoTask?.(t.provider_task_id)).catch(() => {});
  await sql`update takes set status = 'failed', error = 'stopped', error_code = 'stopped', finished_at = now() where project_id = ${projectId} and status in ('pending','submitted','running')`;
  await sql`update jobs set status = 'cancelled', updated_at = now() where project_id = ${projectId} and status = 'queued'`;
}

/** The retention period of a video made through the API ended: its files go, its record stays (status "expired"). */
export async function expireProject(projectId: string) {
  await stopWork(projectId);
  await storage.delProject(projectId);
  await sql`update projects set stage = 'expired', stage_error = null, updated_at = now() where id = ${projectId}`;
}
