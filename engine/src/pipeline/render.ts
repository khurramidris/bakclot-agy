// Rendering: one take = one H3 task. Submit → poll every ~10 s → copy the MP4 into our own
// storage (MiniMax links expire) → verify it with ffprobe → thumbnail → ready for review.
// A customer renders up to MAX_ACTIVE_RENDERS_PER_USER clips at once (4), across everything they make, whatever each
// clip's length. A film's clips go in story order and may use all of those slots (RENDERS_PER_PROJECT), so the customer
// watches the finished ones while the rest render; when one finishes, the next starts straight away.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { storage, downloadTo } from '../storage.js';
import { PermanentError, enqueue, type Again } from '../queue.js';
import * as real from '../providers/minimax.js';
import { ProviderError, type H3Request, type H3Content, type H3Task } from '../providers/minimax.js';
import { mockMinimax } from '../providers/mock.js';
import * as runpod from '../providers/runpod.js';
import { recordUsage } from '../usage.js';
import { debit, sellPrice, settleTake } from '../billing.js';
import { probe, thumbnail, withMediaSlot } from '../media/ffmpeg.js';
import { compileShot, validateH3, costOf, PromptTooLong } from './compiler.js';
import { compileInputFor, projectAssets } from './shots.js';
import { buildClipRequest, providerFor, refreshClip, prepVideo, jpeg } from './clips.js';
import { moderate, refusal } from '../moderation.js';
import { projectEvent } from '../events.js';
import { kickCapacity } from '../capacity.js';

interface VideoApi {
  createVideoTask(body: H3Request, o: { key: string }): Promise<string>;
  queryVideoTask(id: string): Promise<H3Task>;
  cancelVideoTask?(id: string): Promise<void>;
}
/** RunPod is always real (tests point it at a fake server); otherwise mocks replace MiniMax in dev. */
export const mm = (provider: string = config.videoProvider): VideoApi => (provider === 'runpod' ? runpod : config.mock ? mockMinimax : real);
export const takeKey = (t: any) => `projects/${t.project_id}/takes/${t.id}.mp4`;
/** Resolutions a provider renders: our own GPUs make 768P only, so 2K is never sold there. */
export const resolutionsFor = (provider: string) => (provider === 'runpod' ? ['768P'] : ['768P', '2K']);

/** Create a new take for a shot and queue it. */
export async function queueRender(shotId: string, o: { resolution?: string } = {}) {
  const [s] = await sql`select s.*, p.resolution p_res, p.owner_id, p.api_key_id from shots s join projects p on p.id = s.project_id where s.id = ${shotId}`;
  if (!s) throw new PermanentError('shot not found');
  if (s.status === 'approved') throw new PermanentError('This shot is already approved. Unapprove it before rendering again.', 'bad_state');
  const resolution = o.resolution || s.p_res || '768P';
  if (!resolutionsFor(config.videoProvider).includes(resolution)) throw new PermanentError(`${resolution} isn't available: videos are made at 768P.`, 'bad_input');
  // The hold, the take and its job are created together, under a lock on the shot: no take without its credit or its
  // job, and two clicks (or a retry) at the same moment get the same take instead of buying two.
  const t = await begin(async (tx) => {
    await tx`select id from shots where id = ${shotId} for update`;
    const [busy] = await tx`select id, n from takes where shot_id = ${shotId} and status in ('pending','submitted','running') limit 1`;
    if (busy) return { ...busy, already_running: true };
    const held = await debit(tx, s.owner_id, sellPrice(resolution, s.duration), 'render_hold', shotId, s.api_key_id);
    const [row] = await tx`insert into takes (project_id, shot_id, n, resolution, status, hold_usd)
      values (${s.project_id}, ${shotId}, coalesce((select max(n) from takes where shot_id = ${shotId}), 0) + 1, ${resolution}, 'pending', ${held}) returning id, n`;
    await tx`update shots set status = 'queued', error = null, updated_at = now() where id = ${shotId}`;
    await enqueue('take.submit', { takeId: row.id }, { projectId: s.project_id, maxAttempts: 5, tx });
    return row;
  });
  if (t.already_running) return { take_id: t.id, already_running: true };
  await kickCapacity(); // new work: GPUs start warming now, not at the controller's next tick
  return { take_id: t.id, n: t.n };
}

