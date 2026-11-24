# Deploying Backlot

**First time? Follow `docs/BETA.md`: the same setup in plain language, in order, with a built-in Setup check.**
This file is the detailed reference.

Everything below is a one-time setup. After it, every push to `main` that passes CI can be deployed as is.

```
                 ┌──────────────── Railway ────────────────┐
 customers ────▶ │  backlot image (Dockerfile)             │ ──▶ Anthropic (scripts, planning)
 developers ───▶ │  web app + /api/v1 + job worker + FFmpeg│ ──▶ MiniMax API (reference images, voices)
                 └──────┬───────────────┬──────────────────┘ ──▶ Lemon Squeezy (subscriptions, top-ups, tax)
                        │               │ jobs / status / cancel / scaling
                 Supabase:              ▼
                 Auth, Postgres,   RunPod Serverless: gpu-worker image + H3 weights on a network volume
                 Storage (S3)      (autoscaled GPU workers upload clips straight to Supabase Storage)
```

## 1. Supabase (sign-in, database, file storage)

1. Create a project at supabase.com (pick the region closest to your customers and to RunPod).
2. **Auth → Providers**: keep Email on. For Google, create an OAuth client in Google Cloud and paste its id and
   secret.
   - **Auth → URL configuration**: set the Site URL to `https://<your-domain>`, and add these Redirect URLs:
     `https://<your-domain>/dashboard` (sign-up and Google), `https://<your-domain>/reset-password` (forgot
     password) and `https://<your-domain>/account` (change email).
   - **Auth → SMTP settings**: add your own email provider (Resend, Postmark, SES…). Supabase's built-in sender
     only allows a few emails an hour, which isn't enough for sign-up confirmations and password resets.
3. **Project Settings → API**: copy the Project URL → `SUPABASE_URL`, and the anon/publishable key →
   `SUPABASE_ANON_KEY`.
4. **Connect → Session pooler**: copy the connection string → `DATABASE_URL`. The engine creates its tables on
   first boot, and encrypts the connection by itself (an `sslmode` in the URL overrides that).
5. **Storage**: create a **private** bucket `backlot`. **Storage → S3 connection**: create access keys →
   `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET=backlot`,
   `STORAGE_DRIVER=s3`.

## 2. Video: MiniMax now, RunPod later

Launch with MiniMax's hosted H3: `VIDEO_PROVIDER=minimax` and `MINIMAX_API_KEY` (the same key makes the cast and set
images and the voices). There is nothing else to set up.

Then move video to your own GPUs on RunPod. Follow `docs/SELF-HOSTED-H3.md` (plain language) or `gpu-worker/README.md`:
1. GitHub builds and publishes the `gpu-worker` image (`.github/workflows/gpu-image.yml`).
2. Put the H3 weights on a network volume.
3. Create a Serverless endpoint.
   - To prove the whole path before the model is ready, set `MODEL_BACKEND=fake`: it renders test patterns.
4. Copy the endpoint id → `RUNPOD_ENDPOINT_ID`, and create an API key → `RUNPOD_API_KEY`.

### GPU autoscaling (engine env)

With `VIDEO_PROVIDER=runpod` the engine scales the GPUs by itself (`engine/src/capacity.ts`). Every 30 seconds, and at
once whenever new work is queued, it counts the renders that could run now and sets the endpoint's worker floor to one
GPU per `RUNPOD_JOBS_PER_WORKER` of them, up to `RUNPOD_MAX_WORKERS`. RunPod adds GPUs on top as its own queue grows.
While customers are active it keeps `RUNPOD_WARM_WORKERS` warm, and `RUNPOD_WARM_MINUTES` after the last render it lets
the floor fall to zero, so an idle night costs nothing. The number of renders sent at once follows the ceiling
(max workers × jobs per worker), so raising one setting is all it takes to grow.

