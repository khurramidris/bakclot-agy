// Quick clips: text → video, image → video, references (people, products, places, a voice) → video, and remixing a
// short video. A clip is a project with mode 'clip' holding one episode and one shot, so renders, credit holds,
// refunds, retakes, cancel-on-delete and storage accounting work exactly as they do for film shots. What the customer
// typed and uploaded is kept in projects.brief; uploads are normalised with FFmpeg and checked before anything is
// stored or charged.

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { PermanentError } from '../queue.js';
import { requireCredit, sellPrice } from '../billing.js';
import { ffmpeg, probe, trimAudio, isUpload, imageSize, safeInput, withMediaSlot, MAX_IMAGE_PIXELS, MAX_VIDEO_SIDE } from '../media/ffmpeg.js';
import { moderate, refusal } from '../moderation.js';
import type { H3Content, H3Request } from '../providers/minimax.js';
import { validateH3 } from './compiler.js';
import { projectEvent } from '../events.js';

export const CLIP_MODES = ['text', 'image', 'reference', 'remix'] as const;
export type ClipMode = (typeof CLIP_MODES)[number];
export const CLIP_ASPECTS = ['9:16', '16:9', '1:1'];
type Role = 'first_frame' | 'reference_image' | 'reference_video' | 'reference_audio';
export interface ClipInput { role: Role; key: string; label?: string; seconds?: number }
export interface ClipBrief {
  kind: 'clip'; mode: ClipMode; prompt: string; seconds: number; aspect: string; inputs: ClipInput[];
  consent?: { by: string; at: string };
}
export interface Upload { name: string; type: string; data: Buffer }
export interface ClipForm {
  mode: string; prompt: string; seconds: number; aspect: string; consent: boolean;
  images: Upload[]; labels: string[]; video?: Upload; audio?: Upload; audioLabel?: string;
}

const MB = 1024 * 1024;
const bad = (msg: string) => new PermanentError(msg, 'bad_input');
const label = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

function checkPrompt(prompt: string) {
  if (prompt.length < 3) throw bad('Describe the video you want (at least a few words).');
  if (prompt.length > 2000) throw bad('Keep the description under 2,000 characters.');
}
function checkSeconds(seconds: number) {
  const { minSeconds, maxSeconds } = config.clips;
  if (!Number.isInteger(seconds) || seconds < minSeconds || seconds > maxSeconds) throw bad(`Length must be a whole number of seconds from ${minSeconds} to ${maxSeconds}.`);
}

/** Every rule a clip request has to meet, checked before any work. */
export function checkClipForm(f: ClipForm) {
  if (!CLIP_MODES.includes(f.mode as ClipMode)) throw bad(`mode must be one of ${CLIP_MODES.join(', ')}`);
  checkPrompt(String(f.prompt || '').trim());
  checkSeconds(f.seconds);
  if (!CLIP_ASPECTS.includes(f.aspect)) throw bad(`aspect must be one of ${CLIP_ASPECTS.join(', ')}`);
  const n = f.images.length;
  const rules: Record<ClipMode, [boolean, string]> = {
    text: [n === 0 && !f.video && !f.audio, 'Text to video takes no uploads.'],
    image: [n === 1 && !f.video && !f.audio, 'Image to video takes exactly one picture.'],
    reference: [n >= 1 && n <= 9 && !f.video, 'Add one to nine pictures (and optionally one voice clip).'],
    remix: [!!f.video && n <= 8, 'Add one video to remix (and optionally up to eight pictures).'],
  };
  const [ok, why] = rules[f.mode as ClipMode];
  if (!ok) throw bad(why);
  for (const im of f.images) if (im.data.length > 20 * MB) throw bad(`${im.name || 'A picture'} is over 20 MB.`);
  if (f.video && f.video.data.length > 100 * MB) throw bad('The video is over 100 MB. Trim it to 15 seconds or less.');
  if (f.audio && f.audio.data.length > 25 * MB) throw bad('The voice clip is over 25 MB.');
  if ((n || f.video || f.audio) && !f.consent) {
    throw Object.assign(new PermanentError('Confirm you have the right to use these files, including permission from anyone shown or heard in them.', 'consent_required'), { status: 400 });
  }
}

