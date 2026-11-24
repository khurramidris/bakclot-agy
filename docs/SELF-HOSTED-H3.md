# Your own H3 on RunPod: set it up and make a first film

This puts the video model on a GPU you rent from RunPod, instead of paying MiniMax per second of video. Backlot
still uses Anthropic for the writing and MiniMax for character images and voices. Only the video moves to your GPU.

Written in the same plain style as `START-HERE.md`. Look for the words in **bold** on each screen.

**Be clear about one thing first:** nobody has run this exact setup on a real GPU yet. The code is tested on a normal
computer against a stand-in for the model, and the recipe comes from the RunPod test kit (Kablex Ref2VA-VSA). Your first
film is the real test. If anything fails, the RunPod logs say why: send me the last lines.

## What it is

| Part | What it does |
|---|---|
| The **worker image** `ghcr.io/khurramidris/backlot-gpu-worker` | The program the GPU runs. GitHub builds it from `gpu-worker/` every time it changes on `main`. |
| A **network volume** (75 GB) | A RunPod disk that keeps the model files (about 45 GB), so each GPU doesn't download them again. |
| A **serverless endpoint** | RunPod turns GPUs on when Backlot sends a shot and off again when there's nothing to do. You pay per second of GPU use. |

The model recipe is Kablex's ComfyUI-Ref2VA-VSA: MiniMax H3 Ref2VA (8-bit), LightX2V's 4-step speed-up, and sparse
attention (75%). Its author measured about 72 seconds per 5-second clip on one **RTX 4090 (24 GB)**, the cheapest GPU it
fits, so that's what we use, with the faster **RTX 5090 (32 GB)** as a backup when no 4090 is free. A shot is 5 to
15 seconds of 24 fps video at 768 px with lip-synced sound, made from the shot's character, set and voice references.

## What it costs (roughly)

- **Network volume:** about $5 a month for 75 GB, whether or not you use it.
- **GPU time:** RTX 4090 serverless is $0.00031 a second (about $1.12 an hour), and you pay only while a worker is on:
  rendering, loading the model, or the minute or two after the last shot before it switches off. Estimate for a
  1-minute film (12 shots of 5 seconds): **about $0.40 to $0.50**. The first real film gives the true number on the
  Admin page.
- **First start:** the first worker downloads the 45 GB of model files onto the volume (about 10 to 20 minutes of paid
  GPU time, once). Each new worker then loads them into memory before its first shot (a few minutes).

## Step 1. The worker image

1. On GitHub, open the **backlot** repository, then **Actions**, then **GPU worker image** on the left.
2. Click **Run workflow** (on the right), keep the branch on **main**, click the green **Run workflow** button. Wait for the
   green tick (about 30 minutes).
3. Make the image downloadable for RunPod. Pick one:
   - **Simplest:** on GitHub, open your profile, then **Packages**, then **backlot-gpu-worker**, then **Package settings**,
     and under **Danger zone** click **Change visibility** to **Public**. The image only holds the worker program,
     no keys or customer data.
   - **Keep it private:** on GitHub, **Settings → Developer settings → Personal access tokens → Tokens (classic)**,
     create a token with only **read:packages**. In RunPod, **Settings → Container Registry Auth**, add one with
     registry `ghcr.io`, your GitHub username and that token. Choose it when you create the endpoint in step 3.

## Step 2. The network volume

1. Open **console.runpod.io**, sign in and add some credit (**Billing**; $25 is plenty to start).
2. Click **Storage**, then **New Network Volume**.
3. **Data center:** pick one that shows **RTX 4090** (and ideally RTX 5090) with good availability for serverless,
   close to you or your storage. The endpoint can only use GPUs in this data center.
4. **Name:** `backlot-h3`. **Size:** `75` GB. Click **Create**.

## Step 3. The serverless endpoint

1. Click **Serverless**, then **New Endpoint**, then the option to use a **Docker image** (container image).
2. **Container image:** `ghcr.io/khurramidris/backlot-gpu-worker:latest`. (If you kept the image private, pick your
   registry credentials here.)
3. **GPU:** tick **24 GB PRO** (RTX 4090) first, then **32 GB PRO** (RTX 5090) as the second choice. Leave the plain
   24 GB, 16 GB and other tiers unticked: those cards are slower, so a clip costs the same or more.
