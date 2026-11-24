// MiniMax: H3 video (v2 API), image-01 reference images, and Voice Design.
// Docs: https://platform.minimax.io/docs/api-reference/video-generation-v2-create

import { config } from '../config.js';
import { PermanentError } from '../queue.js';

export class ProviderError extends Error {
  code: string; retryable: boolean; status: number;
  constructor(message: string, code: string, retryable: boolean, status = 0) { super(message); this.code = code; this.retryable = retryable; this.status = status; }
}

const base = () => config.minimax.baseUrl;
function headers() {
  if (!config.minimax.apiKey) throw new PermanentError('MINIMAX_API_KEY is not set', 'config');
  return { 'content-type': 'application/json', authorization: `Bearer ${config.minimax.apiKey}` };
}

/** Map an HTTP failure from the v2 API (OpenAI-style error body) to a typed error. */
async function v2Error(r: Response, what: string): Promise<ProviderError> {
  let body: any = null; let text = '';
  try { text = await r.text(); body = JSON.parse(text); } catch {}
  const msg = body?.error?.message || body?.message || text.slice(0, 300) || r.statusText;
  const rid = body?.request_id ? ` (request ${body.request_id})` : '';
  switch (r.status) {
    case 400: return new ProviderError(`${what}: invalid request: ${msg}${rid}`, 'bad_request', false, 400);
    case 401: case 403: return new ProviderError(`${what}: MiniMax rejected the API key${rid}`, 'auth', false, r.status);
    case 402: return new ProviderError(`${what}: MiniMax account balance is too low${rid}`, 'insufficient_balance', false, 402);
    case 422: return new ProviderError(`${what}: MiniMax flagged the content as sensitive: ${msg}${rid}`, 'sensitive_content', false, 422);
    case 429: return new ProviderError(`${what}: MiniMax rate limit${rid}`, 'rate_limited', true, 429);
    default: return new ProviderError(`${what}: MiniMax ${r.status}: ${msg}${rid}`, 'server_error', true, r.status);
  }
}

// ───────────────────────────── H3 video ─────────────────────────────

export type H3Content =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string }; role: 'first_frame' | 'last_frame' | 'reference_image' }
  | { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }
  | { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' };

export interface H3Request {
  model: string;
  content: H3Content[];
  resolution: '480P' | '768P' | '2K';
  duration: number;
  ratio?: string;
  callback_url?: string;
}

export interface H3Task {
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | string;
  url?: string;
  usage?: { total_seconds?: number; input_seconds?: number; output_seconds?: number; input_image_count?: number };
  error?: string;
  raw: any;
}

export async function createVideoTask(body: H3Request): Promise<string> {
  const r = await fetch(`${base()}/v2/video_generation`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    .catch((e) => { throw new ProviderError(`H3 submit network error: ${e.message}`, 'network', true); });
  if (!r.ok) throw await v2Error(r, 'H3 submit');
  const j = await r.json();
  if (!j.task_id) throw new ProviderError(`H3 submit returned no task_id: ${JSON.stringify(j).slice(0, 300)}`, 'bad_response', true);
  return String(j.task_id);
}

export async function queryVideoTask(taskId: string): Promise<H3Task> {
  const r = await fetch(`${base()}/v2/query/video_generation/${encodeURIComponent(taskId)}`, { headers: headers(), signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new ProviderError(`H3 query network error: ${e.message}`, 'network', true); });
  if (!r.ok) throw await v2Error(r, 'H3 query');
  const j = await r.json();
  const t = j.task || j;
  const err = t.error ? (typeof t.error === 'string' ? t.error : t.error.message || JSON.stringify(t.error)) : undefined;
  return { status: String(t.status || 'unknown'), url: t.content?.url, usage: t.usage, error: err, raw: t };
}

// ───────────────────────────── image-01 ─────────────────────────────

export interface MMImageOpts {
  prompt: string;
  aspect: string;                  // 1:1 | 16:9 | 4:3 | 3:2 | 2:3 | 3:4 | 9:16 | 21:9
  subjectRef?: string;             // URL or data URI of the character master (people only)
  n?: number;
  seed?: number;
}

export async function minimaxImage(o: MMImageOpts): Promise<Buffer[]> {
  const body: any = {
    model: config.minimax.imageModel,
    prompt: o.prompt.slice(0, 1500),
    aspect_ratio: o.aspect,
    response_format: 'base64',
    n: o.n ?? 1,
    prompt_optimizer: false,
  };
  if (o.seed !== undefined) body.seed = o.seed;
  if (o.subjectRef) body.subject_reference = [{ type: 'character', image_file: o.subjectRef }];
  const r = await fetch(`${base()}/v1/image_generation`, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  if (!r.ok) throw await v2Error(r, 'image-01');
  const j = await r.json();
  const sc = j.base_resp?.status_code;
  if (sc && sc !== 0) {
    const code = sc === 1026 || sc === 1027 ? 'sensitive_content' : sc === 1008 ? 'insufficient_balance' : sc === 1002 ? 'rate_limited' : 'provider_error';
    throw new ProviderError(`image-01: ${j.base_resp?.status_msg || sc}`, code, code === 'rate_limited');
  }
  const arr: string[] = j.data?.image_base64 || [];
  if (!arr.length) {
    const urls: string[] = j.data?.image_urls || [];
    return Promise.all(urls.map(async (u) => Buffer.from(await (await fetch(u, { signal: AbortSignal.timeout(60_000) })).arrayBuffer())));
  }
  return arr.map((b) => Buffer.from(b, 'base64'));
}

// ───────────────────────────── Voice Design ─────────────────────────────

export async function voiceDesign(prompt: string, previewText: string): Promise<{ voiceId: string; audio: Buffer }> {
  const r = await fetch(`${base()}/v1/voice_design`, {
    method: 'POST', headers: headers(), signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ prompt: prompt.slice(0, 1000), preview_text: previewText.slice(0, 500) }),
  });
  if (!r.ok) throw await v2Error(r, 'voice design');
  const j = await r.json();
  const sc = j.base_resp?.status_code;
  if (sc && sc !== 0) throw new ProviderError(`voice design: ${j.base_resp?.status_msg || sc}`, sc === 1008 ? 'insufficient_balance' : 'provider_error', false);
  if (!j.trial_audio) throw new ProviderError('voice design returned no audio', 'bad_response', true);
  return { voiceId: String(j.voice_id || ''), audio: Buffer.from(j.trial_audio, 'hex') };
}
