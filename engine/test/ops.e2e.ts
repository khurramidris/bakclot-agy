// The ops dashboard end to end, against a real (empty) Postgres with mock providers: the engine records traffic, active
// customers, stages, content checks, webhooks and vital signs; the dashboard's server reads every report as an admin and
// refuses everyone else.
//   DATABASE_URL=postgres://postgres@localhost:5432/studio_ops npx tsx test/ops.e2e.ts

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.PORT ??= '8804';
process.env.OPS_PORT ??= String(+process.env.PORT + 100);
process.env.ENGINE_URL = `http://localhost:${process.env.PORT}`;
process.env.STORAGE_DIR ??= './data/ops-files';
process.env.MINIMAX_POLL_SECONDS ??= '1';
Object.assign(process.env, {
  LEMONSQUEEZY_API_KEY: 'ls_test_key', LEMONSQUEEZY_STORE_ID: '1', LEMONSQUEEZY_WEBHOOK_SECRET: 'ls_whsec_test', LEMONSQUEEZY_BASIC_VARIANT_ID: '100',
  PROVIDER_BUDGETS_MONTHLY: 'anthropic:50,minimax:0.000001', FIXED_COSTS_MONTHLY: 'Railway:20',
});
const A = 'aaaaaaaa-0000-4000-8000-0000000000a1', B = 'bbbbbbbb-0000-4000-8000-0000000000b2';
const ADMIN = 'dddddddd-0000-4000-8000-0000000000d4';
process.env.ADMIN_USER_IDS = ADMIN;
const base = `http://localhost:${process.env.PORT}`;
const log = (s: string) => console.log(s);

await import('../src/index.js');
const { sql } = await import('../src/db.js');
const { flushTelemetry, snapshotTick } = await import('../src/telemetry.js');
const { ops } = await import('../src/ops/app.js');
await new Promise((r) => setTimeout(r, 800));

