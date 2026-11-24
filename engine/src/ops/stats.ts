// Pure helpers for the ops dashboard's reports: percentiles from latency histograms, runway, cohorts, chart buckets,
// and the "needs you" list shown at the top of the Overview. No database access here, so all of it is unit-tested.

import { LATENCY_BOUNDS } from '../telemetry.js';

export const r2 = (v: number) => Math.round(v * 100) / 100;
export const clampDays = (v: unknown, d = 30) => Math.min(365, Math.max(1, Math.round(Number(v)) || d));
/** The windows the Backend page offers, in hours. */
export const HOURS = [1, 6, 24, 168, 720];
export const clampHours = (v: unknown) => (HOURS.includes(Number(v)) ? Number(v) : 24);

/** Seconds per chart point for a window, so a chart has between ~60 and ~170 points. */
export function stepFor(hours: number) {
  if (hours <= 1) return 60;
  if (hours <= 6) return 300;
  if (hours <= 48) return 900;
  if (hours <= 24 * 8) return 3600;
  return 6 * 3600;
}

/**
 * The latency below which a share `q` (0–1) of requests fell, from a histogram over LATENCY_BOUNDS (the last bucket
 * holds everything slower). Interpolates inside the bucket and never exceeds the slowest request seen.
 */
export function percentileMs(hist: number[] | null | undefined, q: number, maxMs: number): number | null {
  const h = hist || [];
  const total = h.reduce((a, b) => a + (b || 0), 0);
  if (!total) return null;
  const target = Math.max(0, Math.min(1, q)) * total;
  let run = 0;
  for (let i = 0; i < h.length; i++) {
    const n = h[i] || 0;
    if (!n) continue;
    if (run + n >= target) {
      const lo = i === 0 ? 0 : LATENCY_BOUNDS[i - 1]!;
      const hi = i < LATENCY_BOUNDS.length ? LATENCY_BOUNDS[i]! : Math.max(maxMs, lo);
      const v = lo + (hi - lo) * ((target - run) / n);
      return Math.round(Math.min(v, maxMs) * 10) / 10;
    }
    run += n;
  }
  return Math.round(maxMs * 10) / 10;
}

/** Days until `left` dollars run out at `perDay`; null when nothing is being spent. */
export function runwayDays(left: number, perDay: number): number | null {
  if (perDay <= 0) return null;
  return Math.max(0, Math.round((left / perDay) * 10) / 10);
}

/** Month-to-date spend projected to the end of the month at the last week's daily rate. */
export function projectMonth(spentSoFar: number, perDay: number, now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysLeft = (end - now.getTime()) / 86_400_000;
  return r2(spentSoFar + perDay * daysLeft);
}

/**
 * Weekly retention: rows of (cohort week, weeks since sign-up, customers active that week) and each cohort's size →
 * one row per cohort with the share active in week 0, 1, 2… (only weeks that have happened).
 */
export function cohortMatrix(rows: { cohort: string; week: number | null; active: number }[], sizes: Record<string, number>, now = new Date()) {
  const cohorts = Object.keys(sizes).sort();
  return cohorts.map((cohort) => {
    const size = sizes[cohort] || 0;
    const weeksSince = Math.floor((now.getTime() - new Date(`${cohort}T00:00:00Z`).getTime()) / (7 * 86_400_000));
    const weeks: (number | null)[] = [];
    for (let w = 0; w <= weeksSince; w++) {
      const r = rows.find((x) => x.cohort === cohort && x.week === w);
      weeks.push(size ? Math.round(((r?.active || 0) / size) * 100) : null);
    }
    return { cohort, size, weeks };
  });
}

export type Level = 'bad' | 'warn' | 'info';
export type Need = { level: Level; title: string; detail: string; page: string };

/** Everything the Overview's "needs you" list looks at. Missing facts (null) are skipped. */
export type Facts = {
  engine: { ok: boolean; error?: string | null };
  heartbeatMinutes: number | null;       // since the last health snapshot; null = never
  oldestRenderMinutes: number;
  rendersWaiting: number;
  oldestJobMinutes: number;
  jobsFailed24h: number;
  filmsFailed24h: number;
  api: { requests: number; errors: number };  // last hour, API routes only
  webhookFailures24h: number;            // deliveries the app couldn't apply (not counting bad signatures)
  webhookBadSignatures24h: number;
  webhookOk24h: number;
  pastDue: number;
  gpuError: string | null;
  budgets: { provider: string; runwayDays: number | null; left: number }[];
  runpodRunwayDays: number | null;
  costlyCustomers: number;               // cost us more than they paid, last 30 days
  waitingForApproval: number;            // films stopped at "Your approval" for more than a day
  refusals24h: { checks: number; refused: number };
  profitMonth: number | null;
  revenueMonth: number;
};

