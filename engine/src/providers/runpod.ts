// Our own H3 deployment on RunPod Serverless. Same interface as providers/minimax.ts, so the
// render pipeline doesn't know which one it talks to. RunPod queues jobs and scales GPU workers.
//
// Contract with gpu-worker/handler.py:
//   input  = { request: <H3 request, media as signed URLs>, upload: { url, key, content_type } }
//   output = { key, seconds, width, height, has_audio }      the clip is already at upload.url
//          | { error, error_code? }                          e.g. error_code "sensitive_content"
// API: https://docs.runpod.io/serverless/endpoints/operation-reference

import { config } from '../config.js';
import { PermanentError } from '../queue.js';
import { ProviderError, type H3Request, type H3Task } from './minimax.js';
import { storage } from '../storage.js';

const base = () => `${config.runpod.apiBase}/${config.runpod.endpointId}`;
function headers() {
  if (!config.runpod.apiKey || !config.runpod.endpointId) throw new PermanentError('RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID must be set', 'config');
  return { 'content-type': 'application/json', authorization: `Bearer ${config.runpod.apiKey}` };
}

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base()}${path}`, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    .catch((e) => { throw new ProviderError(`RunPod network error: ${e.message}`, 'network', true); });
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 300);
    if (r.status === 401 || r.status === 403) throw new ProviderError('RunPod rejected the API key', 'auth', false, r.status);
    if (r.status === 400 || r.status === 404) throw new ProviderError(`RunPod ${r.status}: ${text}`, 'bad_request', false, r.status);
    if (r.status === 429) throw new ProviderError('RunPod rate limit', 'rate_limited', true, 429);
    throw new ProviderError(`RunPod ${r.status}: ${text}`, 'server_error', true, r.status);
  }
  return r.json() as Promise<any>;
}

export async function createVideoTask(body: H3Request, o: { key: string }): Promise<string> {
  const upload = { key: o.key, content_type: 'video/mp4', url: await storage.uploadUrl(o.key, 'video/mp4', config.runpod.executionTimeoutSec + 3600) };
  const j = await call('POST', '/run', {
    input: { request: body, upload },
    policy: { executionTimeout: config.runpod.executionTimeoutSec * 1000, ttl: (config.runpod.executionTimeoutSec + 3600) * 1000 },
  });
  if (!j.id) throw new ProviderError(`RunPod returned no job id: ${JSON.stringify(j).slice(0, 200)}`, 'bad_response', true);
  return String(j.id);
}

export async function queryVideoTask(jobId: string): Promise<H3Task> {
  const j = await call('GET', `/status/${encodeURIComponent(jobId)}`);
  const out = j.output || {};
  const gpuSeconds = (Number(j.executionTime) || 0) / 1000;
  const usage = { output_seconds: Number(out.seconds) || undefined, gpu_seconds: gpuSeconds, cost_usd: gpuSeconds * config.runpod.gpuPricePerSecond } as any;
  switch (j.status) {
    case 'IN_QUEUE': return { status: 'queued', raw: j };
    case 'IN_PROGRESS': return { status: 'running', raw: j };
    case 'COMPLETED':
      if (out.error || !out.key) {
        const refused = out.error_code === 'sensitive_content';
        return { status: 'failed', error: refused ? `sensitive content: ${out.error}` : String(out.error || 'worker returned no clip'), usage, raw: j };
      }
      return { status: 'succeeded', url: `storage:${out.key}`, usage, raw: j };
    default: // FAILED, CANCELLED, TIMED_OUT
      return { status: 'failed', error: `RunPod job ${String(j.status).toLowerCase()}${j.error ? `: ${String(j.error).slice(0, 300)}` : ''}`, usage, raw: j };
  }
}

/** Stop paying for a render nobody will watch. Best effort. */
export async function cancelVideoTask(jobId: string) {
  await call('POST', `/cancel/${encodeURIComponent(jobId)}`).catch(() => {});
}

/** Queue and worker counts, straight from RunPod. */
export const endpointHealth = () => call('GET', '/health');

/** Set the endpoint's worker floor and ceiling (RunPod REST API). */
export async function setWorkers(workersMin: number, workersMax: number) {
  const r = await fetch(`${config.runpod.restBase}/endpoints/${config.runpod.endpointId}`, {
    method: 'PATCH', headers: headers(), body: JSON.stringify({ workersMin, workersMax }), signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`RunPod endpoint update failed: ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
}
