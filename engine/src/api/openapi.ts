// GET /api/v1/pricing and GET /api/v1/openapi.json: both public, both built from the settings and schemas the API
// enforces, so what developers read is what the API does.

import { z } from 'zod';
import { config } from '../config.js';
import { FORMATS } from '../pipeline/writer.js';
import { ErrorObject, FilmCreate, FilmObject, FilmQuote, FILM_FORMATS, ListOf, VideoCreate, VideoObject } from './schemas.js';
import { SCHEDULE } from './webhooks.js';
import { MEDIA_LIMITS } from './videos.js';

const MB = 1024 * 1024;

export function pricing() {
  const c = config.credits;
  return {
    object: 'pricing', currency: 'usd',
    video: {
      per_second_usd: c.sellPerSecond['768P'], resolution: '768P', min_duration: config.clips.minSeconds, max_duration: config.clips.maxSeconds,
      aspect_ratios: ['9:16', '16:9', '1:1'], modes: ['text', 'image', 'reference', 'remix'],
      media_limits_mb: { image: MEDIA_LIMITS.image / MB, video: MEDIA_LIMITS.video / MB, audio: MEDIA_LIMITS.audio / MB }, max_images: 9,
      note: 'Charged only for a video that is delivered: the price is held while it is made and refunded if it fails or is refused.',
    },
    film: {
      setup_fee_usd: c.setupFeeUsd, setup_fee_included_minutes: c.setupFeeIncludedMinutes, setup_fee_per_extra_minute_usd: c.setupFeePerMinuteUsd,
      filming_per_second_usd: c.sellPerSecond['768P'], max_total_seconds: config.api.filmMaxSeconds,
      formats: Object.fromEntries(FILM_FORMATS.map((f) => [f, { aspect_ratio: FORMATS[f].aspect, episode_seconds: FORMATS[f].seconds, default_episodes: FORMATS[f].defaults.episodes, default_episode_seconds: FORMATS[f].defaults.seconds }])),
      note: 'The setup fee pays for writing, casting and planning. Filming is priced per second once the shots are planned; failed shots are refunded.',
    },
    limits: {
      requests_per_minute_per_key: config.api.requestsPerMinute, new_jobs_per_minute: config.api.createsPerMinute,
      videos_in_progress: config.api.maxActive, films_in_progress: config.api.maxActiveFilms,
    },
    retention_days: config.api.retentionDays,
  };
}

let doc: any = null;
const schema = (s: z.ZodType, io: 'input' | 'output' = 'output') => {
  const { $schema, ...rest } = z.toJSONSchema(s, { io, unrepresentable: 'any' }) as any;
  return rest;
};
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (name: string, description: string) => ({ description, content: { 'application/json': { schema: ref(name) } } });
const errors = { 400: json('Error', 'Invalid request'), 401: json('Error', 'Missing, unknown or revoked key'), 402: json('Error', 'Not enough credit'),
  403: json('Error', 'Suspended, or over the key’s monthly limit'), 404: json('Error', 'Not found'), 409: json('Error', 'Wrong state, or the same Idempotency-Key still in progress'),
  422: json('Error', 'Refused by the content check, or an Idempotency-Key reused with a different body'), 429: json('Error', 'Too many requests (see Retry-After)'), 503: json('Error', 'Busy or unavailable: retry') };
const idParam = (what: string) => [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: `The ${what} id.` }];
const listParams = [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'starting_after', in: 'query', schema: { type: 'string' }, description: 'The id of the last item of the previous page.' }];
const idempotency = { name: 'Idempotency-Key', in: 'header', schema: { type: 'string', maxLength: 255 }, description: 'Send the same key to retry safely: one job, one charge. Kept 24 hours.' };

export function openapi() {
  if (doc) return doc;
  doc = {
    openapi: '3.1.0',
    info: {
      title: 'Backlot API', version: '1.0.0',
      description: `Make videos and microdramas from text, pictures, video and voice. Prepaid credit, charged per second of finished video. Webhooks are signed with Backlot-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body"> and retried after ${SCHEDULE.map((s) => (s < 3600 ? `${s / 60} min` : `${s / 3600} h`)).join(', ')}.`,
    },
    servers: [{ url: `${config.publicBaseUrl || ''}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'bk_live_…', description: 'Create keys on the Developers page.' } },
      schemas: {
        VideoCreate: schema(VideoCreate, 'input'), Video: schema(VideoObject), VideoList: schema(ListOf(VideoObject)),
        FilmCreate: schema(FilmCreate, 'input'), FilmQuoteRequest: schema(FilmQuote, 'input'), Film: schema(FilmObject), FilmList: schema(ListOf(FilmObject)),
        Error: schema(ErrorObject),
      },
    },
    paths: {
      '/videos': {
        post: { summary: 'Make a video', operationId: 'createVideo', parameters: [idempotency], requestBody: { required: true, content: { 'application/json': { schema: ref('VideoCreate') } } }, responses: { 201: json('Video', 'Accepted: being made'), ...errors } },
        get: { summary: 'List videos, newest first', operationId: 'listVideos', parameters: listParams, responses: { 200: json('VideoList', 'A page of videos'), 401: errors[401] } },
      },
      '/videos/{id}': {
        get: { summary: 'Get a video', operationId: 'getVideo', parameters: idParam('video'), responses: { 200: json('Video', 'The video'), 404: errors[404] } },
        delete: { summary: 'Delete a video (cancels it if still being made; the hold is refunded)', operationId: 'deleteVideo', parameters: idParam('video'), responses: { 200: { description: 'Deleted' }, 404: errors[404] } },
      },
      '/films/quote': { post: { summary: 'What a film of this shape costs', operationId: 'quoteFilm', requestBody: { content: { 'application/json': { schema: ref('FilmQuoteRequest') } } }, responses: { 200: { description: 'The quote' }, 400: errors[400] } } },
      '/films': {
        post: { summary: 'Make a film from an idea', operationId: 'createFilm', parameters: [idempotency], requestBody: { required: true, content: { 'application/json': { schema: ref('FilmCreate') } } }, responses: { 201: json('Film', 'Accepted: being written'), ...errors } },
        get: { summary: 'List films, newest first', operationId: 'listFilms', parameters: listParams, responses: { 200: json('FilmList', 'A page of films'), 401: errors[401] } },
      },
      '/films/{id}': {
        get: { summary: 'Get a film', operationId: 'getFilm', parameters: idParam('film'), responses: { 200: json('Film', 'The film'), 404: errors[404] } },
        delete: { summary: 'Delete a film', operationId: 'deleteFilm', parameters: idParam('film'), responses: { 200: { description: 'Deleted' }, 404: errors[404] } },
      },
      '/films/{id}/approve': { post: { summary: 'Film it at the price shown (a film waiting with status awaiting_approval)', operationId: 'approveFilm', parameters: idParam('film'), responses: { 200: json('Film', 'Filming'), 402: errors[402], 403: errors[403], 409: errors[409] } } },
      '/films/{id}/retry': { post: { summary: 'Continue a failed film from where it stopped', operationId: 'retryFilm', parameters: idParam('film'), responses: { 200: json('Film', 'Continuing'), 402: errors[402], 409: errors[409] } } },
      '/account': { get: { summary: 'Balance, limits and work in progress', operationId: 'getAccount', responses: { 200: { description: 'The account' }, 401: errors[401] } } },
      '/pricing': { get: { summary: 'Prices and limits (no key needed)', operationId: 'getPricing', security: [], responses: { 200: { description: 'Pricing' } } } },
    },
  };
  return doc;
}