/** Build the exact H3 body for a take. Media is referenced by URL when MiniMax can reach our files, otherwise inlined. */
export async function buildRequest(shot: any, resolution: string) {
  const [p] = await sql`select * from projects where id = ${shot.project_id}`;
  const media = async (key: string) => {
    const mode = config.minimax.mediaMode;
    if (mode !== 'inline') { const u = await storage.providerUrl(key); if (u) return u; if (mode === 'url') throw new PermanentError('MINIMAX_MEDIA_MODE=url but files are not reachable from the internet (set PUBLIC_BASE_URL or use S3 storage).', 'config'); }
    return storage.dataUri(key);
  };
  if (p.mode === 'clip') return { ...(await buildClipRequest(p, shot, media)), provider: providerFor(p), mode: p.mode };

  const scene = shot.scene_id ? (await sql`select * from scenes where id = ${shot.scene_id}`)[0] : null;
  const A = await projectAssets(p.id);

  // Continuity: pass the previous approved clip of the same scene as a reference video (off unless CHAIN_CLIPS=1:
  // its seconds are billed as input on every render).
  let prev: any = null;
  if (config.minimax.chainClips && shot.chain_prev && p.settings?.chain_clips) {
    [prev] = await sql`select t.file_key, t.media from shots s join takes t on t.id = s.approved_take_id
      where s.scene_id = ${shot.scene_id} and s.idx = ${shot.idx - 1} and s.status = 'approved'`;
  }
  const chainNote = prev ? 'Reference video 1 is the shot that plays just before this one: match its colour grade, lighting, lens feel and where everyone is standing, then continue from it.' : null;
  const input = compileInputFor(shot, scene, p, A, chainNote);
  let c: ReturnType<typeof compileShot>;
  try { c = compileShot(input); } catch (e) { if (e instanceof PromptTooLong) throw new PermanentError(e.message, e.code); throw e; }
  const prompt = shot.prompt_locked && shot.prompt ? shot.prompt : c.prompt;

  const content: H3Content[] = [{ type: 'text', text: prompt }];
  const refs: any[] = [];
  for (const a of c.images) { content.push({ type: 'image_url', image_url: { url: await media(a.file_key!) }, role: 'reference_image' }); refs.push({ role: 'reference_image', asset: a.key }); }
  let videoNote: string | null = null;
  if (prev?.file_key) {
    const secs = +(prev.media?.duration || 0);
    if (secs >= 2 && secs <= 15) {
      content.push({ type: 'video_url', video_url: { url: await media(prev.file_key) }, role: 'reference_video' });
      refs.push({ role: 'reference_video', take_file: prev.file_key, seconds: secs });
    } else videoNote = `previous clip not used as reference (${secs}s is outside 2–15s)`;
  }
  // Voices only when there is at least one visual reference (H3 rejects audio on its own).
  if (c.images.length || prev) for (const v of c.voices) { content.push({ type: 'audio_url', audio_url: { url: await media(v.file_key!) }, role: 'reference_audio' }); refs.push({ role: 'reference_audio', asset: v.key }); }

  const body: H3Request = { model: config.minimax.videoModel, content, resolution: resolution as any, duration: shot.duration, ratio: p.aspect };
  validateH3(body);
  const bytes = JSON.stringify(body).length;
  if (bytes > 60 * 1024 * 1024) throw new PermanentError(`Request is ${(bytes / 1048576).toFixed(1)} MB, over MiniMax's 64 MB limit. Use S3 storage or PUBLIC_BASE_URL so media is sent by URL.`, 'too_large');
  const loggable = { model: body.model, resolution: body.resolution, duration: body.duration, ratio: body.ratio, prompt, refs, warnings: [...c.warnings, ...(videoNote ? [videoNote] : [])], bytes };
  return { body, loggable, owner: p.owner_id, provider: providerFor(p), mode: p.mode };
}

