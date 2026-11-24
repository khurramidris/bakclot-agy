# Architecture

| Folder | What | Stack |
|---|---|---|
| `web/` | The product UI: landing and pricing, sign-in and password reset, create, approve, watch, fix a shot, quick clips, billing, account, the Developers page and API guide, the company dashboard (admin), terms and privacy | React 19, Vite, TanStack Router + Query, Tailwind v4, shadcn/Radix |
| `engine/` | The app's API (`/v1`), the public developer API (`/api/v1`), durable job queue, AI pipeline, FFmpeg editing, credits, subscriptions (Lemon Squeezy), storage quota, GPU autoscaling; serves `web/dist` | Node 22, Hono, Postgres (`postgres.js`), zod |
| `gpu-worker/` | Renders one shot per job on RunPod Serverless | Python, RunPod SDK, FFmpeg, the H3 model |

## The flow

```
prompt ─▶ writing ─▶ casting ─▶ planning ─▶ READY (customer approves the price) ─▶ rendering ─▶ assembling ─▶ done
 (Claude)   (Claude +     (Claude +                                                (RunPod)      (FFmpeg)       │
            images/voices) H3 rules)                                                 ▲                          │
                                                                                     └────── fix this shot ◀────┘
```

The same pipeline serves three doors: the web app (`/v1`, a signed-in session), quick clips (one shot, no story
engine), and the public API (`/api/v1`, a `bk_live_` key), whose videos are clip projects and whose films are vibe
projects marked `origin = 'api'`. Through the API a film is approved by itself within the developer's price cap.

