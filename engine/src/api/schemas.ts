// What the public API accepts and returns. The same zod schemas validate requests and generate openapi.json, so the
// documentation can't drift from what is enforced.

import { z } from 'zod';
import { config } from '../config.js';

const describe = <T extends z.ZodType>(s: T, d: string) => s.describe(d);

const MediaUrl = describe(z.string().min(1).max(60_000_000), 'An https:// URL we can download, or a data URI (data:<type>;base64,<data>).');
export const Media = z.object({ url: MediaUrl }).strict();
export const LabeledMedia = z.object({
  url: MediaUrl,
  label: describe(z.string().trim().max(60).optional(), 'Who or what this is, e.g. "Maya" or "the sneaker". Used in the prompt.'),
}).strict();

/** Up to 20 keys of short values, returned as sent. */
export const Metadata = describe(z.record(z.string().min(1).max(64), z.union([z.string().max(500), z.number(), z.boolean(), z.null()]))
  .refine((m) => Object.keys(m).length <= 20, 'at most 20 keys').refine((m) => JSON.stringify(m).length <= 1024, 'at most 1 KB'),
'Your own key-value data (at most 20 keys, 1 KB), returned with the object and in webhooks.');

const WebhookUrl = describe(z.string().max(2000), 'An https:// URL we POST to when the job finishes (signed: see Webhooks).');

export const VideoCreate = z.object({
  prompt: describe(z.string().trim().min(3).max(2000), 'What happens in the clip. Refer to your files as "image 2", "video 1" or "voice 1", or with the model’s tags <Picture 2>, <Video 1>, <Audio 1>.'),
  duration: describe(z.number().int().min(config.clips.minSeconds).max(config.clips.maxSeconds).default(5), 'Length in whole seconds.'),
  aspect_ratio: z.enum(['9:16', '16:9', '1:1']).default('9:16'),
  first_frame: describe(Media.optional(), 'Image to video: this picture is the first frame. Can’t be combined with other media.'),
  images: describe(z.array(LabeledMedia).max(9).optional(), 'Up to 9 reference pictures: people, products, places (up to 8 with a video).'),
  video: describe(Media.optional(), 'A video to remix (MP4 or MOV; the first 15 seconds are used).'),
  audio: describe(LabeledMedia.optional(), 'A voice to speak with (MP3, WAV or M4A, 2 to 14 seconds). Needs at least one picture.'),
  rights_confirmed: describe(z.boolean().optional(), 'Required with any media: you have the rights to it, including the permission of anyone shown or heard.'),
  webhook_url: WebhookUrl.optional(),
  metadata: Metadata.optional(),
}).strict();
export type VideoCreateInput = z.infer<typeof VideoCreate>;

export const FILM_FORMATS = ['microdrama', 'short_film', 'web_series', 'youtube'] as const;
export const FilmCreate = z.object({
  prompt: describe(z.string().trim().min(10).max(4000), 'The idea, in a sentence or a paragraph.'),
  format: describe(z.enum(FILM_FORMATS).default('microdrama'), 'microdrama: vertical 9:16 episodes; the others are 16:9.'),
  episodes: describe(z.number().int().min(1).max(100).optional(), 'How many episodes (or parts).'),
  episode_seconds: describe(z.number().int().min(45).max(600).optional(), 'Seconds per episode (microdrama 45 to 180, other formats up to 600).'),
  total_seconds: describe(z.number().int().min(45).max(36_000).optional(), 'Instead of episodes: the whole length, split into episodes for you.'),
  language: describe(z.string().trim().min(2).max(40).default('English'), 'The language the characters speak.'),
  max_cost_usd: describe(z.number().positive().max(100_000).optional(), 'The most this film may cost in all (setup fee and filming). Above it, the film waits for your approval.'),
  auto_approve: describe(z.boolean().default(true), 'false: the film always stops at its price and waits for POST /films/{id}/approve.'),
  webhook_url: WebhookUrl.optional(),
  metadata: Metadata.optional(),
}).strict();
export type FilmCreateInput = z.infer<typeof FilmCreate>;
export const FilmQuote = FilmCreate.pick({ format: true, episodes: true, episode_seconds: true, total_seconds: true }).strict();

export const KeyLimit = z.object({ name: z.string().max(60).optional(), monthly_limit_usd: z.number().positive().max(100_000).nullable().optional() }).strict();

// ───────── responses (for the documentation) ─────────

const Output = z.object({
  url: describe(z.string(), 'A signed link to the MP4 (H.264 and AAC), valid for 24 hours. Fetch the object again for a fresh one.'),
  thumbnail_url: z.string().nullable(), width: z.number(), height: z.number(), duration: z.number(), has_audio: z.boolean(),
});
const ErrorInfo = z.object({ code: z.string(), message: z.string() });
const Webhook = z.object({ url: z.string(), status: z.enum(['pending', 'delivered', 'failed']).nullable(), attempts: z.number() });

export const VideoObject = z.object({
  id: z.string(), object: z.literal('video'),
  status: z.enum(['queued', 'processing', 'succeeded', 'failed', 'refused', 'expired']),
  mode: z.enum(['text', 'image', 'reference', 'remix']), prompt: z.string(), duration: z.number(), aspect_ratio: z.string(), resolution: z.literal('768P'),
  cost_usd: describe(z.number(), 'Held while the video is made, kept if it succeeds, refunded otherwise (then 0).'),
  output: Output.nullable(), error: ErrorInfo.nullable(), webhook: Webhook.nullable(), metadata: z.record(z.string(), z.any()).nullable(),
  created_at: z.string(), completed_at: z.string().nullable(), expires_at: z.string().nullable(),
});

const Episode = z.object({ index: z.number(), title: z.string(), status: z.string(), output: Output.nullable() });
export const FilmObject = z.object({
  id: z.string(), object: z.literal('film'),
  status: z.enum(['writing', 'awaiting_approval', 'filming', 'editing', 'succeeded', 'failed', 'expired']),
  stage_detail: describe(z.string().nullable(), 'What is happening now, in a few words.'),
  prompt: z.string(), title: z.string(), logline: z.string().nullable(), format: z.string(), language: z.string(), aspect_ratio: z.string(),
  episodes_requested: z.number(), episode_seconds: z.number(),
  cost: z.object({
    setup_fee_usd: z.number(), filming_usd: describe(z.number().nullable(), 'The price to film every shot, once the shots are planned (null before).'),
    estimated_total_usd: z.number(), charged_usd: describe(z.number(), 'Taken so far: the setup fee plus filmed shots. Failed shots are refunded.'),
  }),
  max_cost_usd: z.number().nullable(), auto_approve: z.boolean(),
  approval: describe(z.object({ required: z.boolean(), reason: z.string().nullable() }).nullable(), 'Set while the film waits at its price.'),
  progress: z.object({ shots: z.number(), shots_filmed: z.number() }),
  episodes: z.array(Episode), error: ErrorInfo.nullable(), webhook: Webhook.nullable(), metadata: z.record(z.string(), z.any()).nullable(),
  created_at: z.string(), completed_at: z.string().nullable(), expires_at: z.string().nullable(),
});

export const ErrorObject = z.object({ error: z.object({ type: z.string(), code: z.string(), message: z.string(), param: z.string().optional() }) });
export const ListOf = (item: z.ZodType) => z.object({ object: z.literal('list'), data: z.array(item), has_more: z.boolean() });
