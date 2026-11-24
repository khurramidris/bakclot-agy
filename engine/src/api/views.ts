// The video and film objects of the public API, read from the projects behind them. One query per page of results,
// however many items, so listing stays fast.

import { sql } from '../db.js';
import { storage } from '../storage.js';
import { sellPrice } from '../billing.js';
import { setupFeeFor } from '../pipeline/writer.js';

const LINK_TTL = 24 * 3600;
const iso = (d: any) => (d ? new Date(d).toISOString() : null);
const money = (n: number) => Math.round(n * 100) / 100;
const link = async (key?: string | null) => (key ? storage.url(key, LINK_TTL) : null);
const webhookOf = (r: any) => (r.webhook_url ? { url: r.webhook_url, status: r.w_status ?? null, attempts: Number(r.w_attempts ?? 0) } : null);

// ───────── videos ─────────

/** The rows behind video objects: the clip project, its newest take, its length and its latest webhook delivery. */
export function videoRows(where: any, order: any = sql``, limit = 1) {
  return sql`select p.id, p.owner_id, p.stage, p.aspect, p.brief, p.api_metadata, p.webhook_url, p.created_at, p.finished_at, p.expires_at,
      t.id take_id, t.status t_status, t.error_code t_error_code, t.hold_usd t_hold, t.file_key t_file, t.thumb_key t_thumb, t.media t_media,
      s.duration s_duration, w.status w_status, w.attempts w_attempts
    from projects p
    left join lateral (select * from takes where project_id = p.id order by created_at desc limit 1) t on true
    left join lateral (select duration from shots where project_id = p.id order by idx limit 1) s on true
    left join lateral (select status, attempts from webhook_deliveries where project_id = p.id order by id desc limit 1) w on true
    where p.origin = 'api' and p.mode = 'clip' and ${where} ${order} limit ${limit}`;
}

export function videoStatus(r: any): 'queued' | 'processing' | 'succeeded' | 'failed' | 'refused' | 'expired' {
  if (r.stage === 'expired') return 'expired';
  switch (r.t_status) {
    case 'pending': return 'queued';
    case 'submitted': case 'running': return 'processing';
    case 'succeeded': return 'succeeded';
    case 'failed': case 'rejected': return r.t_error_code === 'sensitive_content' ? 'refused' : 'failed';
    default: return r.stage === 'failed' ? 'failed' : 'queued';
  }
}

export async function videoObject(r: any) {
  const status = videoStatus(r);
  const b = r.brief || {}, m = r.t_media || {};
  const done = status === 'succeeded' && r.t_file;
  return {
    id: r.id, object: 'video' as const, status, mode: b.mode, prompt: b.prompt, duration: Number(r.s_duration ?? b.seconds), aspect_ratio: r.aspect, resolution: '768P' as const,
    cost_usd: ['queued', 'processing', 'succeeded'].includes(status) ? money(Number(r.t_hold || 0)) : 0,
    output: done ? { url: (await link(r.t_file))!, thumbnail_url: await link(r.t_thumb), width: Number(m.width || 0), height: Number(m.height || 0), duration: Number(m.duration || 0), has_audio: !!m.has_audio } : null,
    error: status === 'failed' ? { code: 'render_failed', message: 'The video couldn’t be made. You weren’t charged; it is safe to try again.' }
      : status === 'refused' ? { code: 'content_refused', message: 'The video model refused this request under its content rules. You weren’t charged.' } : null,
    webhook: webhookOf(r), metadata: r.api_metadata ?? null,
    created_at: iso(r.created_at)!, completed_at: iso(r.finished_at), expires_at: iso(r.expires_at),
  };
}

export async function videoById(ownerId: string, id: string) {
  const [r] = await videoRows(sql`p.id = ${id} and p.owner_id = ${ownerId}`);
  return r ? videoObject(r) : null;
}

// ───────── films ─────────

const FILM_STATUS: Record<string, string> = {
  writing: 'writing', story_review: 'writing', script_review: 'writing', breakdown: 'writing', casting: 'writing', cast_review: 'writing', planning: 'writing',
  ready: 'awaiting_approval', rendering: 'filming', assembling: 'editing', done: 'succeeded', failed: 'failed', expired: 'expired',
};

