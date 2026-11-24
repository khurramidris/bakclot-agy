// The engine's HTTP surface: the web app's private API (/v1, a signed-in customer's own projects), the public developer
// API (/api/v1, mounted from api/routes.ts), signed file links, the payment webhook, and the built web app itself.

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { sql, begin, plain, poolAnswers } from './db.js';
import { storage, verifySignature, mimeOf, isLocalStorage, PUT } from './storage.js';
import { requireUser } from './auth.js';
import { enqueue, PermanentError } from './queue.js';
import { createProject } from './pipeline/importer.js';
import { deleteProject } from './pipeline/projects.js';
import { breakdownFee, planFee, projectScenes, episodeScenes, countScenes, checkScript } from './pipeline/limits.js';
import { moderate, refusal } from './moderation.js';
import { queueAllAssets, approveAsset, uploadAsset } from './pipeline/assets.js';
import { queueRender, refreshEpisodeStatus, mm, resolutionsFor, uploadTake } from './pipeline/render.js';
import { createClip, retakeClip, prepAudio, type Upload } from './pipeline/clips.js';
import { withMediaSlot } from './media/ffmpeg.js';
import { queueCut } from './pipeline/assemble.js';
import { costOf } from './pipeline/compiler.js';
import { projectSpend } from './usage.js';
import { ensureAccount, balanceOf, balances, settleTake, sellPrice, debit, planOf, requirePlan, requireCredit, storageUsed, storageQuotaBytes } from './billing.js';
import { paymentsEnabled, subscribeCheckout, topupCheckout, portalUrl, verifyLemonSignature, handleLemonEvent } from './lemonsqueezy.js';
import { resolveBrief, setupFeeFor, splitScenes, unitOf, FORMATS } from './pipeline/writer.js';
import { startAutopilot } from './pipeline/autopilot.js';
import { createFilm, approveFilm, resumeFilm } from './pipeline/films.js';
import { endpointHealth } from './providers/runpod.js';
import { capacitySnapshot, runpodInUse } from './capacity.js';
import { preflight } from './preflight.js';
import { admin } from './admin.js';
import { api as publicApi } from './api/routes.js';
import { developers } from './api/manage.js';
import { limit } from './ratelimit.js';
import { reportError } from './monitoring.js';

type Env = { Variables: { uid: string; email: string | null } };
export const app = new Hono<Env>();
const here = dirname(fileURLToPath(import.meta.url));
const DEV_USER = '11111111-2222-3333-4444-555555555555';

/**
 * What the pages this engine serves may load: their own scripts and styles, pictures and video from our storage, and
 * the sign-in service. Nothing may put the app in a frame. Scripts injected into a page have nowhere to send data.
 */
