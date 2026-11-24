# Launch: go or no-go

The result of the launch audit (13–15 November 2026), in plain language: what was checked, what was fixed, what only
you can do before launch, and what can wait. The rule throughout: launch good enough, then fix what real customers
actually run into.

**What launches:** quick clips (text, a picture, characters and products, or a video to remix → 5–15 seconds), prompt
→ microdrama (and short films, web series, YouTube stories), the Basic plan with top-ups, and the developer API for
clips and films (built, off until you switch it on).

**Verdict:** the code is ready to launch. Everything left is in "Before you launch": accounts, settings, one real film
and clip with your own keys, a price check, the legal review, the deploy, and (last) the trial on your own GPU. None of
it is code.

## What was checked

| Area | Result |
|---|---|
| Sign-in and access | Every customer route checks that the video belongs to the signed-in customer; admin pages check the admin list; API keys only see their own account's work. Dev sign-in, mock providers and the API's local-address switch refuse to start in production. |
| Load | 20+ requests at once from one customer used to freeze the whole engine for everyone (a charge waited on a second database connection while holding a lock). Fixed, and tested under load: the old code hangs, the new code answers. Every transaction now has a lock timeout, `/health` reports a stuck database within 5 seconds, and the engine restarts itself if its connection pool jams. |
| Money | Payment webhooks are signature-checked, applied once, and credit only what our config says. Credit is taken in one atomic statement, so two clicks can't overspend. Each render holds its price and settles exactly once: kept for a usable clip, refunded otherwise. Every paid action is priced by its size: edits, screenplay imports, breakdowns and shot plans can no longer run for free or for a flat fee. |
| Uploads | Files are recognised by their content, not their name. FFmpeg may only read picture, video and sound formats from local files (no playlists, no network), pictures over 50 megapixels are refused from their header before decoding, and uploads are decoded a few at a time, so a burst can't run the server out of memory. Uploads are re-encoded before they're stored. |
| Content | Film ideas, hand-edited scripts, cast descriptions, the film look, quick-clip prompts, uploaded pictures and frames from uploaded videos are checked before anything is filmed. Long texts are read in pieces. A refusal is never charged. |
| Privacy | Customers no longer see what a job cost us. The old database read policies that exposed it are gone. Every response carries security headers and a content security policy. |
| Scale | Work runs in lanes (writing, rendering, pictures, editing, housekeeping) so a burst of one kind never starves the others, with a per-customer share inside each lane so one big order can't hold everyone up. Clips of a film start in story order. Old jobs, replaced edits and cached verdicts are cleaned up hourly. |
| GPU autoscaling | With RunPod, the engine raises the GPU floor as soon as work is queued, sends as many renders as the ceiling allows, and lets the GPUs go to zero when it's quiet. The dashboard says when demand needs more GPUs than your ceiling. Tested end to end against a simulated RunPod. |
| The API | Keys (shown once, stored as a hash, optional monthly cap), videos and films, idempotency, one error shape, rate limits, signed webhooks with retries, safe downloads (public https addresses only, checked as they're resolved), a price guard that stops it selling below cost, automatic suspension after repeated content refusals, and 7-day retention. 18 end-to-end checks, including a microdrama from an idea to a downloaded episode. |
| Customer pages | Every page loads without errors or content-policy violations at desktop and phone sizes, with no sideways scrolling, including the new Developers page and the API guide. |
| Tests | Engine unit, hardening and API tests; the step-by-step, prompt-to-paid-film, RunPod, scale and API end-to-end suites; the GPU worker tests; the web checks and build. All pass, and all run in CI. |

## Fixed in this audit

- **Engine freeze under load** (above): the one that would have taken the site down on a busy day.
- **Free and flat-fee work:** edits were free and unlimited, a pasted screenplay of any size cost one flat fee, and big
  breakdowns and shot plans cost the same as small ones. Edits now need a plan, are one at a time per episode and 30 an
  hour; screenplay import is off in production and size-capped; breakdowns and plans are priced per scene.
- **Hostile uploads:** a crafted file could make FFmpeg fetch web addresses or decode a picture big enough to exhaust
  memory. Closed (above).
- **Costs shown to customers** and an old database policy that exposed them: removed.
- **Provider calls without time limits:** every call to Claude, MiniMax and RunPod now has one, so a hung provider
  can't hold a job forever. MiniMax's charge for extra reference pictures is now counted in our costs.
- **Failed films** now show the customer a readable message; the technical error stays on Admin.
- **Company details** come from settings (`LEGAL_*`, `SUPPORT_EMAIL`), not code: no rebuild to fill them in, and the
  Setup check flags them until they're set.
- **Top-ups without a plan**, so developers can pay for the API.
- **New:** GPU autoscaling on by default with RunPod, the developer API, the Developers page and the API guide.

The October audit's fixes (deploys mid-film, stuck GPU jobs, the content filter on your own H3, placeholder films
when the video service is down) are in git history and still covered by the tests.

## Before you launch (only you can do these)

Work through `docs/BETA.md`. In short:

- [ ] **Accounts and keys:** Anthropic, MiniMax, Supabase (with your own email sender), Cloudflare R2, Lemon Squeezy
      (test mode first), Railway. Put your user id in `ADMIN_USER_IDS`.
- [ ] **Supabase Pro** ($25/month) before real customers: the free plan pauses after a week of no use, and Pro adds
      daily backups you can restore.