| Variable | Start with | Meaning |
|---|---|---|
| `RUNPOD_MAX_WORKERS` | 5 | Budget cap: never more GPUs than this. Raise it (and your RunPod quota) as demand grows |
| `RUNPOD_WARM_WORKERS` | 1 | GPUs kept warm while customers are active |
| `RUNPOD_WARM_MINUTES` | 15 | How long after the last render to stay warm before scaling to 0 |
| `RUNPOD_JOBS_PER_WORKER` | 2 | Renders per GPU (one filming, one waiting) before the floor rises |
| `RUNPOD_MANAGE_SCALING` | 1 (with RunPod) | 0 leaves the worker floor to the RunPod console |
| `RUNPOD_CAPACITY_TICK_SECONDS` | 30 | How often the controller looks (every 15 s while work is waiting) |
| `VIDEO_MAX_INFLIGHT` | derived | Renders sent at once: max workers × jobs per worker on RunPod, 10 on MiniMax |
| `MAX_ACTIVE_RENDERS_PER_USER` | 4 | Clips filming at once per customer, across all their videos, whatever the clip length |
| `RENDERS_PER_PROJECT` | empty | Clips of one film at once, in story order (empty = the customer's limit, so one film can use all 4) |
| `CHAIN_CLIPS` | 0 | 1 sends each scene's previous clip as a reference video: better matching, but its seconds are billed as input |
| `RUNPOD_GPU_PRICE_PER_SECOND` | your rate | Records real GPU cost per clip, for margin reports and the API's price guard |

`/admin` shows the render slots in use and waiting and, with RunPod, the GPUs needed against the floor and the ceiling,
with "raise RUNPOD_MAX_WORKERS" when demand needs more GPUs than the ceiling (the engine also logs it every 30 minutes
while it lasts). `GET /v1/admin/capacity` has the raw numbers, including the controller's last decision.

The controller sets the endpoint's **Active workers** (the floor) and **Max workers** (`RUNPOD_MAX_WORKERS`) itself, so
leave those to it. In the RunPod console set the rest: **Idle timeout** 60–120 s, **Queue delay** scaling at about 4 s,
**FlashBoot** on, and a worker quota at least `RUNPOD_MAX_WORKERS`.

## 3. Lemon Squeezy (payments)

Lemon Squeezy is the Merchant of Record: it charges customers, adds and pays VAT and sales tax, and sends
invoices. Start in **test mode**, and switch the store to live once the launch check passes.

1. Create a store. **Settings → Stores**: copy the store's number → `LEMONSQUEEZY_STORE_ID`.
2. **Products → New product "Basic"**: pricing **Subscription**, $20, every 1 month. Publish it, then open the
   variant and copy its id → `LEMONSQUEEZY_BASIC_VARIANT_ID`. (Variant ids are in the product's "…" menu →
   "Copy ID", or from `GET https://api.lemonsqueezy.com/v1/variants`.)
3. **Credit packs**: one product each, pricing **Single payment**: Starter $10, Creator $50, Studio $200.
   Copy each variant id into `CREDIT_PACKS=starter:10:<id>,creator:50:<id>,studio:200:<id>`. The first
   number is the credit the customer gets, so keep it equal to the product price. The engine never trusts the
   amount paid, which includes tax. Packs are sold to anyone, with or without a plan: they're how developers pay
   for the API.
4. **Settings → API**: create an API key → `LEMONSQUEEZY_API_KEY`. Test-mode and live-mode keys are separate.
5. **Settings → Webhooks → +**: URL `https://<your-domain>/webhooks/lemonsqueezy`, a long random signing
   secret (`openssl rand -hex 32`) → `LEMONSQUEEZY_WEBHOOK_SECRET`, and these events:
   `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`,
   `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`,
   `subscription_payment_success`.
6. **Settings → Customer portal**: turn it on, and allow cancelling and updating the payment method. The
   Billing page's "Manage subscription" button opens it.
7. Set `APP_URL=https://<your-domain>`: checkout sends customers back to `/billing?paid=1`.

How the money works:
- **Plan credit** (`PLAN_CREDITS_USD`, $20) is **reset**, not added, on every paid subscription invoice, so
  unused plan credit expires at renewal. The ledger (`credit_events`) records `plan_expired` and `plan_credit`.
- **Top-up credit** from packs, failed-render refunds and refunded setup fees never expire. Spending takes plan
  credit first.
- **Everything is charged.** The setup fee (`SETUP_FEE_USD`) pays for a video's first automatic pass (story, screenplay,
  cast, sets, shot plan); rendering is per second. Afterwards each action has its own price (`SELL_IMAGE_USD`,
  `SELL_VOICE_USD`, `SELL_BREAKDOWN_USD`, `SELL_PLAN_USD`, `SELL_REVISION_USD`, `SELL_PITCH_USD` for three new story
  takes, `SELL_SCENE_USD` for a scene rewrite), listed for customers on the Billing
  page. Each charge is taken when the work runs and refunded in full (to the never-expiring balance) if it fails, so
  retries and duplicate clicks never cost the customer. Unaffordable actions are refused up front with a 402. Compare
  "charged" with "our cost" on each customer's Admin page and tune the prices.