4. Settings, as RunPod names them:
   - **Active workers** (also called minimum): **1** for now. You'll set it back to 0 in step 4.
   - **Max workers:** **1** for your own tests.
   - **Idle timeout:** **120** seconds.
   - **Execution timeout:** **1800** seconds.
   - **FlashBoot:** on.
   - **Container disk:** 20 GB.
5. Open **Advanced** (or the extra settings):
   - **Network volume:** choose `backlot-h3`. This also fixes the data center.
   - **Allowed CUDA versions:** tick only **13.0** (and newer, if listed). The model needs a recent NVIDIA driver; this
     keeps RunPod off machines with older ones.
   - **Environment variables:** none needed. The table at the end lists the optional ones.
6. Click **Create** (or **Deploy**). Copy the **endpoint ID** (letters and numbers on the endpoint's page) into your
   notes as `RUNPOD_ENDPOINT_ID`.
7. **Settings → API Keys → Create API Key** (read and write). Copy it into your notes as `RUNPOD_API_KEY`.

## Step 4. Let the first worker get ready

With **Active workers** at 1, RunPod starts one worker straight away. Open the endpoint, then **Workers** (or **Logs**),
and watch. You'll see, in order:
1. `First start: downloading 45 GB of H3 weights …` and one `ok (downloaded and verified)` line per file (10 to 20 minutes, once).
2. A line like `{"gpu": "NVIDIA GeForce RTX 4090", "vram_gb": 24.0, … "host_ram_gb": …, "sol_attn": "ok"}`: the GPU check
   passed. Note `host_ram_gb` (the computer's memory): it decides whether the model stays loaded between shots.
3. `H3 worker ready`.

Then set **Active workers** back to **0** and save, so you only pay while rendering. (If you leave it at 1, that worker
stays on and is billed around the clock.)

If you see an error instead, look it up under **If something goes wrong** below.

## Step 5. Point Backlot at it

**With the desktop app** (`START-HERE.md`, Part B): **Settings → Use my own accounts**, then for video choose
**My H3 on RunPod**, paste the RunPod key and endpoint ID and click **Test**. Also set:
- **Video clips made at once:** **1** (the same as Max workers, so no shot waits in RunPod's queue).
- **Your GPU cost per second:** `0.00031` (the 4090 price), so the Admin page shows what each film cost you.

**Running from the repository** (`docs/LOCAL.md`): in `engine/.env.local` set `VIDEO_PROVIDER=runpod`, `RUNPOD_API_KEY`,
`RUNPOD_ENDPOINT_ID`, `RUNPOD_GPU_PRICE_PER_SECOND=0.00031` (the 4090 price), `RUNPOD_MAX_WORKERS=1` and
`VIDEO_MAX_INFLIGHT=1`.

**On the website** (Railway, `docs/BETA.md`): the same settings plus `VIDEO_PROVIDER=runpod`, in Railway's
**Variables**.

From now on Backlot manages the endpoint's **Active workers** and **Max workers** itself (GPU autoscaling, on by default
with RunPod): it raises the active workers as soon as a shot is waiting and sets them back to 0 about 15 minutes after
the last one, so you don't need to touch them in the console. **Max workers** follows `RUNPOD_MAX_WORKERS`, which is
why it's 1 for the trial: without it, Backlot would allow 5. (`RUNPOD_MANAGE_SCALING=0` hands both back to the console.)

## Step 6. Make a first film

Keep it small: one microdrama of about a minute (**Longest film** 120 seconds). Type an idea, approve the script and
cast, and press **Make my video**.

- The first shot takes longest: RunPod starts a worker, and it loads the model into memory. Later shots reuse the warm
  worker until it has been idle for the idle timeout.
- Shots are made at 768 px. If a project is set to 2K, it's still made at 768 px (2K isn't available in this recipe).
- Each shot gets a new random seed, so **Fix this shot** gives a different take. The seed is in the RunPod log line
  starting `{"h3_job"`, with the size, frame count, number of references, and (in the next line) how long it took.

What to judge, shot by shot: does each character look like their picture, keep their clothes, and stay in the set?
Is the dialogue the right words, in the right voice, on the right lips? Hands and motion? Write down what fails. Then
we tune the settings below, or the prompts.

## After the trial: scaling up for customers

Once shots look right and you know the cost per clip:
1. In Railway's **Variables**, remove `VIDEO_MAX_INFLIGHT` and set `RUNPOD_MAX_WORKERS` to the most GPUs you're willing
   to pay for at once (5 is a good start). Renders sent at once follow it (2 per GPU: one filming, one waiting).
2. In RunPod, ask for a higher worker quota if your account's limit is below that number.
3. Set `RUNPOD_GPU_PRICE_PER_SECOND` to what you actually pay: the Admin page's margins and the API's price guard use it.

Backlot then adds GPUs as work queues up and lets them go when it's quiet: no GPU runs (or is billed) overnight unless
someone is making something. The Admin page shows the GPUs needed against the ceiling and says when to raise
`RUNPOD_MAX_WORKERS`. The full list of scaling settings is in `docs/DEPLOY.md` ("GPU autoscaling").

## Optional settings (endpoint environment variables)

| Setting | Default | What it does |
|---|---|---|
| `H3_REF_IMAGE_SIZE` | `match` | `max` gives the model the character and set pictures at full size (better likeness, several times slower). |
| `H3_SPARSITY` | `0.75` | How much of the video attention is skipped. Lower (0.70, 0.50) is slower and may look better. |
| `H3_ATTENTION` | `vsa` | `dense` turns sparse attention off (slower). For comparing quality, or if the GPU check fails on `sol_attn`. |
| `H3_AUTO_DOWNLOAD` | `1` | `0` makes a worker fail instead of downloading missing model files. |
| `H3_TIMEOUT_SEC` | `1700` | A single shot is stopped after this long. |
| `MODEL_DIR` | `/runpod-volume/h3` | Where the model files are on the volume. |

Changing a setting restarts the workers. Compare settings on the same shot: **Fix this shot** without changing the text.

Two related settings live in **Backlot's** own settings (`engine/.env.local`, Railway variables), not on the endpoint:

| Setting | Default | What it does |
|---|---|---|
| `CHAIN_CLIPS` | `0` | `1` sends each scene's previous shot along as a reference video, for continuity. On your own GPUs a reference clip makes every shot about twice the work (sparse attention never speeds up reference material). |
| `CLIP_IMAGE_PROVIDER` | (same as video) | `minimax` sends image-to-video quick clips to MiniMax's hosted H3 instead. On your own GPUs, image-to-video pins the picture as the first frame, which these model files weren't trained for: if those clips look wrong, switch this. |

## If something goes wrong

| The log says | What to do |
|---|---|
| `No network volume is attached` | Endpoint → **Edit** → **Advanced** → choose the `backlot-h3` network volume. |
| `CUDA is unavailable` | Endpoint → **Edit** → **Allowed CUDA versions**: only 13.0 and newer. |
| `H3 GPU check failed: … sol_attn` | Add the environment variable `H3_ATTENTION` = `dense`. It works without sparse attention, only slower. Tell me, so I can look at the attention kernel. |
| `failed its integrity check` | A download was damaged. It was deleted; restart the worker (**Workers** → the worker → **Terminate**) and it downloads that file again. |
| `ComfyUI stopped during the render` or `CUDA out of memory` | The model didn't fit. It restarts for the next shot. If it keeps happening, tell me: the next things to try are `COMFY_ARGS` = `--reserve-vram 1`, or a GPU with more memory. |
| `Warning: … GB host RAM` | Not an error. The test kit asked for about 96 GB of computer memory (not GPU memory). If renders crash or stall while loading, that's the likely reason. |
| In Backlot: `H3 task still queued after 30 minutes` | No worker could start: RunPod had no free 4090 or 5090 in that data center, or the worker failed (see its log). Backlot cancels the job and refunds. |

## For developers

- Worker code: `gpu-worker/backends/h3.py` (request → ComfyUI graph, prompt tag rewrite, private ComfyUI process),
  `gpu-worker/h3/` (pinned versions and weight hashes, the Kablex hardening patch, GPU check, weight download,
  image install). Tests: `python gpu-worker/test_h3.py` (CPU, fake ComfyUI).
- The engine writes prompts for MiniMax's hosted API. The worker rewrites `reference image N` → `<Picture N>`,
  `reference audio N` → `<Audio N>`, `reference video N` → `<Video N>` and `says: "…"` → `says: <d>[Language]…</d>`, the
  tags the open model was trained on. Check them against MiniMax's prompt guide
  (`docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` in the MiniMax-H3 model repository) after the first real films.
- Pins: ComfyUI and Kablex commits, Torch 2.11.0 / CUDA 13.0 base image digest, and all weight files by revision and
  SHA-256 (`gpu-worker/h3/models.lock.json`). They come from the test kit's audit of 17–20 October 2026.
