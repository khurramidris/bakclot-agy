// The public API end to end, against a running engine (mock providers, real FFmpeg, the job worker): keys, auth,
// prepaid credit without a plan, every kind of video, media by URL and data URI, idempotency, webhooks (signed,
// retried), refusals and suspension, limits, isolation, deletion, expiry, and microdramas from an idea to a finished
// episode, with and without automatic approval.
//   DATABASE_URL=postgres://postgres@localhost:5432/api npx tsx test/api.e2e.ts

import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.ENFORCE_CREDITS = '1';
process.env.PORT ??= '8855';
Object.assign(process.env, {
  API_ENABLED: '1', API_ALLOW_PRIVATE_URLS: '1', API_REFUSALS_BEFORE_SUSPEND: '3', API_REQUESTS_PER_MINUTE: '60',
  SELL_PER_SECOND_768P: '0.16', SETUP_FEE_USD: '0.5', MINIMAX_POLL_SECONDS: '1', WORKER_CONCURRENCY: '6',
  LEMONSQUEEZY_WEBHOOK_SECRET: 'ls_whsec_test', LEMONSQUEEZY_STORE_ID: '1', CREDIT_PACKS: 'starter:10:201,big:50:202',
  PUBLIC_BASE_URL: `http://localhost:${process.env.PORT}`, STORAGE_DIR: process.env.STORAGE_DIR || './data/api-files',
});
const ADMIN = 'dddddddd-0000-4000-8000-00000000a0a0';
process.env.ADMIN_USER_IDS = ADMIN;
const base = `http://localhost:${process.env.PORT}`;

// ── local helpers: a media server and a webhook receiver ──
const media = new Map<string, { type: string; data: Buffer }>();
const mediaServer = createServer((req, res) => {
  const f = media.get(req.url || '');
  if (!f) { res.statusCode = 404; return res.end(); }
  res.setHeader('content-type', f.type); res.end(f.data);
});
const hooks: { headers: IncomingMessage['headers']; body: string; event: any }[] = [];
let hookStatus = 200;
const receiver = createServer((req, res) => {
  let raw = ''; req.on('data', (d) => (raw += d)); req.on('end', () => {
    hooks.push({ headers: req.headers, body: raw, event: JSON.parse(raw) });
    res.statusCode = hookStatus; res.end('ok');
  });
});
await new Promise<void>((r) => mediaServer.listen(0, '127.0.0.1', r));
await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
const mediaUrl = (path: string) => `http://127.0.0.1:${(mediaServer.address() as any).port}${path}`;
const hookUrl = `http://127.0.0.1:${(receiver.address() as any).port}/hooks`;

await import('../src/index.js');
const { sql } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const { cleanup } = await import('../src/maintenance.js');
const { probe } = await import('../src/media/ffmpeg.js');
await new Promise((r) => setTimeout(r, 600));

let n = 0;
const step = (t: string) => console.log(`\n${++n}. ${t}`);
const ok = (t: string) => console.log(`  ✓ ${t}`);
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.001, `${what}: ${a} vs ${b}`);

