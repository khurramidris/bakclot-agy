// Housekeeping, about once an hour, so tables and storage don't grow without limit:
// finished jobs, superseded edits, expired API videos and old API logs.

import { sql } from './db.js';
import { storage } from './storage.js';
import { enqueue, type Again } from './queue.js';

/** Extra sweeps other modules add (the public API registers its expiry and log pruning here). */
const sweeps: { name: string; run: () => Promise<number> }[] = [];
export function onCleanup(name: string, run: () => Promise<number>) { sweeps.push({ name, run }); }

/** How many finished edits of one episode are kept: the one on screen and the one before it. */
export const KEEP_CUTS = 2;

export async function cleanup(): Promise<Again> {
  const done: string[] = [];
  // Finished jobs: a week for the ones that worked, a month for the ones that failed (support reads those).
  const [j] = await sql`with gone as (delete from jobs where (status = 'done' and updated_at < now() - interval '7 days')
      or (status = 'failed' and updated_at < now() - interval '30 days') returning 1) select count(*)::int n from gone`;
  if (j.n) done.push(`${j.n} old jobs`);

  // Edits of an episode that newer edits replaced. The customer only ever sees the latest one.
  const old = await sql`select id, file_key, srt_key, thumb_key from (
      select c.id, c.file_key, c.srt_key, c.thumb_key, c.created_at, row_number() over (partition by c.episode_id order by c.created_at desc) rn
      from cuts c where c.status = 'done') x
    where rn > ${KEEP_CUTS} and created_at < now() - interval '1 hour' limit 1000`;
  for (const c of old) {
    for (const k of [c.file_key, c.srt_key, c.thumb_key]) if (k) await storage.del(k);
    await sql`delete from cuts where id = ${c.id}`;
  }
  if (old.length) done.push(`${old.length} replaced edits`);
  await sql`delete from cuts where status = 'failed' and created_at < now() - interval '7 days'`;

  // Content-check verdicts are a cache: after 90 days a request is simply checked again.
  await sql`delete from moderations where created_at < now() - interval '90 days'`;

  for (const s of sweeps) {
    const n = await s.run().catch((e) => { console.error(`[cleanup] ${s.name}: ${e.message}`); return 0; });
    if (n) done.push(`${n} ${s.name}`);
  }
  if (done.length) console.log(`[cleanup] removed ${done.join(', ')}`);
  return { again: 3600, progress: done.length ? `removed ${done.join(', ')}` : 'nothing to remove' };
}

/** One cleanup job for the whole deployment; enqueue dedupes if it's already scheduled. */
export const startCleanup = () => enqueue('system.cleanup', {}, { dedupeKey: 'cleanup', maxAttempts: 1_000_000, delaySec: 120 });
