// The Developers page (signed in through the web app, under /v1/developers): keys, the webhook signing secret, usage
// and the latest requests. Using the API needs prepaid credit, not a plan, so none of this asks for one.

import { Hono } from 'hono';
import { sql, plain } from '../db.js';
import { config } from '../config.js';
import { ensureAccount } from '../billing.js';
import { limit } from '../ratelimit.js';
import { createKey, ensureApiAccount, listKeys, revokeKey, rotateWebhookSecret, updateKey } from './keys.js';
import { ApiError, toApiError, errorBody } from './errors.js';

type Env = { Variables: { uid: string; email: string | null } };
export const developers = new Hono<Env>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

developers.onError((e, c) => {
  const a = toApiError(e);
  if (a.status >= 500) console.error('[developers]', e);
  return c.json({ error: { code: a.code, message: a.message, ...(a.param ? { param: a.param } : {}) } }, a.status as any);
});
developers.post('/keys', limit('apikeys', 20, 3600));
developers.post('/webhook-secret/rotate', limit('apikeys', 20, 3600));

developers.get('/', async (c) => {
  const uid = c.get('uid');
  await ensureAccount(uid, c.get('email'));
  const account = await ensureApiAccount(uid);
  const [usage] = await sql`select count(*)::int requests, count(*) filter (where status >= 400)::int errors,
      count(*) filter (where status >= 500)::int server_errors from api_requests where owner_id = ${uid} and created_at > now() - interval '30 days'`;
  const [made] = await sql`select count(*) filter (where mode = 'clip')::int videos, count(*) filter (where mode = 'vibe')::int films
    from projects where owner_id = ${uid} and origin = 'api' and created_at > now() - interval '30 days'`;
  const [spent] = await sql`select coalesce(-sum(delta_usd), 0)::float usd from credit_events where owner_id = ${uid} and api_key_id is not null and created_at > now() - interval '30 days'`;
  const daily = await sql`select to_char(date_trunc('day', created_at), 'YYYY-MM-DD') as day, count(*)::int requests, count(*) filter (where status >= 400)::int errors
    from api_requests where owner_id = ${uid} and created_at > now() - interval '30 days' group by 1 order by 1`;
  const recent = await sql`select r.request_id, r.method, r.path, r.status, r.error_code, r.ms, r.created_at, k.name key_name from api_requests r
    left join api_keys k on k.id = r.key_id where r.owner_id = ${uid} order by r.id desc limit 50`;
  const webhooks = await sql`select d.event, d.status, d.attempts, d.last_status, d.last_error, d.created_at, d.delivered_at, d.project_id
    from webhook_deliveries d where d.owner_id = ${uid} order by d.id desc limit 20`;
  return c.json(plain({
    enabled: config.api.enabled, base_url: `${config.publicBaseUrl}/api/v1`,
    account: { webhook_secret_preview: `${String(account.webhook_secret).slice(0, 10)}…`, suspended: !!account.suspended_at, suspended_reason: account.suspended_reason },
    keys: await listKeys(uid),
    usage: { days: 30, requests: usage.requests, errors: usage.errors, server_errors: usage.server_errors, videos: made.videos, films: made.films, spend_usd: Math.round(spent.usd * 100) / 100, daily },
    recent_requests: recent, recent_webhooks: webhooks,
  }));
});

developers.post('/keys', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  const { key, row } = await createKey(c.get('uid'), b);
  return c.json({ ...row, key }, 201); // the only time the full key is ever shown
});
developers.patch('/keys/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'not_found', 'No such key.');
  return c.json(await updateKey(c.get('uid'), id, await c.req.json().catch(() => ({}))));
});
developers.delete('/keys/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'not_found', 'No such key.');
  return c.json(await revokeKey(c.get('uid'), id));
});

/** The full signing secret, for the developer's server. */
developers.post('/webhook-secret/reveal', async (c) => c.json({ webhook_secret: (await ensureApiAccount(c.get('uid'))).webhook_secret }));
/** A new signing secret. Deliveries are signed with it from now on. */
developers.post('/webhook-secret/rotate', async (c) => c.json({ webhook_secret: await rotateWebhookSecret(c.get('uid')) }));

export { errorBody };
