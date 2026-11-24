// Webhooks: when a video or film reaches a state worth knowing about, we POST its object to the developer's URL.
// Each delivery is signed like Stripe's (Backlot-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">), sent through
// the same address checks as media downloads, and retried on a schedule until it gets a 2xx. The object is read fresh
// at each attempt, so its links are always valid and its state is current.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from '../db.js';
import { config } from '../config.js';
import { enqueue, type Again } from '../queue.js';
import { safeRequest } from './net.js';
import { filmById, videoById } from './views.js';

/** Seconds to wait after each failed attempt; after the last, the delivery is marked failed (about 21 hours in all). */
export const SCHEDULE = [60, 300, 1800, 7200, 21_600, 43_200];

export const sign = (secret: string, t: number, body: string) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
export const signatureHeader = (secret: string, body: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${sign(secret, t, body)}`;

/** How a developer checks a delivery (the docs show the same code): the signature matches and is under 5 minutes old. */
export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(now / 1000 - t) > toleranceSec) return false;
  const a = Buffer.from(sign(secret, t, body)), b = Buffer.from(parts.v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Record that something happened and queue its delivery. `eventKey` makes it happen once, however often it's reported. */
export async function queueWebhook(p: { id: string; owner_id: string; webhook_url: string | null }, event: string, eventKey: string) {
  if (!p.webhook_url) return;
  const [d] = await sql`insert into webhook_deliveries (project_id, owner_id, event, event_key, url, payload)
    values (${p.id}, ${p.owner_id}, ${event}, ${eventKey}, ${p.webhook_url}, ${sql.json({})}) on conflict (event_key) do nothing returning id`;
  if (d) await enqueue('webhook.deliver', { deliveryId: Number(d.id) }, { projectId: p.id, maxAttempts: 3 });
}

/** One attempt at a delivery. Failed attempts come back on the schedule without using up the job's attempts. */
export async function deliverWebhook(o: { deliveryId: number }): Promise<any | Again> {
  const [d] = await sql`select d.*, a.webhook_secret, p.mode from webhook_deliveries d join projects p on p.id = d.project_id
    left join api_accounts a on a.owner_id = d.owner_id where d.id = ${o.deliveryId}`;
  if (!d || d.status !== 'pending') return { skipped: d?.status ?? 'gone' };
  const data = d.mode === 'clip' ? await videoById(d.owner_id, d.project_id) : await filmById(d.owner_id, d.project_id);
  if (!data) return { skipped: 'gone' };
  const body = JSON.stringify({ id: `evt_${d.id}`, object: 'event', type: d.event, created: Math.floor(new Date(d.created_at).getTime() / 1000), data });
  let status = 0, error = '';
  try {
    const r = await safeRequest(d.url, {
      method: 'POST', body, maxBytes: 64 * 1024, timeoutMs: config.api.webhookTimeoutSec * 1000, redirects: 0,
      headers: { 'content-type': 'application/json', 'backlot-signature': signatureHeader(d.webhook_secret || '', body), 'backlot-event': d.event, 'backlot-delivery': `evt_${d.id}` },
    });
    status = r.status;
  } catch (e: any) { error = String(e?.message || e).slice(0, 300); }
  const attempts = Number(d.attempts) + 1;
  if (status >= 200 && status < 300) {
    await sql`update webhook_deliveries set status = 'delivered', attempts = ${attempts}, last_status = ${status}, last_error = null, delivered_at = now() where id = ${d.id}`;
    return { delivered: true, attempts };
  }
  const failed = attempts > SCHEDULE.length;
  const why = error || `answered ${status}`;
  await sql`update webhook_deliveries set status = ${failed ? 'failed' : 'pending'}, attempts = ${attempts}, last_status = ${status || null}, last_error = ${why} where id = ${d.id}`;
  return failed ? { failed: why, attempts } : { again: SCHEDULE[attempts - 1], progress: `attempt ${attempts} ${why}; next in ${SCHEDULE[attempts - 1]} s` };
}
