# Backlot GPU worker (RunPod Serverless)

Renders one shot per job. The engine sends the H3 request and a signed upload link. The worker renders the
clip, uploads it straight to our storage and returns its length and size. See `handler.py` for the exact
contract. Step-by-step setup in plain language: `docs/SELF-HOSTED-H3.md`.

| File | What it is |
|---|---|
| `handler.py` | RunPod entry point: download references → `backend.generate()` → ffprobe check → upload |
| `backends/h3.py` | Self-hosted H3: turns the engine's request into a ComfyUI graph and runs it on a private ComfyUI that keeps the models warm |
| `backends/fake.py` | Test-pattern clips at the requested length and shape. Use it to prove the endpoint and scaling without the model |
| `h3/models.lock.json` | Pinned ComfyUI and Kablex commits, and every weight file by Hugging Face revision, size and SHA-256 |
| `h3/install.sh` | Image build step: pinned ComfyUI + the Kablex Ref2VA-VSA node, hardened by `h3/harden_kablex.py` |
| `h3/download_models.py` | Puts the weights (about 45 GB) on the network volume and verifies them. The worker runs it on first start |
| `h3/probe.py` | GPU check at start: Torch 2.11 / CUDA 13.0, VRAM, one real call to the Sol sparse-attention kernel |
| `selftest.py`, `test_h3.py` | CPU tests: the handler with the fake backend, and the H3 backend against a fake ComfyUI (need ffmpeg) |

## The H3 recipe

Kablex ComfyUI-Ref2VA-VSA (pinned and audited 17–20 October 2026): H3 Ref2VA pruned INT8 + LightX2V four-step
adapter + FastH3 VSA gates at 75% video sparsity + comfy-kitchen's CUDA Sol attention, on one RTX 4090 (24 GB; the
author measured about 72 s per 5-second clip) or RTX 5090 (32 GB). 24 fps on H3's frame grid (5 s asks for 124
frames, about 5.17 s), 768 px short edge, native 32 kHz stereo audio.

The engine's prompts are written for MiniMax's hosted API. `to_h3_prompt()` rewrites them into the open model's tags:
`reference image 2` → `<Picture 2>`, `reference audio 1` → `<Audio 1>`, `reference video 1` → `<Video 1>`, and
`says: "…"` → `says: <d>[English]…</d>`.

Not yet run on a real GPU: the first film is the integration test.

## Run the tests

```bash
python selftest.py     # handler + fake backend
python test_h3.py      # H3 backend: graph, staging, errors, restarts (fake ComfyUI, no GPU)
```

## Deploy on RunPod

1. **Image.** GitHub builds it (`.github/workflows/gpu-image.yml`) and publishes `ghcr.io/<owner>/backlot-gpu-worker` on
   every change to `main`. Or by hand: `docker build -t <registry>/backlot-gpu-worker:<tag> gpu-worker`.
2. **Network volume** of 75 GB in a data center with RTX 4090s (and 5090s). The first worker downloads the weights into
   `/runpod-volume/h3` (or run `python /app/h3/download_models.py --dest /workspace/h3` on a Pod with the volume).
3. **Serverless endpoint** from the image:
   - GPU: 24 GB PRO (RTX 4090), then 32 GB PRO (RTX 5090). **Allowed CUDA versions: 13.0** (the image needs a CUDA 13 driver).
   - Attach the network volume. No environment variables are required (`MODEL_BACKEND=h3` is the image default;
     `fake` for a dry run). Optional ones are in `backends/h3.py` and `docs/SELF-HOSTED-H3.md`.
   - Workers: min 0, max = your budget cap. The engine sets both from then on (`RUNPOD_MAX_WORKERS` is the max).
   - Scaling: **Queue delay**, about 4 s. Idle timeout: 60–120 s. **FlashBoot on.**
   - Execution timeout: 30 min (matches the engine's `RUNPOD_EXECUTION_TIMEOUT_SEC`).
4. Give the engine `VIDEO_PROVIDER=runpod`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` and `RUNPOD_MAX_WORKERS`. Autoscaling
   is on by default with RunPod (`RUNPOD_MANAGE_SCALING=0` turns it off); `/v1/admin/capacity` shows its decisions.

One job at a time per worker. A worker runs its own ComfyUI on 127.0.0.1 (no credentials in its environment) and
stops anything a cancelled job left running before it starts the next one.

## How scaling works

- **Up:** RunPod adds workers when jobs wait longer than the queue-delay setting.
- **Down:** idle workers stop after the idle timeout, down to the endpoint's minimum.
- **The minimum** is set by the engine's controller (`engine/src/capacity.ts`), every 30 s and as soon as work is queued:
  - 0 when nobody has rendered for `RUNPOD_WARM_MINUTES` (no GPU bill while idle)
  - `RUNPOD_WARM_WORKERS` while customers are active (no multi-minute cold starts)
  - one GPU per `RUNPOD_JOBS_PER_WORKER` renders that can run now, when that's more
- **The ceiling** is always `RUNPOD_MAX_WORKERS`: the engine sets the endpoint's max workers to it, and sends at most
  max workers × jobs per worker renders at once. The Admin page says when demand needs more GPUs than that.
