import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// All configuration comes from environment variables. Nothing secret ever reaches the browser.

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const production = env.NODE_ENV === 'production';
const devMode = bool(env.MOCK_PROVIDERS) || bool(env.ALLOW_DEV_TOKENS);

// Dev sign-in lets anyone act as any user, and mocks fake every render: neither may reach production.
if (production && devMode) throw new Error('MOCK_PROVIDERS and ALLOW_DEV_TOKENS are for local development only and must be unset when NODE_ENV=production.');

// Letting API media or webhook URLs point at private addresses is how tests reach a local server. Never in production.
if (production && bool(env.API_ALLOW_PRIVATE_URLS)) throw new Error('API_ALLOW_PRIVATE_URLS is for local development and tests only and must be unset when NODE_ENV=production.');

// Signed file links are the only thing protecting local-storage files, so a guessable default is never allowed outside dev.
if (!env.FILE_SIGNING_SECRET && !devMode) throw new Error('FILE_SIGNING_SECRET is required (a long random string). Only MOCK_PROVIDERS/ALLOW_DEV_TOKENS runs may omit it.');

/** "starter:10:12345,creator:50:12346" → [{ id: 'starter', usd: 10, variantId: '12345' }, …]. The variant is the Lemon Squeezy product variant. */
const packs = (v: string) => v.split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([id, usd]) => id && +usd > 0)
  .map(([id, usd, variantId]) => ({ id, usd: +usd, variantId: variantId || '' }));
/** "scene:claude-sonnet-5-5, shots:claude-haiku-5-5" → { scene: 'claude-sonnet-5-5', shots: 'claude-haiku-5-5' } */
const pairs = (v: string) => Object.fromEntries(v.split(',').map((p) => p.split(':').map((x) => x.trim())).filter(([k, m]) => k && m));

