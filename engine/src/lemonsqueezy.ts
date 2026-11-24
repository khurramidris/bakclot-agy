// Payments through Lemon Squeezy, our Merchant of Record (it handles VAT and sales tax).
// - The Basic subscription: checkout, then webhooks keep the `subscriptions` table current, and each paid
//   invoice resets the month's plan credit.
// - Top-up packs for subscribers: a one-off order adds credit that never expires.
// Plain REST (JSON:API); no SDK. Webhooks are verified by signature and applied at most once.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql, begin } from './db.js';
import { config } from './config.js';
import { PermanentError } from './queue.js';
import { credit, currentSubscription, expirePlanCredit, isActiveStatus, planOf, resetPlanCredit } from './billing.js';

const ls = config.lemonsqueezy;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const paymentsEnabled = () => !!(ls.apiKey && ls.storeId && ls.basicVariantId && ls.appUrl);

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${ls.apiBase}/v1${path}`, {
    method,
    headers: { accept: 'application/vnd.api+json', 'content-type': 'application/vnd.api+json', authorization: `Bearer ${ls.apiKey}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Lemon Squeezy ${method} ${path} failed (${r.status}): ${j.errors?.[0]?.detail || j.errors?.[0]?.title || 'no detail'}`);
  return j;
}

/** A hosted checkout for one variant. The owner rides along as custom data and comes back on every webhook. */
async function checkout(ownerId: string, variantId: string, email?: string | null) {
  if (!paymentsEnabled()) throw new PermanentError('Payments are not set up yet.', 'config');
  const j = await api('POST', '/checkouts', {
    data: {
      type: 'checkouts',
      attributes: {
        checkout_data: { ...(email ? { email } : {}), custom: { user_id: ownerId } },
        product_options: { redirect_url: `${ls.appUrl}/billing?paid=1` },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(ls.storeId) } },
        variant: { data: { type: 'variants', id: String(variantId) } },
      },
    },
  });
  const url = j.data?.attributes?.url;
  if (!url) throw new Error('Lemon Squeezy returned no checkout url');
  return { url: url as string };
}

export async function subscribeCheckout(ownerId: string, email?: string | null) {
  if ((await planOf(ownerId)).active) throw new PermanentError('You already have an active plan. Manage it from Billing.', 'conflict');
  return checkout(ownerId, ls.basicVariantId, email);
}

export async function topupCheckout(ownerId: string, packId: string, email?: string | null) {
  const pack = config.credits.packs.find((p) => p.id === packId && p.variantId);
  if (!pack) throw new PermanentError(`Unknown credit pack. Choose one of: ${config.credits.packs.filter((p) => p.variantId).map((p) => p.id).join(', ') || 'none yet'}.`, 'bad_input');
  return checkout(ownerId, pack.variantId, email);
}

/** A fresh signed link to Lemon Squeezy's customer portal: update the card, see invoices, cancel. */
export async function portalUrl(ownerId: string) {
  const s = await currentSubscription(ownerId);
  if (!s) throw new PermanentError('You have no subscription yet.', 'not_found');
  if (!ls.apiKey) throw new PermanentError('Payments are not set up yet.', 'config');
  const j = await api('GET', `/subscriptions/${encodeURIComponent(s.id)}`);
  const url = j.data?.attributes?.urls?.customer_portal;
  if (!url) throw new Error('Lemon Squeezy returned no customer portal url');
  return { url: url as string };
}

// ───────── webhooks ─────────

/** X-Signature is the hex HMAC-SHA256 of the raw body with the webhook signing secret. */
export function verifyLemonSignature(raw: string, header: string, secret: string) {
  if (!secret || !header) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.trim());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const SUBSCRIPTION_EVENTS = ['subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_resumed',
  'subscription_expired', 'subscription_paused', 'subscription_unpaused'];

/** Thrown when an event can't be applied yet; a non-2xx reply makes Lemon Squeezy retry it later. */
class RetryLater extends Error { status = 409; code = 'retry_later'; }

async function ownerFor(evt: any, subscriptionId?: string | null): Promise<string | null> {
  const custom = evt.meta?.custom_data?.user_id;
  if (typeof custom === 'string' && UUID.test(custom)) return custom;
  if (!subscriptionId) return null;
  const [s] = await sql`select owner_id from subscriptions where id = ${String(subscriptionId)}`;
  return s?.owner_id ?? null;
}

const date = (v: any) => (v ? new Date(v) : null);

export async function handleLemonEvent(evt: any) {
  const name: string = evt?.meta?.event_name || 'unknown';
  const data = evt?.data || {};
  const a = data.attributes || {};
  if (ls.storeId && a.store_id !== undefined && String(a.store_id) !== String(ls.storeId)) return { ignored: 'another store' };

  if (SUBSCRIPTION_EVENTS.includes(name)) {
    const id = String(data.id || '');
    const owner = await ownerFor(evt, id);
    if (!id || !owner) return { ignored: 'no owner' };
    const changedAt = date(a.updated_at);
    const applied = await begin(async (tx) => {
      // Webhooks can arrive out of order: one older than what we already have (by Lemon Squeezy's own updated_at) is ignored.
      const [row] = await tx`insert into subscriptions (id, owner_id, customer_id, variant_id, status, renews_at, ends_at, ls_updated_at)
        values (${id}, ${owner}, ${a.customer_id != null ? String(a.customer_id) : null}, ${a.variant_id != null ? String(a.variant_id) : null},
                ${String(a.status || 'unknown')}, ${date(a.renews_at)}, ${date(a.ends_at)}, ${changedAt})
        on conflict (id) do update set customer_id = excluded.customer_id, variant_id = excluded.variant_id, status = excluded.status,
          renews_at = excluded.renews_at, ends_at = excluded.ends_at, ls_updated_at = excluded.ls_updated_at, updated_at = now()
        where subscriptions.ls_updated_at is null or excluded.ls_updated_at is null or excluded.ls_updated_at >= subscriptions.ls_updated_at
        returning id`;
      if (!row) return false;
      // Plan credit goes only when the customer has no subscription left that still gives access (an old one expiring
      // after they subscribed again must not take this month's credit).
      if (a.status === 'expired') {
        const subs = await tx`select status, ends_at from subscriptions where owner_id = ${owner} and id <> ${id}`;
        if (!subs.some((x: any) => isActiveStatus(x.status, x.ends_at))) await expirePlanCredit(tx, owner, `ls:subscription:${id}`);
      }
      return true;
    });
    if (!applied) return { subscription: id, ignored: 'older than the last event' };
    return { subscription: id, status: a.status };
  }

  if (name === 'subscription_payment_success') {
    if (a.status !== 'paid') return { ignored: 'invoice not paid' };
    const owner = await ownerFor(evt, a.subscription_id);
    if (!owner) throw new RetryLater('Subscription not known yet.');
    const key = `ls:invoice:${data.id}`;
    return begin(async (tx) => {
      const [first] = await tx`insert into payments (id, owner_id, amount_usd, event_id) values (${key}, ${owner}, ${Number(a.subtotal_usd || 0) / 100}, ${name})
        on conflict (id) do nothing returning id`;
      if (!first) return { duplicate: true };
      // Initial and renewal invoices start a new period. Mid-period invoices (plan changes) don't refill credit.
      if (a.billing_reason && !['initial', 'renewal'].includes(a.billing_reason)) return { recorded: key };
      return { plan_credit: await resetPlanCredit(tx, owner, key) };
    });
  }

  if (name === 'order_created') {
    if (a.status !== 'paid') return { ignored: 'order not paid' };
    const variant = String(a.first_order_item?.variant_id ?? '');
    if (variant && variant === String(ls.basicVariantId)) return { ignored: 'plan order: the invoice credits it' };
    // The credit comes from our pack list, never from the amount paid (which includes tax).
    const pack = config.credits.packs.find((p) => p.variantId && p.variantId === variant);
    if (!pack) return { ignored: 'not a credit pack' };
    const owner = await ownerFor(evt);
    if (!owner) return { ignored: 'no owner' };
    const key = `ls:order:${data.id}`;
    return begin(async (tx) => {
      const [first] = await tx`insert into payments (id, owner_id, amount_usd, event_id) values (${key}, ${owner}, ${Number(a.subtotal_usd || 0) / 100}, ${name})
        on conflict (id) do nothing returning id`;
      if (!first) return { duplicate: true };
      await credit(tx, owner, pack.usd, 'purchase', key);
      return { credited: pack.usd };
    });
  }

  return { ignored: name };
}
