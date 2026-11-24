// The public developer API, mounted at /api/v1. A frozen, documented contract: changes are additive only. (/v1 is the
// web app's private API and can change with the app.) Off until API_ENABLED=1.

import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { sql, plain } from '../db.js';
import { config } from '../config.js';
import { balances } from '../billing.js';
import { hitInfo } from '../ratelimit.js';
import { reportError } from '../monitoring.js';
import { ApiError, errorBody, invalid, notFound, toApiError } from './errors.js';
import { base62, keyHash, KEY_RX, keySpendThisMonth } from './keys.js';
import type { ApiCaller } from './access.js';
import { createVideo, getVideo, listVideos, removeVideo } from './videos.js';
import { approveApiFilm, createApiFilm, getFilm, listFilms, quote, removeFilm, retryApiFilm } from './films.js';
import { videoById, filmById } from './views.js';
import { openapi, pricing } from './openapi.js';

type ApiEnv = { Variables: { uid: string; caller: ApiCaller; requestId: string; projectId?: string; errorCode?: string } };
export const api = new Hono<ApiEnv>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Switched off: the API doesn't exist.
api.use('*', async (c, next) => {
  if (!config.api.enabled) return c.json(errorBody(new ApiError(404, 'not_found', 'api_disabled', 'The API is not available.')), 404);
  await next();
});

// Every response carries a request id (quote it to support); every authenticated request is logged.
api.use('*', async (c, next) => {
  const id = 'req_' + base62(20), t0 = Date.now();
  c.set('requestId', id);
  c.header('x-request-id', id);
  await next();
  const who = c.get('caller');
  if (!who) return;
  sql`insert into api_requests (request_id, owner_id, key_id, method, path, status, error_code, project_id, ms)
    values (${id}, ${who.uid}, ${who.keyId}, ${c.req.method}, ${c.req.path.slice(0, 200)}, ${c.res.status}, ${c.get('errorCode') ?? null},
            ${c.get('projectId') ?? null}, ${Date.now() - t0})`.catch((e) => console.error('[api] request log', e.message));
});

api.onError((e, c) => {
  const a = toApiError(e);
  if (a.status >= 500 && a.code === 'server_error') { console.error('[api]', e); reportError(e, { where: 'public-api', path: c.req.path, method: c.req.method }); }
  c.set('errorCode', a.code);
  if (a.retryAfter) c.header('retry-after', String(a.retryAfter));
  return c.json(errorBody(a), a.status as any);
});

// ───────── public: no key ─────────
api.get('/pricing', (c) => c.json(pricing()));
api.get('/openapi.json', (c) => c.json(openapi()));

// ───────── the key ─────────
const touched = new Map<string, number>();
api.use('*', async (c, next) => {
  const h = c.req.header('authorization') || '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key) throw new ApiError(401, 'authentication_error', 'missing_api_key', 'Send your API key in the header: Authorization: Bearer bk_live_…');
  if (!KEY_RX.test(key)) throw new ApiError(401, 'authentication_error', 'invalid_api_key', 'That API key is not valid.');
  const [k] = await sql`select k.id, k.name, k.owner_id, k.revoked_at, k.monthly_limit_usd, a.suspended_at, a.suspended_reason
    from api_keys k left join api_accounts a on a.owner_id = k.owner_id where k.hash = ${keyHash(key)}`;
  if (!k) throw new ApiError(401, 'authentication_error', 'invalid_api_key', 'That API key is not valid.');
  if (k.revoked_at) throw new ApiError(401, 'authentication_error', 'revoked_api_key', 'This API key was revoked. Create a new one on the Developers page.');
  c.set('caller', { uid: k.owner_id, keyId: k.id, keyName: k.name, monthlyLimit: k.monthly_limit_usd == null ? null : Number(k.monthly_limit_usd),
    suspended: k.suspended_at ? k.suspended_reason || 'suspended' : null });
  c.set('uid', k.owner_id);
  if (Date.now() - (touched.get(k.id) || 0) > 60_000) { // "last used", at most once a minute per key
    touched.set(k.id, Date.now());
    if (touched.size > 50_000) touched.clear();
    sql`update api_keys set last_used_at = now() where id = ${k.id}`.catch(() => {});
  }
  // Requests per key per minute, with the headers a client needs to pace itself.
  const max = config.api.requestsPerMinute;
  const r = hitInfo(`apikey:${k.id}`, max, 60);
  c.header('x-ratelimit-limit', String(max));
  c.header('x-ratelimit-remaining', String(r.remaining));
  c.header('x-ratelimit-reset', String(Math.ceil(r.resetAt / 1000)));
  if (r.wait) throw Object.assign(new ApiError(429, 'rate_limited', 'rate_limited', `Too many requests: at most ${max} a minute per key.`), { retryAfter: r.wait });
  await next();
});

const caller = (c: Context<ApiEnv>) => c.get('caller');
const idOf = (c: Context<ApiEnv>, what: string) => { const id = c.req.param('id') || ''; if (!UUID.test(id)) throw notFound(what); c.set('projectId', id); return id; };

/**
 * Run a create request once per Idempotency-Key: the same key and body replay the first answer (no second job, no second
 * charge), the same key with another body is a 422, and a repeat while the first is still running is a 409.
 */
