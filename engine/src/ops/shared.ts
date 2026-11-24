// Shared pieces of the ops dashboard's reports: short caches for outside calls, the app's health check, RunPod's
// account balance, which provider each cost belongs to, and the activity feed.

import { sql } from '../db.js';
import { config } from '../config.js';
import { endpointHealth } from '../providers/runpod.js';

const cache = new Map<string, { at: number; v: unknown }>();
/** Reuse an outside call's answer for `ttlMs`, so a dashboard refreshing every few seconds doesn't hammer anyone. */
export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
export const clearCache = () => cache.clear();

export type Ping = { ok: boolean; ms: number; status?: number; error?: string | null };
/** Does the app answer its health check? (It also proves the app can reach the database.) */
export const pingEngine = () => cached<Ping>('engine', 10_000, async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(`${config.ops.engineUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const j: any = await r.json().catch(() => null);
    const ok = r.ok && j?.ok === true;
    return { ok, ms: Date.now() - t0, status: r.status, error: ok ? null : `answered ${r.status}` };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t0, error: e?.name === 'TimeoutError' ? 'no answer within 5 seconds' : 'unreachable' };
  }
});

/** RunPod's live view of the endpoint (workers, queue), or why it couldn't be read; null when video isn't on RunPod. */
export const gpuHealth = () => config.videoProvider === 'runpod' && config.runpod.apiKey
  ? cached<any>('gpu', 15_000, () => endpointHealth().catch((e: any) => ({ error: String(e?.message || e).slice(0, 200) })))
  : Promise.resolve(null);

export type Balance = { balance_usd: number; spend_per_hour_usd: number } | { error: string } | null;
/** RunPod account balance and current burn (GraphQL `myself`), refreshed every 5 minutes. */
export const runpodBalance = (): Promise<Balance> => !config.runpod.apiKey ? Promise.resolve(null) : cached<Balance>('runpod-balance', 300_000, async () => {
  try {
    const r = await fetch(`${config.runpod.graphqlUrl}?api_key=${encodeURIComponent(config.runpod.apiKey)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ query: 'query { myself { clientBalance currentSpendPerHr } }' }),
    });
    const j: any = await r.json().catch(() => null);
    const me = j?.data?.myself;
    if (!r.ok || !me) return { error: `RunPod didn’t return the balance (${r.status})` };
    return { balance_usd: Number(me.clientBalance) || 0, spend_per_hour_usd: Number(me.currentSpendPerHr) || 0 };
  } catch {
    return { error: 'RunPod didn’t answer' };
  }
});

const UUID_SQL = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
/**
 * Which company a usage_events row (alias u) was paid to: Claude for writing, MiniMax for voices, the configured image
 * service for pictures, and for video the provider that rendered the take (deleted takes: today's video setting).
 */
export const providerOf = () => sql`case u.kind when 'llm' then 'anthropic' when 'voice' then 'minimax'
  when 'image' then ${config.images.provider}::text
  else coalesce((select t.provider from takes t where t.id = (case when u.ref_id ~* ${UUID_SQL} then u.ref_id::uuid end)), ${config.videoProvider}::text) end`;
export const takeOf = () => sql`(case when u.ref_id ~* ${UUID_SQL} then u.ref_id::uuid end)`;

export const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic (Claude)', minimax: 'MiniMax', runpod: 'RunPod', gemini: 'Google Gemini', openai: 'OpenAI', mock: 'Mock (local)',
};

/** Stages where the machine is working, and where it waits for the customer. */
export const WORKING = ['writing', 'breakdown', 'casting', 'planning', 'rendering', 'assembling'];
export const WAITING = ['story_review', 'script_review', 'cast_review', 'ready'];

export type FeedItem = {
  at: string; kind: string; owner_id: string | null; email: string | null; project_id: string | null;
  title: string | null; detail: string | null; usd: number | null;
};

/** What just happened across the platform, newest first: sign-ups, payments, finished and failed videos, approvals
 * waiting, plan changes, content refusals, failed renders, steps and webhooks. */
export async function feed(limit = 30): Promise<FeedItem[]> {
  const n = Math.min(200, Math.max(1, limit));
  const rows = await sql`
    (select a.created_at as at, 'signup' as kind, a.owner_id, a.email, null::uuid as project_id, null::text as title, null::text as detail, null::float as usd
      from credit_accounts a order by a.created_at desc limit ${n})
    union all
    (select x.created_at, case when x.id like 'ls:invoice:%' then 'plan_payment' else 'topup' end, x.owner_id, a.email, null, null, null, x.amount_usd::float
      from payments x left join credit_accounts a on a.owner_id = x.owner_id order by x.created_at desc limit ${n})
    union all
    (select e.at, 'stage_' || e.stage, e.owner_id, a.email, e.project_id, p.title, case when e.stage = 'failed' then p.stage_error end, null
      from stage_events e left join projects p on p.id = e.project_id left join credit_accounts a on a.owner_id = e.owner_id
      where e.stage in ('done', 'failed', 'ready') order by e.at desc limit ${n})
    union all
    (select s.updated_at, 'plan_' || s.status, s.owner_id, a.email, null, null, null, null
      from subscriptions s left join credit_accounts a on a.owner_id = s.owner_id
      where s.status in ('cancelled', 'expired', 'past_due', 'unpaid', 'paused') order by s.updated_at desc limit ${n})
    union all
    (select m.at, 'refused', m.owner_id, a.email, m.project_id, p.title, m.category, null
      from moderation_events m left join projects p on p.id = m.project_id left join credit_accounts a on a.owner_id = m.owner_id
      where not m.allowed order by m.at desc limit ${n})
    union all
    (select t.finished_at, 'render_failed', p.owner_id, a.email, t.project_id, p.title, coalesce(t.error_code, 'error') || ': ' || left(coalesce(t.error, ''), 160), null
      from takes t join projects p on p.id = t.project_id left join credit_accounts a on a.owner_id = p.owner_id
      where t.status = 'failed' and t.finished_at is not null order by t.finished_at desc limit ${n})
    union all
    (select j.updated_at, 'job_failed', p.owner_id, a.email, j.project_id, p.title, j.kind || ': ' || left(coalesce(j.error, ''), 160), null
      from jobs j left join projects p on p.id = j.project_id left join credit_accounts a on a.owner_id = p.owner_id
      where j.status = 'failed' and j.kind <> 'project.autopilot' order by j.updated_at desc limit ${n})
    union all
    (select w.at, 'webhook_failed', null, null, null, null, coalesce(w.event_name, 'unknown event') || ': ' || coalesce(w.error, ''), null
      from webhook_events w where not w.ok order by w.at desc limit ${n})
    order by at desc limit ${n}`;
  return rows.map((r: any) => ({ ...r, at: new Date(r.at).toISOString() }));
}