/** The web app's private API, as a signed-in customer. */
async function app(uid: string, method: string, path: string, body?: any) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${uid}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any };
}
/** The public API, with a key. */
async function call(key: string | null, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any, headers: r.headers };
}
async function topUp(uid: string, orderId: number, variant = 201) {
  const body = JSON.stringify({ meta: { event_name: 'order_created', custom_data: { user_id: uid } }, data: { type: 'orders', id: String(orderId), attributes: { store_id: 1, status: 'paid', subtotal_usd: 1000, first_order_item: { variant_id: variant } } } });
  const r = await fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', 'ls_whsec_test').update(body).digest('hex') }, body });
  assert.equal(r.status, 200);
}
const balance = async (uid: string) => (await app(uid, 'GET', '/v1/me')).json.balance_usd as number;
async function until<T>(what: string, f: () => Promise<T | false | null | undefined>, ms = 240_000): Promise<T> {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { const v = await f(); if (v) return v; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error(`timed out waiting for: ${what}`);
}
/** Wait for a video or film to reach one of these statuses (watching the database, so polling doesn't use up the key's
 * request limit the way a real client's fast polling would), then read it through the API once. */
const STAGES: Record<string, string[]> = { succeeded: ['done'], failed: ['failed'], refused: ['failed'], awaiting_approval: ['ready'] };
async function finished(key: string, kind: 'videos' | 'films', id: string, want: string[] = ['succeeded', 'failed', 'refused']) {
  const stages = want.flatMap((w) => STAGES[w] || []);
  await until(`${kind} ${id} to reach ${want.join('/')}`, async () => {
    const [p] = await sql`select stage from projects where id = ${id}`;
    if (kind === 'videos') { const [t] = await sql`select status from takes where project_id = ${id} order by created_at desc limit 1`; return !p || (stages.includes(p.stage) && t && !['pending', 'submitted', 'running'].includes(t.status)); }
    return !p || stages.includes(p.stage);
  }, 400_000);
  return (await call(key, 'GET', `/${kind}/${id}`)).json;
}
/** Check a webhook the way the docs tell developers to. */
function verified(h: { headers: IncomingMessage['headers']; body: string }, secret: string) {
  const parts = Object.fromEntries(String(h.headers['backlot-signature']).split(',').map((kv) => kv.split('=')));
  const expect = createHmac('sha256', secret).update(`${parts.t}.${h.body}`).digest('hex');
  return parts.v1 === expect && Math.abs(Date.now() / 1000 - Number(parts.t)) < 300;
}

const dir = await mkdtemp(join(tmpdir(), 'api-e2e-'));
const ff = (args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:d=1', '-frames:v', '1', join(dir, 'face.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=24:d=3', '-f', 'lavfi', '-i', 'sine=d=3', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'src.mp4')]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=330:d=4', join(dir, 'voice.mp3')]);
const jpg = await readFile(join(dir, 'face.jpg'));
media.set('/face.jpg', { type: 'image/jpeg', data: jpg });
media.set('/src.mp4', { type: 'video/mp4', data: await readFile(join(dir, 'src.mp4')) });
media.set('/voice.mp3', { type: 'audio/mpeg', data: await readFile(join(dir, 'voice.mp3')) });
media.set('/playlist.jpg', { type: 'image/jpeg', data: Buffer.from(`#EXTM3U\n#EXTINF:10,\n${mediaUrl('/secret')}\n`) });
const dataUri = `data:image/jpeg;base64,${jpg.toString('base64')}`;

