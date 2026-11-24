// The public API's background side, set up in every process that runs jobs (the API server and any separate worker):
// webhooks when videos and films finish, automatic approval of films within their price cap, and deleting what the
// API made once its retention period ends.

import { sql } from '../db.js';
import { config } from '../config.js';
import { register } from '../queue.js';
import { onProjectEvent, setAutoApprove } from '../events.js';
import { onCleanup } from '../maintenance.js';
import { approveFilm, renderPrice } from '../pipeline/films.js';
import { expireProject } from '../pipeline/projects.js';
import { keySpendThisMonth } from './keys.js';
import { deliverWebhook, queueWebhook } from './webhooks.js';

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Why a film made through the API may not film by itself right now, or null when it may. */
async function holdReason(p: any): Promise<string | null> {
  const api = p.autopilot?.api || {};
  if (api.auto_approve === false) return 'Waiting for your approval: POST /films/{id}/approve to film it.';
  const price = await renderPrice(p), setup = Number(p.autopilot?.setup_fee) || 0;
  if (api.max_cost_usd != null && setup + price > Number(api.max_cost_usd) + 1e-9) {
    return `Filming costs ${usd(price)} (${usd(setup + price)} with the setup fee), over your max_cost_usd of ${usd(Number(api.max_cost_usd))}. Approve it to go ahead anyway.`;
  }
  if (p.api_key_id) {
    const [k] = await sql`select monthly_limit_usd from api_keys where id = ${p.api_key_id}`;
    if (k?.monthly_limit_usd != null && (await keySpendThisMonth(p.api_key_id)) + price > Number(k.monthly_limit_usd) + 1e-9) {
      return `Filming costs ${usd(price)}, which would take this key over its monthly limit. Raise the limit, then approve.`;
    }
  }
  return null;
}

export function registerApi() {
  register('webhook.deliver', (p) => deliverWebhook(p));

  // A film made through the API reached its price: film it now if it may, otherwise say why it waits.
  setAutoApprove(async (p) => {
    if (p.origin !== 'api') return false;
    const why = await holdReason(p);
    if (!why) {
      try { await approveFilm(p); return true; } catch (e: any) {
        await sql`update projects set stage_error = ${String(e?.message || 'Waiting for your approval.').slice(0, 500)} where id = ${p.id} and stage = 'ready'`;
        return false;
      }
    }
    await sql`update projects set stage_error = ${why} where id = ${p.id} and stage = 'ready'`;
    return false;
  });

  // Something finished: set when its files will be deleted, and tell the developer.
  onProjectEvent(async ({ projectId, stage }) => {
    const [p]: any[] = await sql`select id, owner_id, mode, origin, webhook_url, autopilot->'api' api from projects where id = ${projectId}`;
    if (!p || p.origin !== 'api') return;
    if (stage !== 'ready') {
      const days = stage === 'done' ? config.api.retentionDays : config.api.failedRetentionDays;
      await sql`update projects set finished_at = now(), expires_at = now() + make_interval(days => ${days}) where id = ${p.id}`;
    }
    if (p.mode === 'clip') {
      if (stage === 'ready') return;
      const [t] = await sql`select id from takes where project_id = ${p.id} order by created_at desc limit 1`;
      await queueWebhook(p, stage === 'done' ? 'video.succeeded' : 'video.failed', `${p.id}:${stage}:${t?.id ?? 'none'}`);
    } else if (p.mode === 'vibe') {
      const gen = Number(p.api?.generation) || 0;
      const event = stage === 'ready' ? 'film.awaiting_approval' : stage === 'done' ? 'film.succeeded' : 'film.failed';
      await queueWebhook(p, event, `${p.id}:${stage}:${gen}`);
    }
  });

  // Retention: files go when the period ends; the record ("expired") stays a month longer, then goes too.
  onCleanup('expired API videos and films', async () => {
    const due = await sql`select id from projects where origin = 'api' and expires_at < now() and stage <> 'expired' order by expires_at limit 200`;
    for (const p of due) await expireProject(p.id);
    await sql`delete from projects where origin = 'api' and stage = 'expired' and expires_at < now() - interval '30 days'`;
    return due.length;
  });
  onCleanup('old API logs', async () => {
    const [a] = await sql`with gone as (delete from api_requests where created_at < now() - make_interval(days => ${config.api.logDays}) returning 1) select count(*)::int n from gone`;
    await sql`delete from api_idempotency where created_at < now() - interval '24 hours'`;
    await sql`delete from api_refusals where created_at < now() - interval '30 days'`;
    await sql`delete from webhook_deliveries where status <> 'pending' and created_at < now() - interval '30 days'`;
    return a.n;
  });
}