- [ ] **Company details** in Railway: `LEGAL_COMPANY`, `LEGAL_JURISDICTION`, `LEGAL_ADDRESS`, `SUPPORT_EMAIL`.
- [ ] **A lawyer's review** of `/terms` and `/privacy` (now with an API section) before real money.
- [ ] **Deploy** on Railway, then in its settings: health check `/health`, restart policy **Always** (`docs/DEPLOY.md`
      section 4). Add an **outside uptime monitor** on `/health`: Railway doesn't watch it after a deploy.
- [ ] **Setup check** (`/setup`) all green.
- [ ] **One real film and one real clip of each kind with your own keys.** Judge the quality, then open **Admin →
      Where the money goes**. Every clip is checked when it arrives (length, sound, shape, size); one that fails is
      refunded to the customer although MiniMax still bills you. If **Admin → Problems** lists failed renders as
      `invalid_output` ("no audio track", "only W×H"), tell me before launch: the check would need adjusting to what
      MiniMax really sends.
- [ ] **Price check.** The $2 setup fee (`SETUP_FEE_USD`) pays for the writing. At `STORY_EFFORT=high`, Claude can cost
      $1 to $3 a film. If Admin shows writing costing more than the fee, raise the fee or lower the effort. Compare the
      cost of a second of video with the $0.16 you charge.
- [ ] **MiniMax's limit on videos at once** for your account: if it's below 10, set `VIDEO_MAX_INFLIGHT` to it.
- [ ] **Decide the longest film** a customer can order (`MAX_RUNTIME_SECONDS`, no limit today). A default feature-length
      film is several hundred dollars and hundreds of clips, and nothing that long has been made for real. A cap such as
      1800 (30 minutes) until one has is the safer start.
- [ ] **Decide what a refund gives back.** Today a refunded render returns as top-up credit, which never expires, even if
      it was paid from monthly plan credit (the Terms say so). That's generous: a subscriber can keep plan credit by
      starting and deleting a clip. Keep it, or tell me to return plan credit to the plan.
- [ ] **Payments:** apply to activate the Lemon Squeezy store early (they review what you sell, which can take days),
      run the launch check in `docs/DEPLOY.md` section 5, then switch to live mode ("Going live" in `docs/BETA.md`).
      Only share Backlot's own **Billing** page for buying: a purchase through a product's public Lemon Squeezy link
      isn't tied to an account. If Lemon Squeezy points you to Stripe Managed Payments instead, tell me first.
- [ ] **Open the API** (`API_ENABLED=1`) once the price check passes, and run its check (`docs/BETA.md` step 11b).
      Decide its price first: it sells at the app's $0.16 a second, while MiniMax sells the same model direct for
      about $0.08. Until your own GPUs bring the cost down, microdramas (an idea in, finished episodes out) are what
      developers can't get elsewhere; clips mostly matter once the price can drop (`SELL_PER_SECOND_768P`).
- [ ] Recommended: `SENTRY_DSN` (error emails) and `FIXED_COSTS_MONTHLY` (your monthly bills, so Admin shows true
      profit).
- [ ] **Last: your own GPU.** Keep `VIDEO_PROVIDER=minimax` until your H3 has made good films for you
      (`docs/SELF-HOSTED-H3.md`); it has never run on a real GPU. Before selling video from it, confirm the H3 model's
      licence allows running it as a paid hosted service (nothing in the repository says so). Then set
      `VIDEO_PROVIDER=runpod` and `RUNPOD_MAX_WORKERS`: autoscaling takes it from there.

## Known limits you can launch with

Fix these when customers actually hit them, not before.

- A refund issued in Lemon Squeezy doesn't take the credit back. `docs/DEPLOY.md` has the one-line fix by hand.
- Request-rate limits (the app's, and the API's per-key limit) are counted per server. That's fine while you run one;
  the API's limits on new and in-progress work are shared already.
- GPU cost on Admin counts render time only. Cold starts and idle minutes show on the RunPod bill, so check it monthly.
- Some things are done by hand for now: there's no "your film is ready" email, account deletion is by support email,
  and the approval step can't edit the script or cast.
- On your own H3, image-to-video is beta. If those clips look wrong, set `CLIP_IMAGE_PROVIDER=minimax`. The dialogue tag
  format is unverified until the first real film.
- The API has no free test keys yet: developers integrate with real (small) charges, which a key's monthly limit caps.
  `POST /videos` downloads the developer's files while they wait; fine at launch volumes.
- Uploaded voices aren't content-checked: the checker reads text and pictures, not sound. The customer confirms they
  have the rights to every file, and the pictures they're paired with are checked.
- A writing or picture step cut off by a deploy is charged again when it reruns. That's cents, and rare.
- If two subscription updates from Lemon Squeezy arrive out of order seconds apart, a status can be stale until the next
  update. Admin's "payment problems" would show it.
- `npm audit` is clean for the engine. The web app's list is tooling and browser-side code, none of which runs on the
  server: Vite's development server (fixed in Vite 8.3.8; production serves the built files), the lint tools, and the
  browser's form validation library (zod 3; the fix is the major upgrade to zod 4). Do them after launch.

## After launch: the weekly look

Open **Admin** on the 7-day view:
- **Profit and margin:** is video cost per second well under the price? Is writing cost per film under the setup fee?
- **Problems:** many failed renders points to a provider problem. Many refusals means the content check may be too
  strict, so read a few.
- **Health:** renders waiting and failed jobs should be near zero outside busy moments. If "GPUs needed" sits above the
  ceiling, raise `RUNPOD_MAX_WORKERS`.
- **API:** requests, server errors (should be near zero), spend, and any suspended developers.
- **Customers:** cancellations and payment problems: write to those people.