// ─────────────────────────────────────────────────────────────────────────────
step('Switched off, the API does not exist; switched on, prices and the spec are public');
{
  config.api.enabled = false;
  assert.equal((await call(null, 'GET', '/pricing')).status, 404);
  config.api.enabled = true;
  const p = await call(null, 'GET', '/pricing');
  assert.equal(p.status, 200); assert.equal(p.json.video.per_second_usd, 0.16); assert.equal(p.json.film.setup_fee_usd, 0.5);
  assert.ok(p.headers.get('x-request-id')?.startsWith('req_'));
  const spec = (await call(null, 'GET', '/openapi.json')).json;
  assert.equal(spec.openapi, '3.1.0');
  const refs = JSON.stringify(spec).match(/#\/components\/schemas\/(\w+)/g) || [];
  for (const r of new Set(refs)) assert.ok(spec.components.schemas[r.split('/').pop()!], `${r} resolves`);
  for (const path of ['/videos', '/videos/{id}', '/films', '/films/{id}', '/films/{id}/approve', '/films/{id}/retry', '/films/quote', '/account', '/pricing']) assert.ok(spec.paths[path], path);
  assert.deepEqual(spec.components.schemas.VideoCreate.required, ['prompt'], 'only the prompt is required');
  assert.equal((await call(null, 'GET', '/nope')).status, 401, 'without a key, everything but pricing and the spec asks for one');
  ok(`off → 404; pricing and openapi.json public; ${new Set(refs).size} schema references all resolve`);
}

const D = randomUUID(), OTHER = randomUUID();
let key = '', secret = '';
step('A developer makes a key on the Developers page (no plan needed)');
{
  const made = await app(D, 'POST', '/v1/developers/keys', { name: 'ci server', monthly_limit_usd: null });
  assert.equal(made.status, 201);
  key = made.json.key;
  assert.match(key, /^bk_live_[0-9A-Za-z]{32}$/);
  const page = await app(D, 'GET', '/v1/developers');
  assert.equal(page.json.keys.length, 1); assert.equal(page.json.keys[0].prefix, key.slice(0, 12) + '…');
  assert.ok(!JSON.stringify(page.json).includes(key), 'the full key is never shown again');
  const [{ hash }] = await sql`select hash from api_keys where id = ${made.json.id}`;
  assert.notEqual(hash, key); assert.equal(hash.length, 64);
  secret = (await app(D, 'POST', '/v1/developers/webhook-secret/reveal')).json.webhook_secret;
  assert.match(secret, /^whsec_/);
  assert.ok(page.json.account.webhook_secret_preview.startsWith(secret.slice(0, 10)));
  ok('the key is shown once and stored only as its SHA-256; the webhook secret can be revealed');
}

step('Keys are checked on every request');
{
  assert.equal((await call(null, 'GET', '/account')).json.error.code, 'missing_api_key');
  assert.equal((await call('bk_live_' + 'x'.repeat(32), 'GET', '/account')).status, 401);
  assert.equal((await call('Bearer nonsense', 'GET', '/account')).status, 401);
  const extra = (await app(D, 'POST', '/v1/developers/keys', { name: 'to revoke' })).json;
  assert.equal((await call(extra.key, 'GET', '/account')).status, 200);
  await app(D, 'DELETE', `/v1/developers/keys/${extra.id}`);
  const r = await call(extra.key, 'GET', '/account');
  assert.equal(r.status, 401); assert.equal(r.json.error.code, 'revoked_api_key');
  assert.equal((await call(key, 'GET', '/nope')).json.error.code, 'unknown_endpoint');
  ok('missing, malformed, unknown and revoked keys are a 401; an unknown path with a key is a JSON 404');
}

step('No credit: nothing is made. Top-up credit (no plan) pays for the API');
{
  const r = await call(key, 'POST', '/videos', { prompt: 'a red kite over a windy beach' });
  assert.equal(r.status, 402); assert.equal(r.json.error.type, 'insufficient_credit');
  assert.equal((await sql`select count(*)::int n from projects where owner_id = ${D}`)[0].n, 0);
  await topUp(D, 7001);
  assert.equal(await balance(D), 10);
  const acc = (await call(key, 'GET', '/account')).json;
  assert.equal(acc.balance_usd, 10); assert.equal(acc.key.name, 'ci server');
  ok('402 with nothing created; a $10 top-up without any plan; /account shows it');
}

let textId = '';
step('Text to video: made, charged once, downloadable, signed webhook, expiry set');
{
  const r = await call(key, 'POST', '/videos', { prompt: 'A red kite climbs over a windy beach at golden hour.', duration: 5, aspect_ratio: '9:16', webhook_url: hookUrl, metadata: { order: 'A-1042' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  textId = r.json.id;
  assert.ok(['queued', 'processing'].includes(r.json.status)); assert.equal(r.json.cost_usd, 0.8); assert.deepEqual(r.json.metadata, { order: 'A-1042' });
  const v = await finished(key, 'videos', textId);
  assert.equal(v.status, 'succeeded', JSON.stringify(v.error));
  const mp4 = Buffer.from(await (await fetch(v.output.url)).arrayBuffer());
  await writeFile(join(dir, 'out.mp4'), mp4);
  const info = await probe(join(dir, 'out.mp4'));
  assert.ok(info.duration > 4 && info.has_audio && info.height > info.width, 'a vertical MP4 with sound');
  near(await balance(D), 9.2, 'charged $0.80 once');
  const days = (new Date(v.expires_at).getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 6.9 && days <= 7, `expires in ${days.toFixed(2)} days`);
  const hook = await until('the webhook', async () => hooks.find((h) => h.event.data?.id === textId));
  assert.equal(hook.event.type, 'video.succeeded'); assert.equal(hook.event.data.status, 'succeeded');
  assert.ok(verified(hook, secret), 'the signature checks out with the account secret');
  assert.ok(!verified(hook, 'whsec_wrong'));
  await until('delivery recorded', async () => (await call(key, 'GET', `/videos/${textId}`)).json.webhook?.status === 'delivered');
  ok(`${info.width}×${info.height}, ${info.duration.toFixed(1)} s with sound; $0.80 charged; video.succeeded delivered and signed; expires in 7 days`);
}

step('Image to video (data URI), references with a voice and a remix (by URL)');
{
  const img = await call(key, 'POST', '/videos', { prompt: 'The picture comes to life: the camera pushes in slowly.', first_frame: { url: dataUri }, rights_confirmed: true });
  assert.equal(img.status, 201, JSON.stringify(img.json)); assert.equal(img.json.mode, 'image');
  const ref = await call(key, 'POST', '/videos', { prompt: 'Maya in <Picture 1> waves and says hello in voice 1.', images: [{ url: mediaUrl('/face.jpg'), label: 'Maya' }], audio: { url: mediaUrl('/voice.mp3'), label: 'Maya' }, rights_confirmed: true });
  assert.equal(ref.status, 201, JSON.stringify(ref.json)); assert.equal(ref.json.mode, 'reference');
  const remix = await call(key, 'POST', '/videos', { prompt: 'Turn video 1 into a rainy night scene.', video: { url: mediaUrl('/src.mp4') }, duration: 5, rights_confirmed: true });
  assert.equal(remix.status, 201, JSON.stringify(remix.json)); assert.equal(remix.json.mode, 'remix');
  for (const v of [img.json, ref.json, remix.json]) assert.equal((await finished(key, 'videos', v.id)).status, 'succeeded');
  const [shot] = await sql`select prompt from shots where project_id = ${ref.json.id}`;
  assert.match(shot.prompt, /reference image 1/); assert.match(shot.prompt, /reference audio 1/); assert.doesNotMatch(shot.prompt, /<Picture/);
  ok('all three made; the model’s own tags become the wording H3 needs');
}

step('Bad requests are a clear 400, and nothing is charged');
{
  const before = await balance(D);
  const cases: [any, string][] = [
    [{ prompt: 'x', }, 'prompt'],
    [{ prompt: 'a kite', duration: 20 }, 'duration'],
    [{ prompt: 'a kite', aspect_ratio: '4:3' }, 'aspect_ratio'],
    [{ prompt: 'a kite', first_frame: { url: dataUri } }, 'rights_confirmed'],
    [{ prompt: 'a kite', first_frame: { url: dataUri }, images: [{ url: dataUri }], rights_confirmed: true }, 'first_frame'],
    [{ prompt: 'a kite', audio: { url: mediaUrl('/voice.mp3') }, rights_confirmed: true }, 'audio'],
    [{ prompt: 'a kite', first_frame: { url: 'ftp://example.com/a.jpg' }, rights_confirmed: true }, 'first_frame.url'],
    [{ prompt: 'a kite', first_frame: { url: mediaUrl('/missing.jpg') }, rights_confirmed: true }, 'first_frame.url'],
    [{ prompt: 'a kite', bogus_field: 1 }, ''],
    [{ prompt: 'a kite', webhook_url: 'ftp://example.com' }, 'webhook_url'],
    [{ prompt: 'a kite', metadata: { a: 'x'.repeat(400), b: 'y'.repeat(400), c: 'z'.repeat(400) } }, 'metadata'],
    [{ prompt: 'a kite', metadata: { big: 'x'.repeat(600) } }, 'metadata.big'],
  ];
  for (const [body, param] of cases) {
    const r = await call(key, 'POST', '/videos', body);
    assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 80)} → ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.error.type, 'invalid_request');
    if (param) assert.equal(r.json.error.param, param, JSON.stringify(r.json));
  }
  const hostile = await call(key, 'POST', '/videos', { prompt: 'a kite', first_frame: { url: mediaUrl('/playlist.jpg') }, rights_confirmed: true });
  assert.equal(hostile.status, 400, 'a playlist posing as a picture');
  assert.equal((await call(key, 'POST', '/videos', '{not json')).status, 400);
  assert.equal(await balance(D), before);
  ok(`${cases.length + 2} bad requests: 400 with the field named, never charged`);
}

step('Idempotency: one video and one charge per key; a different body is refused');
{
  const before = await balance(D);
  const body = { prompt: 'A paper boat drifts down a gutter after rain.', duration: 5 };
  const headers = { 'idempotency-key': 'order-1042-attempt' };
  const a = await call(key, 'POST', '/videos', body, headers);
  const b = await call(key, 'POST', '/videos', body, headers);
  assert.equal(a.status, 201); assert.equal(b.status, 201); assert.equal(a.json.id, b.json.id);
  assert.equal(b.headers.get('idempotent-replayed'), 'true');
  const c = await call(key, 'POST', '/videos', { ...body, duration: 6 }, headers);
  assert.equal(c.status, 422); assert.equal(c.json.error.type, 'idempotency_error');
  near(await balance(D), before - 0.8, 'charged once');
  await finished(key, 'videos', a.json.id);
  ok('the same key replays the first answer; a changed body is a 422');
}

step('Another developer can’t see or touch these; the app lists only app videos');
{
  const other = (await app(OTHER, 'POST', '/v1/developers/keys', { name: 'other' })).json.key;
  assert.equal((await call(other, 'GET', `/videos/${textId}`)).status, 404);
  assert.equal((await call(other, 'DELETE', `/videos/${textId}`)).status, 404);
  assert.equal((await call(other, 'GET', '/videos')).json.data.length, 0);
  const mine = (await app(D, 'GET', '/v1/projects')).json.projects;
  assert.equal(mine.length, 0, 'API videos stay out of the app’s list');
  assert.equal((await app(D, 'GET', '/v1/me')).json.storage.used_bytes, 0, 'and out of the storage allowance');
  ok('404 for other developers; the app’s list and storage allowance leave API videos out');
}

step('Listing pages through newest first');
{
  const p1 = (await call(key, 'GET', '/videos?limit=2')).json;
  assert.equal(p1.data.length, 2); assert.equal(p1.has_more, true);
  const p2 = (await call(key, 'GET', `/videos?limit=2&starting_after=${p1.data[1].id}`)).json;
  assert.ok(p2.data.length >= 1); assert.ok(!p2.data.some((v: any) => p1.data.some((w: any) => w.id === v.id)));
  assert.ok(new Date(p1.data[0].created_at) >= new Date(p1.data[1].created_at));
  ok(`${p1.data.length} + ${p2.data.length} on two pages, no repeats`);
}

step('Deleting a video still being made refunds its hold');
{
  const before = await balance(D);
  const r = await call(key, 'POST', '/videos', { prompt: 'A slow pan across a quiet harbour at dawn.', duration: 10 });
  near(await balance(D), before - 1.6, 'held');
  const del = await call(key, 'DELETE', `/videos/${r.json.id}`);
  assert.equal(del.json.deleted, true);
  near(await balance(D), before, 'refunded');
  assert.equal((await call(key, 'GET', `/videos/${r.json.id}`)).status, 404);
  ok('held $1.60, deleted at once, refunded in full');
}

step('Webhooks that fail are retried on a schedule, then delivered');
{
  hookStatus = 500;
  const r = await call(key, 'POST', '/videos', { prompt: 'Neon signs flicker on in a narrow alley.', webhook_url: hookUrl });
  await finished(key, 'videos', r.json.id);
  const first = await until('a failed attempt', async () => { const [d] = await sql`select * from webhook_deliveries where project_id = ${r.json.id}`; return d?.attempts >= 1 ? d : null; });
  assert.equal(first.status, 'pending'); assert.equal(first.last_status, 500);
  const [job] = await sql`select run_after from jobs where kind = 'webhook.deliver' and payload->>'deliveryId' = ${String(first.id)} and status = 'queued'`;
  const wait = (new Date(job.run_after).getTime() - Date.now()) / 1000;
  assert.ok(wait > 40 && wait <= 61, `next attempt in ${wait.toFixed(0)} s`);
  hookStatus = 200;
  await sql`update jobs set run_after = now() where kind = 'webhook.deliver' and payload->>'deliveryId' = ${String(first.id)}`;
  await until('delivered', async () => (await sql`select status from webhook_deliveries where id = ${first.id}`)[0].status === 'delivered');
  const v = (await call(key, 'GET', `/videos/${r.json.id}`)).json;
  assert.deepEqual(v.webhook, { url: hookUrl, status: 'delivered', attempts: 2 });
  ok(`a 500 → retried after ${Math.round(wait)} s → delivered on the second attempt; the video shows it`);
}

step('Content refusals are never charged; repeated ones suspend API access until an admin lifts it');
{
  const before = await balance(D);
  for (let i = 0; i < 3; i++) {
    const r = await call(key, 'POST', '/videos', { prompt: `FORCE_SENSITIVE attempt ${i}` });
    assert.equal(r.status, 422); assert.equal(r.json.error.type, 'content_refused');
  }
  const blocked = await call(key, 'POST', '/videos', { prompt: 'a perfectly ordinary kite' });
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error.code, 'account_suspended');
  assert.equal(await balance(D), before);
  assert.equal((await app(D, 'GET', '/v1/developers')).json.account.suspended, true);
  await sql`insert into credit_accounts (owner_id) values (${ADMIN}) on conflict do nothing`;
  assert.equal((await app(ADMIN, 'GET', `/v1/admin/customers/${D}`)).json.api.suspended, true);
  assert.equal((await app(ADMIN, 'POST', `/v1/admin/customers/${D}/api`, { suspended: false })).status, 200);
  assert.equal((await call(key, 'POST', '/videos', { prompt: 'a perfectly ordinary kite' })).status, 201);
  ok('3 refusals (422, $0) → 403 account_suspended → lifted by an admin → working again');
}

