// Films (prompt → script → cast → shots → finished video), as the web app and the public API both start them.

import { sql, begin } from '../db.js';
import { config } from '../config.js';
import { PermanentError } from '../queue.js';
import { balanceOf, debit, sellPrice } from '../billing.js';
import { moderate, refusal } from '../moderation.js';
import { FORMATS, setupFeeFor, type Brief } from './writer.js';
import { startAutopilot } from './autopilot.js';
import type { ApiOrigin } from './clips.js';

/** What the public API adds to a film: see ApiOrigin, plus the most the film may cost and whether it may film unasked. */
export interface FilmApi extends ApiOrigin { maxCostUsd?: number | null; autoApprove?: boolean }

/**
 * Create a film from a brief: check the idea, charge the setup fee and hand it to the autopilot, in that order.
 * The idea is content-checked here because everything downstream is written from it and ends up at a video model
 * (ours has no filter of its own), and because nobody should pay a setup fee for a film that can't be made.
 */
export async function createFilm(uid: string, brief: Brief, api?: FilmApi) {
  const verdict = await moderate({ ownerId: uid, text: `An idea for a ${FORMATS[brief.format].label.toLowerCase()} to be written and filmed:\n${brief.prompt}` });
  if (!verdict.allowed) throw refusal(verdict);
  const p = await begin(async (tx) => {
    const [p] = await tx`insert into projects (owner_id, title, format, aspect, language, mode, stage, brief, settings, origin, api_key_id, webhook_url, api_metadata)
      values (${uid}, ${brief.prompt.slice(0, 80)}, ${brief.engineFormat}, ${brief.aspect}, ${brief.language}, 'vibe', 'writing', ${tx.json(brief as any)},
              ${tx.json({ chain_clips: true, burn_subtitles: false })}, ${api ? 'api' : 'app'}, ${api?.keyId ?? null}, ${api?.webhookUrl ?? null},
              ${api?.metadata ? tx.json(api.metadata as any) : null}) returning *`;
    const fee = await debit(tx, uid, setupFeeFor(brief), 'setup_fee', p.id, api?.keyId);
    const state = { ...(fee ? { setup_fee: fee } : {}), ...(api ? { api: { max_cost_usd: api.maxCostUsd ?? null, auto_approve: api.autoApprove !== false } } : {}) };
    if (Object.keys(state).length) await tx`update projects set autopilot = ${tx.json(state as any)} where id = ${p.id}`;
    return { ...p, autopilot: state };
  });
  return { project: p, job_id: await startAutopilot(p.id) };
}

/** What filming the shots that still need it costs the customer. */
export async function renderPrice(p: { id: string; resolution: string }): Promise<number> {
  const [{ todo }] = await sql`select coalesce(sum(duration) filter (where status <> 'approved'), 0)::int todo from shots where project_id = ${p.id}`;
  return sellPrice(p.resolution, todo);
}

/**
 * The checkpoint: move a film that is waiting at its price into filming. The balance has to cover the price now;
 * each clip then holds its own share as it starts. Returns the price. The caller restarts the autopilot.
 */
export async function approveFilm(p: any): Promise<{ price_usd: number }> {
  if (p.mode !== 'vibe' || p.stage !== 'ready') throw new PermanentError('This project is not waiting to be rendered.', 'bad_state');
  const price = await renderPrice(p);
  const balance = await balanceOf(p.owner_id);
  if (config.credits.enforce && balance < price) {
    throw new PermanentError(`Rendering costs $${price.toFixed(2)} and your balance is $${balance.toFixed(2)}. Add credits to continue.`, 'insufficient_credit');
  }
  const gen = p.autopilot?.api ? { api: { ...p.autopilot.api, generation: (Number(p.autopilot.api.generation) || 0) + 1 } } : {};
  const [go] = await sql`update projects set stage = 'rendering', stage_error = null, autopilot = autopilot || ${sql.json(gen as any)}, updated_at = now()
    where id = ${p.id} and stage = 'ready' returning id`;
  if (!go) throw new PermanentError('This project is already rendering.', 'bad_state');
  return { price_usd: price };
}

/**
 * Pick a failed film up again from the stage it failed in. Every reference and shot that failed gets its automatic
 * retry again (without this, casting skips the characters and sets already retried once and fails straight away), and
 * a failed rendering stage films the failed shots again. A setup fee that was refunded is charged again. The caller
 * restarts the autopilot.
 */
export async function resumeFilm(p: any): Promise<{ stage: string }> {
  if (p.mode !== 'vibe' || p.stage !== 'failed') throw new PermanentError('Only a failed project can be resumed.', 'bad_state');
  const st = p.autopilot || {};
  const stage = st.failed_stage || 'writing';
  await begin(async (tx) => {
    const patch: any = { retried_assets: [], retried_shots: [], ...(stage === 'assembling' ? { cuts: null } : stage === 'rendering' ? { render_queued: false } : {}) };
    if (stage === 'writing' && st.writing) patch.writing = { ...st.writing, tries: 0, problem: null }; // a fresh try at the failed writing step
    if (st.setup_refunded) { patch.setup_fee = await debit(tx, p.owner_id, Number(st.setup_fee) || config.credits.setupFeeUsd, 'setup_fee', p.id, p.api_key_id); patch.setup_refunded = false; }
    if (st.api) patch.api = { ...st.api, generation: (Number(st.api.generation) || 0) + 1 }; // the API notifies again for this new attempt
    const [ok] = await tx`update projects set stage = ${stage}, stage_error = null, autopilot = autopilot || ${tx.json(patch)}, updated_at = now() where id = ${p.id} and stage = 'failed' returning id`;
    if (!ok) throw new PermanentError('This project is already being retried.', 'bad_state');
  });
  return { stage };
}