/** The rows behind film objects. The heavy writing state is left out: only what the object shows is read. */
export function filmRows(where: any, order: any = sql``, limit = 1) {
  return sql`select p.id, p.owner_id, p.stage, p.stage_error, p.title, p.aspect, p.language, p.resolution, p.brief, p.api_metadata, p.webhook_url,
      p.created_at, p.finished_at, p.expires_at, p.story_bible->>'logline' logline,
      jsonb_build_object('setup_fee', p.autopilot->'setup_fee', 'setup_refunded', p.autopilot->'setup_refunded', 'api', p.autopilot->'api') ap,
      (select count(*)::int from shots where project_id = p.id) shots_total,
      (select count(*)::int from shots where project_id = p.id and status = 'approved') shots_done,
      (select coalesce(sum(duration), 0)::int from shots where project_id = p.id) secs_total,
      (select coalesce(sum(hold_usd) filter (where status not in ('failed','rejected')), 0)::float from takes where project_id = p.id) holds,
      (select progress from jobs where project_id = p.id and kind = 'project.autopilot' order by id desc limit 1) ap_progress,
      w.status w_status, w.attempts w_attempts
    from projects p
    left join lateral (select status, attempts from webhook_deliveries where project_id = p.id order by id desc limit 1) w on true
    where p.origin = 'api' and p.mode = 'vibe' and ${where} ${order} limit ${limit}`;
}

/** Each film's episodes with their newest finished edit. */
async function episodesOf(ids: string[]) {
  if (!ids.length) return new Map<string, any[]>();
  const rows = await sql`select e.project_id, e.idx, e.title, e.label, e.status, c.file_key, c.thumb_key, c.duration
    from episodes e left join lateral (select file_key, thumb_key, duration from cuts where episode_id = e.id and status = 'done' order by created_at desc limit 1) c on true
    where e.project_id in ${sql(ids)} order by e.project_id, e.idx`;
  const by = new Map<string, any[]>();
  for (const r of rows) by.set(r.project_id, [...(by.get(r.project_id) || []), r]);
  return by;
}

export async function filmObject(r: any, episodes: any[]) {
  const b = r.brief || {}, ap = r.ap || {}, api = ap.api || {};
  const status = FILM_STATUS[r.stage] || 'writing';
  const setup = Number(ap.setup_fee ?? setupFeeFor({ episodes: b.episodes || 1, seconds: b.seconds || 60 }));
  const filming = r.shots_total ? sellPrice(r.resolution || '768P', r.secs_total) : null;
  const estimated = money(setup + (filming ?? sellPrice('768P', (b.episodes || 1) * (b.seconds || 60))));
  const failedMsg = String(r.stage_error || 'The film couldn’t be finished.').replace(/Press Try again/g, 'Retry it (POST /films/{id}/retry)');
  return {
    id: r.id, object: 'film' as const, status, stage_detail: ['writing', 'filming', 'editing'].includes(status) ? r.ap_progress || null : null,
    prompt: b.prompt, title: r.title, logline: r.logline || null, format: b.format, language: r.language, aspect_ratio: r.aspect,
    episodes_requested: Number(b.episodes || 1), episode_seconds: Number(b.seconds || 0),
    cost: { setup_fee_usd: money(setup), filming_usd: filming == null ? null : money(filming), estimated_total_usd: estimated,
      charged_usd: money((ap.setup_refunded ? 0 : Number(ap.setup_fee || 0)) + Number(r.holds || 0)) },
    max_cost_usd: api.max_cost_usd == null ? null : Number(api.max_cost_usd), auto_approve: api.auto_approve !== false,
    approval: r.stage === 'ready' ? { required: true, reason: r.stage_error || 'Waiting for your approval: POST /films/{id}/approve to film it.' } : null,
    progress: { shots: Number(r.shots_total || 0), shots_filmed: Number(r.shots_done || 0) },
    episodes: await Promise.all(episodes.map(async (e) => ({
      index: e.idx, title: e.title || e.label || `Episode ${e.idx}`, status: e.status,
      output: e.file_key ? { url: (await link(e.file_key))!, thumbnail_url: await link(e.thumb_key), duration: Number(e.duration || 0) } : null,
    }))),
    error: status === 'failed' ? { code: 'film_failed', message: failedMsg } : null,
    webhook: webhookOf(r), metadata: r.api_metadata ?? null,
    created_at: iso(r.created_at)!, completed_at: iso(r.finished_at), expires_at: iso(r.expires_at),
  };
}

export async function filmObjects(rows: any[]) {
  const eps = await episodesOf(rows.map((r) => r.id));
  return Promise.all(rows.map((r) => filmObject(r, eps.get(r.id) || [])));
}

export async function filmById(ownerId: string, id: string) {
  const rows = await filmRows(sql`p.id = ${id} and p.owner_id = ${ownerId}`);
  return rows.length ? (await filmObjects(rows))[0] : null;
}
