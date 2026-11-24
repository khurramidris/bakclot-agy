# Backlot API

A public, pay-as-you-go API for developers: send a prompt (and pictures, a video or a voice) and get back a video with
sound, or send an idea and get back a finished microdrama, short film, web series or YouTube story. It's built and
tested, and off until `API_ENABLED=1`.

Developers read the public guide at `/docs/api` (quick start, every endpoint, webhooks with signature-check code,
errors, limits, examples in curl, Python and JavaScript) and the machine-readable spec at `/api/v1/openapi.json`. This
file is the engineering and operations reference.

## Decisions

| Decision | Choice |
|---|---|
| What it makes | **Videos** (quick clips): text, image (first frame), references (up to 9 pictures and a voice), remix (a video). 5–15 s, 768P, MP4 (H.264 + AAC). **Films**: an idea in, finished episodes out, through the same pipeline as the app, up to `API_FILM_MAX_SECONDS` (900) per request. |
| Who can use it | Anyone with prepaid credit. **No subscription needed.** Top-up packs on the Billing page are sold without a plan. A subscriber's plan credit is spent first, then top-ups. |
| Price | The same as the app: per second of video (`SELL_PER_SECOND_768P`); films pay the setup fee plus filming per second. `GET /api/v1/pricing` publishes it. |
| How long outputs are kept | **7 days** after a video or film finishes (1 day after a failure), then the files are deleted and the object says `expired`. API work doesn't count against the 10 GB app allowance. |
| Rights and content | The same content check as the app, on every request. Any request with media must send `rights_confirmed: true`. |
| Contract | `/api/v1` is separate from `/v1`, the web app's private API. `/api/v1` changes only by adding things; `/v1` keeps changing with the UI. |

## How it fits

```
developer ──Bearer bk_live_…──▶ /api/v1 (engine/src/api/routes.ts)
                                  │ key auth · per-key limits · idempotency · request log · price guard
                                  ▼
   videos: safe media fetch (URLs / data URIs) ──▶ createClip()   ← the app's own clip pipeline
   films:  brief checks ─────────────────────────▶ createFilm()   ← the app's prompt → film pipeline
                                                     │ content check, holds, render, refunds, cancel on delete
                                                     ▼
                       project event (done / failed / awaiting price) ──▶ expires_at + signed webhook job
```

A video is a clip project and a film is a "vibe" project, both with `origin = 'api'`, so holds, settlement, refunds,
cancel-on-delete, the RunPod path, GPU autoscaling and the dashboard's cost ledger are the code the app runs every day.
The app's own dashboard lists `origin = 'app'` projects only.

## The contract

### Authentication
`Authorization: Bearer bk_live_<32 base62 characters>`. Keys are created on the **Developers** page (`/developers`).
The full key is shown once; we store only its SHA-256 and a display prefix. Each account can have up to `API_MAX_KEYS`
(10) active keys, each with an optional monthly spend limit. `last_used_at` is updated at most once a minute per key, and
keys are never logged.

### Endpoints

| Method and path | What it does |
|---|---|
| `GET /api/v1/pricing` (no key) | Prices, lengths, aspect ratios, film formats, media limits and rate limits. |
| `GET /api/v1/openapi.json` (no key) | The OpenAPI 3.1 spec, generated from the same zod schemas that validate requests. |
| `GET /api/v1/account` | Balance, limits, and how many videos and films are in progress. |
| `POST /api/v1/videos` | Make a video. `201` with the video object once inputs are checked and the render is queued. |
| `GET /api/v1/videos` | List, newest first: `?limit=20&starting_after=<id>`. |
| `GET /api/v1/videos/{id}` | Status, cost, output links (signed for 24 h; fetch again for fresh ones until it expires). |
| `DELETE /api/v1/videos/{id}` | Cancel if still rendering (the hold is refunded) and delete its files. |
| `POST /api/v1/films/quote` | What a film of this shape will cost (setup fee and estimated filming), without making anything. |
| `POST /api/v1/films` | Make a film. `201` with the film object; writing starts at once. |
| `GET /api/v1/films`, `GET /api/v1/films/{id}` | List and read films, with each episode's output link when it's ready. |
| `POST /api/v1/films/{id}/approve` | Film it at the price shown (a film waits at its price when `auto_approve` is false or the price is over `max_cost_usd`). |
| `POST /api/v1/films/{id}/retry` | Continue a failed film from the step it stopped at. |
| `DELETE /api/v1/films/{id}` | Stop it, refund what's held, delete every file. |