export async function submitTake(takeId: string): Promise<any | Again> {
  let [t] = await sql`select * from takes where id = ${takeId}`;
  // A claim without a provider task is an earlier try of this job that stopped half way: give the slot back and go again.
  if (t?.status === 'submitted' && !t.provider_task_id) [t] = await sql`update takes set status = 'pending', submitted_at = null where id = ${takeId} returning *`;
  if (!t || t.status !== 'pending') return { skipped: t?.status };
  const [shot] = await sql`select s.*, e.idx episode_idx from shots s join episodes e on e.id = s.episode_id where s.id = ${t.shot_id}`;
  // The checks and the claim happen under one lock, so two clips finishing their checks at the same moment can't both
  // take the last slot: the limits (all renders, the customer's 4, the film's story order) hold exactly.
  const wait = await begin(async (tx): Promise<Again | null> => {
    await tx`select pg_advisory_xact_lock(724001)`;
    const [{ active }] = await tx`select count(*)::int active from takes where status in ('submitted','running')`;
    if (active >= config.minimax.maxConcurrentVideo) return { again: 15, progress: `waiting for a render slot (${active} running)` };
    const [{ mine }] = await tx`select count(*)::int mine from takes t join projects p on p.id = t.project_id
      where t.status in ('submitted','running') and p.owner_id = (select owner_id from projects where id = ${t.project_id})`;
    if (mine >= config.minimax.maxConcurrentPerUser) return { again: 15, progress: `waiting for one of your ${mine} renders to finish` }; // startNext wakes it sooner
    // Story order: this clip waits while the project has its clips rendering, or earlier clips still waiting to start.
    const [{ busy, ahead }] = await tx`select count(*) filter (where t.status in ('submitted','running'))::int busy,
        count(*) filter (where t.status = 'pending' and t.id <> ${takeId} and (e.idx, s.idx, t.created_at) < (${shot.episode_idx}::int, ${shot.idx}::int, ${t.created_at}::timestamptz))::int ahead
      from takes t join shots s on s.id = t.shot_id join episodes e on e.id = s.episode_id where t.project_id = ${t.project_id}`;
    // Strictly in story order: a clip starts only once every clip before it has started, and only while the project
    // has a slot free. With many render slots working at once, this keeps the order exact; each start wakes the next
    // clip at once (startNext), so the line moves without waiting for anyone's next check. Clips far back in a long
    // film's line check less often.
    if (ahead > 0 || busy >= config.minimax.maxConcurrentPerProject) return { again: Math.min(120, 10 + 2 * ahead), progress: ahead ? `waiting for the ${ahead} clip${ahead > 1 ? 's' : ''} before it` : 'waiting for the clip before it' };
    const [claimed] = await tx`update takes set status = 'submitted', submitted_at = clock_timestamp() where id = ${takeId} and status = 'pending' returning id`;
    return claimed ? null : { again: 0, progress: 'already started' };
  });
  if (wait) return wait;
  await startNext(t.project_id); // the next clip in line may start now
  /** The slot is given back when the clip can't be sent this time (it is tried again). */
  const unclaim = () => sql`update takes set status = 'pending', submitted_at = null where id = ${takeId} and status = 'submitted' and provider_task_id is null`;
  let built: Awaited<ReturnType<typeof buildRequest>>;
  try { built = await buildRequest(shot, t.resolution); } catch (e) { if (e instanceof PermanentError) await failTake(takeId, shot.id, e.message, e.code || 'bad_request'); else await unclaim(); throw e; }
  const { body, loggable, owner, provider } = built;
  // A prompt the customer wrote by hand goes straight to the video model: check it first. Clips too: their prompt can be
  // edited after creation through the shot API. Verdicts are cached by content, so an unchanged prompt isn't re-checked.
  if (shot.prompt_locked) {
    const text = (body.content.find((x) => x.type === 'text') as any)?.text || '';
    const v = await moderate({ ownerId: owner, projectId: shot.project_id, text });
    if (!v.allowed) { await failTake(takeId, shot.id, `Refused by the content check: ${v.reason}`, 'sensitive_content', loggable); return { blocked: v.category }; }
  }
  try {
    const taskId = await mm(provider).createVideoTask(body, { key: takeKey(t) });
    await sql`update takes set status = 'submitted', provider = ${provider}, provider_task_id = ${taskId}, request = ${sql.json(loggable)} where id = ${takeId}`;
    await sql`update shots set status = 'rendering', updated_at = now() where id = ${shot.id}`;
    await enqueue('take.poll', { takeId }, { projectId: t.project_id, delaySec: config.minimax.pollSeconds, maxAttempts: 8 });
    return { task_id: taskId };
  } catch (e: any) {
    if (e instanceof ProviderError && e.retryable) {
      await unclaim();
      if (e.code === 'rate_limited') return { again: 30, progress: 'MiniMax rate limit, retrying' };
      throw e; // network / 5xx: the queue retries with backoff
    }
    if (!(e instanceof ProviderError)) { await unclaim(); throw e; } // something unexpected: the queue retries it
    await failTake(takeId, shot.id, e.message, e.code || 'submit_failed', loggable);
    throw new PermanentError(e.message, e.code);
  }
}