step('Limits: requests per key, and a key’s monthly spending cap');
{
  const k2 = (await app(D, 'POST', '/v1/developers/keys', { name: 'limited', monthly_limit_usd: 0.5 })).json;
  const capped = await call(k2.key, 'POST', '/videos', { prompt: 'a lighthouse beam sweeping the fog' });
  assert.equal(capped.status, 403); assert.equal(capped.json.error.code, 'key_limit_reached');
  const rs = [];
  for (let i = 0; i < 61; i++) rs.push(await call(k2.key, 'GET', '/account'));
  const last = rs.at(-1)!;
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal(rs[0].headers.get('x-ratelimit-limit'), '60');
  assert.equal(rs[57].headers.get('x-ratelimit-remaining'), '1', 'the 59th request of the minute (the capped POST was the first)');
  assert.equal(rs[58].status, 200); assert.equal(rs[59].status, 429, 'the 61st is refused');
  assert.equal((await call(key, 'GET', '/account')).status, 200, 'other keys are unaffected');
  ok('over the key’s $0.50 cap → 403; the 61st request in a minute → 429 with Retry-After and X-RateLimit headers');
}

step('Expiry: the files go when the retention period ends; the record says "expired"');
{
  const [take] = await sql`select file_key from takes where project_id = ${textId} and status = 'succeeded'`;
  const file = join(config.storage.localDir, take.file_key);
  assert.ok(existsSync(file));
  await sql`update projects set expires_at = now() - interval '1 minute' where id = ${textId}`;
  await cleanup();
  const v = (await call(key, 'GET', `/videos/${textId}`)).json;
  assert.equal(v.status, 'expired'); assert.equal(v.output, null);
  assert.ok(!existsSync(file), 'the MP4 is deleted');
  ok('status expired, no output, file deleted');
}