/** "image 2" / "picture 2" / "video 1" / "voice 1" in a customer's prompt → the wording the H3 request uses. */
export function normalizeRefs(text: string) {
  return text
    // The model's own tags, which developers copy from its guide: <Picture 2>, <Image 2>, <Video 1>, <Audio 1>.
    .replace(/<\s*(?:picture|image)\s*(\d)\s*>/gi, 'reference image $1')
    .replace(/<\s*video\s*(\d)\s*>/gi, 'reference video $1')
    .replace(/<\s*(?:audio|voice)\s*(\d)\s*>/gi, 'reference audio $1')
    .replace(/(?<!reference\s)\b(?:image|picture|photo|pic|img)\s*#?\s*(\d)\b/gi, 'reference image $1')
    .replace(/(?<!reference\s)\b(?:video|clip)\s*#?\s*1\b/gi, 'reference video 1')
    .replace(/(?<!reference\s)\b(?:audio|voice)\s*#?\s*(\d)\b/gi, 'reference audio $1');
}

/** A clip's title: the start of its prompt, cut at a word. */
export function clipTitle(prompt: string, max = 60) {
  const text = prompt.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max);
  const cut = space >= max / 2 ? text.slice(0, space) : text.slice(0, max);
  return `${cut.replace(/[\s,;:.!?-]+$/, '')}…`;
}

/** The H3 prompt for a clip: what each reference is, then the customer's words. */
export function clipPrompt(b: Pick<ClipBrief, 'prompt' | 'inputs'>) {
  const lines: string[] = [];
  const images = b.inputs.filter((i) => i.role === 'reference_image');
  if (b.inputs.some((i) => i.role === 'reference_video')) lines.push('Reference video 1 is the source clip to remix.');
  const named = images.map((im, n) => (im.label ? `reference image ${n + 1} is ${im.label}` : '')).filter(Boolean);
  if (named.length) lines.push(`References: ${named.join('; ')}.`);
  const voice = b.inputs.find((i) => i.role === 'reference_audio');
  if (voice) lines.push(voice.label ? `${voice.label} speaks with the voice in reference audio 1.` : 'Speech uses the voice in reference audio 1.');
  lines.push(normalizeRefs(b.prompt.trim()));
  return lines.join('\n');
}

// ───────── media ─────────

/** A picture as a JPEG of at most 2048 px (re-encoding also drops metadata such as GPS), plus a small copy for the check. */
export async function prepImage(data: Buffer, dir: string, name: string) {
  const unreadable = bad('One of the pictures couldn’t be read. Use a JPEG, PNG or WebP.');
  if (!isUpload('image', data)) throw unreadable; // not a picture at all: FFmpeg never sees it
  const head = imageSize(data); // a picture that would decode to gigabytes is refused before anything decodes it
  if (head && head.width * head.height > MAX_IMAGE_PIXELS) throw bad('That picture is too large. Use one of up to 50 megapixels.');
  const raw = join(dir, `${name}.in`);
  await writeFile(raw, data);
  const info = await probe(raw, 'image').catch(() => null);
  if (!info?.width || !info.height) throw unreadable;
  if (info.width * info.height > MAX_IMAGE_PIXELS) throw bad('That picture is too large. Use one of up to 50 megapixels.');
  if (Math.min(info.width, info.height) < 300) throw bad('Pictures need to be at least 300 pixels on their shorter side.');
  const r = info.width / info.height;
  if (r < 0.4 || r > 2.5) throw bad('Pictures need a shape between 2:5 (tall) and 5:2 (wide).');
  const file = join(dir, `${name}.jpg`), small = join(dir, `${name}.small.jpg`);
  await ffmpeg([...safeInput('image', raw), '-vf', "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '2', file], { timeoutMs: 60_000 }).catch(() => { throw unreadable; });
  await ffmpeg(['-i', file, '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '4', small]);
  return { file, small: await readFile(small) };
}

/** A video as 24 fps H.264 MP4 of at most 15 s and 1280 px, plus three frames for the check. */
export async function prepVideo(data: Buffer, dir: string) {
  const unreadable = bad('The video couldn’t be read. Use an MP4 or MOV file.');
  if (!isUpload('video', data)) throw unreadable;
  const raw = join(dir, 'video.in');
  await writeFile(raw, data);
  const info = await probe(raw, 'video').catch(() => null);
  if (!info?.width || !info.duration) throw unreadable;
  if (Math.min(info.width, info.height) > MAX_VIDEO_SIDE || info.width * info.height > 8192 * 4320) throw bad('That video’s picture is too large. Use one of up to 8K.');
  if (info.duration < 2) throw bad('The video needs to be at least 2 seconds long.');
  const file = join(dir, 'video.mp4');
  await ffmpeg([...safeInput('video', raw), '-t', '15', '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', file], { timeoutMs: 5 * 60_000 })
    .catch(() => { throw unreadable; });
  return { file, seconds: +Math.min(info.duration, 15).toFixed(2), frames: await framesOf(file, dir, Math.min(info.duration, 15)) };
}

async function framesOf(video: string, dir: string, seconds: number) {
  const out: Buffer[] = [];
  for (const [i, at] of [0.1, 0.5, 0.9].entries()) {
    const f = join(dir, `frame${i}.jpg`);
    await ffmpeg(['-ss', (seconds * at).toFixed(2), '-i', video, '-frames:v', '1', '-vf', "scale='min(768,iw)':-2", '-q:v', '4', f]);
    out.push(await readFile(f));
  }
  return out;
}

/** A voice or music file as a mono MP3 of at most `maxSec` seconds. */
export async function prepAudio(data: Buffer, dir: string, maxSec = 14, what = 'The voice clip') {
  const unreadable = bad(`${what} couldn’t be read. Use an MP3, WAV or M4A file.`);
  if (!isUpload('audio', data)) throw unreadable;
  const raw = join(dir, 'voice.in');
  await writeFile(raw, data);
  const info = await probe(raw, 'audio').catch(() => null);
  if (!info?.acodec || !(info.duration > 0)) throw unreadable;
  const file = join(dir, 'voice.mp3');
  await trimAudio(raw, file, maxSec, true).catch(() => { throw unreadable; });
  return { file };
}

export const jpeg = (data: Buffer) => ({ mime: 'image/jpeg', data });

// ───────── create, retake, status ─────────

/** What the public API adds to a clip: the key that made it, where to send the webhook, and the caller's own metadata. */
export interface ApiOrigin { keyId: string; webhookUrl?: string | null; metadata?: Record<string, unknown> | null }

/**
 * Check the request, store the inputs, create the clip and queue its first render. The render is charged as it starts.
 * `api` marks a clip made through the public API (it is then kept out of the app's lists and storage allowance).
 */
export async function createClip(uid: string, f: ClipForm, api?: ApiOrigin) {
  checkClipForm(f);
  const seconds = f.seconds, prompt = f.prompt.trim();
  await requireCredit(uid, sellPrice('768P', seconds));
  const dir = await mkdtemp(join(tmpdir(), 'clip-'));
  try {
    // Decoding uploads is memory-hungry: a few requests at a time (withMediaSlot), the rest wait their turn.
    const { images, video, audio } = await withMediaSlot(async () => {
      const images: Awaited<ReturnType<typeof prepImage>>[] = [];
      for (const [i, im] of f.images.entries()) images.push(await prepImage(im.data, dir, `image${i + 1}`));
      return { images, video: f.video ? await prepVideo(f.video.data, dir) : null, audio: f.audio ? await prepAudio(f.audio.data, dir) : null };
    });

    const id = randomUUID();
    const inputs: ClipInput[] = [];
    const files: { key: string; file: string }[] = [];
    images.forEach((im, i) => {
      const key = `projects/${id}/inputs/image-${i + 1}.jpg`;
      inputs.push({ role: f.mode === 'image' ? 'first_frame' : 'reference_image', key, ...(label(f.labels[i]) ? { label: label(f.labels[i]) } : {}) });
      files.push({ key, file: im.file });
    });
    if (video) { const key = `projects/${id}/inputs/video.mp4`; inputs.push({ role: 'reference_video', key, seconds: video.seconds }); files.push({ key, file: video.file }); }
    if (audio) { const key = `projects/${id}/inputs/voice.mp3`; inputs.push({ role: 'reference_audio', key, ...(label(f.audioLabel) ? { label: label(f.audioLabel) } : {}) }); files.push({ key, file: audio.file }); }

    const brief: ClipBrief = { kind: 'clip', mode: f.mode as ClipMode, prompt, seconds, aspect: f.aspect, inputs,
      ...(files.length ? { consent: { by: uid, at: new Date().toISOString() } } : {}) };
    const verdict = await moderate({ ownerId: uid, text: checkText(brief), images: [...images.map((im) => jpeg(im.small)), ...(video?.frames || []).map(jpeg)] });
    if (!verdict.allowed) throw refusal(verdict);

    const title = clipTitle(prompt);
    const shotId = await begin(async (tx) => {
      await tx`insert into projects (id, owner_id, title, format, aspect, resolution, language, mode, stage, brief, origin, api_key_id, webhook_url, api_metadata)
        values (${id}, ${uid}, ${title}, 'clip', ${f.aspect}, '768P', 'English', 'clip', 'rendering', ${tx.json(brief as any)},
                ${api ? 'api' : 'app'}, ${api?.keyId ?? null}, ${api?.webhookUrl ?? null}, ${api?.metadata ? tx.json(api.metadata as any) : null})`;
      const [ep] = await tx`insert into episodes (project_id, idx, label, title) values (${id}, 1, 'Clip', ${title}) returning id`;
      const [s] = await tx`insert into shots (project_id, episode_id, idx, code, duration, prompt, prompt_locked)
        values (${id}, ${ep.id}, 1, '1', ${seconds}, ${clipPrompt(brief)}, true) returning id`;
      return s.id as string;
    });
    try {
      for (const x of files) await storage.putFile(x.key, x.file);
      const { queueRender } = await import('./render.js');
      await queueRender(shotId);
    } catch (e) { // nothing usable was made: leave no half-created clip behind
      await storage.delProject(id).catch(() => {});
      await sql`delete from projects where id = ${id}`;
      throw e;
    }
    const [p] = await sql`select * from projects where id = ${id}`;
    return p;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** What the content check reads: the mode, what each upload is called, and the prompt. */
const checkText = (b: ClipBrief) => [
  `Mode: ${{ text: 'text to video', image: 'animate the attached picture', reference: 'video using the attached pictures as references', remix: 'remix the attached video (frames shown)' }[b.mode]}.`,
  ...b.inputs.filter((i) => i.label).map((i) => `${i.role.replace('_', ' ')} labelled: ${i.label}`),
  `Prompt: ${b.prompt}`,
].join('\n');

/** Another version of a clip, optionally with a new prompt or length. Charged like the first. */
export async function retakeClip(p: any, o: { prompt?: unknown; seconds?: unknown }) {
  if (p.mode !== 'clip') throw new PermanentError('This is not a clip.', 'bad_state');
  const [shot] = await sql`select * from shots where project_id = ${p.id} order by idx limit 1`;
  const [busy] = await sql`select id from takes where shot_id = ${shot.id} and status in ('pending','submitted','running') limit 1`;
  if (busy) return { take_id: busy.id, already_running: true };
  let brief: ClipBrief = p.brief;
  let seconds = shot.duration;
  if (o.seconds !== undefined && o.seconds !== null && o.seconds !== '') seconds = Number(o.seconds);
  const prompt = typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt.trim() : brief.prompt;
  checkPrompt(prompt);
  checkSeconds(seconds);
  await requireCredit(p.owner_id, sellPrice('768P', seconds));
  if (prompt !== brief.prompt) { // a new prompt is checked together with the pictures it will be used with
    brief = { ...brief, prompt };
    const verdict = await moderate({ ownerId: p.owner_id, projectId: p.id, text: checkText(brief), images: await storedImages(brief) });
    if (!verdict.allowed) throw refusal(verdict);
  }
  await sql`update projects set brief = ${sql.json(brief as any)}, stage = 'rendering', stage_error = null, updated_at = now() where id = ${p.id}`;
  await sql`update shots set prompt = ${clipPrompt(brief)}, duration = ${seconds}, status = 'planned', updated_at = now() where id = ${shot.id}`;
  const { queueRender } = await import('./render.js');
  try { return await queueRender(shot.id); } finally { await refreshClip(p.id); }
}

/** The pictures (and three frames of the video) a clip was made with, small, for a fresh content check. */
async function storedImages(b: ClipBrief) {
  const dir = await mkdtemp(join(tmpdir(), 'clipcheck-'));
  try {
    const out: { mime: string; data: Buffer }[] = [];
    for (const [i, x] of b.inputs.entries()) {
      if (x.role === 'reference_audio') continue;
      const local = await storage.toLocal(x.key, dir);
      if (x.role === 'reference_video') { out.push(...(await framesOf(local, dir, x.seconds || 5)).map(jpeg)); continue; }
      const small = join(dir, `check${i}.jpg`);
      await ffmpeg(['-i', local, '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease", '-frames:v', '1', '-q:v', '4', small]);
      out.push(jpeg(await readFile(small)));
    }
    return out;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The H3 request for a clip: the stored prompt and every input in the order it was uploaded. */
export async function buildClipRequest(p: any, shot: any, media: (key: string) => Promise<string>) {
  const b: ClipBrief = p.brief;
  const content: H3Content[] = [{ type: 'text', text: shot.prompt }];
  for (const i of b.inputs) {
    const url = await media(i.key);
    if (i.role === 'reference_video') content.push({ type: 'video_url', video_url: { url }, role: 'reference_video' });
    else if (i.role === 'reference_audio') content.push({ type: 'audio_url', audio_url: { url }, role: 'reference_audio' });
    else content.push({ type: 'image_url', image_url: { url }, role: i.role });
  }
  const body: H3Request = { model: config.minimax.videoModel, content, resolution: '768P', duration: shot.duration, ratio: p.aspect };
  validateH3(body);
  const loggable = { model: body.model, resolution: body.resolution, duration: body.duration, ratio: body.ratio, prompt: shot.prompt,
    refs: b.inputs.map((i) => ({ role: i.role, key: i.key })), warnings: [], bytes: JSON.stringify(body).length };
  return { body, loggable, owner: p.owner_id };
}

/** Which service renders a project's video: image-to-video clips can go to another provider (CLIP_IMAGE_PROVIDER). */
export const providerFor = (p: any): 'minimax' | 'runpod' =>
  (p.mode === 'clip' && p.brief?.mode === 'image' && config.clips.imageProvider) || config.videoProvider;

/** A clip's stage follows its takes: rendering while one is in flight, done once any version worked, else failed. */
export async function refreshClip(projectId: string) {
  const [p] = await sql`select mode from projects where id = ${projectId}`;
  if (p?.mode !== 'clip') return;
  const [latest] = await sql`select status, error, error_code from takes where project_id = ${projectId} order by created_at desc limit 1`;
  const [good] = await sql`select 1 from takes where project_id = ${projectId} and status = 'succeeded' limit 1`;
  const busy = latest && ['pending', 'submitted', 'running'].includes(latest.status);
  const stage = busy ? 'rendering' : good ? 'done' : 'failed';
  const why = latest?.status === 'failed'
    ? (latest.error_code === 'sensitive_content' ? 'This version was refused by the content check. You weren’t charged.' : 'This version failed to render. You weren’t charged.')
    : null;
  const [was] = await sql`select stage from projects where id = ${projectId}`;
  await sql`update projects set stage = ${stage}, stage_error = ${busy ? null : why}, updated_at = now() where id = ${projectId}`;
  // The clip just reached its final state: tell whoever is listening (the public API sends its webhook and sets the expiry).
  if (!busy && was?.stage !== stage) await projectEvent({ projectId, stage: stage as 'done' | 'failed' });
}