export async function pollTake(takeId: string): Promise<any | Again> {
  const [t] = await sql`select * from takes where id = ${takeId}`;
  if (!t || !['submitted', 'running'].includes(t.status)) return { skipped: t?.status };
  const task = await mm(t.provider).queryVideoTask(t.provider_task_id); // the provider that took the job, not today's setting
  const age = (Date.now() - new Date(t.submitted_at).getTime()) / 60000;
  if (task.status === 'queued' || task.status === 'running' || task.status === 'processing' || task.status === 'preparing') {
    if (age > config.minimax.taskTimeoutMinutes) {
      await mm(t.provider).cancelVideoTask?.(t.provider_task_id); // stop paying for GPU time on a clip we've given up on
      await failTake(takeId, t.shot_id, `H3 task still ${task.status} after ${Math.round(age)} minutes`, 'timeout');
      return { timeout: true };
    }
    if (task.status === 'running' && t.status !== 'running') await sql`update takes set status = 'running' where id = ${takeId}`;
    return { again: config.minimax.pollSeconds, progress: `H3 ${task.status} (${Math.round(age * 60)}s)` };
  }
  if (task.status !== 'succeeded' || !task.url) {
    const why = task.error || `H3 task ${task.status}`;
    await failTake(takeId, t.shot_id, why, /sensitive|moderat|policy/i.test(why) ? 'sensitive_content' : task.status);
    return { failed: why };
  }

  // The provider has charged us from this point on, so record the spend once, even if our own copy step fails.
  const [shot] = await sql`select duration from shots where id = ${t.shot_id}`;
  const outSec = +(task.usage?.output_seconds ?? shot.duration);
  const inSec = +(task.usage?.input_seconds ?? 0);
  // RunPod reports GPU time (priced by RUNPOD_GPU_PRICE_PER_SECOND); otherwise estimate from list prices.
  // MiniMax also bills reference pictures past the first few of each request (its price list, November 2026).
  const extraImages = Math.max(0, +(task.usage?.input_image_count ?? 0) - config.pricing.freeInputImages);
  const cost = (task.usage as any)?.cost_usd || (config.mock ? 0 : costOf(t.resolution, outSec + inSec) + extraImages * config.pricing.inputImageEach);
  const [first] = await sql`update takes set seconds = ${outSec + inSec}, cost_usd = ${cost} where id = ${takeId} and cost_usd is null returning project_id`;
  if (first) {
    const [pr] = await sql`select owner_id from projects where id = ${t.project_id}`;
    await recordUsage({ ownerId: pr.owner_id, projectId: t.project_id, kind: 'video', units: outSec + inSec, cost, ref: takeId, estimated: task.usage?.output_seconds === undefined });
  }

  // Copy the video into our storage and check it is what we asked for.
  const key = takeKey(t);
  await downloadTo(key, task.url);
  const dir = await mkdtemp(join(tmpdir(), 'take-'));
  try {
    const local = await storage.toLocal(key, dir);
    await storage.record(key, (await stat(local)).size); // counts toward storage even when the worker uploaded it directly
    const info = await probe(local).catch((e) => { throw new PermanentError(`downloaded file is not a readable video: ${e.message}`, 'invalid_output'); });
    const [pr] = await sql`select aspect from projects where id = ${t.project_id}`;
    const { problems, fatal } = checkOutput(info, { seconds: shot.duration, aspect: pr?.aspect, resolution: t.resolution });
    const thumbKey = `projects/${t.project_id}/takes/${takeId}.jpg`;
    const thumbLocal = join(dir, 'thumb.jpg');
    if (info.width && info.height) {
      await thumbnail(local, thumbLocal, Math.min(0.4, Math.max(0, info.duration / 2)));
      await storage.putFile(thumbKey, thumbLocal, 'image/jpeg');
    }
    await sql`update takes set status = ${fatal ? 'failed' : 'succeeded'}, file_key = ${key}, thumb_key = ${info.width && info.height ? thumbKey : null}, media = ${sql.json({ ...info, problems })},
      error = ${problems.join('; ') || null}, error_code = ${fatal ? 'invalid_output' : null}, finished_at = now() where id = ${takeId}`;
    await settleTake(takeId, !fatal); // the customer only pays for a usable clip
    const [other] = fatal ? await sql`select 1 from takes where shot_id = ${t.shot_id} and status = 'succeeded' limit 1` : [];
    await sql`update shots set status = ${fatal && !other ? 'failed' : 'review'}, error = ${fatal ? `The video model's clip was unusable (${problems.join('; ')}); you were not charged.` : null}, updated_at = now() where id = ${t.shot_id} and status <> 'approved'`;
    await refreshEpisodeStatus(t.shot_id);
    await refreshClip(t.project_id);
    await startNext(t.project_id);
    return { file_key: key, problems };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/**
 * Is a finished clip what was ordered? A clip that is the wrong length, has no sound, is the wrong shape or is far
 * below the ordered size is not delivered and not charged: the customer pays for usable clips, and for every redo of
 * a usable clip they ask for, but never for a broken one.
 */
export function checkOutput(info: { width: number; height: number; duration: number; has_audio: boolean }, want: { seconds: number; aspect?: string | null; resolution?: string | null }) {
  const problems: string[] = [];
  let fatal = false;
  const bad = (p: string) => { problems.push(p); fatal = true; };
  if (!info.width || !info.height) { bad('no video stream'); return { problems, fatal }; }
  if (!(info.duration > 0) || Math.abs(info.duration - want.seconds) > Math.max(1, want.seconds * 0.15)) bad(`length ${(+info.duration || 0).toFixed(1)}s, asked for ${want.seconds}s`);
  if (!info.has_audio) bad('no audio track');
  const [aw, ah] = String(want.aspect || '').split(':').map(Number);
  if (aw && ah) {
    const got = info.width / info.height, asked = aw / ah;
    if (Math.abs(Math.log(got / asked)) > Math.log(1.12)) bad(`shape ${info.width}×${info.height}, asked for ${want.aspect}`);
  }
  const shortSide = Math.min(info.width, info.height);
  const minShort = want.resolution === '2K' ? 1000 : 600; // 768P is ~768 px on the short side; allow some slack
  if (shortSide < minShort) bad(`only ${info.width}×${info.height}, asked for ${want.resolution || '768P'}`);
  return { problems, fatal };
}

/**
 * The repair sweep (about once a minute). Fixes renders that lost their way when a process died between two steps:
 * a paid take waiting with no job to start it gets its job back, and a take that ended without settling its credit
 * (kept for a good clip, refunded otherwise) is settled.
 */
export async function repairRenders() {
  const orphans = await sql`select t.id, t.project_id from takes t
    where t.status = 'pending' and t.created_at < now() - interval '2 minutes'
      and not exists (select 1 from jobs j where j.kind = 'take.submit' and j.status in ('queued','running') and j.payload->>'takeId' = t.id::text)
    limit 200`;
  for (const o of orphans) {
    console.error(`[repair] take ${o.id} was waiting with no job: queued again`);
    await enqueue('take.submit', { takeId: o.id }, { projectId: o.project_id, maxAttempts: 5 });
  }
  const lost = await sql`select t.id, t.project_id from takes t
    where t.status in ('submitted','running') and t.provider_task_id is not null and t.submitted_at < now() - interval '2 minutes'
      and not exists (select 1 from jobs j where j.kind in ('take.poll','take.submit') and j.status in ('queued','running') and j.payload->>'takeId' = t.id::text)
    limit 200`;
  for (const o of lost) await enqueue('take.poll', { takeId: o.id }, { projectId: o.project_id, maxAttempts: 8 });
  const unsettled = await sql`select id, status from takes where not settled and status in ('succeeded','failed','rejected') and finished_at < now() - interval '2 minutes' limit 200`;
  for (const u of unsettled) await settleTake(u.id, u.status !== 'failed');
  // A clip that was created but never got its first take (the process died between the two steps): nothing was
  // charged and nothing will ever render, so say so instead of showing "rendering" for ever.
  const empty = await sql`update projects p set stage = 'failed', stage_error = 'This clip couldn’t be started. You weren’t charged. Please make it again.', updated_at = now()
    where p.mode = 'clip' and p.stage = 'rendering' and p.created_at < now() - interval '10 minutes'
      and not exists (select 1 from takes t where t.project_id = p.id) returning p.id`;
  for (const e of empty) await projectEvent({ projectId: e.id, stage: 'failed' });
}

async function failTake(takeId: string, shotId: string, error: string, code: string, request?: any) {
  await sql`update takes set status = 'failed', error = ${error.slice(0, 1000)}, error_code = ${code}, finished_at = now()
    ${request ? sql`, request = ${sql.json(request)}` : sql``} where id = ${takeId}`;
  await settleTake(takeId, false);
  const [other] = await sql`select 1 from takes where shot_id = ${shotId} and status = 'succeeded' limit 1`;
  const [s] = await sql`update shots set status = ${other ? 'review' : code === 'sensitive_content' ? 'blocked' : 'failed'}, error = ${error.slice(0, 500)}, updated_at = now()
    where id = ${shotId} and status <> 'approved' returning project_id`;
  const [tk] = await sql`select project_id from takes where id = ${takeId}`;
  if (s) await refreshClip(s.project_id);
  if (tk) await startNext(tk.project_id);
}

/** A clip finished: the project's next waiting clip starts now rather than at its next check. */
/** A render slot freed up: wake the owner's next few waiting clips (oldest first, so a film keeps its story order). */
async function startNext(projectId: string) {
  // This project's next clips first (its line is strictly ordered), then the owner's other waiting clips.
  await sql`update jobs set run_after = now() where id in (
    (select j.id from jobs j where j.kind = 'take.submit' and j.status = 'queued' and j.run_after > now() and j.project_id = ${projectId}
      order by j.id limit 4)
    union
    (select j.id from jobs j join projects p on p.id = j.project_id
      where j.kind = 'take.submit' and j.status = 'queued' and j.run_after > now()
        and p.owner_id = (select owner_id from projects where id = ${projectId})
      order by j.id limit ${config.minimax.maxConcurrentPerUser * 2}))`;
}

export async function refreshEpisodeStatus(shotId: string) {
  const [s] = await sql`select episode_id from shots where id = ${shotId}`;
  if (!s) return;
  const [c] = await sql`select count(*)::int total, count(*) filter (where status = 'approved')::int approved,
    count(*) filter (where status in ('queued','rendering'))::int busy from shots where episode_id = ${s.episode_id}`;
  const status = c.total && c.approved === c.total ? 'approved' : c.busy ? 'rendering' : 'review';
  await sql`update episodes set status = ${status}, updated_at = now() where id = ${s.episode_id} and status <> 'assembled'`;
}

export async function takeFailedHook(p: any) {
  const [t] = await sql`select * from takes where id = ${p.takeId}`;
  if (t && ['pending', 'submitted', 'running'].includes(t.status)) await failTake(t.id, t.shot_id, 'render job gave up after repeated errors', 'job_failed');
}

/**
 * The customer's own video for a shot (step by step): checked like any upload, made 24 fps H.264 of at most 15 s, kept
 * as a new take and used for the shot. Nothing is generated, so nothing is charged.
 */
export async function uploadTake(shotId: string, data: Buffer, uid: string, consent: boolean) {
  const [s] = await sql`select s.* from shots s join projects p on p.id = s.project_id where s.id = ${shotId} and p.owner_id = ${uid}`;
  if (!s) throw new PermanentError('shot not found', 'not_found');
  if (!consent) throw new PermanentError('Confirm that you own this video and that everyone in it agreed to be in your film.', 'consent_required');
  const [busy] = await sql`select id from takes where shot_id = ${shotId} and status in ('pending','submitted','running') limit 1`;
  if (busy) throw new PermanentError('This shot is being filmed right now. Upload your video once it finishes.', 'bad_state');
  const dir = await mkdtemp(join(tmpdir(), 'uptake-'));
  try {
    const v = await withMediaSlot(() => prepVideo(data, dir));
    const verdict = await moderate({ ownerId: uid, projectId: s.project_id, text: 'A video the customer uploaded to use as one shot of their film.', images: v.frames.map(jpeg) });
    if (!verdict.allowed) throw refusal(verdict);
    const info = await probe(v.file);
    const [t] = await sql`insert into takes (project_id, shot_id, n, provider, status, resolution, seconds, cost_usd, settled, request, submitted_at)
      values (${s.project_id}, ${shotId}, coalesce((select max(n) from takes where shot_id = ${shotId}), 0) + 1, 'upload', 'running', '768P', 0, 0, true,
              ${sql.json({ source: 'upload', consent: { by: uid, at: new Date().toISOString() } })}, now()) returning *`;
    const key = takeKey(t), thumbKey = `projects/${t.project_id}/takes/${t.id}.jpg`, thumbLocal = join(dir, 'thumb.jpg');
    await storage.putFile(key, v.file, 'video/mp4');
    await thumbnail(v.file, thumbLocal, 0.4);
    await storage.putFile(thumbKey, thumbLocal, 'image/jpeg');
    const problems = info.has_audio ? [] : ['no audio track'];
    await sql`update takes set status = 'succeeded', file_key = ${key}, thumb_key = ${thumbKey}, media = ${sql.json({ ...info, problems, uploaded: true } as any)},
      error = ${problems.join('; ') || null}, finished_at = now() where id = ${t.id}`;
    await sql`update shots set status = 'approved', approved_take_id = ${t.id}, error = null, updated_at = now() where id = ${shotId}`;
    await refreshEpisodeStatus(shotId);
    return { take_id: t.id, n: t.n, seconds: info.duration };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
