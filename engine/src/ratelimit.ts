// Per-customer request limits, so one account (or a script using its token) can't flood the API or run up AI
// costs. Fixed windows counted in memory: each instance counts on its own, which is enough to stop runaway
// clients. Limits are generous for real use.

import type { Context, Next } from 'hono';

const windows = new Map<string, { count: number; resetAt: number }>();
let sweptAt = 0;

/** Count one hit; returns seconds to wait when over the limit, else 0. */
export function hit(key: string, max: number, windowSec: number, now = Date.now()): number {
  return hitInfo(key, max, windowSec, now).wait;
}

/** Count one hit, with what a client needs to pace itself: requests left in this window and when it resets. */
export function hitInfo(key: string, max: number, windowSec: number, now = Date.now()): { wait: number; remaining: number; resetAt: number } {
  if (now - sweptAt > 60_000) { // drop expired windows once a minute so the map can't grow forever
    sweptAt = now;
    for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
  }
  let w = windows.get(key);
  if (!w || w.resetAt <= now) { w = { count: 0, resetAt: now + windowSec * 1000 }; windows.set(key, w); }
  w.count++;
  return { wait: w.count > max ? Math.ceil((w.resetAt - now) / 1000) : 0, remaining: Math.max(0, max - w.count), resetAt: w.resetAt };
}

/** Middleware for signed-in routes: `max` requests per `windowSec` per customer, in the named bucket. */
export const limit = (bucket: string, max: number, windowSec: number) => async (c: Context, next: Next) => {
  const wait = hit(`${bucket}:${c.get('uid') ?? 'anon'}`, max, windowSec);
  if (wait) {
    c.header('retry-after', String(wait));
    const when = wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`;
    return c.json({ error: { code: 'rate_limited', message: `Too many requests. Please try again in ${when}.` } }, 429);
  }
  await next();
};