Unknown paths answer a JSON `404` (after the key check), never the web app.

### Making a video

```json
POST /api/v1/videos
Idempotency-Key: 7f0c…            (optional, recommended)
{
  "prompt": "Maya in image 1 holds up the sneaker in image 2 and says: These changed my mornings.",
  "duration": 5,                       // whole seconds, 5–15
  "aspect_ratio": "9:16",              // 9:16 | 16:9 | 1:1
  "first_frame": { "url": "https://…/start.png" },                      // image to video
  "images": [ { "url": "https://…/maya.png", "label": "Maya" }, { "url": "data:image/png;base64,…" } ],
  "video": { "url": "https://…/source.mp4" },                           // remix
  "audio": { "url": "https://…/maya.mp3", "label": "Maya" },            // a voice
  "rights_confirmed": true,
  "webhook_url": "https://example.com/hooks/backlot",
  "metadata": { "order": "A-1042" }                                      // ≤ 20 keys, ≤ 1 KB, returned as sent
}
```

The mode is inferred from the inputs: nothing → text; `first_frame` → image; `images` and/or `audio` → references;
`video` → remix. Invalid combinations get a clear `400` with the same rules as the app (`checkClipForm`). Prompts may say
`image 2`, `video 1` or `voice 1`, or use the model's tags `<Picture 2>`, `<Video 1>`, `<Audio 1>`.

Video **statuses**: `queued` (waiting for a GPU), `processing`, `succeeded` (charged once), `failed` (refunded),
`refused` (by the content check, never charged), `expired` (files deleted after the retention period).

### Making a film

```json
POST /api/v1/films
{
  "prompt": "A night-shift nurse finds out the patient in room 6 is the father who left her.",
  "format": "microdrama",              // microdrama (9:16) | short_film | web_series | youtube (16:9)
  "episodes": 10, "episode_seconds": 90,   // or "total_seconds": 900, split into episodes for you
  "language": "English",
  "max_cost_usd": 60,                  // films by itself while the price is within this
  "auto_approve": true,                // false: always stop at the price and wait for /approve
  "webhook_url": "https://example.com/hooks/backlot",
  "metadata": { "series": "night-shift" }
}
```

The setup fee is taken when the film is created (or, with `auto_approve`, the whole estimate must be affordable up
front); filming is priced exactly once the shots are planned, and taken shot by shot as they're filmed. Failed shots are
refunded. Film **statuses**: `writing`, `awaiting_approval` (see `approval.reason`), `filming`, `editing`, `succeeded`,
`failed`, `expired`. `stage_detail` says what is happening in a few words; `progress` counts shots filmed.

### Errors
One shape: `{ "error": { "type", "code", "message", "param" } }`. Every response carries `X-Request-Id`.

| HTTP | type | When |
|---|---|---|
| 400 | `invalid_request` | bad JSON, wrong combination, file unreadable or too small, `rights_confirmed` missing, a film too long |
| 401 | `authentication_error` | missing, unknown or revoked key |
| 402 | `insufficient_credit` | the balance can't cover it (nothing is created) |
| 403 | `permission_error` | API access suspended (`account_suspended`), or the key's monthly limit reached (`key_limit_reached`) |
| 404 | `not_found` | not yours, or doesn't exist |
| 409 | `idempotency_error` / `invalid_request` | the same Idempotency-Key still in progress; or the wrong state (`bad_state`) |
| 422 | `content_refused` / `idempotency_error` | refused by the content check; or the same key sent with a different body |
| 429 | `rate_limited` | too many requests, or too many in progress (`Retry-After`, `X-RateLimit-*`) |
| 503 | `service_unavailable` | busy (retry), or `pricing_unavailable` (the price guard, below) |