async function api(uid: string, method: string, path: string, body?: any, expect = [200, 201, 202]) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${uid}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
/** A dashboard report, read in-process from the ops app (as `uid`, or signed out). */
async function report(path: string, uid: string | null = ADMIN, expect = 200) {
  const r = await ops.request(path, { headers: uid ? { authorization: `Bearer dev:${uid}` } : {} });
  const j: any = await r.json().catch(() => ({}));
  assert.equal(r.status, expect, `${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return Object.assign(j, { _headers: r.headers });
}
async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeout = 120_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
function lsEvent(event: string, owner: string, type: string, id: number, attributes: any) {
  const body = JSON.stringify({ meta: { event_name: event, custom_data: { user_id: owner } }, data: { type, id: String(id), attributes: { store_id: 1, ...attributes } } });
  return { body, sig: createHmac('sha256', 'ls_whsec_test').update(body).digest('hex') };
}
const webhook = (e: { body: string; sig: string }) => fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'x-signature': e.sig, 'content-type': 'application/json' }, body: e.body });

log('\n1. Customers use the app: a quick clip, a film that stops at "Your approval", a refused prompt, a subscription');
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); return fd; };
const clip = await fetch(`${base}/v1/clips`, { method: 'POST', headers: { authorization: `Bearer dev:${A}` }, body: form({ mode: 'text', prompt: 'A lighthouse keeper watches a storm roll in at dusk.', seconds: '5', aspect: '9:16' }) });
assert.equal(clip.status, 201, await clip.clone().text());
const { project: clipProject } = (await clip.json()) as any;
const film = await api(A, 'POST', '/v1/create', { prompt: 'Two estranged sisters reopen their late father’s bakery and find his secret recipe book.', format: 'microdrama' });
const refused = await fetch(`${base}/v1/clips`, { method: 'POST', headers: { authorization: `Bearer dev:${B}` }, body: form({ mode: 'text', prompt: 'FORCE_SENSITIVE something the check refuses', seconds: '5', aspect: '9:16' }) });
assert.equal(refused.status, 422);
await api(B, 'GET', '/v1/me');
await until('clip finished', async () => (await api(A, 'GET', `/v1/projects/${clipProject.id}`)).project.stage === 'done');
await until('film waiting for approval', async () => (await api(A, 'GET', `/v1/projects/${film.project.id}`)).project.stage === 'ready');
await sql`update credit_accounts set email = 'ana@example.com' where owner_id = ${A}`;
await sql`update credit_accounts set email = 'ben@example.com' where owner_id = ${B}`;
const renews = new Date(Date.now() + 30 * 86_400_000).toISOString();
assert.equal((await webhook(lsEvent('subscription_created', A, 'subscriptions', 7, { customer_id: 9007, variant_id: 100, status: 'active', renews_at: renews, ends_at: null }))).status, 200);
assert.equal((await webhook(lsEvent('subscription_payment_success', A, 'subscription-invoices', 71, { subscription_id: 7, status: 'paid', billing_reason: 'initial', subtotal_usd: 2000, total_usd: 2200 }))).status, 200);
assert.equal((await webhook({ body: '{"meta":{"event_name":"order_created"}}', sig: 'forged' })).status, 400);
await flushTelemetry();
await snapshotTick();
log('  ✓ clip finished, film at the approval step, one refusal, one paid subscription, one forged webhook');

log('\n2. What the engine recorded');
const stages = (await sql`select stage from stage_events where project_id = ${clipProject.id} order by id`).map((r: any) => r.stage);
assert.deepEqual(stages, ['rendering', 'done'], 'the trigger logs each stage a clip enters, once');
const filmStages = (await sql`select stage from stage_events where project_id = ${film.project.id} order by id`).map((r: any) => r.stage);
assert.equal(filmStages[0], 'writing'); assert.equal(filmStages.at(-1), 'ready');
const routes = (await sql`select distinct route from api_minutes`).map((r: any) => r.route);
assert.ok(routes.includes('/v1/clips') && routes.includes('/v1/projects/:id') && routes.includes('/webhooks/lemonsqueezy'), `route patterns: ${routes.join(', ')}`);
assert.equal((await sql`select count(*)::int n from api_minutes where route ~ '[0-9a-f]{8}-[0-9a-f]{4}'`)[0].n, 0, 'no ids in the traffic stats');
const [act] = await sql`select count(*)::int n, sum(requests)::int requests from activity_days where owner_id in (${A}, ${B})`;
assert.equal(act.n, 2); assert.ok(act.requests >= 4);
const checks = await sql`select owner_id, allowed, category from moderation_events order by id`;
assert.ok(checks.some((c: any) => c.owner_id === B && !c.allowed && c.category === 'other'), 'the refusal is recorded with who and why (never the prompt)');
const hooks = await sql`select event_name, ok, status, error from webhook_events order by id`;
assert.deepEqual(hooks.map((h: any) => [h.ok, h.status]), [[true, 200], [true, 200], [false, 400]]);
assert.equal(hooks[2].error, 'bad signature');
assert.ok((await sql`select count(*)::int n from health_snapshots`)[0].n >= 1);
assert.ok((await sql`select count(*)::int n from usage_events where kind = 'llm' and model = 'mock'`)[0].n > 0, 'Claude calls record their model');
log('  ✓ stages, route patterns (no ids), active customers, content checks, webhooks, a snapshot and the Claude model');

log('\n3. Only admins get in');
await report('/api/overview', null, 401);
const denied = await report('/api/overview', A, 403);
assert.match(denied.error.message, new RegExp(A));
assert.equal((await ops.request('/api/nope', { headers: { authorization: `Bearer dev:${ADMIN}` } })).status, 404);
const me = await report('/api/me');
assert.equal(me.user_id, ADMIN);
assert.equal(me._headers.get('cache-control'), 'no-store');
assert.equal(me._headers.get('x-robots-tag'), 'noindex, nofollow');
assert.equal((await fetch(`${base}/ops/`)).status, 404, 'the dashboard page is never served on the customer site');
const page = await ops.request('/');
assert.ok([200, 404].includes(page.status), 'the dashboard page (404 until web/ is built)');
assert.equal((await ops.request('/health')).status, 200);
log('  ✓ signed out → 401, a customer → 403 with their user id to add, the admin → in; no caching, no indexing');

log('\n4. Every report');
const o = await report('/api/overview');
assert.deepEqual(o.status.map((s: any) => s.key), ['app', 'database', 'worker', 'video', 'payments']);
assert.equal(o.status[0].level, 'ok', `the app answers its health check: ${JSON.stringify(o.status[0])}`);
assert.equal(o.status[2].level, 'ok', 'a fresh heartbeat');
assert.equal(o.kpis.accounts, 2); assert.equal(o.kpis.paying, 1); assert.equal(o.kpis.mrr_usd, 20);
assert.equal(o.kpis.revenue_today_usd, 20); assert.equal(o.kpis.waiting_for_customer, 1); assert.equal(o.kpis.videos_done_today, 1);
assert.ok(o.kpis.active_today >= 2);
assert.ok(o.needs.some((n: any) => n.title === 'MiniMax budget used up'), JSON.stringify(o.needs));
assert.ok(!o.needs.some((n: any) => /webhook/i.test(n.title)), 'a forged webhook is not a payment problem while real ones get through');
assert.equal(o.trend.length, 30);
assert.ok(['signup', 'plan_payment', 'stage_done', 'stage_ready', 'refused', 'webhook_failed'].every((k) => o.feed.some((f: any) => f.kind === k)), o.feed.map((f: any) => f.kind).join(','));

const lv = await report('/api/live');
assert.equal(lv.waiting.length, 1); assert.equal(lv.waiting[0].stage, 'ready');
assert.ok(lv.online.some((u: any) => u.owner_id === A));
assert.ok(lv.snapshots.length >= 1 && lv.feed.length >= 6);

const biz = await report('/api/business?days=30');
assert.equal(biz.money.revenue_usd, 20); assert.equal(biz.customers.paying, 1);
assert.ok(biz.unit_economics.some((u: any) => u.mode === 'clip' && u.finished === 1));
assert.equal(biz.monthly.length, 12); assert.equal(biz.monthly.at(-1).revenue_usd, 20);
assert.equal(biz.last_30_days.arpu_usd, 20);

const g = await report('/api/growth?days=30');
assert.deepEqual(g.funnel.map((f: any) => f.n), [2, 1, 1, 1, 0]);
assert.ok(g.active.at(-1).dau >= 2 && g.cohorts.length >= 1 && g.cohorts.at(-1).weeks[0] === 100);
assert.equal(g.recent_signups.length, 2);

const list = await report('/api/customers?q=ana&sort=paid');
assert.equal(list.customers.length, 1); assert.equal(list.customers[0].paid_usd, 20); assert.equal(list.customers[0].paying, true);
const one = await report(`/api/customers/${A}`);
assert.equal(one.totals.paid_usd, 20); assert.ok(one.timeline.some((t: any) => t.stage === 'done')); assert.ok(one.activity.length >= 1);
const ben = await report(`/api/customers/${B}`);
assert.equal(ben.refusals.length, 1);
await report('/api/customers/not-a-user', ADMIN, 404);
await report('/api/customers/eeeeeeee-0000-4000-8000-0000000000e5', ADMIN, 404);
await api(ADMIN, 'GET', `/v1/admin/customers/${A}`); // the in-app admin page shares the same customer detail

const pr = await report('/api/product?days=30');
assert.ok(pr.made.some((m: any) => m.mode === 'clip' && m.kind === 'text' && m.done === 1));
assert.equal(pr.approval.reached, 1); assert.equal(pr.approval.started, 0);
assert.ok(pr.waiting_now.some((w: any) => w.stage === 'ready' && w.n === 1));
assert.ok(pr.durations.some((d: any) => d.mode === 'clip' && d.stage === 'rendering' && d.p50_secs !== null));
assert.ok(pr.renders.ok >= 1 && pr.renders.success_pct === 100);

const be = await report('/api/backend?hours=1');
assert.ok(be.api.requests > 0 && be.api.p95_ms !== null);
assert.ok(be.api.routes.some((r: any) => r.route === '/v1/clips' && r.method === 'POST' && r.client_errors === 1), 'the refused clip shows as a 422 on /v1/clips');
assert.ok(be.heartbeat.samples >= 1 && be.database.tables.length > 0 && be.storage.files > 0);
assert.ok(be.webhooks.some((w: any) => !w.ok && w.error === 'bad signature'));
assert.ok(be.jobs.kinds.some((k: any) => k.kind === 'project.autopilot'));
await report('/api/backend?hours=720');

const pv = await report('/api/providers?days=30');
assert.ok(pv.claude.some((c: any) => c.model === 'mock'));
assert.ok(pv.budgets.some((b: any) => b.provider === 'anthropic' && b.budget_usd === 50 && b.left_usd === 50));

const sf = await report('/api/safety?days=30');
assert.equal(sf.checks.refused, 1); assert.equal(sf.latest[0].email, 'ben@example.com'); assert.equal(sf.auth.bad_webhook_signatures, 1);
assert.equal(sf.daily.length, 30);
log('  ✓ overview, live, business, growth, customers, product, backend, providers and safety');

log('\nOps dashboard: all checks passed.');
process.exit(0);
