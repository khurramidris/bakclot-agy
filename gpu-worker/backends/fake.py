"""A stand-in for the video model: an FFmpeg test clip at the requested length and frame shape, with a
tone. Lets the RunPod endpoint, uploads and scaling be tested end to end before the real model is in."""

import os
import subprocess

from . import Refused

SHORT_SIDE = int(os.environ.get("FAKE_SHORT_SIDE", "768"))  # the real worker's 768P short side


def load() -> None:
    pass


def _size(ratio: str) -> tuple[int, int]:
    w, h = (int(x) for x in (ratio if ratio and ":" in ratio else "16:9").split(":"))
    if w >= h:
        return (round(SHORT_SIDE * w / h / 2) * 2, SHORT_SIDE)
    return (SHORT_SIDE, round(SHORT_SIDE * h / w / 2) * 2)


def generate(request: dict, media: list[dict], workdir: str) -> str:
    prompt = next((c.get("text", "") for c in request["content"] if c.get("type") == "text"), "")
    if "FORCE_SENSITIVE" in prompt:
        raise Refused("the fake model refuses prompts containing FORCE_SENSITIVE")
    seconds = int(request["duration"])
    w, h = _size(request.get("ratio", "16:9"))
    out = os.path.join(workdir, "out.mp4")
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r=24:d={seconds}",
            "-f", "lavfi", "-i", f"sine=frequency=330:sample_rate=48000:duration={seconds}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", out,
        ],
        check=True,
    )
    return out