- In the app, creating, rendering, retakes, edits and uploads need an active plan: `active`, `on_trial`, `past_due`
  (grace while Lemon Squeezy retries the card), or `cancelled` until its `ends_at`. When the subscription expires, the
  rest of the plan credit goes too. Top-ups stay. The API needs credit only, no plan.
- Long work is priced by its size, so a big job can't ride on a flat fee: the setup fee grows per minute beyond
  `SETUP_FEE_INCLUDED_MINUTES`, a breakdown per scene beyond `BREAKDOWN_INCLUDED_SCENES`, a shot plan per scene beyond
  `PLAN_INCLUDED_SCENES`, and pictures past `FREE_INPUT_IMAGES` on a MiniMax request are counted in our cost.
- **Storage**: every app project file is counted per customer against `PLAN_STORAGE_GB` (10). Nothing in the app is
  deleted automatically (API outputs expire after `API_RETENTION_DAYS` instead): files stay until the customer deletes them (on Cloudflare R2, a full 10 GB costs about $0.15 a
  month). When a customer is over it, new work is refused with "You're using 10.1 of 10 GB. Delete old videos to
  make room." Renders already running finish. Deleting a video deletes its files.
- Webhooks are verified (`X-Signature`) and applied once: `payments` rows are keyed `ls:invoice:<id>` and
  `ls:order:<id>`, so Lemon Squeezy's retries never credit twice.
- **Refunds** issued in the Lemon Squeezy dashboard don't take credit back automatically. If you refund a
  top-up, take the credit back by hand: `update credit_accounts set balance_usd = balance_usd - <usd>` plus a
  `credit_events` row with reason `refund_reversed`.

## 4. Railway (the app)

1. New project → **Deploy from GitHub repo** → `khurramidris/backlot`. Railway reads `railway.json` and builds
   the root `Dockerfile`.
2. **Variables**: paste everything from `engine/env.sample` with real values. The required ones are marked.
   Leave `MOCK_PROVIDERS` and `ALLOW_DEV_TOKENS` unset: the engine refuses to start in production with them.
3. **Settings → Networking**: generate a domain, or add your own. Use it for `PUBLIC_BASE_URL`, `APP_URL`
   and `CORS_ORIGINS`.
4. Deploy. `https://<your-domain>/health` should return `{"ok":true,"mock":false}`.
5. **Settings → Deploy**: check that **Healthcheck path** is `/health` and set **Restart policy** to **Always** (paid
   plans; on the trial plan keep "On failure"). `railway.json` sets the builder, the health check and a restart
   policy, but Railway is replacing that file with its newer Infrastructure as Code, so set them in the settings too.
   Railway calls the health check only while a deploy goes live: it doesn't watch it afterwards. The engine looks
   after itself (it exits to be restarted if its database pool jams while the database is fine, `DB_WATCHDOG`), and
   `/health` answers `503` within 5 seconds when the database stops answering.
6. **An outside uptime monitor** on `https://<your-domain>/health` (UptimeRobot or Better Stack, free), alerting you by
   email or phone. It's the only thing that tells you the site is down before a customer does.

