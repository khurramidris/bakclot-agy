// The failures found by the 2026-11-13 outside audit, each reproduced against a real database and real FFmpeg, and
// each shown fixed. Mock providers; no worker runs, so every job stays where the test can see it.
//   DATABASE_URL=postgres://postgres@localhost:5432/reliability npx tsx test/reliability.e2e.ts

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.ENFORCE_CREDITS = '1';
process.env.SELL_PER_SECOND_768P = '0.16';
Object.assign(process.env, { LEMONSQUEEZY_WEBHOOK_SECRET: 'x', PLAN_CREDITS_USD: '20' });

const { sql, migrate } = await import('../src/db.js');
await migrate();
const billing = await import('../src/billing.js');
const { queueRender, repairRenders, checkOutput } = await import('../src/pipeline/render.js');
const { handleLemonEvent } = await import('../src/lemonsqueezy.js');
const { app } = await import('../src/server.js');
const { compileShot } = await import('../src/pipeline/compiler.js');
const { placeholderVideo, probe } = await import('../src/media/ffmpeg.js');

let n = 0;
const step = (t: string) => console.log(`\n${++n}. ${t}`);
const ok = (t: string) => console.log(`  ✓ ${t}`);
const uid = () => crypto.randomUUID();

async function customer(usd = 50) {
  const id = uid();
  await sql`insert into credit_accounts (owner_id, balance_usd) values (${id}, ${usd})`;
  return id;
}
const balance = async (id: string) => (await billing.balances(id)).total;
async function shotFor(owner: string, duration = 10) {
  const [p] = await sql`insert into projects (owner_id, aspect) values (${owner}, '9:16') returning id`;
  const [e] = await sql`insert into episodes (project_id, idx) values (${p.id}, 1) returning id`;
  const [s] = await sql`insert into shots (project_id, episode_id, idx, duration) values (${p.id}, ${e.id}, 1, ${duration}) returning id`;
  return { projectId: p.id, episodeId: e.id, shotId: s.id };
}

// ───────────────────────────────────────────────────────────────────────────
step('The desktop tunnel only reaches signed files, the health check and the webhook');
{
  const viaTunnel = { host: 'random-words.trycloudflare.com', 'cf-ray': '8f00-LHR', 'cf-connecting-ip': '203.0.113.9' };
  const r1 = await app.request('/app-config.json', { headers: viaTunnel });
  assert.equal(r1.status, 403, 'the dev user id must not be handed to the internet');
  const r2 = await app.request('/v1/projects', { headers: { ...viaTunnel, authorization: `Bearer dev:${uid()}` } });
  assert.equal(r2.status, 403, 'dev sign-in must not work through the tunnel');
  // A tunnel that rewrites Host to localhost still carries Cloudflare's headers.
  const r3 = await app.request('/v1/projects', { headers: { host: '127.0.0.1:8787', 'cf-ray': 'x', authorization: `Bearer dev:${uid()}` } });
  assert.equal(r3.status, 403);
  assert.equal((await app.request('/health', { headers: viaTunnel })).status, 200, 'RunPod can still check the address');
  assert.equal((await app.request('/files/x.mp4?exp=1&sig=bad', { headers: viaTunnel })).status, 403, 'files still need their signature');
  const local = await app.request('/app-config.json', { headers: { host: '127.0.0.1:8787' } });
  assert.equal(local.status, 200);
  assert.ok((await local.json()).devUser, 'on this computer the studio still signs in by itself');
  ok('through the tunnel: no app config, no dev sign-in; /health and signed /files still answer');
}

// ───────────────────────────────────────────────────────────────────────────
step('Two clicks on Render at the same moment buy one take');
{
  const owner = await customer(50);
  const { shotId } = await shotFor(owner, 10);
  const got = await Promise.all([queueRender(shotId), queueRender(shotId), queueRender(shotId)]);
  const takes = await sql`select id, hold_usd from takes where shot_id = ${shotId}`;
  assert.equal(takes.length, 1, `one take, not ${takes.length}`);
  assert.equal(new Set(got.map((g: any) => g.take_id)).size, 1, 'every click points at the same take');
  assert.equal(await balance(owner), 50 - 1.6, 'one $1.60 hold');
  const jobs = await sql`select 1 from jobs where kind = 'take.submit' and payload->>'takeId' = ${takes[0].id}`;
  assert.equal(jobs.length, 1, 'the take has its job');
  ok('3 simultaneous requests → 1 take, 1 hold of $1.60, 1 job');
}

// ───────────────────────────────────────────────────────────────────────────
step('A paid take that lost its job is picked up again');
{
  const owner = await customer(50);
  const { shotId, projectId } = await shotFor(owner, 5);
  // What a crash between the two steps used to leave behind: the credit held, the take waiting, no job.
  const [t] = await sql`insert into takes (project_id, shot_id, n, resolution, status, hold_usd, created_at)
    values (${projectId}, ${shotId}, 1, '768P', 'pending', 0.8, now() - interval '5 minutes') returning id`;
  await repairRenders();
  const jobs = await sql`select status from jobs where kind = 'take.submit' and payload->>'takeId' = ${t.id}`;
  assert.equal(jobs.length, 1, 'the repair sweep queued it again');
  // A take that finished without settling its hold is settled too (a failed one is refunded).
  const [f] = await sql`insert into takes (project_id, shot_id, n, resolution, status, hold_usd, finished_at)
    values (${projectId}, ${shotId}, 2, '768P', 'failed', 0.8, now() - interval '5 minutes') returning id`;
  const before = await balance(owner);
  await repairRenders();
  assert.equal(await balance(owner), before + 0.8, 'the stranded hold came back');
  assert.equal((await sql`select settled from takes where id = ${f.id}`)[0].settled, true);
  ok('orphaned pending take re-queued; an unsettled failed take refunded once');
}