export const config = {
  port: num(env.PORT, 8787),
  host: env.LISTEN_HOST || undefined,                     // e.g. 127.0.0.1 to accept only this computer (the desktop app); unset = all
  publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/$/, ''), // e.g. https://engine.yourdomain.com
  databaseUrl: env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/studio',
  autoMigrate: bool(env.AUTO_MIGRATE, true),
  runWorker: bool(env.RUN_WORKER, true),           // run the job worker inside the API process
  // Background work runs in lanes, each with its own slots per process, so one kind never starves another:
  //   llm     writing, breakdown, planning (long Claude turns; mostly waiting, so raise it freely) = WORKER_CONCURRENCY
  //   render  sending clips to the video service and collecting them (quick)
  //   assets  cast, set and voice generation
  //   media   editing with FFmpeg (uses a whole CPU core each)
  //   io      webhooks and housekeeping
  // WORKER_LANES overrides any of them, e.g. "llm:12,render:16,media:4".
  lanes: { llm: Math.max(1, num(env.WORKER_CONCURRENCY, 6)), render: 8, assets: 4, media: 2, io: 4,
    ...Object.fromEntries(Object.entries(pairs(env.WORKER_LANES || '')).map(([k, v]) => [k, Math.max(1, Number(v) || 1)])) } as Record<string, number>,
  // Fairness between customers: how many jobs of one customer may run at once in a lane (the rest step aside briefly).
  fairness: { llm: Math.max(1, num(env.FAIR_LLM_PER_CUSTOMER, 3)), assets: Math.max(1, num(env.FAIR_ASSETS_PER_CUSTOMER, 2)), media: Math.max(1, num(env.FAIR_EDITS_PER_CUSTOMER, 1)) },
  db: {
    poolMax: Math.max(4, num(env.DB_POOL_MAX, 10)),          // database connections per process
    lockTimeoutMs: num(env.DB_LOCK_TIMEOUT_MS, 15_000),      // a transaction waiting on a lock gives up after this
    idleTxTimeoutMs: num(env.DB_IDLE_TX_TIMEOUT_MS, 60_000), // Postgres ends a transaction that goes silent this long
    watchdog: bool(env.DB_WATCHDOG, true),                   // exit (to be restarted) if the pool stops answering
  },
  corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  auth: {
    // Supabase: Project Settings → API → JWT secret (HS256), or leave empty and set SUPABASE_URL to use JWKS.
    supabaseJwtSecret: env.SUPABASE_JWT_SECRET || '',
    supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
    // Publishable/anon key: lets the engine confirm a session with Supabase itself when it can't verify the JWT locally.
    supabaseAnonKey: env.SUPABASE_ANON_KEY || '',
    // Local development only: accept "Authorization: Bearer dev:<uuid>" when set.
    allowDevTokens: bool(env.ALLOW_DEV_TOKENS, false),
    // Server-to-server key (e.g. a Supabase Edge Function calling the engine on behalf of a user).
    serviceKey: env.ENGINE_SERVICE_KEY || '',
  },

  storage: {
    driver: (env.STORAGE_DRIVER || 'local') as 'local' | 's3',
    localDir: env.STORAGE_DIR || './data/files',
    signingSecret: env.FILE_SIGNING_SECRET || 'dev-signing-secret-change-me',
    // S3-compatible: Supabase Storage (S3 protocol), Cloudflare R2, AWS S3…
    s3Endpoint: env.S3_ENDPOINT || '',
    s3Region: env.S3_REGION || 'auto',
    s3Bucket: env.S3_BUCKET || '',
    s3AccessKeyId: env.S3_ACCESS_KEY_ID || '',
    s3SecretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
    s3ForcePathStyle: bool(env.S3_FORCE_PATH_STYLE, true),
    urlTtlSeconds: num(env.FILE_URL_TTL, 6 * 3600),
  },

  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
    model: env.CLAUDE_MODEL || 'claude-opus-5-5',            // every creative and planning step
    fastModel: env.CLAUDE_FAST_MODEL || 'claude-sonnet-5-5', // retake revisions, small edits
    // Per-step overrides, e.g. "scene:claude-sonnet-5-5,shots:claude-haiku-5-5". Steps: pitch, choose, bible, rename,
    // outline, scene, critique, judge, breakdown, direct, shots, retake. Unlisted steps use CLAUDE_MODEL (retake: CLAUDE_FAST_MODEL).
    models: pairs(env.CLAUDE_MODELS || '') as Record<string, string>,
    // Thinking depth: story development, scene writing, critique and direction use the creative level;
    // breakdown and per-scene shot planning (many calls) use the planning level.
    effort: (env.STORY_EFFORT || 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    planningEffort: (env.PLANNING_EFFORT || 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    // What the model and endpoint support. Off: the answer's shape is described in the prompt and an answer that
    // doesn't parse gets one repair round; no thinking parameters are sent. A 400 that names the feature turns it off too.
    structured: bool(env.CLAUDE_STRUCTURED_OUTPUTS, true),
    thinking: bool(env.CLAUDE_THINKING, true),
    // Server-side refusal fallbacks (first-party API only; turn off behind a proxy that rejects them).
    fallbacks: bool(env.CLAUDE_FALLBACKS, !env.ANTHROPIC_BASE_URL || /api\.anthropic\.com/.test(env.ANTHROPIC_BASE_URL)),
    // The polish pass: a script editor's critique, then rewrites of only the scenes it flags, each kept only if it's better.
    scriptDoctor: bool(env.SCRIPT_DOCTOR, true),
    // Each episode's opening and closing scene is drafted this many times and a judge keeps the best (1 = no extra drafts).
    keyDrafts: Math.max(1, Math.min(3, num(env.KEY_SCENE_DRAFTS, 2))),
    // Scenes written or planned at once per episode (each is one Claude call).
    planConcurrency: num(env.PLAN_CONCURRENCY, 4),
    // Long projects (a whole season, a feature film): the many small calls (scene cards, scenes, judging, notes,
    // breakdown, direction, shot plans) run on a cheaper model, so a 90-minute drama costs a few dollars to write.
    // The story's spine (pitch, choose, bible, season plan) stays on CLAUDE_MODEL. A CLAUDE_MODELS entry still wins.
    bulkModel: env.CLAUDE_BULK_MODEL || 'claude-haiku-5-5',
    bulkSteps: (env.CLAUDE_BULK_STEPS || 'outline,scene,judge,critique,breakdown,direct,shots').split(',').map((s) => s.trim()).filter(Boolean),
    longFormSeconds: num(env.LONG_FORM_SECONDS, 900), // total runtime from which a project counts as long
    // A long story is planned a batch of episodes at a time (the season plan), and its script editor reads a batch at a time.
    seasonBatch: Math.max(2, num(env.SEASON_BATCH_EPISODES, 12)),
    critiqueBatchSeconds: Math.max(120, num(env.CRITIQUE_BATCH_SECONDS, 600)),
    breakdownBatchScenes: Math.max(10, num(env.BREAKDOWN_BATCH_SCENES, 40)), // scenes per breakdown call
  },

  minimax: {
    apiKey: env.MINIMAX_API_KEY || '',
    baseUrl: (env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/$/, ''),
    videoModel: env.MINIMAX_VIDEO_MODEL || 'MiniMax-H3',
    imageModel: env.MINIMAX_IMAGE_MODEL || 'image-01',
    // Renders in flight at the provider at once (RunPod: roughly max workers × 2, so its queue stays short).
    // On our own GPUs it follows the worker ceiling (RunPod's autoscaler can only add GPUs for work it can see waiting),
    // so raising RUNPOD_MAX_WORKERS is the one setting to change as demand grows.
    maxConcurrentVideo: num(env.VIDEO_MAX_INFLIGHT, (env.VIDEO_PROVIDER || 'minimax') === 'runpod'
      ? Math.max(1, num(env.RUNPOD_MAX_WORKERS, 5) * Math.max(1, num(env.RUNPOD_JOBS_PER_WORKER, 2)))
      : num(env.MINIMAX_MAX_CONCURRENT, 10)),
    // Clips one customer renders at once, across all their films and quick clips, whatever their length.
    maxConcurrentPerUser: Math.max(1, num(env.MAX_ACTIVE_RENDERS_PER_USER, 4)),
    // Clips of one project render this many at a time, in story order, so the customer watches them arrive in the
    // order they play. By default a film may use all of its owner's slots.
    maxConcurrentPerProject: Math.max(1, num(env.RENDERS_PER_PROJECT, num(env.MAX_ACTIVE_RENDERS_PER_USER, 4))),
    // Send the scene's previous approved clip as a reference video. Off: its seconds count as input on every render,
    // a cost the customer's per-second price doesn't cover.
    chainClips: bool(env.CHAIN_CLIPS, false),
    pollSeconds: num(env.MINIMAX_POLL_SECONDS, 10),
    taskTimeoutMinutes: num(env.MINIMAX_TASK_TIMEOUT_MIN, 30),
    // How reference media reaches MiniMax: 'url' needs PUBLIC_BASE_URL or S3 signed URLs reachable
    // from the internet; 'inline' sends base64 data URIs (≤64 MB per request). 'auto' picks.
    mediaMode: (env.MINIMAX_MEDIA_MODE || 'auto') as 'auto' | 'url' | 'inline',
  },

  // Which service renders video: MiniMax's API, or our own H3 deployment on RunPod Serverless.
  videoProvider: (env.VIDEO_PROVIDER || 'minimax') as 'minimax' | 'runpod',

  // Quick clips: text, an image, references or a video to remix → one clip, charged per second like film shots.
  clips: {
    minSeconds: num(env.CLIP_MIN_SECONDS, 5),
    maxSeconds: 15, // one H3 generation
    // Image-to-video can run on another provider than the rest (e.g. minimax while it's in beta on our own GPUs).
    imageProvider: (env.CLIP_IMAGE_PROVIDER || '') as '' | 'minimax' | 'runpod',
  },

  // Customer prompts and uploads are checked before they reach a video model (our own H3 has no filter of its own).
  moderation: bool(env.MODERATION, true),

  // Screenplay limits: what one episode's script and one imported project may hold, so the AI work behind any one
  // request stays bounded (an episode of a few minutes is 3,000 to 8,000 characters).
  scripts: {
    maxEpisodeChars: num(env.MAX_SCRIPT_CHARS, 40_000),
    maxEpisodeScenes: num(env.MAX_EPISODE_SCENES, 80),
    maxImportEpisodes: num(env.MAX_IMPORT_EPISODES, 120),
  },
  // Importing a ready-made screenplay (POST /v1/projects). The web app doesn't offer it; off in production unless asked for.
  importEnabled: bool(env.IMPORT_ENABLED, !production),

  // The public developer API (/api/v1): pay-as-you-go keys for clips and microdramas. Off until API_ENABLED=1.
  api: {
    enabled: bool(env.API_ENABLED, false),
    retentionDays: num(env.API_RETENTION_DAYS, 7),               // API videos are deleted this long after they finish
    failedRetentionDays: num(env.API_FAILED_RETENTION_DAYS, 1),  // …and this long after a failure
    requestsPerMinute: num(env.API_REQUESTS_PER_MINUTE, 300),    // per key
    createsPerMinute: num(env.API_CREATES_PER_MINUTE, 30),       // new videos and films per account
    maxActive: num(env.API_MAX_ACTIVE_PER_ACCOUNT, 20),          // clips queued or rendering per account
    maxActiveFilms: num(env.API_MAX_ACTIVE_FILMS, 3),            // films being made per account
    filmMaxSeconds: num(env.API_FILM_MAX_SECONDS, 900),          // the longest film one request may ask for
    refusalsBeforeSuspend: num(env.API_REFUSALS_BEFORE_SUSPEND, 5), // content refusals in 24 h before API access is suspended
    webhookTimeoutSec: num(env.API_WEBHOOK_TIMEOUT_SEC, 10),
    maxKeys: num(env.API_MAX_KEYS, 10),                          // active keys per account
    logDays: num(env.API_LOG_DAYS, 30),                          // how long the request log is kept
    // Local development and tests only (refused in production): media and webhook URLs may point at this machine.
    allowPrivateUrls: bool(env.API_ALLOW_PRIVATE_URLS, false),
  },

  // Who runs the service: shown in the Terms, the Privacy Policy and wherever the app says "contact support".
  legal: {
    company: env.LEGAL_COMPANY || '', jurisdiction: env.LEGAL_JURISDICTION || '', address: env.LEGAL_ADDRESS || '',
    email: env.SUPPORT_EMAIL || '', updated: env.LEGAL_UPDATED || '14 November 2026',
  },

  // The company dashboard: monthly fixed costs ("Railway:20,Supabase:25") and the payment processor's fee per payment.
  business: {
    fixedCosts: (env.FIXED_COSTS_MONTHLY || '').split(',').map((x) => x.split(':').map((s) => s.trim())).filter(([n, v]) => n && +v > 0)
      .map(([name, usd]) => ({ name, usd: +usd })),
    paymentFeePct: num(env.PAYMENT_FEE_PCT, 5),
    paymentFeeUsd: num(env.PAYMENT_FEE_USD, 0.5),
  },

  runpod: {
    apiKey: env.RUNPOD_API_KEY || '',
    endpointId: env.RUNPOD_ENDPOINT_ID || '',
    apiBase: (env.RUNPOD_API_BASE || 'https://api.runpod.ai/v2').replace(/\/$/, ''),
    restBase: (env.RUNPOD_REST_BASE || 'https://rest.runpod.io/v1').replace(/\/$/, ''),
    executionTimeoutSec: num(env.RUNPOD_EXECUTION_TIMEOUT_SEC, 1800),
    gpuPricePerSecond: num(env.RUNPOD_GPU_PRICE_PER_SECOND, 0), // what one worker-second costs us, for margin reports
    // Warm-pool controller: keep GPUs warm while customers are active, scale to zero when idle.
    // On by default whenever our own GPUs render: the controller pre-warms GPUs for the work waiting and lets them go when idle.
    manageScaling: bool(env.RUNPOD_MANAGE_SCALING, (env.VIDEO_PROVIDER || '') === 'runpod' || (env.CLIP_IMAGE_PROVIDER || '') === 'runpod'),
    warmWorkers: num(env.RUNPOD_WARM_WORKERS, 1),
    warmMinutes: num(env.RUNPOD_WARM_MINUTES, 15),
    maxWorkers: num(env.RUNPOD_MAX_WORKERS, 5),
    jobsPerWorker: num(env.RUNPOD_JOBS_PER_WORKER, 2),
    tickSeconds: num(env.RUNPOD_CAPACITY_TICK_SECONDS, 30),
    graphqlUrl: env.RUNPOD_GRAPHQL_URL || 'https://api.runpod.io/graphql', // account balance, for the ops dashboard
  },

  // The ops dashboard (src/ops.ts): its own service, so it stays up when the app has trouble and shows you that it does.
  ops: {
    port: num(env.OPS_PORT, num(env.PORT, 8790)),
    // Where it checks that the app answers: ENGINE_URL (e.g. Railway's private address), else the public site.
    engineUrl: (env.ENGINE_URL || env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 8787)}`).replace(/\/$/, ''),
    // Monthly spend you allow per provider ("anthropic:300,minimax:200,runpod:400"): the dashboard shows what's left
    // and how many days it lasts at the current rate.
    budgets: Object.fromEntries(Object.entries(pairs(env.PROVIDER_BUDGETS_MONTHLY || '')).map(([k, v]) => [k.toLowerCase(), Number(v)] as const)
      .filter(([, v]) => v > 0)) as Record<string, number>,
  },

  // Error alerts (optional): a Sentry project's DSN. Server errors and failed jobs are reported there.
  sentryDsn: env.SENTRY_DSN || '',

  admins: (env.ADMIN_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),

  images: {
    provider: (env.IMAGE_PROVIDER || 'minimax') as 'minimax' | 'gemini' | 'openai',
    geminiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    geminiBaseUrl: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    openaiKey: env.OPENAI_API_KEY || '',
    openaiModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, ''),
  },

  // USD list prices used for estimates and spend tracking. Update when MiniMax changes pricing.
  pricing: {
    videoPerSecond: { '768P': num(env.PRICE_768P, 0.08), '2K': num(env.PRICE_2K, 0.13), '480P': num(env.PRICE_480P, 0.04) } as Record<string, number>,
    imageEach: num(env.PRICE_IMAGE, 0.0035),
    // MiniMax video: reference pictures sent with a request are free up to this many, then billed each.
    freeInputImages: num(env.FREE_INPUT_IMAGES, 5), inputImageEach: num(env.PRICE_INPUT_IMAGE, 0.04),
    voicePerChar: num(env.PRICE_VOICE_CHAR, 30 / 1_000_000),
    retakeFactor: num(env.RETAKE_FACTOR, 1.8), // expected takes per approved shot, for estimates
  },

  // What customers pay, in USD credits. Deliberately independent of provider cost, so a cheaper
  // provider (or self-hosting) becomes margin instead of a price change.
  credits: {
    enforce: bool(env.ENFORCE_CREDITS, production),
    sellPerSecond: { '768P': num(env.SELL_PER_SECOND_768P, 0.16), '2K': num(env.SELL_PER_SECOND_2K, 0.26) } as Record<string, number>,
    // Per vibe project: the first automatic pass (story, screenplay, cast, sets and shot plan). An estimate of our
    // AI cost with margin: check "charged vs our cost" on the Admin customer page after the first real runs.
    setupFeeUsd: num(env.SETUP_FEE_USD, 2),
    // A longer film is more writing, casting and planning: each minute past the first SETUP_FEE_INCLUDED_MINUTES adds this.
    setupFeeIncludedMinutes: num(env.SETUP_FEE_INCLUDED_MINUTES, 10),
    setupFeePerMinuteUsd: num(env.SETUP_FEE_PER_MINUTE_USD, 0.1),
    // What each later action costs the customer. Charged when the work runs, refunded automatically if it fails.
    actions: {
      image: num(env.SELL_IMAGE_USD, 0.05),         // one character, outfit, set or prop image (re)generated
      voice: num(env.SELL_VOICE_USD, 0.05),         // one character voice (re)designed
      breakdown: num(env.SELL_BREAKDOWN_USD, 0.5),  // casting, costume and set design from the script (studio projects, re-runs)
      plan: num(env.SELL_PLAN_USD, 0.75),           // the director's plan and shot list for an episode (studio projects, re-plans)
      revision: num(env.SELL_REVISION_USD, 0.05),   // rewriting a shot from a review note
      pitch: num(env.SELL_PITCH_USD, 0.25),          // three new takes on the idea (step-by-step projects)
      scene: num(env.SELL_SCENE_USD, 0.1),           // rewriting one scene of the screenplay from a note
    },
    // Long scripts are more work. Past the scenes each fee includes, every extra scene adds a little, so a redo of a
    // long script is never sold below what it costs to make.
    breakdownIncludedScenes: num(env.BREAKDOWN_INCLUDED_SCENES, 20), breakdownPerSceneUsd: num(env.SELL_BREAKDOWN_SCENE_USD, 0.02),
    planIncludedScenes: num(env.PLAN_INCLUDED_SCENES, 12), planPerSceneUsd: num(env.SELL_PLAN_SCENE_USD, 0.08),
    signupUsd: num(env.SIGNUP_CREDIT_USD, 0),        // free credit when a user's account is first created
    // Top-up packs for subscribers. They go into the balance that never expires.
    packs: packs(env.CREDIT_PACKS || 'starter:10,creator:50,studio:200'),
  },

  // The Basic subscription: required to create, includes monthly credit (reset at each renewal) and storage.
  plan: {
    name: env.PLAN_NAME || 'Basic',
    priceUsd: num(env.PLAN_PRICE_USD, 20),     // shown to customers; the charge itself is set in Lemon Squeezy
    creditsUsd: num(env.PLAN_CREDITS_USD, 20), // plan credit each billing period, unused credit expires at renewal
    storageGb: num(env.PLAN_STORAGE_GB, 10),
  },

  lemonsqueezy: {
    apiKey: env.LEMONSQUEEZY_API_KEY || '',
    storeId: env.LEMONSQUEEZY_STORE_ID || '',
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET || '',
    basicVariantId: env.LEMONSQUEEZY_BASIC_VARIANT_ID || '',
    apiBase: (env.LEMONSQUEEZY_API_BASE || 'https://api.lemonsqueezy.com').replace(/\/$/, ''),
    appUrl: (env.APP_URL || '').replace(/\/$/, ''), // where checkout returns the customer, e.g. https://backlot.app
  },

  // Built web app served by the engine (repo layout: engine/ next to web/).
  webDir: env.WEB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'),

  autopilot: {
    // Optional cap on a project's total runtime, in seconds (0 = no cap: a whole series or a feature film is fine).
    maxRuntimeSeconds: num(env.MAX_RUNTIME_SECONDS, 0),
  },

  // Customer uploads being decoded at once per process, and how many more may wait before callers are told to retry.
  // …and large requests (uploads, API videos with media) being received at once per process: the rest are asked to retry.
  media: { slots: Math.max(1, num(env.MEDIA_SLOTS, 3)), queue: Math.max(0, num(env.MEDIA_QUEUE, 24)), uploads: Math.max(1, num(env.MAX_PARALLEL_UPLOADS, 12)) },

  ffmpeg: { bin: env.FFMPEG_BIN || 'ffmpeg', probe: env.FFPROBE_BIN || 'ffprobe', font: env.SUBTITLE_FONT || 'DejaVu Sans',
    // Optional: a font file and folder shipped with the app (the desktop app uses these), for machines without fontconfig.
    fontFile: env.SUBTITLE_FONT_FILE || '', fontsDir: env.SUBTITLE_FONTS_DIR || '' },

  // Replace every paid provider with local fakes (no keys needed). For development and CI only.
  mock: bool(env.MOCK_PROVIDERS, false),
};

export type Config = typeof config;