**Database connections:** each engine process opens up to `DB_POOL_MAX` (10). Keep replicas × `DB_POOL_MAX` under your
Supabase pooler's pool size (Project Settings → Database → Connection pooling; it's small on the smaller compute sizes,
so check it before adding replicas). A transaction that waits on a lock longer than `DB_LOCK_TIMEOUT_MS` gives up and
the request is retried, so one stuck request can't freeze the rest.

**Deploying while customers work:** a deploy gives running steps 20 seconds to finish, then hands what's left back to
the queue, and the new version carries on at once. Railway only waits for this if you give it the time: add the
variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`. Without it, or if an instance is killed outright, the cut-off steps
are picked up again within about 3 minutes. Either way deploying mid-film delays it but loses nothing.

**Scaling the app itself:** one instance handles the web app, both APIs, the job queue and FFmpeg editing. The queue
runs in lanes, each with its own slots per process, so a burst of one kind of work never starves the others:

| Lane | Work | Slots |
|---|---|---|
| `llm` | writing, breakdowns, shot plans (long Claude turns, mostly waiting) | `WORKER_CONCURRENCY` (6) |
| `render` | sending clips to the video service and collecting them | 8 |
| `assets` | cast and set pictures, voices | 4 |
| `media` | FFmpeg editing (CPU heavy) | 2 |
| `io` | webhooks, cleanup, small jobs | 4 |

`WORKER_LANES=llm:12,render:16,media:4` changes any of them. Within a lane, one customer gets at most
`FAIR_LLM_PER_CUSTOMER` (3) writing jobs, 2 picture jobs and `FAIR_EDITS_PER_CUSTOMER` (1) edit at once; the rest wait
their turn so nobody is held up behind one big order. When a lane backs up (the dashboard shows the queue), raise its
slots or add replicas. The queue is safe to share between instances. To separate the web and API from background work,
run one service with `RUN_WORKER=0` and more with the start command `node dist/worker.js`.

**Uploads** are checked by content (not their name), decoded with an allow-list of formats and no network access, and
at most `MEDIA_SLOTS` (3) at a time per process, with `MEDIA_QUEUE` (24) waiting; past that, callers are asked to retry
(`503`), so a burst of uploads can't run the server out of memory.

**Cleanup** runs hourly: finished jobs after 7 days and failed ones after 30, edits beyond the two newest per episode,
old content-check verdicts, and the API's expired outputs and logs.

## 5. Launch check (10 minutes)

1. Sign up with email and with Google.
2. Subscribe to Basic with a Lemon Squeezy test card (`4242 4242 4242 4242`). /billing should show the plan as
   active with $20 of monthly credit within a few seconds. Buy the Starter pack: top-up credit shows $10.
   "Manage subscription" should open the customer portal.
3. Create a microdrama from one sentence. It should stop at "Your approval" with script, cast and price.
4. Press "Make my video", wait for "Finished", play and download the MP4.
5. "Fix this shot" on one shot: the balance drops by that shot's price and a new edit appears.
6. Delete a video from the dashboard: storage on /billing goes down.
7. "Forgot password?" on the sign-in page: the email arrives and its link lets you set a new password.
8. Cancel from the customer portal: /billing shows "Cancelled · ends …" and creating still works until then.
9. As an admin (`ADMIN_USER_IDS`), open `/admin`: under Health, "Render capacity" shows the slots in use and, with
   RunPod, the GPUs needed against the floor and the ceiling.
10. With `API_ENABLED=1` (see Public API below): on `/developers` create a key with a $5 monthly limit, then run the
    quick start from `/docs/api` with it. The video arrives, the balance drops by its price, and a webhook to a test
    receiver (webhook.site) shows a `Backlot-Signature`. Revoke the key afterwards.

## Operations
- **Admin** (`/admin`, users in `ADMIN_USER_IDS`) is the company dashboard, for the last 7 days, 30 days,
  90 days or 12 months:
  - money: revenue (plans and top-ups), costs (AI and GPU, fixed bills, estimated payment fees), profit and
    margin, and monthly recurring revenue
  - money in and out per day, with a table view
  - where the money goes: Claude (writing and content checks), pictures, video, voices, payment fees, each fixed
    bill, video cost per second against the price, credits spent and credits still owed to customers
  - health right now: queue, background jobs, storage, RunPod workers
  - customers: accounts, new, active, paying, cancelling, payment problems
  - what was made: films, clips, renders, failures, content refusals, average render time
  - problems (failed films and renders, refusals) and the top customers by spend
  - customer search by email or user id

  For true profit, list your monthly bills in `FIXED_COSTS_MONTHLY` (`Railway:20,Supabase:25,RunPod storage:5.25`).
  Payment fees are estimated with `PAYMENT_FEE_PCT` (5) and `PAYMENT_FEE_USD` (0.50), Lemon Squeezy's standard
  rate. The same report is `GET /v1/admin/business?days=30`.
  - each customer's detail: plan, credits, storage, films with charged vs provider cost, payments and the credit
    ledger, plus credit grants and deductions (with a note; top-up bucket; ledger reasons
    `admin_grant` / `admin_deduct`)
- **Setup check** (`/setup`) tests every production setting and service, including the company details and, with the
  API on, the price guard.
- **Public API** (`/api/v1`, reference `docs/API.md`, developers' guide `/docs/api`): off until `API_ENABLED=1`. Turn
  it on once a real film and real clips have been made and their cost checked on `/admin`. It sells at the app's prices
  and needs prepaid credit, no plan.

  | Variable | Start with | Meaning |
  |---|---|---|
  | `API_ENABLED` | 0 | 1 opens `/api/v1`. While it's 0, keys can be made but requests get a 404, and the Developers page and `/docs/api` say the API opens soon |
  | `API_RETENTION_DAYS` / `API_FAILED_RETENTION_DAYS` | 7 / 1 | When API outputs are deleted after they finish or fail |
  | `API_REQUESTS_PER_MINUTE` | 300 | Per key (per engine instance) |
  | `API_CREATES_PER_MINUTE` | 30 | New videos and films a minute per account |
  | `API_MAX_ACTIVE_PER_ACCOUNT` / `API_MAX_ACTIVE_FILMS` | 20 / 3 | Videos and films in progress at once per account |
  | `API_FILM_MAX_SECONDS` | 900 | The longest film one request may ask for |
  | `API_REFUSALS_BEFORE_SUSPEND` | 5 | Content refusals in 24 h before the account's API access is suspended |
  | `API_WEBHOOK_TIMEOUT_SEC` / `API_MAX_KEYS` / `API_LOG_DAYS` | 10 / 10 / 30 | Webhook timeout, keys per account, request log kept |

  The **price guard** refuses paid API requests (`503 pricing_unavailable`, red on `/setup`) whenever the video service
  costs us as much per second as we charge: MiniMax's list price, or your GPUs' measured cost over the last week. A
  suspended account shows on its Admin page with a button to restore it.
- **Screenplay import** (`POST /v1/projects` with a script) is for local tools and tests; the web app doesn't offer it.
  It's off in production unless `IMPORT_ENABLED=1`, and each script is held to `MAX_SCRIPT_CHARS`, `MAX_EPISODE_SCENES`
  and `MAX_IMPORT_EPISODES`.
- **Story engine** (how it works and how to judge a change: `docs/STORY-ENGINE.md`):

  | Variable | Start with | Meaning |
  |---|---|---|
  | `CLAUDE_MODEL` | `claude-opus-5-5` | Every writing and planning step |
  | `CLAUDE_MODELS` | empty | Per-step models, e.g. `scene:claude-sonnet-5-5,judge:claude-sonnet-5-5,shots:claude-sonnet-5-5` |
  | `CLAUDE_BULK_MODEL` / `CLAUDE_BULK_STEPS` | `claude-haiku-5-5` / `outline,scene,judge,critique,breakdown,direct,shots` | The cheaper model for the many small calls of long films (from `LONG_FORM_SECONDS`, 900) |
  | `SEASON_BATCH_EPISODES` / `CRITIQUE_BATCH_SECONDS` / `BREAKDOWN_BATCH_SCENES` | 12 / 600 / 40 | How a long story is cut into calls |
  | `SETUP_FEE_INCLUDED_MINUTES` / `SETUP_FEE_PER_MINUTE_USD` | 10 / 0.1 | The setup fee grows with story length beyond the first 10 minutes |
  | `MAX_RUNTIME_SECONDS` | 0 | Longest story a customer can order (0 = no limit) |
  | `STORY_EFFORT` / `PLANNING_EFFORT` | `high` / `medium` | Thinking depth for the story steps / the many shot and judge calls |
  | `SCRIPT_DOCTOR` | 1 | The script editor's notes and the rewrites of the scenes it flags |
  | `KEY_SCENE_DRAFTS` | 2 | Drafts of each episode's opening and ending; a judge keeps the best (1 = off) |
  | `CLAUDE_STRUCTURED_OUTPUTS` / `CLAUDE_THINKING` | 1 / 1 | Set 0 for a model or endpoint without them |
  | `PROMPT_LOG_DIR` | unset | Write every prompt to this folder, to read exactly what the model was sent |
- **Error alerts:** set `SENTRY_DSN`. It reports API errors (5xx), jobs that fail on their last attempt, and
  unhandled rejections.
- **Content checks** (`MODERATION`, on by default): before anything is filmed, Claude's fast model checks quick-clip
  prompts and uploads, uploaded character and set pictures, and shot prompts a customer rewrote by hand (Claude
  follows the same rules when it writes the others). It refuses nudity and sex, minors in any sexual or abusive
  context, celebrities and politicians (deepfakes), real people in sexual, violent or deceptive scenes, gore, hate,
  self-harm and serious crime. Drama, thrillers and non-gory action pass. A refusal is shown to the customer and
  never charged. Verdicts are cached, so a retake costs nothing extra. The cost shows on `/admin` under "content
  checks".
- **Quick clips** are 5 to 15 seconds (`CLIP_MIN_SECONDS` sets the shortest). On your own RunPod H3,
  image-to-video pins the picture as the first frame; if those clips look wrong, set
  `CLIP_IMAGE_PROVIDER=minimax` to send just that mode to MiniMax. `CHAIN_CLIPS` (off) decides whether films send
  each scene's previous shot along for continuity: billed as input seconds on MiniMax, double the GPU work on RunPod.
- **Rate limits** in the app are per customer and in memory, per instance:
  - 600 requests a minute
  - 30 new videos an hour
  - 30 billing calls an hour
  - 200 renders or retakes an hour
  - 300 asset calls an hour
  - 30 edits (new cuts) an hour
  Over a limit the engine answers 429 with `Retry-After`. The public API's own limits are above.
- **Security headers:** the engine sends a Content Security Policy, `X-Frame-Options: DENY`, `nosniff`, a strict
  referrer policy and HSTS (in production). Customer costs (what a job cost us) are visible to admins only.
- **Fonts:** the Docker image installs DejaVu Sans, which subtitles and slates use. To use a font file that ships with the
  app instead (the desktop app does), set `SUBTITLE_FONT_FILE` and `SUBTITLE_FONTS_DIR`; with the fonts folder set, text
  drawn into pictures uses libass, so FFmpeg builds without the `drawtext` filter still work.

## 6. Before you take real money

- Set the company details on Railway: `LEGAL_COMPANY`, `LEGAL_JURISDICTION`, `LEGAL_ADDRESS` and `SUPPORT_EMAIL`. The
  Terms, the Privacy Policy and the support links read them at startup (no rebuild), and `/setup` flags them until set.
- Have a lawyer review `/terms` and `/privacy` (`web/src/routes/terms.tsx`, `privacy.tsx`). They're
  plain-language drafts. In particular, check the retention periods (including the API's 7 days), the list of
  processors and their data locations, the promise not to train on customer content (confirm it with each AI
  provider's terms), the API terms (section 11: the developer answers for what their users send), and the consumer
  cancellation and refund rights where you sell.
- Switch the Lemon Squeezy store to live mode, and swap in the live API key, webhook secret and variant ids.