### Webhooks
- **Events:** `video.succeeded`, `video.failed` (a refusal arrives as `video.failed` with code `content_refused`),
  `film.awaiting_approval`, `film.succeeded`, `film.failed`. Each happens once per state (`webhook_deliveries.event_key`).
- **Body:** `{ "id": "evt_…", "object": "event", "type", "created", "data": <the video or film object> }`, read fresh at
  each attempt so its links are valid. Headers `Backlot-Event` and `Backlot-Delivery`.
- **Signing:** `Backlot-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`, Stripe-style, checked
  within 5 minutes. One signing secret per account (`whsec_…`), revealed and rotated on the Developers page.
- **Delivery:** a durable `webhook.deliver` job, through the same address checks as media downloads, no redirects. A
  2xx within `API_WEBHOOK_TIMEOUT_SEC` (10) succeeds; otherwise it's retried after 1 min, 5 min, 30 min, 2 h, 6 h and
  12 h, then marked `failed`. The latest state shows on the object (`webhook.status`, `attempts`).

### Idempotency
`Idempotency-Key` (≤ 255 characters) on `POST /videos` and `POST /films`, kept 24 h per account. The same key and body
replay the first answer (`Idempotent-Replayed: true`) with no second job or charge; the same key with a different body
is a `422`; a repeat while the first is still running is a `409`. "Try again" answers (409, 429, 5xx) aren't kept, so a
retry runs for real.

### Limits (all settings)
- `API_REQUESTS_PER_MINUTE` (300) per key, counted per engine instance.
- `API_CREATES_PER_MINUTE` (30) new videos and films a minute per account; `API_MAX_ACTIVE_PER_ACCOUNT` (20) videos and
  `API_MAX_ACTIVE_FILMS` (3) films in progress. These are counted in the database, so every instance agrees.
- GPU slots per account still follow `MAX_ACTIVE_RENDERS_PER_USER`, so one developer can't take every GPU.
- Media: pictures ≤ 20 MB, video ≤ 100 MB (the first 15 s is used), voice ≤ 25 MB; request body ≤ 40 MB for data URIs.

## Safety

- **Safe media fetch** (`net.ts`): https only, no credentials in URLs, DNS resolved through a `lookup` hook that rejects
  private, loopback, link-local, CGNAT, multicast and reserved IPv4/IPv6 (including IPv4-mapped IPv6 and the cloud
  metadata address) and pins the checked address (no DNS rebinding). Redirects are followed by hand (at most 3) and
  re-checked; connect and total timeouts; size caps enforced while streaming. Everything then goes through the same
  FFmpeg preparation as uploads (content sniffed, formats and protocols allow-listed, pixel limits), which re-encodes it.
  `API_ALLOW_PRIVATE_URLS=1` lifts the address check for tests and is refused in production.
- **The price guard** (`access.ts`): before any paid request, the video service must cost us less per second than we
  charge: MiniMax's list price, or on RunPod what renders cost over the last 7 days (once there's a minute to judge by).
  Otherwise the API answers `503 pricing_unavailable` and `/setup` turns red.
- **Abuse:** `API_REFUSALS_BEFORE_SUSPEND` (5) content refusals in 24 hours suspend the account's API access, report it
  to Sentry and count on the dashboard's API panel. An admin lifts it from the customer's Admin page (`POST /v1/admin/customers/:id/api`).
- **Retention:** the hourly cleanup deletes expired API files (`expireProject`), removes `expired` records a month later,
  and prunes the request log (`API_LOG_DAYS`, 30), idempotency keys (24 h), refusals and old deliveries (30 days).

## Data model: `engine/db/migrations/011_api.sql`

- `api_keys` (name, prefix, SHA-256 hash, monthly limit, last used, revoked) and `api_accounts` (webhook secret,
  suspension).
- `projects` gains `origin` (`app` | `api`), `api_key_id`, `webhook_url`, `api_metadata`, `finished_at`, `expires_at`;
  `credit_events` gains `api_key_id`, so each key's monthly spend is exact.
