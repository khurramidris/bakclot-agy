// Providers: what each company we pay (Anthropic, MiniMax, RunPod…) cost per day, this month against your budgets,
// RunPod's balance, Claude by writing step and model, video by provider and resolution, and the average cost of a video.

import { sql } from '../db.js';
import { config } from '../config.js';
import { PROVIDER_NAMES, providerOf, runpodBalance, takeOf } from './shared.js';
import { projectMonth, r2, runwayDays } from './stats.js';

const startOfMonth = () => sql`(date_trunc('month', now() at time zone 'utc') at time zone 'utc')`;

/** Spend per provider this month, the last week's daily rate, and what's left of each budget (PROVIDER_BUDGETS_MONTHLY). */
export async function budgetStatus() {
  const rows = await sql`select ${providerOf()} provider,
      coalesce(sum(u.cost_usd) filter (where u.created_at >= ${startOfMonth()}), 0)::float month_usd,
      coalesce(sum(u.cost_usd) filter (where u.created_at > now() - interval '7 days'), 0)::float week_usd
    from usage_events u where u.created_at > least(${startOfMonth()}, now() - interval '7 days') group by 1`;
  const by = new Map<string, any>(rows.map((r: any) => [r.provider, r]));
  const names = new Set([...by.keys(), ...Object.keys(config.ops.budgets)]);
  return [...names].sort().map((p) => {
    const r = by.get(p) || { month_usd: 0, week_usd: 0 };
    const perDay = r.week_usd / 7;
    const budget = config.ops.budgets[p] ?? null;
    const left = budget === null ? null : r2(budget - r.month_usd);
    return {
      provider: p, name: PROVIDER_NAMES[p] ?? p, month_usd: r2(r.month_usd), per_day_usd: r2(perDay),
      projected_month_usd: projectMonth(r.month_usd, perDay), budget_usd: budget, left_usd: left,
      runway_days: left === null ? null : runwayDays(left, perDay),
    };
  });
}

export async function providers(days: number) {
  const since = sql`now() - make_interval(days => ${days})`;
  const [daily, budgets, balance, claude, video, perVideo, [est]] = await Promise.all([
    sql`select to_char((u.created_at at time zone 'utc')::date, 'YYYY-MM-DD') as day, ${providerOf()} provider, sum(u.cost_usd)::float usd
      from usage_events u where u.created_at > ${since} group by 1, 2 order by 1`,
    budgetStatus(),
    runpodBalance(),
    sql`select split_part(coalesce(ref_id, '?'), ':', 1) step, coalesce(model, 'not recorded') model, count(*)::int calls,
        coalesce(sum(units), 0)::float tokens, coalesce(sum(cost_usd), 0)::float usd
      from usage_events where kind = 'llm' and created_at > ${since} group by 1, 2 order by usd desc limit 40`,
    sql`select coalesce(t.provider, ${config.videoProvider}::text) provider, coalesce(t.resolution, 'unknown') resolution, count(*)::int renders,
        coalesce(sum(u.units), 0)::float seconds, coalesce(sum(u.cost_usd), 0)::float usd
      from usage_events u left join takes t on t.id = ${takeOf()} where u.kind = 'video' and u.created_at > ${since} group by 1, 2 order by usd desc`,
    sql`select p.mode, count(distinct p.id)::int videos,
        coalesce(sum(u.cost_usd) filter (where u.kind = 'llm'), 0)::float writing, coalesce(sum(u.cost_usd) filter (where u.kind = 'image'), 0)::float pictures,
        coalesce(sum(u.cost_usd) filter (where u.kind = 'voice'), 0)::float voices, coalesce(sum(u.cost_usd) filter (where u.kind = 'video'), 0)::float video
      from projects p join usage_events u on u.project_id = p.id where p.created_at > ${since} group by p.mode`,
    sql`select coalesce(sum(cost_usd) filter (where estimated), 0)::float estimated, coalesce(sum(cost_usd), 0)::float total
      from usage_events where created_at > ${since}`,
  ]);

  // One row per day with a column per provider, for a stacked chart.
  const names = [...new Set(daily.map((d: any) => d.provider as string))].sort();
  const byDay = new Map<string, Record<string, number | string>>();
  for (const d of daily as any[]) {
    const row = byDay.get(d.day) || { day: d.day };
    row[d.provider] = r2(d.usd);
    byDay.set(d.day, row);
  }
  const totals = names.map((p) => ({ provider: p, name: PROVIDER_NAMES[p] ?? p, usd: r2(daily.filter((d: any) => d.provider === p).reduce((t: number, d: any) => t + d.usd, 0)) }))
    .sort((a, b) => b.usd - a.usd);
  const rp = balance && 'balance_usd' in balance ? balance : null;

  return {
    range: { days },
    totals, providers: names, daily: [...byDay.values()],
    budgets,
    runpod: !config.runpod.apiKey ? null : rp
      ? { ...rp, runway_days: rp.spend_per_hour_usd > 0 ? runwayDays(rp.balance_usd, rp.spend_per_hour_usd * 24) : null }
      : { error: (balance as any)?.error ?? 'unavailable' },
    claude: claude.map((c: any) => ({ ...c, usd: r2(c.usd) })),
    video: video.map((v: any) => ({ ...v, usd: r2(v.usd), per_second_usd: v.seconds > 0 ? Math.round((v.usd / v.seconds) * 10000) / 10000 : null })),
    per_video: perVideo.map((p: any) => {
      const each = (v: number) => (p.videos ? r2(v / p.videos) : 0);
      return { mode: p.mode, videos: p.videos, writing: each(p.writing), pictures: each(p.pictures), voices: each(p.voices), video: each(p.video),
        total: each(p.writing + p.pictures + p.voices + p.video) };
    }),
    estimated_share_pct: est.total > 0 ? Math.round((est.estimated / est.total) * 100) : 0,
    notes: [
      'Costs are our own estimates from list prices (CLAUDE_*, PRICE_* settings). Compare them with each provider’s invoice once a month.',
      ...(config.videoProvider === 'runpod' ? ['RunPod video cost counts render time only: worker start-up and idle minutes are on the RunPod bill.'] : []),
      ...(!Object.keys(config.ops.budgets).length ? ['Set PROVIDER_BUDGETS_MONTHLY (e.g. anthropic:300,minimax:200) to see what’s left of each month’s budget.'] : []),
    ],
  };
}
