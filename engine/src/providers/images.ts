// Reference-image generation. MiniMax image-01 by default (same key as H3);
// Gemini or OpenAI are better when a variant must match a *place* (they accept any
// reference image, while image-01's subject reference only locks people).

import { config } from '../config.js';
import { minimaxImage, ProviderError } from './minimax.js';
import { mockImage } from './mock.js';
import { PermanentError } from '../queue.js';

export interface RefImage { mime: string; data: Buffer; role: 'identity' | 'place' | 'style' }
export interface ImageRequest {
  prompt: string;
  aspect: string;            // e.g. 3:4, 16:9, 9:16, 1:1
  refs?: RefImage[];         // earlier approved assets this image must stay faithful to
  label?: string[];          // for mock placeholders
  provider?: 'minimax' | 'gemini' | 'openai';
}
export interface ImageResult { data: Buffer; mime: string; provider: string }

const IMG_ASPECTS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'];
const nearestAspect = (a: string) => (IMG_ASPECTS.includes(a) ? a : a === '4:5' ? '3:4' : '1:1');

/** Whether a provider can take a place (room, street) reference picture. MiniMax image-01 only takes a face. */
export const placeRefsSupported = (provider: string) => provider !== 'minimax';

export async function generateImage(req: ImageRequest): Promise<ImageResult> {
  if (config.mock) return { data: await mockImage(req), mime: 'image/png', provider: 'mock' };
  let provider = req.provider || config.images.provider;
  // Place references need a provider that accepts arbitrary reference images.
  const needsPlaceRef = (req.refs || []).some((r) => r.role !== 'identity');
  if (provider === 'minimax' && needsPlaceRef) {
    if (config.images.geminiKey) provider = 'gemini';
    else if (config.images.openaiKey) provider = 'openai';
  }
  if (provider === 'gemini') return { data: await gemini(req), mime: 'image/png', provider };
  if (provider === 'openai') return { data: await openai(req), mime: 'image/png', provider };
  const identity = (req.refs || []).find((r) => r.role === 'identity');
  const [buf] = await minimaxImage({
    prompt: req.prompt,
    aspect: nearestAspect(req.aspect),
    subjectRef: identity ? `data:${identity.mime};base64,${identity.data.toString('base64')}` : undefined,
  });
  if (!buf) throw new ProviderError('image-01 returned no image', 'bad_response', true);
  return { data: buf, mime: 'image/jpeg', provider: 'minimax' };
}

async function gemini(req: ImageRequest): Promise<Buffer> {
  if (!config.images.geminiKey) throw new PermanentError('GEMINI_API_KEY is not set', 'config');
  const parts: any[] = [{ text: req.prompt }];
  for (const r of req.refs || []) parts.push({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } });
  const r = await fetch(`${config.images.geminiBaseUrl}/v1beta/models/${config.images.geminiModel}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(180_000),
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.images.geminiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: nearestAspect(req.aspect) } },
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError(`Gemini image ${r.status}: ${j?.error?.message || ''}`, r.status === 429 ? 'rate_limited' : r.status >= 500 ? 'server_error' : 'bad_request', r.status === 429 || r.status >= 500, r.status);
  const cand = j.candidates?.[0];
  const img = cand?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!img) {
    const why = cand?.finishReason || j.promptFeedback?.blockReason || 'no image';
    throw new ProviderError(`Gemini returned no image (${why})`, /SAFETY|BLOCK|PROHIBITED/i.test(why) ? 'sensitive_content' : 'bad_response', !/SAFETY|BLOCK/i.test(why));
  }
  return Buffer.from(img.inlineData.data, 'base64');
}

async function openai(req: ImageRequest): Promise<Buffer> {
  if (!config.images.openaiKey) throw new PermanentError('OPENAI_API_KEY is not set', 'config');
  const [w, h] = req.aspect.split(':').map(Number);
  const size = !w || !h || w === h ? '1024x1024' : w > h ? '1536x1024' : '1024x1536';
  const auth = { authorization: `Bearer ${config.images.openaiKey}` };
  let r: Response;
  if (req.refs?.length) {
    const fd = new FormData();
    fd.append('model', config.images.openaiModel);
    fd.append('prompt', req.prompt);
    fd.append('size', size);
    fd.append('input_fidelity', 'high');
    req.refs.forEach((x, i) => fd.append('image[]', new Blob([new Uint8Array(x.data)], { type: x.mime }), `ref${i}.png`));
    r = await fetch(`${config.images.openaiBaseUrl}/v1/images/edits`, { method: 'POST', headers: auth, body: fd, signal: AbortSignal.timeout(240_000) });
  } else {
    r = await fetch(`${config.images.openaiBaseUrl}/v1/images/generations`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({ model: config.images.openaiModel, prompt: req.prompt, size, n: 1 }),
    });
  }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError(`OpenAI image ${r.status}: ${j?.error?.message || ''}`, j?.error?.code === 'moderation_blocked' ? 'sensitive_content' : r.status === 429 ? 'rate_limited' : 'bad_request', r.status === 429 || r.status >= 500, r.status);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new ProviderError('OpenAI returned no image', 'bad_response', true);
  return Buffer.from(b64, 'base64');
}
