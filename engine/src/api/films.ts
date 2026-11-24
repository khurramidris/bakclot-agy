// Films through the API: an idea in, a finished microdrama (or short film, web series, YouTube story) out, written,
// cast, filmed and edited by the same pipeline as the app. A film stops at its price like in the app; through the API
// it goes on by itself when auto_approve is on and the price is within max_cost_usd, otherwise it waits for
// POST /films/{id}/approve.

import { sql } from '../db.js';
import { config } from '../config.js';
import { sellPrice } from '../billing.js';
import { approveFilm, createFilm, renderPrice, resumeFilm } from '../pipeline/films.js';
import { startAutopilot } from '../pipeline/autopilot.js';
import { deleteProject } from '../pipeline/projects.js';
import { FORMATS, resolveBrief, setupFeeFor } from '../pipeline/writer.js';
import { PermanentError } from '../queue.js';
import { ApiError, invalid, notFound } from './errors.js';
import { FilmCreate, FilmQuote } from './schemas.js';
import { checkAccess, checkKeyLimit, recordRefusal, type ApiCaller } from './access.js';
import { checkWebhookUrl } from './videos.js';
import { filmById, filmObjects, filmRows } from './views.js';

const money = (n: number) => Math.round(n * 100) / 100;

/** The brief a request describes, checked against what the format and the API allow. */
function briefOf(b: { prompt: string; format: string; episodes?: number; episode_seconds?: number; total_seconds?: number; language?: string }) {
  const f = FORMATS[b.format];
  if (b.episode_seconds !== undefined && (b.episode_seconds < f.seconds[0] || b.episode_seconds > f.seconds[1])) {
    throw invalid(`A ${f.label.toLowerCase()} episode is ${f.seconds[0]} to ${f.seconds[1]} seconds.`, 'episode_seconds');
  }
  if (b.episodes !== undefined && b.episodes > f.episodes[1]) throw invalid(`A ${f.label.toLowerCase()} has ${f.episodes[1]} part.`, 'episodes');
  if (b.total_seconds !== undefined && (b.episodes !== undefined || b.episode_seconds !== undefined) && f.episodes[1] !== 1) {
    throw invalid('Give either total_seconds, or episodes and episode_seconds.', 'total_seconds');
  }
  const brief = resolveBrief({ prompt: b.prompt, format: b.format, episodes: b.episodes, seconds: b.episode_seconds, total_seconds: b.total_seconds, language: b.language, review: false });
  const total = brief.episodes * brief.seconds;
  if (total > config.api.filmMaxSeconds) {
    throw invalid(`A film made through the API is at most ${config.api.filmMaxSeconds} seconds; this one would be ${total}.`, b.total_seconds !== undefined ? 'total_seconds' : 'episodes');
  }
  return brief;
}

/** What a film of this shape costs: the setup fee now, filming at its price. Filming is exact once the shots are planned. */
export function quote(raw: unknown) {
  const b = FilmQuote.parse(raw);
  const brief = briefOf({ prompt: 'a quote for the price of a film', ...b });
  const total = brief.episodes * brief.seconds, setup = setupFeeFor(brief), filming = sellPrice('768P', total);
  return {
    object: 'film_quote' as const, format: brief.format, episodes: brief.episodes, episode_seconds: brief.seconds, total_seconds: total,
    setup_fee_usd: setup, estimated_filming_usd: money(filming), estimated_total_usd: money(setup + filming),
    note: 'Filming is priced per second of finished film. The exact price is known once the shots are planned, before anything is filmed.',
  };
}

export async function createApiFilm(who: ApiCaller, raw: unknown) {
  const b = FilmCreate.parse(raw);
  const brief = briefOf(b);
  const setup = setupFeeFor(brief), estimate = money(setup + sellPrice('768P', brief.episodes * brief.seconds));
  if (b.max_cost_usd != null && b.max_cost_usd < setup) throw invalid(`max_cost_usd must at least cover the $${setup.toFixed(2)} setup fee.`, 'max_cost_usd');
  if (b.max_cost_usd != null && b.auto_approve && b.max_cost_usd < estimate * 0.9) {
    throw invalid(`This film is estimated at $${estimate.toFixed(2)}. Raise max_cost_usd, make it shorter, or set auto_approve to false and approve its price yourself.`, 'max_cost_usd');
  }
  const webhookUrl = await checkWebhookUrl(b.webhook_url);
  // With auto_approve the film goes straight through, so the whole estimate must be affordable now; otherwise the setup fee.
  await checkAccess(who, { cost: b.auto_approve ? Math.min(estimate, b.max_cost_usd ?? estimate) : setup, kind: 'film' });
  try {
    const { project } = await createFilm(who.uid, brief, { keyId: who.keyId, webhookUrl, metadata: b.metadata ?? null, maxCostUsd: b.max_cost_usd ?? null, autoApprove: b.auto_approve });
    return project;
  } catch (e: any) {
    if (e?.code === 'sensitive_content') await recordRefusal(who.uid, e.category || 'other');
    throw e;
  }
}

async function ownFilm(who: ApiCaller, id: string): Promise<any> {
  const [p] = await sql`select * from projects where id = ${id} and owner_id = ${who.uid} and origin = 'api' and mode = 'vibe'`;
  if (!p) throw notFound('film');
  return p;
}

export async function listFilms(who: ApiCaller, q: { limit?: string; starting_after?: string }) {
  const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
  let cursor = sql`true`;
  if (q.starting_after) {
    const [c] = await sql`select created_at, id from projects where id = ${q.starting_after} and owner_id = ${who.uid} and origin = 'api'`;
    if (!c) throw invalid('starting_after must be the id of one of your films.', 'starting_after');
    cursor = sql`(p.created_at, p.id) < (${c.created_at}, ${c.id})`;
  }
  const rows = await filmRows(sql`p.owner_id = ${who.uid} and ${cursor}`, sql`order by p.created_at desc, p.id desc`, limit + 1);
  return { object: 'list' as const, data: await filmObjects(rows.slice(0, limit)), has_more: rows.length > limit };
}

export async function getFilm(who: ApiCaller, id: string) {
  const f = await filmById(who.uid, id);
  if (!f) throw notFound('film');
  return f;
}

/** Film it at the price shown: the explicit go-ahead, over max_cost_usd if need be. */
export async function approveApiFilm(who: ApiCaller, id: string) {
  const p = await ownFilm(who, id);
  if (p.stage !== 'ready') throw new ApiError(409, 'invalid_request', 'bad_state', 'This film is not waiting for approval.');
  await checkKeyLimit(who, await renderPrice(p));
  await approveFilm(p);
  await startAutopilot(p.id);
  return getFilm(who, id);
}

/** Continue a failed film from the step it stopped at. */
export async function retryApiFilm(who: ApiCaller, id: string) {
  const p = await ownFilm(who, id);
  if (who.suspended) throw new ApiError(403, 'permission_error', 'account_suspended', `API access is suspended (${who.suspended}).`);
  try { await resumeFilm(p); } catch (e) { if (e instanceof PermanentError && e.code === 'bad_state') throw new ApiError(409, 'invalid_request', 'bad_state', 'Only a failed film can be retried.'); throw e; }
  await startAutopilot(p.id);
  return getFilm(who, id);
}

/** Delete a film: anything still being made stops, held credit is refunded, every file is deleted. */
export async function removeFilm(who: ApiCaller, id: string) {
  const p = await ownFilm(who, id);
  await deleteProject(p.id);
  return { id, object: 'film' as const, deleted: true };
}
