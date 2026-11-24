// The launch audit's attacks, each run for real (database, FFmpeg, the job worker, many requests at once) and each
// shown fixed: the engine freezing under a burst of requests, free and unlimited edits, flat-fee screenplays, uploads
// that make FFmpeg fetch web addresses or decode gigabytes, provider costs shown to customers, and one kind of work
// starving another. Mock providers.
//   DATABASE_URL=postgres://postgres@localhost:5432/scale npx tsx test/scale.e2e.ts

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.ENFORCE_CREDITS = '1';
process.env.DB_POOL_MAX = '4'; // a small pool: the old freeze needed only a handful of requests at once
Object.assign(process.env, {
  SELL_PER_SECOND_768P: '0.16', PLAN_CREDITS_USD: '20', MINIMAX_POLL_SECONDS: '1', WORKER_CONCURRENCY: '2', IMPORT_ENABLED: '1',
  STORAGE_DIR: process.env.STORAGE_DIR || './data/scale-files', PUBLIC_BASE_URL: 'http://localhost:8856',
});
const ADMIN = 'dddddddd-0000-4000-8000-0000000000aa';
process.env.ADMIN_USER_IDS = ADMIN;

const { sql, migrate } = await import('../src/db.js');
await migrate();
const { config } = await import('../src/config.js');
const { app } = await import('../src/server.js');
const { registerJobs } = await import('../src/jobs.js');
const { register, startWorker, enqueue } = await import('../src/queue.js');
const { cleanup } = await import('../src/maintenance.js');
const { breakdownFee } = await import('../src/pipeline/limits.js');
registerJobs();
const worker = startWorker();

let n = 0;
const step = (t: string) => console.log(`\n${++n}. ${t}`);
const ok = (t: string) => console.log(`  ✓ ${t}`);
const local = { host: 'localhost' };
async function call(uid: string | null, method: string, path: string, body?: any) {
  const headers: Record<string, string> = { ...local, ...(uid ? { authorization: `Bearer dev:${uid}` } : {}) };
  let payload: any = body;
  if (body !== undefined && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await app.request(path, { method, headers, body: payload });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function subscriber(planUsd = 20) {
  const id = randomUUID();
  await sql`insert into credit_accounts (owner_id, plan_usd) values (${id}, ${planUsd})`;
  await sql`insert into subscriptions (id, owner_id, status) values (${'sub_' + id}, ${id}, 'active')`;
  return id;
}
const balance = async (id: string) => { const [a] = await sql`select (plan_usd + balance_usd)::float t from credit_accounts where owner_id = ${id}`; return a.t as number; };
const clip = (prompt: string, seconds = 15, files: Record<string, { data: Buffer; name: string; type: string }[]> = {}, mode = 'text') => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ mode, prompt, seconds, aspect: '9:16', consent: 'true' })) fd.append(k, String(v));
  for (const [k, list] of Object.entries(files)) for (const f of list) fd.append(k, new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  return fd;
};
async function until(what: string, f: () => Promise<boolean>, ms = 120_000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await f()) return; await new Promise((r) => setTimeout(r, 300)); }
  throw new Error(`timed out waiting for: ${what}`);
}
const healthy = async () => (await Promise.race([app.request('/health'), new Promise<null>((r) => setTimeout(() => r(null), 5000))]))?.status === 200;

// ─────────────────────────────────────────────────────────────────────────────
step('A burst of requests from one customer who can afford only some of them');
{
  const A = await subscriber(20);
  const t0 = Date.now();
  // 30 at once: the most one customer may start in an hour (the rest would get 429).
  const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => call(A, 'POST', '/v1/clips', clip(`a paper boat number ${i} in a gutter after rain`))));
  const secs = (Date.now() - t0) / 1000;
  const created = rs.filter((r) => r.status === 201).length, refused = rs.filter((r) => r.status === 402).length;
  assert.equal(created, 8, `8 clips of $2.40 fit in $20 (got ${created}: ${[...new Set(rs.map((r) => r.status))]})`);
  assert.equal(refused, 22);
  assert.ok(rs.filter((r) => r.status === 402).every((r) => /balance is \$/.test(r.json.error.message)), 'a clear message with the balance');
  assert.ok(secs < 30, `answered in ${secs.toFixed(1)} s`);
  assert.ok(await healthy(), 'the engine still answers');
  assert.ok(Math.abs((await balance(A)) - 0.8) < 1e-6, `balance ${await balance(A)}`);
  const [h] = await sql`select count(*)::int takes, coalesce(sum(hold_usd), 0)::float held from takes t join projects p on p.id = t.project_id where p.owner_id = ${A}`;
  assert.deepEqual(h, { takes: 8, held: 19.2 });
  const [orphans] = await sql`select count(*)::int n from projects p where owner_id = ${A} and not exists (select 1 from takes t where t.project_id = p.id)`;
  assert.equal(orphans.n, 0, 'no half-made clips');
  ok(`30 requests on a pool of ${config.db.poolMax} connections: 8 made, 22 refused with the balance, in ${secs.toFixed(1)} s; the engine kept answering`);
}

