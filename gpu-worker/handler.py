"""RunPod Serverless worker: renders one Backlot shot per job.

Contract with the engine (engine/src/providers/runpod.ts):
  input  = {"request": <H3 request, media as signed URLs>, "upload": {"url", "key", "content_type"}}
  output = {"key", "seconds", "width", "height", "has_audio"}   (the clip is already at upload.url)
         | {"error", "error_code": "sensitive_content"}         (content refused)
Any other failure raises, which RunPod reports as FAILED and the engine retries or refunds.
"""

import importlib
import json
import os
import subprocess
import tempfile
import urllib.request

from backends import Refused

MEDIA_TYPES = ("image_url", "video_url", "audio_url")
_backend = None


def backend():
    """Load the model once per worker; every job after the first reuses it."""
    global _backend
    if _backend is None:
        _backend = importlib.import_module(f"backends.{os.environ.get('MODEL_BACKEND', 'fake')}")
        _backend.load()
    return _backend


def download(url: str, dest: str) -> None:
    with urllib.request.urlopen(url, timeout=120) as r, open(dest, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)


def fetch_media(request: dict, workdir: str) -> list[dict]:
    media = []
    for i, item in enumerate(request.get("content", [])):
        kind = item.get("type")
        if kind not in MEDIA_TYPES:
            continue
        path = os.path.join(workdir, f"ref{i}")
        download(item[kind]["url"], path)
        media.append({"type": kind, "role": item.get("role"), "path": path})
    return media


def probe(path: str) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
        check=True, capture_output=True, text=True,
    ).stdout
    j = json.loads(out)
    video = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    audio = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError("the model produced a file with no video stream")
    return {
        "seconds": round(float(j.get("format", {}).get("duration", 0)), 3),
        "width": int(video.get("width", 0)),
        "height": int(video.get("height", 0)),
        "has_audio": audio is not None,
    }


def fit_length(path: str, seconds: float, workdir: str) -> str:
    """H3 makes clips on a fixed frame grid (5.17 s for a 4 or 5 s order, 6.58 s for 6 s), so a clip can come out longer
    than ordered. Cut it to the ordered length, so the engine's checks, the film's timing and the price all agree. Only
    the tail goes; a clip that is shorter than ordered is left as it is (the engine rejects it)."""
    if not seconds or probe(path)["seconds"] <= seconds + 0.05:
        return path
    out = os.path.join(workdir, "fit.mp4")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-t", f"{float(seconds):.3f}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k",
         "-movflags", "+faststart", out],
        check=True, capture_output=True,
    )
    return out


def upload(path: str, target: dict) -> None:
    with open(path, "rb") as f:
        data = f.read()
    req = urllib.request.Request(target["url"], data=data, method="PUT",
                                 headers={"content-type": target.get("content_type", "video/mp4")})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status >= 300:
            raise RuntimeError(f"upload failed with HTTP {r.status}")


def handler(job: dict) -> dict:
    inp = job["input"]
    request, target = inp["request"], inp["upload"]
    with tempfile.TemporaryDirectory() as workdir:
        media = fetch_media(request, workdir)
        try:
            clip = backend().generate(request, media, workdir)
        except Refused as e:
            return {"error": str(e), "error_code": "sensitive_content"}
        clip = fit_length(clip, float(request.get("duration") or 0), workdir)
        info = probe(clip)
        upload(clip, target)
    return {"key": target["key"], **info}


if __name__ == "__main__":
    import runpod  # only needed on RunPod (and for `python handler.py --test_input ...` locally)

    backend()  # load the model before taking jobs, so the first customer doesn't wait for it
    runpod.serverless.start({"handler": handler})