- **The story engine** (`docs/STORY-ENGINE.md` has the whole design). Every step is Claude through the official SDK,
  with structured outputs, adaptive thinking and an explicit effort; prompts in `pipeline/prompts.ts`, answer shapes in
  `pipeline/schemas.ts`, worked writing examples in `pipeline/craft.ts`, budgets and checks in `pipeline/story.ts`.
  Each call does one small job and code does the bookkeeping, so a cheaper model still writes well:
  1. **Pitch and choose** (`writer.ts`): three different takes on the idea; a head of development scores them on a
     rubric and picks one, with development notes. Freshness: optional sparks, the customer's earlier stories, and a
     list of overused AI names, premises and images.
  2. **Bible**: characters (want, obstacle, secret, arc, a voice with a verbal habit and sample lines, look),
     relationships, world, sets, setups and payoffs, each episode's opening and ending, the film's look. Overused
     names are recast once, here.
  3. **Outline**: each episode boarded into scene cards (set, who, what each wants and how, what's underneath, the
     turn, the exit). Code works out the scene count, the seconds and a timed beat grid for the format.
  4. **Scenes**: written in parallel, one per card, to a word budget from code and with two worked examples each.
     Scenes come back as elements and code renders the Fountain. Each episode's opening and ending get two drafts and
     a judge.
  5. **Polish**: `storyLint` (runtime, cast and set counts, stock and on-the-nose lines, unfilmable or
     camera-directing action, legible text, a slow opening, an ending on talk, the customer's names and places), then
     a script editor's located notes. Only flagged scenes are rewritten, and a rewrite is kept only if the checks
     don't get worse and a pairwise judge prefers it. The report is saved in `story_bible.quality`, the cards in
     `story_bible.outline`.
  6. **Breakdown** (`breakdown.ts`): casting, costume and production design. It aims for real, distinct faces
     cast for contrast, signature colours, sets that tell a story, and one palette and texture for the film.
     Image prompts (`assets.ts`) put the essentials first, within the image model's 1500 characters.
  7. **Direction** (`shots.ts`): one plan per episode (visual approach, motifs), with each scene's purpose,
     temperature, pace, key image, camera, light, blocking, and opening and closing images, made from the writers'
     cards. It's saved on the episode.
  8. **Shots:** scenes are planned in parallel from the director's plan and the scene's card (what each character
     wants, what's underneath, where it turns), following the WanPE lesson: each beat is a cinematic brief (framing,
     lens, camera trajectory, blocking, performance, light, verbatim dialogue).
     - A timing-safe coverage made in code is the starting point; two matching reference sequences from
       `exemplars.ts` teach film grammar, rotated per scene.
     - Code guarantees every dialogue line and every action line is covered, fits the beats to H3, and flags
       monotonous camera work.
  - Each writing step is its own autopilot run (state in `projects.autopilot.writing`), so a restart resumes and
    no job runs long.
  - Any step can run on its own model (`CLAUDE_MODELS`). Without structured outputs the answer's shape is described
    in the prompt and gets one repair round; a feature an endpoint rejects is switched off for that model.
  - `npm --prefix engine run eval:story` runs sample ideas through the whole engine and writes a report plus every
    take, card, script and plan (mock mode is free; a real run needs `EVAL_CONFIRM=1`). `PROMPT_LOG_DIR` saves every
    prompt as sent.
- **Quick clips** (`pipeline/clips.ts`, `POST /v1/clips`): one clip of 5 to 15 seconds, no story engine. A clip is a
  project with `mode = 'clip'`, one episode and one shot, so it reuses the render path (hold, settle once, refund on
  failure) and the project page. Four modes:
  - text to video
  - image to video: the picture is the first frame (`first_frame` role; MiniMax's `first_frame_image`, or
    `MiniMaxH3AddGuide` on our worker)
  - characters & products: up to 9 pictures and a voice as references
  - remix: a video to change ("replace the man with the woman in picture 1")
  Uploads are re-encoded by FFmpeg first (pictures to JPEG, video to 24 fps H.264 of at most 15 s, voice to 14 s
  MP3) and stored under `projects/<id>/inputs/`. The customer's "image 2" or "the voice" becomes the wording H3
  requests use (`normalizeRefs`). Another version is a new take of the same shot, optionally with a new prompt or
  length.
- **Content checks** (`moderation.ts`): our own H3 has no filter, so whatever reaches a video model without Claude
  rewriting it is checked first by Claude's fast model: clip prompts and uploads, uploaded character and set pictures,
  and hand-edited shot prompts. Verdicts are cached by content hash (`moderations`); a refusal is a 422
  `sensitive_content` and never charged.
- **Autopilot** (`engine/src/pipeline/autopilot.ts`) moves a project through the stages. It's a queue job that
  reschedules itself, so it survives restarts and costs nothing while waiting.
- **Every step is a job** in Postgres (`engine/src/queue.ts`, `FOR UPDATE SKIP LOCKED`). Any number of
  engine instances can share the queue. A worker renews the lease on its running jobs every 30 seconds. A job whose
  worker died (a deploy, a crash) goes back in the queue after 3 minutes, or fails, running its refund hook, once
  it has used every attempt. On SIGTERM a process takes no new jobs, gives running ones 20 seconds to finish, then
  hands the rest straight back to the queue with their attempt returned.
  - **Lanes:** each kind of job belongs to a lane with its own slots per process (`llm` writing and planning, `render`,
    `assets` pictures and voices, `media` FFmpeg, `io` everything else; `config.lanes`, `WORKER_LANES`). A worker only
    claims kinds whose lane has a free slot, so a burst of edits can't block writing and a burst of writing can't block
    renders.
  - **Fairness:** inside a lane, one customer may hold only a few slots (`FAIR_*_PER_CUSTOMER`); a job over its owner's
    share steps aside for a few seconds (`fair()` in `jobs.ts`), so one big order can't make everyone else wait.
  - **Housekeeping** (`maintenance.ts`): an hourly job removes finished jobs after 7 days and failed ones after 30,
    replaced edits (keeping the two newest per episode), old failed cuts and content-check verdicts, and runs the
    sweeps other modules register (`onCleanup`: the API's expiry and logs).
- **Project events** (`events.ts`): the autopilot reports when a project reaches its price, finishes or fails
  (`projectEvent`). Listeners (`onProjectEvent`) set API expiry dates and queue webhooks, and `mayAutoApprove` lets the
  API approve a film within its cap. The pipeline doesn't know about the API.
- **The public API** (`engine/src/api/`, reference `docs/API.md`): key auth, idempotency, the request log, limits and
  the price guard in front of the same `createClip()` and `createFilm()` the app uses. Media and webhook addresses go
  through `net.ts`, which allows only public internet addresses, checks them as they're resolved and connects to the
  address it checked. Webhooks are durable jobs with a retry schedule.
- **The database under load** (`db.ts`): every transaction goes through `begin()`, which sets a lock timeout and an
  idle-in-transaction timeout, so a stuck request gives up instead of holding the pool. Lock conflicts are retried
  (`retryBusy`). `/health` answers `503` within 5 seconds when the pool can't get a connection, and a watchdog exits
  the process (to be restarted) when the pool stops answering while the database itself still does.
- **Money:**
  - `engine/src/billing.ts`: two credit buckets on `credit_accounts`. `plan_usd` is the monthly plan credit,
    reset at each paid invoice. `balance_usd` holds top-ups and refunds, which never expire. Plan credit is
    spent first, in one atomic statement. Credits are reserved per render and settled exactly once: kept for a
    usable clip, refunded otherwise. This file also holds the subscription gate (`requirePlan`: an active plan
    and room in storage, with credits enforced).
  - `engine/src/lemonsqueezy.ts`: checkouts for the Basic plan and top-up packs, the customer portal link, and a
    signed, idempotent webhook that keeps `subscriptions` current and credits invoices and orders.
  - `files`: every stored object under `projects/<id>/`, with its size. It's recorded where files are written
    (`storage.put`, `putFile`, and `pollTake` for clips the GPU worker uploads directly). Usage is one sum per
    customer. Deleting a project deletes its objects.
  - `usage_events`: what providers cost us, for margins.
- **Video providers:** `providers/runpod.ts` (ours) or `providers/minimax.ts` (hosted), same interface,
  chosen by `VIDEO_PROVIDER`.
  - With RunPod, the worker uploads each clip straight to our storage through a signed link.
  - `engine/src/capacity.ts` is the GPU autoscaler (on by default with RunPod): every 30 seconds, and at once when
    work is queued (`kickCapacity`), it sets the endpoint's floor to one GPU per `RUNPOD_JOBS_PER_WORKER` renders that
    can run now (0 when idle, `RUNPOD_WARM_WORKERS` while active) and its ceiling to `RUNPOD_MAX_WORKERS`. It counts
    only clips that can run now, so a film's clips waiting their turn keep no GPU warm. Renders in flight are capped
    at the ceiling × jobs per worker (`VIDEO_MAX_INFLIGHT` overrides). `capacitySnapshot()` feeds the dashboards,
    including GPUs needed beyond the ceiling.
- **Rendering** (`pipeline/render.ts`): a project's clips start strictly in story order (a clip never starts while
  an earlier one is still waiting), up to 4 at a time per customer across all their videos
  (`MAX_ACTIVE_RENDERS_PER_USER`, `RENDERS_PER_PROJECT`), and the next starts as soon as one finishes. A slot is claimed under a Postgres advisory lock, so the limit holds with many workers. The customer plays each finished clip on
  the project page while the rest are filmed. The previous clip is not sent along as a reference video
  (`CHAIN_CLIPS`, off): its seconds would be billed as input on every render.
- **Editing** (`pipeline/assemble.ts`): the clips are joined whole, in order, at one size, frame rate and audio
  format, with the episode's loudness at streaming level. Nothing is trimmed, and captions and music are the
  creator's to add; burned-in subtitles, fades and a music bed remain options of a cut.
- **Auth:** Supabase Auth in the browser. The engine verifies the session token on every `/v1` request. All
  product data lives in the engine's tables; Supabase only knows about users.

- **Uploads** (`media/ffmpeg.ts`): a file is recognised by its first bytes (`sniff`), never its name. FFmpeg opens it
  with an allow-list of demuxers for that kind and only local protocols (`-protocol_whitelist file,crypto,data`,
  `safeInput`), so a disguised playlist can't reach the network or other files; pictures over 50 megapixels are refused from their header before decoding.
  Decoding runs at most `MEDIA_SLOTS` at a time per process (`withMediaSlot`); past `MEDIA_QUEUE` waiting, callers
  get a `503` to retry. Large request bodies are gated per process (`MAX_PARALLEL_UPLOADS`).
- **Operations:** `engine/src/admin.ts` (the admin console API), `engine/src/business.ts` (the company dashboard:
  revenue, costs and profit, customers, what was made, health, capacity, the API and problems for a date range),
  `engine/src/preflight.ts` (Setup check),
  `engine/src/ratelimit.ts` (per-customer limits) and `engine/src/monitoring.ts` (Sentry, optional). Every response
  carries security headers and a content security policy (`server.ts`); what a job cost us is shown to admins only.

## Invariants worth keeping

- Nothing expensive happens before the customer approves a price at the checkpoint.
- A customer is never charged for a clip that failed to render.
- Every billable action goes through `paid()` (`billing.ts`): charge, run, refund on failure, so nothing a customer
  pays for can fail silently. The automatic first pass of a vibe project is marked `covered` (the setup fee pays for
  it), so it is never charged twice.
- Payment webhooks credit at most once (`payments` primary key), and credited amounts come from our config,
  never from the amount paid.
- Without `ENFORCE_CREDITS` (local development, the mock e2e suites) there's no plan gate and no storage limit.
- Every script line reaches the screen verbatim, and every action line gets a shot (`repairShots`). Every H3 rule is
  checked before a request leaves (`validateH3`).
- Structured outputs make the answer's shape reliable; code still repairs its content (the API doesn't enforce enums
  or numbers). Without them the shape goes in the prompt and an unusable answer gets one repair round. Never ask the
  model to write out its reasoning in a field (it can trigger refusals): every answer is a production document the
  next step uses (a take, a card, a scene, an editor's note, a verdict), and thinking stays internal.
- Generated scripts are rendered from scene elements by code (`sceneFountain`), so they always parse the same way.
- Anything that reaches an FFmpeg filter graph is validated first (`parseCutOptions`).
- Customer uploads are only ever opened by FFmpeg as local files (its file protocol won't follow a disguised playlist
  to the network) and never reach a shell. Quick-clip inputs and voices are re-encoded into fresh JPEG, MP4 and MP3
  files before a model sees them.
- What a customer writes or uploads for a video passes the content check before it reaches a video model, unless
  Claude rewrote it first.
- Inside a transaction, every query uses that transaction (`tx`), never the pool: a transaction that waits for a
  second pool connection while holding locks can freeze the engine (the November audit's freeze). Every transaction
  goes through `begin()`.
- Paid work is priced by its size (per second, per scene, per minute of story): nothing large rides on a flat fee.
- The API never sells video below what it costs us (`priceGuard`), and API work (`origin = 'api'`) is kept out of the
  app's lists and storage allowance and deleted after its retention period.
- Media and webhook addresses from developers are fetched only through `net.ts`, never with a plain `fetch`.
