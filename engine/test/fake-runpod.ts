// A stand-in for RunPod Serverless + our GPU worker, for tests. Speaks the same HTTP API as
// api.runpod.ai/v2 and rest.runpod.io/v1, and does what gpu-worker/handler.py does: render a clip,
// PUT it to the signed upload URL, report COMPLETED with { key, seconds, width, height, has_audio }.

import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeholderVideo } from '../src/media/ffmpeg.js';

type Job = { id: string; status: string; input: any; output?: any; error?: string; executionTime?: number; timer?: NodeJS.Timeout };

export function startFakeRunpod(port: number) {
  const jobs = new Map<string, Job>();
  const state = { jobs, cancelled: [] as string[], workersMin: [] as number[], workersMax: [] as number[], holdMs: 0, submitted: 0 };
  let n = 0;

  async function work(job: Job) {
    job.status = 'IN_PROGRESS';
    const req = job.input.request, up = job.input.upload;
    const prompt: string = req.content.find((c: any) => c.type === 'text')?.text || '';
    if (/FORCE_SENSITIVE/.test(prompt)) { // what the handler returns when the model refuses
      job.status = 'COMPLETED'; job.output = { error: 'the model refused this prompt', error_code: 'sensitive_content' }; return;
    }
    if (state.holdMs) await new Promise((r) => setTimeout(r, state.holdMs));
    if (job.status !== 'IN_PROGRESS') return; // cancelled meanwhile
    const [w, h] = req.ratio === '9:16' ? [768, 1344] : [1344, 768]; // the real worker's 768P canvas
    const dir = await mkdtemp(join(tmpdir(), 'fake-runpod-'));
    try {
      const file = join(dir, 'out.mp4');
      await placeholderVideo(file, ['RunPod fake', `${req.duration}s ${req.resolution}`], req.duration, w, h, true);
      const put = await fetch(up.url, { method: 'PUT', headers: { 'content-type': up.content_type }, body: new Uint8Array(await readFile(file)) });
      if (!put.ok) throw new Error(`upload failed ${put.status}`);
      job.status = 'COMPLETED'; job.executionTime = req.duration * 1000 * 3;
      job.output = { key: up.key, seconds: req.duration, width: w, height: h, has_audio: true };
    } catch (e: any) { job.status = 'FAILED'; job.error = e.message; }
    finally { await rm(dir, { recursive: true, force: true }); }
  }

  const server = createServer(async (req, res) => {
    const send = (code: number, body: any) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== 'Bearer rp_test') return send(401, { error: 'unauthorized' });
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = req.url || '';
    let m: RegExpMatchArray | null;
    if (req.method === 'POST' && (m = url.match(/^\/v2\/([^/]+)\/run$/))) {
      const job: Job = { id: `job-${++n}`, status: 'IN_QUEUE', input: body.input };
      jobs.set(job.id, job); state.submitted++;
      job.timer = setTimeout(() => void work(job), 200);
      return send(200, { id: job.id, status: job.status });
    }
    if (req.method === 'GET' && (m = url.match(/^\/v2\/[^/]+\/status\/(.+)$/))) {
      const j = jobs.get(m[1]);
      return j ? send(200, { id: j.id, status: j.status, output: j.output, error: j.error, executionTime: j.executionTime }) : send(404, { error: 'not found' });
    }
    if (req.method === 'POST' && (m = url.match(/^\/v2\/[^/]+\/cancel\/(.+)$/))) {
      const j = jobs.get(m[1]);
      if (j && (j.status === 'IN_QUEUE' || j.status === 'IN_PROGRESS')) { clearTimeout(j.timer); j.status = 'CANCELLED'; state.cancelled.push(j.id); }
      return send(200, { id: m[1], status: j?.status ?? 'unknown' });
    }
    if (req.method === 'GET' && /^\/v2\/[^/]+\/health$/.test(url)) {
      const count = (s: string) => [...jobs.values()].filter((j) => j.status === s).length;
      return send(200, { jobs: { inQueue: count('IN_QUEUE'), inProgress: count('IN_PROGRESS'), completed: count('COMPLETED'), failed: count('FAILED') }, workers: { idle: 0, running: count('IN_PROGRESS') } });
    }
    if (req.method === 'PATCH' && /^\/v1\/endpoints\/[^/]+$/.test(url)) {
      state.workersMin.push(body.workersMin); state.workersMax.push(body.workersMax);
      return send(200, { ok: true, ...body });
    }
    send(404, { error: `no route ${req.method} ${url}` });
  });
  return new Promise<{ state: typeof state; close: () => void }>((resolve) => server.listen(port, () => resolve({ state, close: () => server.close() })));
}
