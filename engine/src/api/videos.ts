// Videos through the API: one clip of 5 to 15 seconds from text, a first frame, reference pictures and a voice, or a
// video to remix. A thin layer over the app's own clip pipeline (pipeline/clips.ts): the same checks, the same content
// check, the same hold, render, refund and storage. Only how the files arrive is different: by URL or data URI.

import { sql } from '../db.js';
import { sellPrice } from '../billing.js';
import { createClip, type Upload } from '../pipeline/clips.js';
import { deleteProject } from '../pipeline/projects.js';
import { sniff } from '../media/ffmpeg.js';
import { invalid, notFound } from './errors.js';
import { checkPublicHost, checkUrl, fetchMedia, FetchError } from './net.js';
import { VideoCreate, type VideoCreateInput } from './schemas.js';
import { checkAccess, recordRefusal, type ApiCaller } from './access.js';
import { videoById, videoObject, videoRows } from './views.js';

const MB = 1024 * 1024;
export const MEDIA_LIMITS = { image: 20 * MB, video: 100 * MB, audio: 25 * MB };

/** Which kind of clip the inputs ask for, with a clear 400 for combinations that can't be made. */
export function inferMode(b: Pick<VideoCreateInput, 'first_frame' | 'images' | 'video' | 'audio'>): 'text' | 'image' | 'reference' | 'remix' {
  const images = b.images?.length || 0;
  if (b.first_frame) {
    if (images || b.video || b.audio) throw invalid('first_frame (image to video) can’t be combined with images, video or audio.', 'first_frame');
    return 'image';
  }
  if (b.video) {
    if (b.audio) throw invalid('A remix takes a video and up to 8 pictures, not a voice.', 'audio');
    if (images > 8) throw invalid('A remix takes up to 8 pictures with its video.', 'images');
    return 'remix';
  }
  if (b.audio && !images) throw invalid('A voice needs at least one picture to go with it.', 'audio');
  return images ? 'reference' : 'text';
}

/** A webhook URL must be https and on the public internet, now and at every delivery. */
export async function checkWebhookUrl(url?: string | null): Promise<string | null> {
  if (!url) return null;
  try { const u = checkUrl(url); await checkPublicHost(u); return u.toString(); } catch (e: any) { throw invalid(`webhook_url: ${e.message}`, 'webhook_url'); }
}

async function download(spec: string, kind: keyof typeof MEDIA_LIMITS, param: string): Promise<Buffer> {
  try { return await fetchMedia(spec, MEDIA_LIMITS[kind]); } catch (e) {
    if (e instanceof FetchError) throw invalid(`${param}: ${e.message}`, param, e.code === 'too_large' ? 'file_too_large' : 'media_unavailable');
    throw e;
  }
}
const MIME: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac' };
const upload = (data: Buffer, name: string): Upload => ({ name, type: MIME[sniff(data) ?? ''] || 'application/octet-stream', data });

export async function createVideo(who: ApiCaller, raw: unknown) {
  const b = VideoCreate.parse(raw);
  const mode = inferMode(b);
  if (mode !== 'text' && b.rights_confirmed !== true) {
    throw invalid('Send rights_confirmed: true to confirm you have the rights to these files, including the permission of anyone shown or heard in them.', 'rights_confirmed');
  }
  const webhookUrl = await checkWebhookUrl(b.webhook_url);
  await checkAccess(who, { cost: sellPrice('768P', b.duration), kind: 'video' });
  // Everything is fetched at once, each file with its own size cap and deadline.
  const pics = mode === 'image' ? [{ url: b.first_frame!.url, label: undefined as string | undefined, param: 'first_frame.url' }]
    : (b.images || []).map((im, i) => ({ url: im.url, label: im.label, param: `images[${i}].url` }));
  const [images, video, audio] = await Promise.all([
    Promise.all(pics.map((p) => download(p.url, 'image', p.param))),
    b.video ? download(b.video.url, 'video', 'video.url') : null,
    b.audio ? download(b.audio.url, 'audio', 'audio.url') : null,
  ]);
  try {
    return await createClip(who.uid, {
      mode, prompt: b.prompt, seconds: b.duration, aspect: b.aspect_ratio, consent: mode !== 'text',
      images: images.map((d, i) => upload(d, `image-${i + 1}`)), labels: pics.map((p) => p.label || ''),
      video: video ? upload(video, 'video') : undefined, audio: audio ? upload(audio, 'voice') : undefined, audioLabel: b.audio?.label,
    }, { keyId: who.keyId, webhookUrl, metadata: b.metadata ?? null });
  } catch (e: any) {
    if (e?.code === 'sensitive_content') await recordRefusal(who.uid, e.category || 'other');
    throw e;
  }
}

/** A page of videos, newest first. `starting_after` is the id of the last video of the previous page. */
export async function listVideos(who: ApiCaller, q: { limit?: string; starting_after?: string }) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  let cursor = sql`true`;
  if (q.starting_after) {
    const [c] = await sql`select created_at, id from projects where id = ${q.starting_after} and owner_id = ${who.uid} and origin = 'api'`;
    if (!c) throw invalid('starting_after must be the id of one of your videos.', 'starting_after');
    cursor = sql`(p.created_at, p.id) < (${c.created_at}, ${c.id})`;
  }
  const rows = await videoRows(sql`p.owner_id = ${who.uid} and ${cursor}`, sql`order by p.created_at desc, p.id desc`, limit + 1);
  return { object: 'list' as const, data: await Promise.all(rows.slice(0, limit).map(videoObject)), has_more: rows.length > limit };
}

export async function getVideo(who: ApiCaller, id: string) {
  const v = await videoById(who.uid, id);
  if (!v) throw notFound('video');
  return v;
}

/** Delete a video: if it is still being made it stops and its hold is refunded; its files are deleted at once. */
export async function removeVideo(who: ApiCaller, id: string) {
  const [p] = await sql`select id from projects where id = ${id} and owner_id = ${who.uid} and origin = 'api' and mode = 'clip'`;
  if (!p) throw notFound('video');
  await deleteProject(p.id);
  return { id, object: 'video' as const, deleted: true };
}