// ───────────────────────────────────────────────────────────────────────────
step('A step interrupted after it was charged is not charged again when it runs again');
{
  const owner = await customer(10);
  const key = 'job:999001:breakdown';
  // First run: charged, then the process "dies" (the work never finishes, so no refund runs).
  void billing.paid(owner, 1, 'breakdown', 'p', () => new Promise(() => {}), key);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await balance(owner), 9);
  // The job is picked up again by another process: same key, so the same charge.
  const out = await billing.paid(owner, 1, 'breakdown', 'p', async () => 'done', key);
  assert.equal(out, 'done');
  assert.equal(await balance(owner), 9, 'charged once, not twice');
  // An ordinary failure is still refunded, and the next try is charged again (each paid attempt delivers or refunds).
  const k2 = 'job:999002:image_gen';
  await assert.rejects(billing.paid(owner, 0.5, 'image_gen', 'a', async () => { throw new Error('provider down'); }, k2));
  assert.equal(await balance(owner), 9, 'failed work refunded');
  // A job that dies on its last try gives back what it still holds.
  const k3 = 'job:999003:shot_plan';
  void billing.paid(owner, 2, 'shot_plan', 'e', () => new Promise(() => {}), k3);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await balance(owner), 7);
  await billing.releaseCharges(999003);
  await billing.releaseCharges(999003);
  assert.equal(await balance(owner), 9, 'released once');
  ok('crash + retry → one charge; a job that gives up for good is refunded once');
}

// ───────────────────────────────────────────────────────────────────────────
step('An old subscription expiring does not take the current one’s credit');
{
  const owner = uid();
  const sub = (id: string, status: string, updated: string) => ({
    meta: { event_name: status === 'expired' ? 'subscription_expired' : 'subscription_updated', custom_data: { user_id: owner } },
    data: { id, attributes: { status, updated_at: updated, customer_id: 1, variant_id: 100 } },
  });
  await handleLemonEvent(sub('old', 'cancelled', '2026-10-01T00:00:00Z'));
  await handleLemonEvent(sub('new', 'active', '2026-11-01T00:00:00Z'));
  await sql.begin((tx) => billing.resetPlanCredit(tx, owner, 'ls:invoice:1'));
  assert.equal((await billing.balances(owner)).plan, 20);
  await handleLemonEvent(sub('old', 'expired', '2026-11-05T00:00:00Z'));
  assert.equal((await billing.balances(owner)).plan, 20, 'the $20 of this month stays');
  assert.equal((await billing.planOf(owner)).active, true);
  // Out of order: an older "active" event arriving after the newer "cancelled" one changes nothing.
  await handleLemonEvent(sub('new', 'cancelled', '2026-11-10T00:00:00Z'));
  const r = await handleLemonEvent(sub('new', 'past_due', '2026-11-02T00:00:00Z'));
  assert.equal((r as any).ignored, 'older than the last event');
  assert.equal((await sql`select status from subscriptions where id = 'new'`)[0].status, 'cancelled');
  ok('old sub expiring keeps $20 plan credit; a late older webhook is ignored');
}

// ───────────────────────────────────────────────────────────────────────────
step('A clip that is not what was ordered is not delivered or charged');
{
  const dir = await mkdtemp(join(tmpdir(), 'rel-'));
  try {
    const f = join(dir, 'bad.mp4');
    await placeholderVideo(f, ['bad'], 1, 160, 90, false); // 1 s, silent, tiny, landscape
    const info = await probe(f);
    const bad = checkOutput(info, { seconds: 10, aspect: '9:16', resolution: '768P' });
    assert.equal(bad.fatal, true);
    for (const w of ['length', 'no audio', 'shape', 'only 160']) assert.ok(bad.problems.some((p) => p.includes(w)), `flags ${w}: ${bad.problems}`);
    const g = join(dir, 'good.mp4');
    await placeholderVideo(g, ['good'], 10, 768, 1344, true);
    const good = checkOutput(await probe(g), { seconds: 10, aspect: '9:16', resolution: '768P' });
    assert.deepEqual(good, { problems: [], fatal: false });
    ok(`1 s silent 160×90 for a 10 s 9:16 order → rejected (${bad.problems.join('; ')}); a correct clip passes`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ───────────────────────────────────────────────────────────────────────────
step('A long description never pushes a spoken line out of the prompt');
{
  const essay = 'An extraordinarily detailed description of a face, its history, every scar and freckle and habit. '.repeat(120);
  const line = 'The key was never in the drawer, Mama. It was in your hand the whole time.';
  const c = compileShot({
    plan: { duration: 8, characters: ['ASMA'], props: [], beats: [{ t0: 0, t1: 8, shot: 'close-up', action: 'Asma turns to face her mother.', dialogue: [{ who: 'ASMA', line }] }] },
    project: { aspect: '9:16', language: 'English', style: {}, format: 'micro' },
    scene: { heading: 'INT. KITCHEN - NIGHT', time_of_day: 'NIGHT', int_ext: 'INT' },
    set: null, setMaster: null, props: [],
    characters: [{ key: 'ASMA', name: 'Asma Khan', identity: { id: 'a', kind: 'character', key: 'ASMA', name: 'Asma', description: essay, meta: {}, file_key: 'k' } }],
  } as any);
  assert.ok(c.prompt.length <= 7000);
  assert.ok(c.prompt.includes(line), 'the line is in the prompt');
  ok(`${essay.length}-character description → ${c.prompt.length}-character prompt, line kept (${c.warnings.at(-1)})`);
}

console.log('\nALL RELIABILITY CHECKS PASSED');
await sql.end();
process.exit(0);