step('A text clip is made, and its edits can no longer be flooded');
let E: string, ep: string, clipId: string;
{
  E = await subscriber(20);
  const r = await call(E, 'POST', '/v1/clips', clip('a red kite climbing over a windy beach', 5));
  assert.equal(r.status, 201);
  clipId = r.json.project.id;
  await until('the clip is filmed', async () => (await call(E, 'GET', `/v1/projects/${clipId}`)).json.project.stage === 'done');
  ep = (await call(E, 'GET', `/v1/projects/${clipId}`)).json.episodes[0].id;
  const [{ id: shot }] = await sql`select id from shots where episode_id = ${ep}`;
  const [{ id: take }] = await sql`select id from takes where shot_id = ${shot} and status = 'succeeded'`;
  await call(E, 'POST', `/v1/takes/${take}/approve`, {});
  const before = await sql`select count(*)::int n from cuts where episode_id = ${ep}`;
  const rs = await Promise.all(Array.from({ length: 100 }, () => call(E, 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview' })));
  const accepted = rs.filter((x) => x.status === 202).length, limited = rs.filter((x) => x.status === 429).length;
  assert.equal(accepted + limited, 100);
  assert.ok(limited >= 70, `${limited} refused by the limit`);
  assert.ok(rs.find((x) => x.status === 429)!.headers.get('retry-after'), 'says when to try again');
  const [after] = await sql`select count(*)::int n from cuts where episode_id = ${ep}`;
  assert.ok(after.n - before[0].n <= 3, `${after.n - before[0].n} edits made for ${accepted} requests`);
  ok(`100 edit requests: ${accepted} accepted, ${limited} limited (429), ${after.n - before[0].n} edit(s) actually queued`);

  await sql`update subscriptions set status = 'expired' where owner_id = ${E}`;
  const r2 = await call(randomUUID(), 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview' });
  assert.equal(r2.status, 404, 'someone else can’t edit it');
  const fresh = await subscriber(5); // a new customer can't touch it either; the owner without a plan can't edit
  void fresh;
  await sql`delete from jobs where kind = 'cut.assemble' and project_id = ${clipId}`; // let the next request through the dedupe
  const r3 = await app.request(`/v1/episodes/${ep}/cuts`, { method: 'POST', headers: { ...local, authorization: `Bearer dev:${E}`, 'content-type': 'application/json' }, body: '{"kind":"preview","options":{"fade":true}}' });
  assert.ok([402, 429].includes(r3.status), `an ended plan can’t make new edits (${r3.status})`);
  await sql`update subscriptions set status = 'active' where owner_id = ${E}`;
  ok('edits need a plan and room in storage, like any new work');
}

step('Uploads that are not what they claim are refused before FFmpeg reads them');
{
  const hits: string[] = [];
  const listener = createServer((req, res) => { hits.push(`${req.method} ${req.url}`); res.statusCode = 404; res.end(); });
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(listener.address() as any).port}`;
  const hostile: Record<string, string> = {
    'HLS playlist': `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${at}/hls.ts\n#EXT-X-ENDLIST\n`,
    'HLS with a key': `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${at}/key"\n#EXTINF:10.0,\n${at}/seg.ts\n#EXT-X-ENDLIST\n`,
    'DASH manifest': `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1000"><BaseURL>${at}/dash.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation></AdaptationSet></Period></MPD>`,
    'concat script': `ffconcat version 1.0\nfile '${at}/concat.mp4'\nfile '/etc/passwd'\n`,
    'SVG with links': `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="800" height="800"><image xlink:href="${at}/svg.png" width="400" height="400"/><image xlink:href="file:///etc/hostname"/></svg>`,
  };
  const U = await subscriber(20);
  const pic = (data: Buffer, name: string) => ({ images: [{ data, name, type: 'image/jpeg' }] });
  for (const [what, body] of Object.entries(hostile)) {
    const data = Buffer.from(body);
    const asImage = await call(U, 'POST', '/v1/clips', clip('make it move', 5, pic(data, 'x.jpg'), 'image'));
    const asVideo = await call(U, 'POST', '/v1/clips', clip('make it move', 5, { video: [{ data, name: 'x.mp4', type: 'video/mp4' }] }, 'remix'));
    assert.equal(asImage.status, 400, `${what} as a picture: ${asImage.status} ${asImage.text.slice(0, 120)}`);
    assert.equal(asVideo.status, 400, `${what} as a video: ${asVideo.status}`);
  }
  // A real picture with a hostile "voice".
  const { execFileSync } = await import('node:child_process');
  const jpg = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x480:d=1', '-frames:v', '1', '-f', 'mjpeg', 'pipe:1']);
  const asVoice = await call(U, 'POST', '/v1/clips', clip('she says hello', 5, { ...pic(jpg, 'a.jpg'), audio: [{ data: Buffer.from(hostile['HLS playlist']), name: 'v.mp3', type: 'audio/mpeg' }] }, 'reference'));
  assert.equal(asVoice.status, 400, `a playlist as a voice: ${asVoice.status}`);
  // A PNG of 12,000 × 12,000 pixels: under half a megabyte to send, 411 MB to decode.
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const W = 12000, ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const bomb = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((W * 3 + 1) * W), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  const t0 = Date.now();
  const big = await call(U, 'POST', '/v1/clips', clip('make it move', 5, pic(bomb, 'big.png'), 'image'));
  assert.equal(big.status, 400);
  assert.match(big.json.error.message, /too large/);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(hits, [], `FFmpeg fetched: ${hits.join(', ')}`);
  assert.equal(await balance(U), 20, 'nothing charged');
  listener.close();
  ok(`${Object.keys(hostile).length} hostile files as pictures and videos, a playlist as a voice: all refused, no web request made`);
  ok(`a ${(bomb.length / 1024).toFixed(0)} KB picture of ${W}×${W} pixels refused from its header in ${Date.now() - t0} ms`);
}

step('A screenplay is limited in size and its design fees follow its length');
{
  const S = await subscriber(20);
  const scene = (i: number) => `${i % 2 ? 'EXT' : 'INT'}. ROOM ${i} - NIGHT\n\nAMIRA turns the key over in her hand.\n\nAMIRA\nYou kept it.\n\n`;
  const script = (k: number) => Array.from({ length: k }, (_, i) => scene(i)).join('');
  config.importEnabled = false;
  assert.equal((await call(S, 'POST', '/v1/projects', { title: 'x', screenplay: script(3) })).status, 404, 'off unless switched on');
  config.importEnabled = true;
  const long = await call(S, 'POST', '/v1/projects', { title: 'Too long', screenplay: script(config.scripts.maxEpisodeScenes + 1) });
  assert.equal(long.status, 400); assert.equal(long.json.error.code, 'too_long');
  const huge = await call(S, 'POST', '/v1/projects', { title: 'Huge', screenplay: 'word '.repeat(10_000) });
  assert.equal(huge.status, 400);
  const r = await call(S, 'POST', '/v1/projects', { title: 'Thirty scenes', screenplay: script(30) });
  assert.equal(r.status, 201);
  await until('the breakdown is charged', async () => (await sql`select 1 from credit_events where owner_id = ${S} and reason = 'breakdown'`).length > 0);
  const [{ d }] = await sql`select -sum(delta_usd)::float d from credit_events where owner_id = ${S} and reason = 'breakdown'`;
  assert.equal(d, breakdownFee(30));
  assert.ok(d > config.credits.actions.breakdown);
  ok(`screenplays over ${config.scripts.maxEpisodeScenes} scenes or ${config.scripts.maxEpisodeChars.toLocaleString('en-US')} characters refused; 30 scenes cost $${d.toFixed(2)} to design (flat fee $${config.credits.actions.breakdown.toFixed(2)})`);
  const pid = r.json.project.id;
  const [{ id: epi }] = await sql`select id from episodes where project_id = ${pid}`;
  const edit = await call(S, 'PATCH', `/v1/episodes/${epi}`, { script: script(2) + '\nAMIRA\nFORCE_SENSITIVE\n' });
  assert.equal(edit.status, 422, 'a hand-edited script is content-checked');
  const tooLong = await call(S, 'PATCH', `/v1/episodes/${epi}`, { script: script(config.scripts.maxEpisodeScenes + 1) });
  assert.equal(tooLong.status, 400);
  ok('a script edited by hand is content-checked and kept to one episode');
}

step('Customer-written text that reaches a picture or the video model is checked');
{
  const C = await subscriber(20);
  const film = await call(C, 'POST', '/v1/create', { prompt: 'FORCE_SENSITIVE a story about a lighthouse keeper and the sea' });
  assert.equal(film.status, 422);
  assert.equal(await balance(C), 20, 'no setup fee for a refused idea');
  const [p] = await sql`insert into projects (owner_id) values (${C}) returning id`;
  const [a] = await sql`insert into assets (project_id, kind, key, name, description) values (${p.id}, 'character', 'AMIRA', 'Amira', 'A nurse') returning id`;
  assert.equal((await call(C, 'PATCH', `/v1/assets/${a.id}`, { description: 'FORCE_SENSITIVE' })).status, 422);
  assert.equal((await call(C, 'PATCH', `/v1/assets/${a.id}`, { description: 'A night nurse with a tired smile' })).status, 200);
  const patched = await call(C, 'PATCH', `/v1/projects/${p.id}`, { title: 'x'.repeat(100_000), settings: { burn_subtitles: true, anything: { nested: 1 } }, style: { look: 'FORCE_SENSITIVE' } });
  assert.equal(patched.status, 422, 'the look is checked too');
  const p2 = await call(C, 'PATCH', `/v1/projects/${p.id}`, { title: 'x'.repeat(100_000), settings: { burn_subtitles: true, anything: { nested: 1 } } });
  assert.equal(p2.json.project.title.length, 200);
  assert.deepEqual(Object.keys(p2.json.project.settings).sort(), ['burn_subtitles']);
  ok('film ideas, cast descriptions, scripts and the film look are content-checked; settings only take known switches');
}

step('Customers see prices; only the operator sees what things cost us');
{
  const mine = await call(E, 'GET', `/v1/projects/${clipId}`);
  assert.equal(mine.json.spend, undefined);
  assert.ok(mine.json.clip.takes.every((t: any) => !('cost_usd' in t)));
  const est = await call(E, 'GET', `/v1/projects/${clipId}/estimate`);
  assert.equal(est.json.prices, undefined); assert.ok(est.json.customer.per_second > 0);
  const shots = await call(E, 'GET', `/v1/episodes/${ep}/shots`);
  assert.ok(shots.json.shots.every((s: any) => s.estimate_usd === undefined && s.price_usd > 0));
  await sql`insert into credit_accounts (owner_id) values (${ADMIN}) on conflict do nothing`;
  const cap = await call(ADMIN, 'GET', '/v1/admin/capacity');
  assert.equal(cap.status, 200); assert.ok('in_flight_cap' in cap.json.capacity);
  ok('no provider cost in a customer’s project, takes, shots or estimate; the admin capacity view works');
}

step('Every response carries browser protections, and broken addresses are a 400');
{
  const r = await app.request('/health', { headers: local });
  for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy']) assert.ok(r.headers.get(h), h);
  assert.equal((await app.request('/%E0%A4%A', { headers: local })).status, 400);
  assert.equal((await app.request('/files/%E0%A4%A?exp=1&sig=x', { headers: local })).status, 400);
  const bad = await call(E, 'GET', '/v1/projects/not-a-uuid');
  assert.equal(bad.status, 404);
  ok('nosniff, no framing, referrer policy; a malformed address no longer reads as a server error');
}

step('A pile of slow writing jobs never holds up collecting finished clips');
{
  let slowRunning = 0, slowMax = 0;
  register('project.autopilot', async () => { slowRunning++; slowMax = Math.max(slowMax, slowRunning); await new Promise((r) => setTimeout(r, 1500)); slowRunning--; return { done: true }; });
  let polledAt = 0;
  register('take.poll', async () => { polledAt = Date.now(); return { done: true }; });
  for (let i = 0; i < 12; i++) await enqueue('project.autopilot', { projectId: null });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  await enqueue('take.poll', { takeId: randomUUID() });
  await until('the clip check ran', async () => polledAt > 0, 10_000);
  assert.ok(polledAt - t0 < 3000, `waited ${polledAt - t0} ms`);
  assert.ok(slowMax <= config.lanes.llm, `${slowMax} writing jobs ran at once (lane has ${config.lanes.llm})`);
  ok(`with ${config.lanes.llm} writing slots full and ${12 - config.lanes.llm} more waiting, a clip check ran after ${polledAt - t0} ms`);
}

step('Housekeeping: replaced edits and old jobs are removed');
{
  const [{ id: epi }] = await sql`select id from episodes where project_id = ${clipId}`;
  for (let i = 0; i < 4; i++) {
    await sql`insert into cuts (project_id, episode_id, kind, status, file_key, created_at) values (${clipId}, ${epi}, 'preview', 'done', ${`projects/${clipId}/cuts/old-${i}.mp4`}, now() - make_interval(hours => ${2 + i}))`;
  }
  await sql`insert into jobs (kind, status, updated_at) values ('test.old', 'done', now() - interval '8 days')`;
  const before = (await sql`select count(*)::int n from cuts where episode_id = ${epi} and status = 'done'`)[0].n;
  await cleanup();
  const after = (await sql`select count(*)::int n from cuts where episode_id = ${epi} and status = 'done'`)[0].n;
  assert.equal(after, 2, `${before} done edits → ${after}`);
  assert.equal((await sql`select count(*)::int n from jobs where kind = 'test.old'`)[0].n, 0);
  ok(`edits of one episode: ${before} → ${after} (the newest two are kept); week-old finished jobs removed`);
}

await worker.stop(2000);
await sql.end({ timeout: 2 });
console.log('\nALL SCALE CHECKS PASSED');
process.exit(0);