step('A microdrama from an idea: written, cast, filmed and edited, approved within its price cap');
{
  const q = (await call(key, 'POST', '/films/quote', { format: 'microdrama', episodes: 1, episode_seconds: 45 })).json;
  assert.equal(q.setup_fee_usd, 0.5); near(q.estimated_filming_usd, 7.2, 'filming estimate');
  await topUp(D, 7002, 202);
  const before = await balance(D);
  const bad = await call(key, 'POST', '/films', { prompt: 'A night-shift nurse finds a letter that proves her husband is alive.', episodes: 1, episode_seconds: 45, max_cost_usd: 2 });
  assert.equal(bad.status, 400); assert.equal(bad.json.error.param, 'max_cost_usd');
  const r = await call(key, 'POST', '/films', { prompt: 'A night-shift nurse finds a letter that proves her husband is alive.', episodes: 1, episode_seconds: 45, max_cost_usd: 20, webhook_url: hookUrl, metadata: { campaign: 'launch' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.status, 'writing'); assert.equal(r.json.auto_approve, true);
  const f = await finished(key, 'films', r.json.id, ['succeeded', 'failed', 'awaiting_approval']);
  assert.equal(f.status, 'succeeded', JSON.stringify({ status: f.status, error: f.error, approval: f.approval }));
  assert.equal(f.episodes.length, 1); assert.ok(f.episodes[0].output.url);
  const ep = Buffer.from(await (await fetch(f.episodes[0].output.url)).arrayBuffer());
  await writeFile(join(dir, 'episode.mp4'), ep);
  const info = await probe(join(dir, 'episode.mp4'));
  assert.ok(info.duration > 20 && info.has_audio && info.height > info.width, 'a vertical episode with sound');
  near(before - (await balance(D)), f.cost.charged_usd, 'what the film says it charged is what was taken');
  assert.ok(f.cost.charged_usd <= 20 && f.cost.charged_usd > 0.5);
  const events = hooks.filter((h) => h.event.data?.id === r.json.id).map((h) => h.event.type);
  await until('film.succeeded', async () => hooks.some((h) => h.event.data?.id === r.json.id && h.event.type === 'film.succeeded'));
  assert.ok(!events.includes('film.awaiting_approval'), 'approved by itself: no approval needed');
  ok(`${f.progress.shots} shots, a ${info.duration.toFixed(0)} s vertical episode; charged $${f.cost.charged_usd.toFixed(2)} within the $20 cap; film.succeeded delivered`);
}

step('A film that waits for approval, then films when approved');
{
  const r = await call(key, 'POST', '/films', { prompt: 'Two rival food-truck owners must share one parking spot for a week.', episodes: 1, episode_seconds: 45, auto_approve: false, webhook_url: hookUrl });
  assert.equal(r.status, 201);
  const f = await finished(key, 'films', r.json.id, ['awaiting_approval', 'failed']);
  assert.equal(f.status, 'awaiting_approval'); assert.equal(f.approval.required, true); assert.ok(f.cost.filming_usd > 0);
  await until('film.awaiting_approval', async () => hooks.some((h) => h.event.data?.id === r.json.id && h.event.type === 'film.awaiting_approval'));
  const early = await call(key, 'POST', `/films/${r.json.id}/retry`);
  assert.equal(early.status, 409, 'only a failed film can be retried'); assert.equal(early.json.error.code, 'bad_state');
  const before = await balance(D);
  const go = await call(key, 'POST', `/films/${r.json.id}/approve`);
  assert.equal(go.status, 200); assert.ok(['filming', 'editing', 'succeeded'].includes(go.json.status), go.json.status);
  assert.equal((await call(key, 'POST', `/films/${r.json.id}/approve`)).status, 409, 'approving twice is a 409');
  await until('filming started', async () => (await balance(D)) < before);
  const del = await call(key, 'DELETE', `/films/${r.json.id}`);
  assert.equal(del.json?.deleted, true, `${del.status} ${JSON.stringify(del.json)}`);
  await new Promise((res) => setTimeout(res, 500));
  const [{ held }] = await sql`select coalesce(sum(hold_usd) filter (where not settled), 0)::float held from takes where project_id = ${r.json.id}`;
  assert.equal(held, 0);
  ok('stops at its price with film.awaiting_approval; approve → filming; delete mid-film refunds every open hold');
}

step('The account and the Developers page add it all up');
{
  const acc = (await call(key, 'GET', '/account')).json;
  assert.ok(acc.key.spent_this_month_usd > 0);
  const page = (await app(D, 'GET', '/v1/developers')).json;
  assert.ok(page.usage.requests > 30 && page.usage.videos >= 7 && page.usage.films >= 1 && page.usage.spend_usd > 0, JSON.stringify(page.usage)); // deleted ones aren't counted
  assert.ok(page.recent_requests.length > 0 && page.recent_requests[0].request_id.startsWith('req_'));
  const biz = (await app(ADMIN, 'GET', '/v1/admin/business?days=1')).json;
  assert.ok(biz.api.requests > 0 && biz.api.videos >= 7);
  ok(`key spent $${acc.key.spent_this_month_usd}; ${page.usage.requests} requests logged; the company dashboard counts API use`);
}

mediaServer.close(); receiver.close();
console.log('\nALL API CHECKS PASSED');
process.exit(0);
