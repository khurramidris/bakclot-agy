// Launch checklist, run against the real services with the real settings. Every check says in plain words
// what is wrong and how to fix it. Admins see it at /setup in the web app; locally: `npm run preflight`.
// Each call is read-only or costs a fraction of a cent (one tiny Claude message, one tiny file in storage).

import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { sql } from './db.js';
import { storage } from './storage.js';
import { priceGuard } from './api/access.js';

export type Check = { area: string; name: string; status: 'ok' | 'warn' | 'fail'; detail: string };

const REQUIRED_LS_EVENTS = ['order_created', 'subscription_created', 'subscription_updated', 'subscription_cancelled',
  'subscription_resumed', 'subscription_expired', 'subscription_paused', 'subscription_unpaused', 'subscription_payment_success'];

async function timed<T>(p: Promise<T>, ms = 15_000): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer after ${ms / 1000}s`)), ms))]);
}

export async function preflight(): Promise<Check[]> {
  const out: Check[] = [];
  const add = (area: string, name: string, status: Check['status'], detail: string) => out.push({ area, name, status, detail });
  const run = async (area: string, name: string, fn: () => Promise<[Check['status'], string]>) => {
    try { const [s, d] = await timed(fn()); add(area, name, s, d); } catch (e: any) {
      const msg = e.message || String(e);
      add(area, name, 'fail', msg === 'fetch failed' ? 'Couldn’t reach the service at all. Check its address (URL) setting for typos.' : msg);
    }
  };
  const https = (u: string) => /^https:\/\//.test(u);

  // Running on your own computer (dev sign-in, nothing charged): skip the checks that only matter in production.
  const local = process.env.NODE_ENV !== 'production' && config.auth.allowDevTokens && !config.mock;

  // ── Settings ──
  if (local) {
    add('Settings', 'Local run', 'ok', 'Dev sign-in, nothing charged: payments, Supabase and production settings are skipped.');
    if (config.videoProvider === 'runpod') {
      await run('Settings', 'RunPod can reach this computer', async () => {
        // The GPU worker downloads reference images from, and uploads each finished clip to, PUBLIC_BASE_URL.
        if (!https(config.publicBaseUrl)) return ['fail', 'Set PUBLIC_BASE_URL to the https address of a tunnel to this computer (e.g. cloudflared tunnel --url http://localhost:' + config.port + '). RunPod can’t reach localhost.'];
        const r = await fetch(`${config.publicBaseUrl}/health`);
        const j: any = await r.json().catch(() => null);
        if (!r.ok || !j?.ok) return ['fail', `${config.publicBaseUrl}/health didn’t answer like Backlot. Is the tunnel running and pointing at port ${config.port}?`];
        return ['ok', `${config.publicBaseUrl} reaches this engine.`];
      });
    }
  } else {
  add('Settings', 'Production mode', process.env.NODE_ENV === 'production' ? 'ok' : 'warn',
    process.env.NODE_ENV === 'production' ? 'NODE_ENV=production.' : 'Set NODE_ENV=production on Railway. Without it, customers are not charged.');
  add('Settings', 'Charging customers', config.credits.enforce ? 'ok' : 'fail',
    config.credits.enforce ? 'Plans, credits and storage limits are enforced.' : 'ENFORCE_CREDITS is off: anyone could create for free. Remove ENFORCE_CREDITS=0 or set NODE_ENV=production.');
  add('Settings', 'Mock services off', config.mock || config.auth.allowDevTokens ? 'fail' : 'ok',
    config.mock || config.auth.allowDevTokens ? 'Remove MOCK_PROVIDERS and ALLOW_DEV_TOKENS.' : 'Real services are used.');
  add('Settings', 'File signing secret', (process.env.FILE_SIGNING_SECRET || '').length >= 32 ? 'ok' : 'fail',
    (process.env.FILE_SIGNING_SECRET || '').length >= 32 ? 'Set and long enough.' : 'FILE_SIGNING_SECRET must be a random string of at least 32 characters (run: openssl rand -hex 32).');
  add('Settings', 'Public address', https(config.publicBaseUrl) ? 'ok' : 'fail',
    https(config.publicBaseUrl) ? config.publicBaseUrl : 'Set PUBLIC_BASE_URL to your site address, starting with https:// (e.g. https://backlot.app).');
  add('Settings', 'Checkout return address', https(config.lemonsqueezy.appUrl) ? 'ok' : 'fail',
    https(config.lemonsqueezy.appUrl) ? config.lemonsqueezy.appUrl : 'Set APP_URL to your site address, starting with https://. Usually the same as PUBLIC_BASE_URL.');
  add('Settings', 'File storage', config.storage.driver === 's3' ? 'ok' : 'fail',
    config.storage.driver === 's3' ? `S3 bucket "${config.storage.s3Bucket}".` : 'STORAGE_DRIVER must be s3 in production: Railway wipes local files on every deploy, and customers would lose their videos.');
  const legalMissing = (['company', 'jurisdiction', 'address', 'email'] as const).filter((k) => !config.legal[k]);
  add('Settings', 'Company details', legalMissing.length ? 'fail' : 'ok', legalMissing.length
    ? `The Terms, Privacy Policy and support links show placeholders. Set ${legalMissing.map((k) => ({ company: 'LEGAL_COMPANY', jurisdiction: 'LEGAL_JURISDICTION', address: 'LEGAL_ADDRESS', email: 'SUPPORT_EMAIL' })[k]).join(', ')}.`
    : `${config.legal.company}, ${config.legal.jurisdiction}; support ${config.legal.email}.`);
  add('Settings', 'Admins', config.admins.length ? 'ok' : 'warn',
    config.admins.length ? `${config.admins.length} admin(s).` : 'Set ADMIN_USER_IDS to your user id (Account page) to see this page and the capacity page.');

  }

  // ── Database ──
  await run('Database', 'Connects', async () => {
    const [r] = await sql`select count(*)::int n from schema_migrations`;
    return ['ok', `Connected; ${r.n} migrations applied.`];
  });

  // ── Sign-in ──
  if (!local) await run('Sign-in (Supabase)', 'Project and key', async () => {
    if (!config.auth.supabaseUrl || !config.auth.supabaseAnonKey) return ['fail', 'Set SUPABASE_URL and SUPABASE_ANON_KEY (Supabase → Project Settings → API).'];
    const r = await fetch(`${config.auth.supabaseUrl}/auth/v1/settings`, { headers: { apikey: config.auth.supabaseAnonKey } });
    if (!r.ok) return ['fail', `Supabase refused the key (${r.status}). Copy the anon/publishable key again from Project Settings → API.`];
    const s: any = await r.json();
    const google = s.external?.google ? 'Google sign-in on.' : 'Google sign-in off (optional).';
    return [s.mailer_autoconfirm ? 'warn' : 'ok', `${google} ${s.mailer_autoconfirm ? 'Email confirmation is off: anyone can sign up with an address they don’t own.' : 'Email confirmation on.'}`];
  });

  // ── Storage ──
  await run('Storage', 'Write, read, delete', async () => {
    const key = `preflight/${Date.now()}.txt`;
    await storage.put(key, Buffer.from('backlot preflight'), 'text/plain');
    try {
      if ((await storage.get(key)).toString() !== 'backlot preflight') return ['fail', 'The file read back was different.'];
      // Browsers load every image and video, and MiniMax fetches reference images, through signed links: try one.
      if (config.storage.driver !== 's3' && !https(config.publicBaseUrl)) return ['ok', 'A test file was written, read back and deleted.'];
      const r = await fetch(await storage.url(key, 300)).catch(() => null);
      if (!r?.ok || (await r.text()) !== 'backlot preflight') {
        return ['fail', `A signed link to the test file didn’t work (${r ? `answer ${r.status}` : 'no answer'}), so videos and images won’t load. Check S3_ENDPOINT and S3_REGION (Cloudflare R2, or Supabase → Storage → S3 connection) and that the bucket exists.`];
      }
      return ['ok', 'A test file was written, read back, downloaded through a signed link and deleted.'];
    } finally { await storage.del(key); }
  });

  // ── AI ──
  const models = [...new Set([config.anthropic.model, config.anthropic.fastModel, ...Object.values(config.anthropic.models)])];
  await run('AI writing (Anthropic)', `Model ${config.anthropic.model}`, async () => {
    if (!config.anthropic.apiKey) return ['fail', 'Set ANTHROPIC_API_KEY (console.anthropic.com → API keys).'];
    for (const model of models) {
      const r = await fetch(`${config.anthropic.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': config.anthropic.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (!r.ok) {
        const t = (await r.text()).slice(0, 200);
        return ['fail', r.status === 401 ? 'The API key is wrong.' : r.status === 404 ? `Model "${model}" not found: check CLAUDE_MODEL / CLAUDE_FAST_MODEL / CLAUDE_MODELS.` : `Anthropic answered ${r.status}: ${t}. If it mentions credit, add credit in the Anthropic console.`];
      }
    }
    return ['ok', `Key works for ${models.join(', ')}.`];
  });

  const needsMinimax = config.images.provider === 'minimax' || config.videoProvider === 'minimax';
  if (needsMinimax) {
    await run('Images and voices (MiniMax)', 'API key', async () => {
      if (!config.minimax.apiKey) return ['fail', 'Set MINIMAX_API_KEY (MiniMax platform → API keys). It is used for cast and set images, voices' + (config.videoProvider === 'minimax' ? ', and video.' : '.')];
      const r = await fetch(`${config.minimax.baseUrl}/v2/query/video_generation/0`, { headers: { authorization: `Bearer ${config.minimax.apiKey}` } });
      const j: any = await r.json().catch(() => ({}));
      const sc = j.base_resp?.status_code;
      if (r.status === 401 || r.status === 403 || sc === 1004 || sc === 2049) return ['fail', `MiniMax rejected the key (${j.base_resp?.status_msg || r.status}). Check MINIMAX_API_KEY and MINIMAX_BASE_URL (api.minimax.io, or api.minimaxi.com for China accounts).`];
      return ['ok', 'Key accepted. Make sure the MiniMax account has balance: each image and voice is billed.'];
    });
  }
  if (config.images.provider === 'minimax') {
    add('Images and voices (MiniMax)', 'Same place, new look', config.images.geminiKey || config.images.openaiKey ? 'ok' : 'warn',
      config.images.geminiKey || config.images.openaiKey
        ? 'Set variants (the same room at night, after the fire) are drawn from the room’s picture with Gemini or OpenAI.'
        : 'MiniMax images can copy a face but not a room. Without GEMINI_API_KEY or OPENAI_API_KEY, “the same room at night” is drawn from its description only and may not look like the same room. Such pictures are marked on the cast page.');
  }

  // ── Video ──
  if (config.videoProvider === 'runpod') {
    await run('Video (RunPod)', 'Endpoint', async () => {
      if (!config.runpod.apiKey || !config.runpod.endpointId) return ['fail', 'Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID, or set VIDEO_PROVIDER=minimax to use MiniMax’s hosted video for now.'];
      const r = await fetch(`${config.runpod.apiBase}/${config.runpod.endpointId}/health`, { headers: { authorization: `Bearer ${config.runpod.apiKey}` } });
      if (!r.ok) return ['fail', `RunPod answered ${r.status}. Check the endpoint id and API key.`];
      const h: any = await r.json().catch(() => ({}));
      const w = h.workers || {}, j = h.jobs || {};
      return ['warn', `Endpoint reachable (workers: ${w.idle ?? 0} idle, ${w.running ?? 0} running, ${w.initializing ?? 0} starting; jobs waiting: ${j.inQueue ?? 0}). Only a real test render proves the model and the handler work: make one short film.`];
    });
  } else add('Video', 'Provider', 'ok', 'MiniMax hosted video (MINIMAX_API_KEY above).');

  // ── Public API ──
  if (!config.api.enabled) add('Public API', 'Switched on', 'ok', 'Off (API_ENABLED is not set). Developers can’t use /api/v1 yet; turn it on once video costs are confirmed.');
  else {
    add('Public API', 'Switched on', 'ok', `On at ${config.publicBaseUrl || '(PUBLIC_BASE_URL)'}/api/v1. Videos are kept ${config.api.retentionDays} days.`);
    await run('Public API', 'Price above cost', async () => {
      const g = await priceGuard(true);
      if (!g.ok) return ['fail', `Video costs $${g.cost_per_second}/s (${g.source}) but sells for $${g.sell_per_second}/s: the API refuses new videos until SELL_PER_SECOND_768P is above cost.`];
      return [g.cost_per_second == null ? 'warn' : 'ok', g.cost_per_second == null ? `Selling at $${g.sell_per_second}/s; cost ${g.source}.` : `Selling at $${g.sell_per_second}/s, costing $${g.cost_per_second}/s (${g.source}).`];
    });
  }

  // ── Payments ──
  if (local) return out;
  const ls = config.lemonsqueezy;
  const lsGet = async (path: string) => {
    const r = await fetch(`${ls.apiBase}/v1${path}`, { headers: { accept: 'application/vnd.api+json', authorization: `Bearer ${ls.apiKey}` } });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Lemon Squeezy rejected the API key (LEMONSQUEEZY_API_KEY).' : r.status === 404 ? `Not found: ${path}` : `Lemon Squeezy answered ${r.status} for ${path}`);
    return j;
  };
  if (!ls.apiKey || !ls.storeId) {
    add('Payments (Lemon Squeezy)', 'Store and key', 'fail', 'Set LEMONSQUEEZY_API_KEY (Settings → API) and LEMONSQUEEZY_STORE_ID (Settings → Stores, the number).');
  } else {
    await run('Payments (Lemon Squeezy)', 'Store', async () => {
      const j = await lsGet(`/stores/${encodeURIComponent(ls.storeId)}`);
      return ['ok', `Store "${j.data?.attributes?.name}" found.`];
    });
    // Lists every product with the ids the settings need, so nobody has to dig for variant ids in the dashboard.
    await run('Payments (Lemon Squeezy)', 'Your products (copy ids from here)', async () => {
      const products: any[] = (await lsGet(`/products?filter[store_id]=${encodeURIComponent(ls.storeId)}`)).data || [];
      if (!products.length) return ['warn', 'No products yet. Create the $20/month Basic subscription and the credit packs (docs/BETA.md step 5).'];
      const lines: string[] = [];
      for (const p of products) {
        const variants: any[] = (await lsGet(`/variants?filter[product_id]=${encodeURIComponent(p.id)}`)).data || [];
        for (const v of variants.filter((x) => x.attributes?.status !== 'pending')) {
          const a = v.attributes || {};
          const price = `$${Number(a.price) / 100}${a.is_subscription ? `/${a.interval || 'month'}` : ''}`;
          lines.push(`${p.attributes?.name}${a.name && a.name !== 'Default' ? ` (${a.name})` : ''}: ${price} → variant id ${v.id}`);
        }
      }
      return ['ok', lines.join(' · ')];
    });
    await run('Payments (Lemon Squeezy)', `${config.plan.name} plan product`, async () => {
      if (!ls.basicVariantId) return ['fail', 'Set LEMONSQUEEZY_BASIC_VARIANT_ID to the variant id of the $20/month product.'];
      const a = (await lsGet(`/variants/${encodeURIComponent(ls.basicVariantId)}`)).data?.attributes || {};
      if (!a.is_subscription) return ['fail', `Variant ${ls.basicVariantId} ("${a.name}") is not a subscription. Use the variant of the monthly Basic product.`];
      const price = Number(a.price) / 100;
      if (price !== config.plan.priceUsd) return ['warn', `Lemon Squeezy charges $${price} but the site says $${config.plan.priceUsd}. Make PLAN_PRICE_USD match.`];
      return ['ok', `Variant ${ls.basicVariantId}: $${price} every ${a.interval_count || 1} ${a.interval || 'month'}.`];
    });
    const packs = config.credits.packs;
    if (!packs.some((p) => p.variantId)) add('Payments (Lemon Squeezy)', 'Top-up packs', 'warn', 'No top-up packs have a variant id yet: CREDIT_PACKS=starter:10:<variant id>,… Subscribers can’t top up until then.');
    for (const p of packs.filter((x) => x.variantId)) {
      await run('Payments (Lemon Squeezy)', `Top-up "${p.id}"`, async () => {
        const a = (await lsGet(`/variants/${encodeURIComponent(p.variantId)}`)).data?.attributes || {};
        const price = Number(a.price) / 100;
        if (a.is_subscription) return ['fail', `Variant ${p.variantId} is a subscription; top-ups must be single payments.`];
        return [price === p.usd ? 'ok' : 'warn', price === p.usd ? `$${price} gives $${p.usd} of credit.` : `Costs $${price} but gives $${p.usd} of credit: check CREDIT_PACKS.`];
      });
    }
    await run('Payments (Lemon Squeezy)', 'Webhook', async () => {
      if (!ls.webhookSecret) return ['fail', 'Set LEMONSQUEEZY_WEBHOOK_SECRET to the signing secret you typed when creating the webhook.'];
      const hooks: any[] = (await lsGet(`/webhooks?filter[store_id]=${encodeURIComponent(ls.storeId)}`)).data || [];
      const want = `${config.publicBaseUrl}/webhooks/lemonsqueezy`;
      const hook = hooks.find((h) => h.attributes?.url === want);
      if (!hook) return ['fail', `No webhook points at ${want}. Settings → Webhooks → + and use exactly that URL.`];
      const missing = REQUIRED_LS_EVENTS.filter((e) => !(hook.attributes.events || []).includes(e));
      if (missing.length) return ['fail', `The webhook is missing these events: ${missing.join(', ')}.`];
      return [hook.attributes.test_mode ? 'warn' : 'ok', hook.attributes.test_mode ? 'Webhook set up (test mode: no real money yet).' : 'Webhook set up, live mode.'];
    });
  }
  return out;
}

// `npm run preflight` (or `node dist/preflight.js` on the server) prints the list and exits non-zero on any failure.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checks = await preflight();
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  let area = '';
  for (const c of checks) {
    if (c.area !== area) { area = c.area; console.log(`\n${area}`); }
    console.log(`  ${icon[c.status]} ${c.name}: ${c.detail}`);
  }
  const failed = checks.filter((c) => c.status === 'fail').length;
  console.log(failed ? `\n${failed} problem(s) to fix before launch.` : '\nReady.');
  process.exit(failed ? 1 : 0);
}