async function idempotent(c: Context<ApiEnv>, run: (body: unknown) => Promise<{ id: string } & Record<string, any>>) {
  const who = caller(c);
  const raw = await c.req.text();
  let body: unknown;
  try { body = raw.trim() ? JSON.parse(raw) : {}; } catch { throw invalid('The request body is not valid JSON.'); }
  const key = c.req.header('idempotency-key');
  const finish = (out: any) => { c.set('projectId', out.id); return c.json(out, 201); };
  if (!key) return finish(await run(body));
  if (key.length > 255) throw invalid('Idempotency-Key is at most 255 characters.', 'Idempotency-Key');
  const hash = createHash('sha256').update(`${c.req.method} ${c.req.path}\n${raw}`).digest('hex');
  await sql`delete from api_idempotency where owner_id = ${who.uid} and key = ${key} and status is null and created_at < now() - interval '10 minutes'`; // abandoned
  const [claimed] = await sql`insert into api_idempotency (owner_id, key, request_hash) values (${who.uid}, ${key}, ${hash}) on conflict (owner_id, key) do nothing returning key`;
  if (!claimed) {
    const [prev] = await sql`select * from api_idempotency where owner_id = ${who.uid} and key = ${key}`;
    if (!prev) throw new ApiError(409, 'idempotency_error', 'request_in_progress', 'A request with this Idempotency-Key is being processed. Retry shortly.');
    if (prev.request_hash !== hash) throw new ApiError(422, 'idempotency_error', 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
    if (prev.status == null) throw Object.assign(new ApiError(409, 'idempotency_error', 'request_in_progress', 'A request with this Idempotency-Key is still being processed. Retry shortly.'), { retryAfter: 2 });
    c.header('idempotent-replayed', 'true');
    if (prev.project_id) c.set('projectId', prev.project_id);
    return c.json(prev.response, prev.status);
  }
  try {
    const out = await run(body);
    await sql`update api_idempotency set status = 201, response = ${sql.json(plain(out))}, project_id = ${out.id} where owner_id = ${who.uid} and key = ${key}`;
    return finish(out);
  } catch (e) {
    const a = toApiError(e);
    // A definite answer about this request is kept (it would be the same again); "try later" answers are not.
    if (a.status >= 500 || a.status === 409 || a.status === 429) await sql`delete from api_idempotency where owner_id = ${who.uid} and key = ${key}`;
    else await sql`update api_idempotency set status = ${a.status}, response = ${sql.json(errorBody(a))} where owner_id = ${who.uid} and key = ${key}`;
    throw a;
  }
}

// ───────── account ─────────
api.get('/account', async (c) => {
  const who = caller(c);
  const credit = await balances(who.uid);
  const [w] = await sql`select count(*) filter (where mode = 'clip' and stage = 'rendering')::int videos,
      count(*) filter (where mode = 'vibe' and stage not in ('ready','done','failed','expired'))::int films,
      count(*) filter (where mode = 'vibe' and stage = 'ready')::int films_awaiting_approval
    from projects where owner_id = ${who.uid} and origin = 'api' and created_at > now() - interval '3 days'`;
  return c.json({
    object: 'account', balance_usd: credit.total, credit: { plan_usd: credit.plan, topup_usd: credit.topup },
    key: { id: who.keyId, name: who.keyName, monthly_limit_usd: who.monthlyLimit, spent_this_month_usd: Math.round((await keySpendThisMonth(who.keyId)) * 100) / 100 },
    in_progress: w, suspended: !!who.suspended, suspended_reason: who.suspended,
    limits: { requests_per_minute_per_key: config.api.requestsPerMinute, new_jobs_per_minute: config.api.createsPerMinute, videos_in_progress: config.api.maxActive, films_in_progress: config.api.maxActiveFilms },
  });
});

// ───────── videos ─────────
api.post('/videos', (c) => idempotent(c, async (body) => {
  const p = await createVideo(caller(c), body);
  return (await videoById(caller(c).uid, p.id))!;
}));
api.get('/videos', async (c) => c.json(await listVideos(caller(c), c.req.query())));
api.get('/videos/:id', async (c) => c.json(await getVideo(caller(c), idOf(c, 'video'))));
api.delete('/videos/:id', async (c) => c.json(await removeVideo(caller(c), idOf(c, 'video'))));

// ───────── films ─────────
api.post('/films/quote', async (c) => c.json(quote(await c.req.json().catch(() => { throw invalid('The request body is not valid JSON.'); }))));
api.post('/films', (c) => idempotent(c, async (body) => {
  const p = await createApiFilm(caller(c), body);
  return (await filmById(caller(c).uid, p.id))!;
}));
api.get('/films', async (c) => c.json(await listFilms(caller(c), c.req.query())));
api.get('/films/:id', async (c) => c.json(await getFilm(caller(c), idOf(c, 'film'))));
api.post('/films/:id/approve', async (c) => c.json(await approveApiFilm(caller(c), idOf(c, 'film'))));
api.post('/films/:id/retry', async (c) => c.json(await retryApiFilm(caller(c), idOf(c, 'film'))));
api.delete('/films/:id', async (c) => c.json(await removeFilm(caller(c), idOf(c, 'film'))));

// Anything else under /api/v1 is a JSON 404, never the web app.
api.all('*', () => { throw new ApiError(404, 'not_found', 'unknown_endpoint', 'No such endpoint. See /api/v1/openapi.json.'); });