function contentSecurityPolicy() {
  const supa = config.auth.supabaseUrl;
  const dev = config.auth.allowDevTokens && config.publicBaseUrl ? [config.publicBaseUrl] : []; // local files over http
  const connect = ["'self'", supa, supa.replace(/^http/, 'ws'), ...dev].filter(Boolean);
  return [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${dev.join(' ')}`.trim(), `media-src 'self' blob: https: ${dev.join(' ')}`.trim(), "font-src 'self' data:",
    `connect-src ${connect.join(' ')}`, "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
  ].join('; ');
}

/**
 * A request made on this computer: addressed to a loopback name and not passed on by Cloudflare (a quick tunnel keeps
 * the public host name and adds cf-* headers, so a request through it never looks local).
 */
export function isLocalRequest(c: Context) {
  const host = (c.req.header('host') || '').toLowerCase().replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return false;
  return !c.req.header('cf-connecting-ip') && !c.req.header('cf-ray') && !c.req.header('x-forwarded-host');
}
/** What the outside world may reach on a development engine: signed file links, the health check, the signed webhook. */
export const remoteAllowed = (method: string, path: string) =>
  (path === '/health' && method === 'GET')
  || (path.startsWith('/files/') && ['GET', 'HEAD', 'PUT'].includes(method))
  || (path === '/webhooks/lemonsqueezy' && method === 'POST');

const tooBig = (c: Context) => c.json({ error: { code: 'too_large', message: 'Request body is too large.' } }, 413);
const jsonLimit = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooBig });
const fileLimit = bodyLimit({ maxSize: 30 * 1024 * 1024, onError: tooBig });
const uploadLimit = bodyLimit({ maxSize: 500 * 1024 * 1024, onError: tooBig }); // rendered clips PUT by the GPU worker
const clipLimit = bodyLimit({ maxSize: 150 * 1024 * 1024, onError: tooBig }); // a quick clip's pictures, video and voice
// Large requests (a clip's pictures and video, a customer's own clip, an API video with its media) are held in memory
// while they are read and checked. A few at a time per process: past that, the caller is asked to try again shortly.
let receiving = 0;
const heavy = (c: Context) => c.req.method === 'POST' && (/multipart\/form-data/i.test(c.req.header('content-type') || '') || c.req.path === '/api/v1/videos')
  && Number(c.req.header('content-length') || 0) > 2 * 1024 * 1024;
app.use('*', async (c, next) => {
  if (!heavy(c)) return next();
  if (receiving >= config.media.uploads) {
    c.header('retry-after', '5');
    return c.json({ error: { code: 'busy', type: 'rate_limited', message: 'We’re receiving a lot of uploads right now. Please try again in a few seconds.' } }, 503);
  }
  receiving++;
  try { await next(); } finally { receiving--; }
});
const apiMediaLimit = bodyLimit({ maxSize: 40 * 1024 * 1024, onError: tooBig }); // an API video's media sent as data URIs
app.use('*', (c, next) => (c.req.method === 'PUT' && c.req.path.startsWith('/files/') ? uploadLimit
  : c.req.method === 'POST' && c.req.path === '/api/v1/videos' ? apiMediaLimit
  : /multipart\/form-data/i.test(c.req.header('content-type') || '') ? (/^\/v1\/(clips|shots\/[^/]+\/upload)$/.test(c.req.path) ? clipLimit : fileLimit) : jsonLimit)(c, next));

const appCors = cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins, allowHeaders: ['authorization', 'content-type', 'x-engine-key', 'x-user-id', 'idempotency-key'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'] });
const apiCors = cors({ origin: '*', allowHeaders: ['authorization', 'content-type', 'idempotency-key'], allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['x-request-id', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'idempotent-replayed'], maxAge: 600 });
app.use('*', (c, next) => (c.req.path.startsWith('/api/') ? apiCors(c, next) : appCors(c, next)));

// Browser protections on every response: no framing by other sites (clickjacking), no content-type guessing, no
// referrer leaks, HTTPS only once it has been seen, and a content policy for the pages we serve ourselves.
const csp = contentSecurityPolicy();
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (/^https:/.test(config.publicBaseUrl)) h.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if ((h.get('content-type') || '').startsWith('text/html') && c.req.path !== '/console') h.set('content-security-policy', csp);
});

/** Postgres errors that mean "busy right now", not "broken": a lock wait or a transaction that timed out. */
const BUSY = new Set(['55P03', '25P03', '57014', '40P01', '40001']);
app.onError((e: any, c) => {
  if (e instanceof URIError) return c.json({ error: { code: 'bad_request', message: 'The address is not valid.' } }, 400);
  if (BUSY.has(e?.code)) {
    console.warn(`[api] busy (${e.code}) ${c.req.method} ${c.req.path}`);
    c.header('retry-after', '2');
    return c.json({ error: { code: 'busy', message: 'We’re handling a lot right now. Please try again in a moment.' } }, 503);
  }
  const status = e.status || (e instanceof PermanentError ? (e.code === 'not_found' ? 404 : e.code === 'conflict' || e.code === 'not_approved' || e.code === 'bad_state' ? 409 : ['insufficient_credit', 'subscription_required', 'storage_full'].includes(e.code) ? 402 : e.code === 'config' ? 503 : e.code === 'rate_limited' ? 429 : 400) : e.name === 'ZodError' ? 400 : 500);
  if (status >= 500) { console.error('[api]', e); reportError(e, { where: 'api', path: c.req.path, method: c.req.method }); }
  // A failure we didn't expect never shows its inner message to a customer (it can name tables, hosts or providers).
  const message = e.name === 'ZodError' ? 'Invalid request: ' + (e.issues || []).map((i: any) => `${i.path.join('.')} ${i.message}`).join('; ')
    : status === 500 && !(e instanceof PermanentError) ? 'Something went wrong on our side. Please try again.' : e.message;
  return c.json({ error: { code: e.code && typeof e.code === 'string' && !/^[0-9A-Z]{5}$/.test(e.code) ? e.code : status === 400 ? 'bad_request' : 'server_error', message, ...(e.missing ? { missing: e.missing } : {}) } }, status);
});

// Development sign-in (ALLOW_DEV_TOKENS: the desktop app, a laptop run) trusts anyone who asks. Such an engine is often
// reachable from the internet through a tunnel so RunPod or MiniMax can fetch files, and a tunnel forwards every path.
// So only this computer gets the app and the API; a request from anywhere else reaches the signed file links, the
// health check and the signed payment webhook, nothing more.
app.use('*', async (c, next) => {
  if (!config.auth.allowDevTokens || isLocalRequest(c) || remoteAllowed(c.req.method, c.req.path)) return next();
  return c.json({ error: { code: 'local_only', message: 'This studio only answers on the computer it runs on.' } }, 403);
});

// Answers within five seconds either way: a database that is down, or a pool that stopped answering, reads as 503.
app.get('/health', async (c) => ((await poolAnswers(5000)) ? c.json({ ok: true, mock: config.mock }) : c.json({ ok: false, error: 'database not answering' }, 503)));

// Signed file access for local storage (S3 storage hands out presigned URLs instead).
// Local storage only: the GPU worker uploads a rendered clip to a signed upload link.
app.put('/files/*', async (c) => {
  const key = decodeURI(c.req.path.slice('/files/'.length));
  if (!isLocalStorage) return c.text('not found', 404);
  if (!verifySignature(PUT + key, +(c.req.query('exp') || 0), c.req.query('sig') || '')) return c.text('link expired or invalid', 403);
  await storage.put(key, Buffer.from(await c.req.arrayBuffer()), c.req.header('content-type') || mimeOf(key));
  return c.body(null, 200);
});

app.get('/files/*', async (c) => {
  const key = decodeURI(c.req.path.slice('/files/'.length));
  if (!verifySignature(key, +(c.req.query('exp') || 0), c.req.query('sig') || '')) return c.text('link expired or invalid', 403);
  if (!isLocalStorage || !(await storage.exists(key))) return c.text('not found', 404);
  const data = await storage.get(key);
  const range = c.req.header('range');
  const headers: Record<string, string> = { 'content-type': mimeOf(key), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (range) { // video scrubbing in browsers needs byte ranges
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? +m[1] : 0, end = m && m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1;
    return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(new Uint8Array(data), { headers: { ...headers, 'content-length': String(data.length) } });
});

// Lemon Squeezy calls this for subscription and order events. Authenticated by its signature, not a user session.
app.post('/webhooks/lemonsqueezy', async (c) => {
  const raw = await c.req.text();
  if (!verifyLemonSignature(raw, c.req.header('x-signature') || '', config.lemonsqueezy.webhookSecret)) {
    return c.json({ error: { code: 'bad_signature', message: 'Invalid Lemon Squeezy signature.' } }, 400);
  }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return c.json({ error: { code: 'bad_request', message: 'Body is not JSON.' } }, 400); }
  return c.json(await handleLemonEvent(evt));
});

// The web app reads its sign-in settings at startup, so one build works in every environment.
app.get('/app-config.json', (c) => c.json({
  supabaseUrl: config.auth.supabaseUrl, supabaseAnonKey: config.auth.supabaseAnonKey,
  // Public pricing for the landing page.
  plan: { name: config.plan.name, price_usd: config.plan.priceUsd, credits_usd: config.plan.creditsUsd, storage_gb: config.plan.storageGb },
  prices: { per_second_usd: config.credits.sellPerSecond['768P'], setup_fee_usd: config.credits.setupFeeUsd },
  // The public API: whether it is switched on, and what the docs page needs to show.
  api: { enabled: config.api.enabled, base_url: `${config.publicBaseUrl}/api/v1`, retention_days: config.api.retentionDays,
    clip_seconds: [config.clips.minSeconds, config.clips.maxSeconds], film_max_seconds: config.api.filmMaxSeconds,
    requests_per_minute: config.api.requestsPerMinute, creates_per_minute: config.api.createsPerMinute,
    max_active: config.api.maxActive, max_active_films: config.api.maxActiveFilms },
  // Who runs the service, for the Terms, the Privacy Policy and "contact support".
  legal: config.legal,
  ...(config.auth.allowDevTokens ? { devUser: DEV_USER } : {}), // local development: sign in as a fixed user
}));
// A bare-bones developer console for local runs. Never served by a production engine.
app.get('/console', async (c) => (config.auth.allowDevTokens
  ? c.html(await readFile(join(here, '..', 'public', 'console.html'), 'utf8'))
  : c.json({ error: { code: 'not_found', message: 'not found' } }, 404)));

const v1 = new Hono<Env>();
v1.use('*', requireUser);
// Request limits per customer: generous for people, tight enough to stop a runaway script running up AI costs.
v1.use('*', limit('api', 600, 60));
v1.post('/create', limit('create', 30, 3600));
v1.post('/projects', limit('create', 30, 3600));
v1.post('/clips', limit('create', 30, 3600));
v1.post('/clips/:id/retake', limit('render', 200, 3600));
v1.post('/projects/:id/repitch', limit('render', 200, 3600));
v1.post('/episodes/:id/rewrite', limit('render', 200, 3600));
v1.post('/shots/:id/upload', limit('assets', 300, 3600));
v1.use('/billing/*', limit('billing', 30, 3600));
v1.post('/shots/:id/retake', limit('render', 200, 3600));
v1.post('/shots/:id/render', limit('render', 200, 3600));
v1.post('/episodes/:id/render', limit('render', 200, 3600));
v1.use('/assets/*', limit('assets', 300, 3600));
v1.post('/episodes/:id/cuts', limit('cuts', 30, 3600));
v1.post('/takes/:id/approve', limit('cuts', 120, 3600));

// ───────── helpers ─────────
const nf = (what: string) => new PermanentError(`${what} not found`, 'not_found');
const url = async (key?: string | null) => (key ? storage.url(key) : null);
async function ownProject(c: Context<Env>, id: string) {
  const [p] = await sql`select * from projects where id = ${id} and owner_id = ${c.get('uid')}`;
  if (!p) throw nf('project'); return p;
}
async function own(c: Context<Env>, table: 'episodes' | 'assets' | 'shots' | 'takes' | 'cuts', id: string) {
  const rows = await sql`select x.* from ${sql(table)} x join projects p on p.id = x.project_id where x.id = ${id} and p.owner_id = ${c.get('uid')}`;
  if (!rows[0]) throw nf(table.slice(0, -1)); return rows[0] as any;
}
/** Whether a scene rewrite is waiting or running for this project (the script is about to change). */
const rewriting = async (projectId: string) =>
  (await sql`select 1 from jobs where project_id = ${projectId} and kind = 'scene.rewrite' and status in ('queued','running') limit 1`).length > 0;
const body = async (c: Context) => { try { return await c.req.json(); } catch { return {}; } };
/** Provider costs are shown to the operator, and on an engine that charges nobody (a local studio). Never to customers. */
const showCosts = (c: Context<Env>) => !config.credits.enforce || config.admins.includes(c.get('uid'));
const UUID = /^[0-9a-f-]{36}$/i;
/** Optional render resolution from a request body; only what the video provider renders is accepted. */
const resolutionOf = (v: any): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const ok = resolutionsFor(config.videoProvider);
  if (!ok.includes(v)) throw new PermanentError(`resolution must be ${ok.join(' or ')}`);
  return v;
};
v1.use('/*', async (c, next) => { // reject malformed ids early
  const seg = c.req.path.split('/'); // ['', 'v1', resource, id, ...]
  const id = seg[3];
  if (id && /^(projects|episodes|assets|shots|takes|cuts|scenes|clips)$/.test(seg[2]) && !UUID.test(id)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  if (id && seg[2] === 'jobs' && !/^\d+$/.test(id)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  await next();
});

async function assetView(a: any) {
  return { ...a, url: await url(a.file_key), history: undefined, history_count: (a.history || []).length };
}
/** A take as the customer sees it. What it cost us is for the operator only (and for a local studio, whose owner pays the providers). */
async function takeView(t: any, costs = false) {
  return { id: t.id, n: t.n, status: t.status, error: t.error, error_code: t.error_code, resolution: t.resolution, seconds: t.seconds, ...(costs ? { cost_usd: t.cost_usd } : {}),
    media: t.media, created_at: t.created_at, finished_at: t.finished_at, url: await url(t.file_key), thumb_url: await url(t.thumb_key), request: t.request };
}

// ───────── projects ─────────
// Importing a ready-made screenplay. The web app doesn't offer it, so a production engine answers 404 unless
// IMPORT_ENABLED=1. Scripts are size-limited (limits.ts) and the design fee grows with their length.
v1.post('/projects', async (c) => {
  if (!config.importEnabled) throw nf('page');
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const src = b.project || b;
  if (c.req.query('breakdown') !== '0') {
    const scripts: string[] = Array.isArray(src?.episodes) ? src.episodes.map((e: any) => String(e?.script || '')) : typeof src?.screenplay === 'string' ? [src.screenplay] : [];
    await requireCredit(c.get('uid'), breakdownFee(scripts.reduce((t, s) => t + countScenes(s), 0)));
  }
  const p = await createProject(c.get('uid'), src);
  const job = c.req.query('breakdown') === '0' ? null : await enqueue('project.breakdown', { projectId: p.id }, { projectId: p.id, maxAttempts: 2 });
  return c.json({ project: plain(p), job_id: job }, 201);
});
v1.get('/projects', async (c) => {
  const rows = await sql`select p.id, p.title, p.format, p.aspect, p.status, p.mode, p.stage, p.stage_error, p.updated_at, p.created_at,
    (select count(*)::int from episodes e where e.project_id = p.id) episodes,
    coalesce((select thumb_key from cuts where project_id = p.id and status = 'done' order by created_at desc limit 1),
      (select thumb_key from takes where project_id = p.id and status = 'succeeded' order by finished_at desc limit 1)) thumb_key
    from projects p where owner_id = ${c.get('uid')} and origin = 'app' order by updated_at desc limit 200`;
  return c.json({ projects: await Promise.all(rows.map(async ({ thumb_key, ...r }: any) => ({ ...r, thumb_url: await url(thumb_key) }))) });
});
v1.get('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const episodes = await sql`select e.id, e.idx, e.label, e.title, e.status, length(e.script) script_chars,
      (select count(*)::int from scenes s where s.episode_id = e.id) scenes,
      (select count(*)::int from shots s where s.episode_id = e.id) shots,
      (select count(*)::int from shots s where s.episode_id = e.id and s.status = 'approved') approved,
      (select coalesce(sum(duration),0)::int from shots s where s.episode_id = e.id) seconds
    from episodes e where e.project_id = ${p.id} order by idx`;
  const assets = await sql`select kind, status, count(*)::int n from assets where project_id = ${p.id} and coalesce((meta->>'unused')::boolean,false) = false group by kind, status`;
  const jobs = await sql`select id, kind, status, progress, error, payload, updated_at from jobs where project_id = ${p.id} and (status in ('queued','running') or (status = 'failed' and updated_at > now() - interval '1 day')) order by id desc limit 50`;
  const cuts = await sql`select distinct on (episode_id) id, episode_id, kind, status, duration, error, file_key, srt_key, thumb_key, created_at, finished_at
    from cuts where project_id = ${p.id} order by episode_id, created_at desc`;
  const [{ todo }] = await sql`select coalesce(sum(duration) filter (where status <> 'approved'), 0)::int todo from shots where project_id = ${p.id}`;
  return c.json(plain({
    project: { ...p, source: undefined }, episodes, asset_counts: assets, jobs, ...(showCosts(c) ? { spend: await projectSpend(p.id) } : {}), clip: await clipView(p, showCosts(c)),
    latest_cuts: await Promise.all(cuts.map(async ({ file_key, srt_key, thumb_key, ...r }: any) => ({ ...r, url: await url(file_key), srt_url: await url(srt_key), thumb_url: await url(thumb_key) }))),
    render_price_usd: sellPrice(p.resolution, todo),
  }));
});

/** A clip's inputs and every version made so far (newest first), for the clip page. */
async function clipView(p: any, costs = false) {
  if (p.mode !== 'clip') return null;
  const [shot] = await sql`select id, duration, status from shots where project_id = ${p.id} order by idx limit 1`;
  if (!shot) return null;
  const takes = await sql`select * from takes where shot_id = ${shot.id} order by n desc`;
  const b = p.brief || {};
  return {
    mode: b.mode, prompt: b.prompt, seconds: shot.duration, aspect: p.aspect, shot_id: shot.id, price_usd: sellPrice('768P', shot.duration),
    inputs: await Promise.all((b.inputs || []).map(async (i: any) => ({ role: i.role, label: i.label || null, url: await url(i.key) }))),
    takes: await Promise.all(takes.map((t: any) => takeView(t, costs))),
  };
}

// ───────── quick clips: text, an image, references or a video to remix → one clip ─────────
v1.post('/clips', async (c) => {
  const uid = c.get('uid');
  await ensureAccount(uid, c.get('email'));
  await requirePlan(uid);
  const form = await c.req.parseBody({ all: true });
  const all = (k: string) => [form[k]].flat().filter((x) => x !== undefined);
  const str = (k: string) => { const v = all(k)[0]; return typeof v === 'string' ? v : ''; };
  const files = async (k: string): Promise<Upload[]> => Promise.all(all(k).filter((f): f is File => typeof f !== 'string')
    .map(async (f) => ({ name: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) })));
  const [images, video, audio] = await Promise.all([files('images'), files('video'), files('audio')]);
  const p = await createClip(uid, {
    mode: str('mode'), prompt: str('prompt'), seconds: Number(str('seconds')), aspect: str('aspect'), consent: str('consent') === 'true',
    images, labels: all('labels').map((x) => (typeof x === 'string' ? x : '')), video: video[0], audio: audio[0], audioLabel: str('audio_label'),
  });
  return c.json({ project: plain({ ...p, source: undefined }) }, 201);
});
/** Another version of a clip; optionally a new prompt or length. Charged like the first. */
v1.post('/clips/:id/retake', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  return c.json(await retakeClip(p, { prompt: b.prompt, seconds: b.seconds }), 202);
});

// ───────── vibe: prompt → finished video ─────────
v1.post('/create', async (c) => {
  const uid = c.get('uid');
  const brief = resolveBrief(await body(c));
  await ensureAccount(uid, c.get('email'));
  await requirePlan(uid);
  await requireCredit(uid, setupFeeFor(brief));
  const { project: p, job_id } = await createFilm(uid, brief); // checks the idea, charges the setup fee, starts the autopilot
  return c.json({ project: plain({ ...p, source: undefined }), job_id }, 201);
});
/** What a story of this length costs to write and cast, before anyone presses Create. */
v1.post('/create/quote', async (c) => {
  const brief = resolveBrief({ prompt: 'a quote for the price of a story', ...(await body(c)) });
  return c.json({ episodes: brief.episodes, seconds_per_episode: brief.seconds, total_seconds: brief.episodes * brief.seconds, unit: unitOf(brief.format), setup_fee_usd: setupFeeFor(brief) });
});

// ───────── step by step: the customer checks the story, the script and the cast before the film is made ─────────
/** Go on from a stop: the take the customer chose (optionally with a note), the script as it stands, or the cast as approved. */
v1.post('/projects/:id/continue', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const st = p.autopilot || {};
  if (p.stage === 'story_review') {
    const w = st.writing || {};
    const n = (w.concepts || []).length;
    const pick = b.concept === undefined ? w.choice?.chosen ?? 0 : Number(b.concept);
    if (!Number.isInteger(pick) || pick < 0 || pick >= n) throw new PermanentError(`concept must be a take number from 0 to ${n - 1}`);
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
    const choice = { ...(w.choice || { scores: [], notes: [] }), chosen: pick, notes: [...(w.choice?.notes || []), ...(note ? [`The customer's own note, which comes first: ${note}`] : [])] };
    await sql`update projects set stage = 'writing', stage_error = null, autopilot = autopilot || ${sql.json({ writing: { ...w, choice, picked: true } })}, updated_at = now()
      where id = ${p.id} and stage = 'story_review'`;
  } else if (p.stage === 'script_review') {
    if (await rewriting(p.id)) throw new PermanentError('A scene is still being rewritten. Continue once it is done, so the shots follow the script you approved.', 'bad_state');
    await sql`update projects set stage = 'breakdown', stage_error = null, updated_at = now() where id = ${p.id} and stage = 'script_review'`;
  } else if (p.stage === 'cast_review') {
    const [busy] = await sql`select id from jobs where project_id = ${p.id} and kind = 'asset.generate' and status in ('queued','running') limit 1`;
    if (busy) throw new PermanentError('Some pictures are still being made. Continue once they are ready.', 'bad_state');
    await sql`update projects set stage = 'casting', stage_error = null, autopilot = autopilot || '{"cast_confirmed": true}'::jsonb, updated_at = now()
      where id = ${p.id} and stage = 'cast_review'`;
  } else throw new PermanentError('This project is not waiting for you.', 'bad_state');
  return c.json({ job_id: await startAutopilot(p.id) }, 202);
});
/** Three new takes on the idea, optionally with the customer's direction (paid; refunded if they can't be written). */
v1.post('/projects/:id/repitch', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  if (p.stage !== 'story_review') throw new PermanentError('New takes can be asked for while you choose the story.', 'bad_state');
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const direction = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
  const w = p.autopilot?.writing || {};
  await begin(async (tx) => {
    const fee = await debit(tx, c.get('uid'), config.credits.actions.pitch, 'pitch', p.id);
    const writing = { phase: 'pitch', tries: 0, direction: direction || undefined, concepts: [...(w.previous || []), ...(w.concepts || [])].slice(-9) };
    const [ok] = await tx`update projects set stage = 'writing', stage_error = null, autopilot = autopilot || ${tx.json({ writing, repitch_fee: fee } as any)}, updated_at = now()
      where id = ${p.id} and stage = 'story_review' returning id`;
    if (!ok) throw new PermanentError('New takes are already being written.', 'bad_state');
  });
  return c.json({ job_id: await startAutopilot(p.id) }, 202);
});
/** The checkpoint: the customer has seen the script, cast and price, and wants the film rendered. */
v1.post('/projects/:id/produce', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  if (p.mode !== 'vibe' || p.stage !== 'ready') throw new PermanentError('This project is not waiting to be rendered.', 'bad_state');
  await requirePlan(c.get('uid'));
  const { price_usd } = await approveFilm(p); // the balance must cover the price; the film moves to rendering
  return c.json({ job_id: await startAutopilot(p.id), price_usd }, 202);
});
/** Pick a failed vibe project up again from the stage it failed in. */
v1.post('/projects/:id/resume', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  if (p.mode !== 'vibe' || p.stage !== 'failed') throw new PermanentError('Only a failed project can be resumed.', 'bad_state');
  await requirePlan(c.get('uid'));
  const { stage } = await resumeFilm(p);
  return c.json({ job_id: await startAutopilot(p.id), stage }, 202);
});
v1.patch('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const b = await body(c);
  const ratio = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  if (b.aspect && !ratio.includes(b.aspect)) throw new PermanentError('aspect must be one of ' + ratio.join(', '));
  if (b.resolution) resolutionOf(b.resolution);
  // Only what a customer can sensibly change, in bounded sizes: a title, a language, the two edit switches, and the
  // look (short text values, which end up in prompts, so they are content-checked like any other customer text).
  const text = (v: unknown, max: number, fallback: string) => (v === undefined || v === null ? fallback : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || fallback);
  const settings = { ...p.settings };
  for (const k of ['burn_subtitles', 'chain_clips']) if (typeof b.settings?.[k] === 'boolean') settings[k] = b.settings[k];
  let style = p.style;
  if (b.style && typeof b.style === 'object' && !Array.isArray(b.style)) {
    const add = Object.fromEntries(Object.entries(b.style).slice(0, 16).filter(([k, v]) => /^[a-z_]{1,24}$/.test(k) && (typeof v === 'string' || v === null))
      .map(([k, v]) => [k, v === null ? undefined : String(v).trim().slice(0, 400)]));
    const words = Object.values(add).filter(Boolean).join('\n');
    if (words) { const v = await moderate({ ownerId: c.get('uid'), projectId: p.id, text: `The look a customer set for their film:\n${words}` }); if (!v.allowed) throw refusal(v); }
    style = { ...p.style, ...add };
  }
  const [r] = await sql`update projects set title = ${text(b.title, 200, p.title)}, aspect = ${b.aspect ?? p.aspect}, resolution = ${b.resolution ?? p.resolution},
    language = ${text(b.language, 40, p.language)}, style = ${sql.json(style)}, settings = ${sql.json(settings)}, updated_at = now() where id = ${p.id} returning *`;
  return c.json(plain({ project: { ...r, source: undefined } }));
});
v1.delete('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await deleteProject(p.id); // refunds held credit, cancels running renders, frees the storage
  return c.json({ deleted: true });
});
v1.post('/projects/:id/breakdown', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), breakdownFee(await projectScenes(p.id)));
  if (await rewriting(p.id)) throw new PermanentError('A scene is still being rewritten. Run the breakdown once it is done.', 'bad_state');
  const b = await body(c);
  return c.json({ job_id: await enqueue('project.breakdown', { projectId: p.id, force: !!b.force }, { projectId: p.id, maxAttempts: 2, dedupeKey: `bd:${p.id}` }) }, 202);
});
v1.get('/projects/:id/scenes', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select s.id, s.episode_id, e.idx episode, s.idx, s.heading, s.characters, s.speakers, s.props, s.looks, s.est_seconds,
    s.location_asset_id, a.key location_key, a.name location_name from scenes s join episodes e on e.id = s.episode_id
    left join assets a on a.id = s.location_asset_id where s.project_id = ${p.id} order by e.idx, s.idx`;
  return c.json({ scenes: rows });
});
v1.patch('/scenes/:id', async (c) => { // re-point a scene at a different set/variant or look
  const b = await body(c);
  const [s] = await sql`select s.* from scenes s join projects p on p.id = s.project_id where s.id = ${c.req.param('id')} and p.owner_id = ${c.get('uid')}`;
  if (!s) throw nf('scene');
  const ids = [b.location_asset_id, ...Object.values(b.looks || {})].filter((v) => v != null);
  if (ids.some((v) => typeof v !== 'string' || !UUID.test(v))) throw new PermanentError('asset ids must be UUIDs');
  if (b.props !== undefined && (!Array.isArray(b.props) || b.props.some((x: any) => typeof x !== 'string'))) throw new PermanentError('props must be a list of prop keys');
  if (ids.length) {
    const [{ n }] = await sql`select count(*)::int n from assets where project_id = ${s.project_id} and id in ${sql(ids as string[])}`;
    if (n !== new Set(ids).size) throw new PermanentError('every asset must belong to this project');
  }
  const [r] = await sql`update scenes set location_asset_id = ${b.location_asset_id ?? s.location_asset_id}, looks = ${sql.json(b.looks ? { ...s.looks, ...b.looks } : s.looks)},
    props = ${b.props ?? s.props} where id = ${s.id} returning *`;
  return c.json({ scene: r });
});

// ───────── assets ─────────
v1.get('/projects/:id/assets', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select * from assets where project_id = ${p.id} order by
    case kind when 'character' then 0 when 'look' then 1 when 'voice' then 2 when 'location' then 3 when 'set_variant' then 4 else 5 end, priority desc, key`;
  return c.json({ assets: await Promise.all(rows.map(assetView)) });
});
v1.get('/assets/:id', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  return c.json({ asset: await assetView(a), history: await Promise.all((a.history || []).map(async (h: any, i: number) => ({ index: i, at: h.at, note: h.note, url: await url(h.file_key) }))) });
});
v1.patch('/assets/:id', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const b = await body(c);
  const meta = { ...a.meta };
  const short = (v: unknown, max: number) => (v === null || v === '' ? undefined : String(v).trim().slice(0, max));
  for (const k of ['layout', 'sample_line', 'prompt_override', 'default_wardrobe']) if (b[k] !== undefined) meta[k] = short(b[k], 2000);
  if (b.name !== undefined) b.name = short(b.name, 120) ?? a.name;
  if (b.description !== undefined) b.description = short(b.description, 2000) ?? '';
  const changed = (b.description !== undefined && b.description !== a.description) || b.prompt_override !== undefined;
  // What a customer writes here becomes the picture's prompt, and the picture becomes a reference for the video model.
  const written = [b.name, b.description, meta.prompt_override, meta.default_wardrobe, meta.layout].filter((x) => typeof x === 'string' && x).join('\n');
  if (written && (changed || b.name !== undefined || b.default_wardrobe !== undefined || b.layout !== undefined)) {
    const v = await moderate({ ownerId: c.get('uid'), projectId: a.project_id, text: `A customer's description of a ${a.kind} for their film:\n${written}` });
    if (!v.allowed) throw refusal(v);
  }
  const [r] = await sql`update assets set name = ${b.name ?? a.name}, description = ${b.description ?? a.description}, meta = ${sql.json(meta)},
    status = ${changed && a.status === 'approved' ? 'review' : a.status}, updated_at = now() where id = ${a.id} returning *`;
  return c.json({ asset: await assetView(r), note: changed ? 'Description changed: generate again to update the image.' : undefined });
});
v1.post('/assets/:id/generate', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), a.kind === 'voice' ? config.credits.actions.voice : config.credits.actions.image);
  const b = await body(c);
  if (a.status === 'approved') await sql`update assets set status = 'review' where id = ${a.id}`;
  await sql`update assets set status = 'planned', error = null where id = ${a.id}`;
  return c.json({ job_id: await enqueue('asset.generate', { assetId: a.id, note: b.note || null }, { projectId: a.project_id, dedupeKey: `asset:${a.id}` }) }, 202);
});
v1.post('/projects/:id/assets/generate', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  return c.json({ queued: await queueAllAssets(p.id, { kinds: b.kinds }) }, 202);
});
v1.post('/assets/:id/approve', async (c) => { const a = await own(c, 'assets', c.req.param('id')); return c.json({ asset: await assetView(await approveAsset(a.id)) }); });
v1.post('/assets/:id/unapprove', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const [r] = await sql`update assets set status = 'review', approved_at = null where id = ${a.id} and status = 'approved' returning *`;
  return c.json({ asset: await assetView(r || a) });
});
v1.post('/projects/:id/assets/approve-all', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select id from assets where project_id = ${p.id} and status = 'review' order by case kind when 'character' then 0 when 'location' then 1 else 2 end`;
  for (const r of rows) await approveAsset(r.id);
  return c.json({ approved: rows.length });
});
v1.post('/assets/:id/restore', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const { index } = await body(c);
  const h = (a.history || [])[+index];
  if (!h) throw new PermanentError('no such version');
  const hist = [...a.history]; hist.splice(+index, 1); if (a.file_key) hist.push({ file_key: a.file_key, at: new Date().toISOString(), note: 'swapped out' });
  const [r] = await sql`update assets set file_key = ${h.file_key}, mime = ${mimeOf(h.file_key)}, history = ${sql.json(hist)}, status = 'review', updated_at = now() where id = ${a.id} returning *`;
  return c.json({ asset: await assetView(r) });
});
v1.post('/assets/:id/upload', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const form = await c.req.parseBody();
  const f = form['file'] as File;
  if (!f || typeof f === 'string') throw new PermanentError('send multipart form-data with a "file" field');
  if (f.size > 25 * 1024 * 1024) throw new PermanentError('file over 25 MB');
  const r = await uploadAsset(a.id, Buffer.from(await f.arrayBuffer()), f.type || mimeOf(f.name), c.get('uid'), String(form['consent'] || '') === 'true');
  return c.json({ asset: await assetView(r) });
});
v1.post('/projects/:id/music', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const form = await c.req.parseBody();
  const f = form['file'] as File;
  if (!f || typeof f === 'string') throw new PermanentError('send an audio file in the "file" field');
  if (f.size > 25 * 1024 * 1024) throw new PermanentError('file over 25 MB');
  // Stored as our own MP3 (at most ten minutes), never as the bytes that were sent: the edit reads this file with FFmpeg.
  const dir = await mkdtemp(join(tmpdir(), 'music-'));
  try {
    const data = Buffer.from(await f.arrayBuffer());
    const m = await withMediaSlot(() => prepAudio(data, dir, 600, 'The music file'));
    const key = `projects/${p.id}/music/${Date.now()}.mp3`;
    await storage.putFile(key, m.file, 'audio/mpeg');
    return c.json({ music_key: key, url: await url(key) });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ───────── episodes, shots, takes ─────────
v1.get('/episodes/:id', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const scenes = splitScenes(e.script).scenes.map((text, i) => ({ n: i + 1, heading: text.split('\n')[0], text }));
  return c.json({ episode: { ...e, scenes } });
});
/** Rewrite one scene from the customer's note (paid when it runs, refunded if it fails). Scene numbers start at 1. */
v1.post('/episodes/:id/rewrite', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
  if (note.length < 3) throw new PermanentError('Say what should change in the scene.');
  const scene = Number(b.scene);
  if (!Number.isInteger(scene) || scene < 1 || scene > splitScenes(e.script).scenes.length) throw new PermanentError('scene must be a scene number of this episode');
  await requireCredit(c.get('uid'), config.credits.actions.scene);
  return c.json({ job_id: await enqueue('scene.rewrite', { episodeId: e.id, scene, note }, { projectId: e.project_id, maxAttempts: 2, dedupeKey: `rewrite:${e.id}:${scene}` }) }, 202);
});
v1.patch('/episodes/:id', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const b = await body(c);
  if (b.script !== undefined && await rewriting(e.project_id)) throw new PermanentError('A scene is being rewritten right now. Edit the script once it is done, so neither change is lost.', 'bad_state');
  if (b.title !== undefined) b.title = String(b.title).trim().slice(0, 200);
  if (b.script !== undefined && b.script !== e.script) {
    checkScript(b.script); // one episode's worth, so planning it stays bounded
    // Every line of a script reaches the screen: a script the customer wrote by hand is checked like any other prompt.
    const v = await moderate({ ownerId: c.get('uid'), projectId: e.project_id, text: `A screenplay the customer edited by hand, to be filmed:\n${b.script}` });
    if (!v.allowed) throw refusal(v);
  }
  const [r] = await sql`update episodes set title = ${b.title ?? e.title}, script = ${b.script ?? e.script},
    script_version = script_version + ${b.script !== undefined ? 1 : 0}, updated_at = now() where id = ${e.id} returning *`;
  return c.json({ episode: r, note: b.script ? 'Script changed: run the breakdown again, then re-plan this episode.' : undefined });
});
v1.post('/episodes/:id/plan', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), planFee(await episodeScenes(e.id)));
  if (await rewriting(e.project_id)) throw new PermanentError('A scene is still being rewritten. Plan the shots once it is done.', 'bad_state');
  const b = await body(c);
  return c.json({ job_id: await enqueue('episode.plan', { episodeId: e.id, force: !!b.force }, { projectId: e.project_id, maxAttempts: 2, dedupeKey: `plan:${e.id}` }) }, 202);
});
v1.get('/episodes/:id/shots', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const shots = await sql`select s.*, sc.heading scene_heading, sc.idx scene_idx from shots s left join scenes sc on sc.id = s.scene_id where s.episode_id = ${e.id} order by s.idx`;
  const takes = await sql`select * from takes where shot_id in ${sql(shots.length ? shots.map((s: any) => s.id) : ['00000000-0000-0000-0000-000000000000'])} order by n`;
  const [{ resolution }] = await sql`select resolution from projects where id = ${e.project_id}`;
  const out = await Promise.all(shots.map(async (s: any) => ({
    ...s, takes: await Promise.all(takes.filter((t: any) => t.shot_id === s.id).map((t: any) => takeView(t, showCosts(c)))),
    price_usd: sellPrice(resolution, s.duration), // what another take of this shot costs the customer
    ...(showCosts(c) ? { estimate_usd: +costOf(resolution, s.duration).toFixed(2) } : {}),
  })));
  return c.json({ shots: out, totals: { shots: out.length, approved: out.filter((s: any) => s.status === 'approved').length, seconds: out.reduce((t: number, s: any) => t + s.duration, 0) } });
});
v1.patch('/shots/:id', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  const b = await body(c);
  if (b.duration !== undefined && (!Number.isInteger(b.duration) || b.duration < 4 || b.duration > 15)) throw new PermanentError('duration must be a whole number from 4 to 15');
  const [r] = await sql`update shots set prompt = ${b.prompt ?? s.prompt}, prompt_locked = ${b.prompt !== undefined ? true : b.prompt_locked ?? s.prompt_locked},
    duration = ${b.duration ?? s.duration}, chain_prev = ${b.chain_prev ?? s.chain_prev}, updated_at = now() where id = ${s.id} returning *`;
  return c.json({ shot: r });
});
v1.post('/shots/:id/render', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  return c.json(await queueRender(s.id, { resolution: resolutionOf(b.resolution) }), 202);
});
v1.post('/episodes/:id/render', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const shots = await sql`select id from shots where episode_id = ${e.id} and status in ${sql(b.include_review ? ['planned', 'failed', 'review'] : ['planned', 'failed'])} order by idx`;
  const out: any[] = [];
  for (const s of shots) out.push({ shot_id: s.id, ...(await queueRender(s.id, { resolution: resolutionOf(b.resolution) })) });
  await sql`update episodes set status = 'rendering' where id = ${e.id}`;
  return c.json({ queued: out.length, takes: out }, 202);
});
v1.post('/shots/:id/retake', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const resolution = resolutionOf(b.resolution);
  const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : '';
  if (note && !b.prompt) await requireCredit(c.get('uid'), config.credits.actions.revision); // the rewrite itself is charged too
  // One update takes the shot out of review, so an autopilot pass can't re-approve the old take in between.
  await sql`update shots set status = 'queued', approved_take_id = null, error = null,
    ${b.prompt ? sql`prompt = ${String(b.prompt)}, prompt_locked = true, review_note = ${note || null},` : sql``} updated_at = now() where id = ${s.id}`;
  let out: any;
  try {
    out = b.prompt ? await queueRender(s.id, { resolution })
      : { job_id: await enqueue('shot.retake', { shotId: s.id, note, resolution }, { projectId: s.project_id, maxAttempts: 2, dedupeKey: `retake:${s.id}` }) }; // a double-click is one retake
  } catch (e) { // nothing was started: put the shot back as it was
    await sql`update shots set status = ${s.status}, approved_take_id = ${s.approved_take_id} where id = ${s.id}`;
    throw e;
  }
  if (b.recut) await recut(s.project_id); // vibe projects: once the retake renders, use it and rebuild the finished episode
  return c.json(out, 202);
});
/** A vibe project whose shots changed after filming: wait for anything still rendering, then edit the film again. */
async function recut(projectId: string) {
  const [p] = await sql`update projects set stage = 'rendering', stage_error = null, autopilot = autopilot || '{"cuts": null}'::jsonb, updated_at = now()
    where id = ${projectId} and mode = 'vibe' and stage in ('done','rendering','assembling') returning id`;
  if (p) await startAutopilot(projectId);
}
v1.post('/takes/:id/approve', async (c) => {
  const t = await own(c, 'takes', c.req.param('id'));
  if (t.status !== 'succeeded') throw new PermanentError('Only a finished take can be approved.', 'bad_state');
  await sql`update shots set status = 'approved', approved_take_id = ${t.id}, updated_at = now() where id = ${t.shot_id}`;
  await refreshEpisodeStatus(t.shot_id);
  const b = await body(c);
  if (b.recut) { await requirePlan(c.get('uid')); await recut(t.project_id); } // re-editing the film is new work
  return c.json({ approved: true });
});
/** The customer's own video for a shot, used in place of a generated take (vibe projects re-edit the film). */
v1.post('/shots/:id/upload', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const form = await c.req.parseBody();
  const f = form['file'] as File;
  if (!f || typeof f === 'string') throw new PermanentError('send multipart form-data with a "file" field');
  if (f.size > 150 * 1024 * 1024) throw new PermanentError('file over 150 MB');
  const r = await uploadTake(s.id, Buffer.from(await f.arrayBuffer()), c.get('uid'), String(form['consent'] || '') === 'true');
  if (String(form['recut'] || '') === 'true') await recut(s.project_id);
  return c.json(r, 201);
});
v1.post('/takes/:id/reject', async (c) => {
  const t = await own(c, 'takes', c.req.param('id'));
  const b = await body(c);
  await sql`update takes set status = 'rejected', error = ${String(b.note || 'rejected in review').slice(0, 500)} where id = ${t.id} and status = 'succeeded'`;
  await sql`update shots set status = case when approved_take_id = ${t.id} then 'review' else status end,
    approved_take_id = case when approved_take_id = ${t.id} then null else approved_take_id end, updated_at = now() where id = ${t.shot_id}`;
  return c.json({ rejected: true });
});
v1.post('/shots/:id/unapprove', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await sql`update shots set status = 'review', approved_take_id = null, updated_at = now() where id = ${s.id}`;
  await refreshEpisodeStatus(s.id);
  return c.json({ ok: true });
});

// ───────── assembly ─────────
v1.post('/episodes/:id/cuts', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid')); // an edit is new work and a new file: it needs a plan and room in storage
  const b = await body(c);
  const { cut, job_id } = await queueCut(e.id, b.kind === 'preview' ? 'preview' : 'final', b.options || {});
  return c.json({ cut, job_id }, 202);
});
v1.get('/episodes/:id/cuts', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const rows = await sql`select * from cuts where episode_id = ${e.id} order by created_at desc`;
  return c.json({ cuts: await Promise.all(rows.map(async (r: any) => ({ ...r, url: await url(r.file_key), srt_url: await url(r.srt_key), thumb_url: await url(r.thumb_key) }))) });
});

// ───────── money, jobs, live updates ─────────
v1.get('/projects/:id/estimate', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const res = c.req.query('resolution') || p.resolution;
  const [s] = await sql`select coalesce(sum(duration),0)::int secs, count(*)::int n,
    coalesce(sum(duration) filter (where status <> 'approved'),0)::int todo_secs from shots where project_id = ${p.id}`;
  const [a] = await sql`select count(*) filter (where kind in ('character','look','location','set_variant','prop') and status in ('planned','failed'))::int images,
    count(*) filter (where kind = 'voice' and status in ('planned','failed'))::int voices from assets where project_id = ${p.id}`;
  const once = costOf(res, s.todo_secs);
  return c.json({
    resolution: res, shots: s.n, runtime_seconds: s.secs, seconds_left_to_approve: s.todo_secs,
    // What the customer pays in credits.
    customer: { per_second: config.credits.sellPerSecond[res] ?? config.credits.sellPerSecond['768P'], to_finish_usd: sellPrice(res, s.todo_secs), full_runtime_usd: sellPrice(res, s.secs) },
    // What the providers charge us: for the operator, and for a local studio whose owner pays the providers directly.
    ...(showCosts(c) ? {
      video_full_runtime_once_usd: +costOf(res, s.secs).toFixed(2),
      video_if_every_shot_works_first_time_usd: +once.toFixed(2),
      video_expected_with_retakes_usd: +(once * config.pricing.retakeFactor).toFixed(2),
      assets_pending_usd: +(a.images * config.pricing.imageEach + a.voices * 25 * config.pricing.voicePerChar).toFixed(2),
      spent: await projectSpend(p.id),
      prices: { video_per_second: config.pricing.videoPerSecond, image_each: config.pricing.imageEach },
    } : {}),
  });
});

// Operators only (ADMIN_USER_IDS): render queue, RunPod workers and the warm-pool controller's last decision.
v1.get('/admin/capacity', async (c) => {
  if (!config.admins.includes(c.get('uid'))) throw nf('page');
  const [queue] = await sql`select count(*) filter (where status = 'pending')::int pending, count(*) filter (where status = 'submitted')::int submitted,
    count(*) filter (where status = 'running')::int running from takes`;
  const [ctl] = await sql`select progress, updated_at from jobs where kind = 'system.capacity' order by id desc limit 1`;
  const runpod = runpodInUse() ? await endpointHealth().catch((e: any) => ({ error: e.message })) : null;
  return c.json(plain({ provider: config.videoProvider, queue, runpod, controller: ctl ?? null, capacity: await capacitySnapshot() }));
});

// Operators only: the launch checklist against the real services (the web app shows it at /setup).
v1.get('/admin/preflight', async (c) => {
  if (!config.admins.includes(c.get('uid'))) throw nf('page');
  return c.json({ checks: await preflight() });
});

v1.get('/me', async (c) => {
  const uid = c.get('uid');
  await ensureAccount(uid, c.get('email'));
  const events = await sql`select delta_usd::float delta_usd, reason, ref, created_at from credit_events where owner_id = ${uid} order by id desc limit 20`;
  const credits = await balances(uid);
  return c.json({
    user_id: uid, email: c.get('email'), is_admin: config.admins.includes(uid), balance_usd: credits.total, credits, credits_enforced: config.credits.enforce,
    plan: { ...(await planOf(uid)), name: config.plan.name, price_usd: config.plan.priceUsd, credits_usd: config.plan.creditsUsd, storage_gb: config.plan.storageGb },
    storage: { used_bytes: await storageUsed(uid), quota_bytes: storageQuotaBytes() },
    prices: { per_second: config.credits.sellPerSecond, setup_fee_usd: config.credits.setupFeeUsd, setup_fee_included_minutes: config.credits.setupFeeIncludedMinutes,
      setup_fee_per_minute_usd: config.credits.setupFeePerMinuteUsd, actions: config.credits.actions },
    formats: Object.fromEntries(Object.entries(FORMATS).map(([id, f]) => [id, { unit: f.unit, seconds: f.seconds, episodes: [f.episodes[0], f.episodes[1] === Number.MAX_SAFE_INTEGER ? null : f.episodes[1]], defaults: f.defaults }])),
    renders_at_once: config.minimax.maxConcurrentPerUser,
    clips: { min_seconds: config.clips.minSeconds, max_seconds: config.clips.maxSeconds },
    packs: config.credits.packs.map((p) => ({ id: p.id, usd: p.usd, available: !!p.variantId })),
    payments_enabled: paymentsEnabled(), recent: events,
  });
});
v1.post('/billing/subscribe', async (c) => c.json(await subscribeCheckout(c.get('uid'), c.get('email'))));
v1.post('/billing/topup', async (c) => {
  const b = await body(c);
  return c.json(await topupCheckout(c.get('uid'), String(b.pack || ''), c.get('email')));
});
v1.get('/billing/portal', async (c) => c.json(await portalUrl(c.get('uid'))));
v1.get('/jobs/:id', async (c) => {
  const [j] = await sql`select j.id, j.kind, j.status, j.progress, j.error, j.result, j.attempts, j.created_at, j.updated_at from jobs j
    join projects p on p.id = j.project_id where j.id = ${+c.req.param('id')} and p.owner_id = ${c.get('uid')}`;
  if (!j) throw nf('job');
  return c.json({ job: plain(j) });
});
/** Server-sent events: one "change" event whenever anything in the project moves. */
v1.get('/projects/:id/events', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  return streamSSE(c, async (stream) => {
    let last = '';
    for (let i = 0; i < 1800 && !stream.aborted; i++) { // ~1 hour, then the client reconnects
      const [d] = await sql`select
        (select max(updated_at) from projects where id = ${p.id})::text a,
        (select max(updated_at) from assets where project_id = ${p.id})::text b,
        (select max(updated_at) from shots where project_id = ${p.id})::text c,
        (select max(coalesce(finished_at, submitted_at, created_at)) from takes where project_id = ${p.id})::text d,
        (select max(updated_at) from jobs where project_id = ${p.id})::text e,
        (select max(coalesce(finished_at, created_at)) from cuts where project_id = ${p.id})::text f`;
      const sig = Object.values(d).join('|');
      if (sig !== last) {
        last = sig;
        const jobs = await sql`select id, kind, status, progress from jobs where project_id = ${p.id} and status in ('queued','running') order by id limit 20`;
        await stream.writeSSE({ event: 'change', data: JSON.stringify(plain({ at: new Date().toISOString(), active_jobs: jobs })) });
      } else if (i % 15 === 0) await stream.writeSSE({ event: 'ping', data: '{}' });
      await stream.sleep(2000);
    }
  });
});

v1.route('/admin', admin);
v1.route('/developers', developers); // the Developers page: keys, webhook secret, usage
app.route('/v1', v1);
app.route('/api/v1', publicApi); // the public developer API (off until API_ENABLED=1)

// ───────── the web app (web/dist): static files, and index.html for every app route ─────────
const WEB_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};
const webDir = resolve(config.webDir);
app.get('*', async (c) => {
  const path = decodeURIComponent(c.req.path);
  if (/^\/(v1|api|files|webhooks|health|console)(\/|$)/.test(path)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  const file = resolve(webDir, '.' + path);
  if (path !== '/' && file.startsWith(webDir + sep) && (await stat(file).then((s) => s.isFile(), () => false))) {
    return new Response(new Uint8Array(await readFile(file)), { headers: {
      'content-type': WEB_MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', // Vite hashes /assets names
    } });
  }
  const index = await readFile(join(webDir, 'index.html'), 'utf8').catch(() => null);
  return index ? c.html(index, 200, { 'cache-control': 'no-cache' }) : c.text('The web app is not built. Run `npm run build` in web/.', 404);
});