- `api_idempotency`, `api_requests` (the request log), `webhook_deliveries` (`event_key` unique), `api_refusals`.
- Row level security on every new table (the engine's role bypasses it).

## Code layout: `engine/src/api/`

| File | Contents |
|---|---|
| `routes.ts` | the `/api/v1` Hono app: `API_ENABLED` gate, request id and log, key auth, per-key rate limit headers, idempotency, the routes |
| `manage.ts` | the Developers page's session routes (`/v1/developers`): keys (create, rename or limit, revoke), webhook secret (reveal, rotate), usage |
| `keys.ts` | key generation (`crypto.randomBytes` → base62), hashing, CRUD, monthly spend per key |
| `access.ts` | the checks before paid work (suspension, the price guard, limits, key cap, credit), refusal strikes and suspension |
| `net.ts` | the safe fetch and the address checks, data URI decoding |
| `schemas.ts` | zod request and response schemas; `openapi.ts` turns them into the spec and the pricing document |
| `videos.ts`, `films.ts` | request → the app's `createClip()` / `createFilm()`; list, read, delete; film quote, approve, retry |
| `views.ts` | the video and film objects, from projects, takes and deliveries |
| `webhooks.ts` | signing, verifying, queueing once per state, one delivery attempt on the retry schedule |
| `register.ts` | the background side, in every process that runs jobs: delivery jobs, auto-approval within `max_cost_usd`, expiry dates and webhooks on project events, the retention sweeps |
| `errors.ts` | `ApiError` and the mapping from the pipeline's errors to the table above |

Admin and dashboard: `admin.ts` shows each customer's API keys, spend and suspension with a suspend/resume button;
`business.ts` adds an API panel (developers, suspended accounts, requests, server errors, videos, films, spend);
`preflight.ts` checks the switch and the price guard.

## Tests

- `engine/test/api.test.ts`: key format and hashing, every blocked address range (IPv4, IPv6, mapped forms), URL rules,
  data URIs, mode inference, `<Picture n>` normalising, the error mapping, webhook signatures against a known vector.
- `engine/test/api.e2e.ts` (CI step, its own database, mock providers, real FFmpeg): off means no API, on publishes the
  prices and the spec; a key from the session API; text,
  image and reference videos (data URIs and a local URL) succeed, are charged exactly `duration × price` and download
  as real MP4s; no plan but credit works, no credit is a `402` with nothing created; idempotent replays and conflicts;
  content refusals never charged and five of them suspending the account; revoked keys and other accounts' objects;
  rate limits with `Retry-After`; signed webhooks received and verified, a failing receiver retried; delete while
  rendering refunds; expiry deletes the files; a microdrama from an idea to finished episodes, approved by itself within
  its price cap; a film that waits at its price, can't be retried (it hasn't failed), is approved, and deleted mid-film
  with every hold refunded; the app dashboard and the 10 GB allowance ignore API work; the account and Developers page
  totals.

## Later

- **Test keys** (`bk_test_…`): free, instant sample output, for integrating without paying.
- **`POST /api/v1/files`:** upload once, reuse across requests.
- **Client libraries** (npm and PyPI) generated from the spec.
- **Per-key rate limits shared in Postgres or Redis**, once several engine instances serve the API (today each instance
  counts its own; creates and in-progress limits are already shared).
- **Priority:** subscribers before API traffic, or a paid fast lane.
- **Auto-recharge** and low-balance emails; **volume pricing**.

## Risks to keep in mind
- **The cheap price depends on the self-hosted GPU.** The price guard stops the API from selling below cost.
- **Bursty traffic.** `RUNPOD_MAX_WORKERS` caps GPU spend; past the in-progress limits developers get a clear `429`
  instead of silent waits, and the dashboard says when demand needs more GPUs than the ceiling.
- **Synchronous create.** `POST /videos` fetches and checks inputs while the developer waits. Uploads are decoded a few
  at a time (`MEDIA_SLOTS`), and past `MEDIA_QUEUE` callers get a `503` to retry. If that becomes a bottleneck, move the
  fetch into a job with the same contract (the video starts as `queued`).
- **Text-only video on Kablex** runs, but its quality is unmeasured until the GPU trial. If it's weak, text requests can
  first make a starting picture.