/** The problems worth your attention right now, worst first. An empty list means all clear. */
export function needsYou(f: Facts): Need[] {
  const out: Need[] = [];
  const add = (level: Level, title: string, detail: string, page: string) => out.push({ level, title, detail, page });
  const s = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  if (!f.engine.ok) add('bad', 'The app isn’t answering', `Its health check failed${f.engine.error ? ` (${f.engine.error})` : ''}. Customers can’t use Backlot. Check Railway → the app service → Deployments.`, 'backend');
  if (f.heartbeatMinutes === null) add('warn', 'No heartbeat from the job worker yet', 'Deploy the latest engine: it records the platform’s vital signs once a minute.', 'backend');
  else if (f.heartbeatMinutes > 3) add('bad', 'The job worker has stopped', `No heartbeat for ${Math.round(f.heartbeatMinutes)} minutes: films and clips aren’t moving.`, 'backend');
  if (f.oldestRenderMinutes > 30) add('bad', 'Renders are stuck', `${s(f.rendersWaiting, 'render')} waiting; the oldest started ${f.oldestRenderMinutes} minutes ago.`, 'live');
  else if (f.oldestRenderMinutes > 10) add('warn', 'Renders are slow', `The oldest render in progress started ${f.oldestRenderMinutes} minutes ago.`, 'live');
  if (f.oldestJobMinutes > 10) add('bad', 'Background work is backed up', `The oldest step has waited ${f.oldestJobMinutes} minutes for a worker.`, 'live');
  else if (f.oldestJobMinutes > 3) add('warn', 'Background work is slow', `The oldest step has waited ${f.oldestJobMinutes} minutes.`, 'live');
  if (f.gpuError) add('bad', 'RunPod isn’t answering', f.gpuError, 'backend');
  if (f.api.requests >= 20 && f.api.errors / f.api.requests >= 0.02) add('bad', 'The app is returning errors', `${s(f.api.errors, 'server error')} in ${f.api.requests} requests in the last hour.`, 'backend');
  else if (f.api.errors > 0) add('warn', 'Some server errors', `${s(f.api.errors, 'server error')} in the last hour.`, 'backend');
  if (f.webhookFailures24h > 0) add('bad', 'Payment webhooks are failing', `${s(f.webhookFailures24h, 'delivery', 'deliveries')} from Lemon Squeezy failed in 24 hours: a payment or plan change may not have reached the app.`, 'backend');
  // A wrong signature is either someone poking at the address, or (when nothing gets through) the wrong secret.
  if (f.webhookBadSignatures24h > 0 && f.webhookOk24h === 0) add('warn', 'Webhooks with a wrong signature', `${s(f.webhookBadSignatures24h, 'delivery', 'deliveries')} in 24 hours and none accepted. If Lemon Squeezy sent them, LEMONSQUEEZY_WEBHOOK_SECRET doesn’t match the webhook’s signing secret.`, 'backend');
  for (const b of f.budgets) {
    if (b.left <= 0) add('bad', `${b.provider} budget used up`, 'This month’s budget is spent. Raise it or check the spend.', 'providers');
    else if (b.runwayDays !== null && b.runwayDays < 7) add(b.runwayDays < 2 ? 'bad' : 'warn', `${b.provider} budget runs out soon`, `About ${b.runwayDays} days left at the current rate.`, 'providers');
  }
  if (f.runpodRunwayDays !== null && f.runpodRunwayDays < 3) add(f.runpodRunwayDays < 1 ? 'bad' : 'warn', 'RunPod balance is low', `About ${f.runpodRunwayDays} days of GPU time left at the current rate. Top up on runpod.io.`, 'providers');
  if (f.jobsFailed24h > 0) add('warn', s(f.jobsFailed24h, 'background step') + ' failed', 'In the last 24 hours, after every retry.', 'backend');
  if (f.filmsFailed24h > 0) add('warn', s(f.filmsFailed24h, 'video') + ' failed', 'In the last 24 hours. Customers were refunded what wasn’t delivered.', 'product');
  if (f.pastDue > 0) add('warn', f.pastDue === 1 ? '1 customer’s payment is failing' : `${f.pastDue} customers’ payments are failing`, 'The card was declined at renewal. Write to them.', 'business');
  if (f.refusals24h.checks >= 5 && f.refusals24h.refused / f.refusals24h.checks > 0.3) add('warn', 'Many content refusals', `${f.refusals24h.refused} of ${f.refusals24h.checks} checks refused in 24 hours: the check may be too strict. Read a few.`, 'safety');
  if (f.profitMonth !== null && f.revenueMonth > 0 && f.profitMonth < 0) add('warn', 'Losing money this month', 'Costs are above revenue so far this month.', 'business');
  if (f.costlyCustomers > 0) add('info', s(f.costlyCustomers, 'customer') + ' cost more than they paid', 'In the last 30 days. Usually free credit you granted; otherwise worth a look.', 'safety');
  if (f.waitingForApproval > 0) add('info', s(f.waitingForApproval, 'film') + ' waiting for approval', 'The customer stopped at “Your approval” more than a day ago. A nudge may help.', 'product');
  const rank = { bad: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
