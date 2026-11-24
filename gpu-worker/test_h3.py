"""Runs the H3 backend on CPU against a fake ComfyUI: the engine's request becomes the right graph (tags, references,
size, frames), references are staged and cleaned up, the clip comes back through the handler and is uploaded, and
render errors, cancelled leftovers and a crashed ComfyUI are handled. No GPU, Torch or weights. Needs ffmpeg.
Run: python test_h3.py"""

import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

tmp = Path(tempfile.mkdtemp())
port = socket.socket()
port.bind(("127.0.0.1", 0))
os.environ.update(MODEL_BACKEND="h3", COMFY_DIR=str(tmp / "comfy"), COMFY_WORK_DIR=str(tmp / "work"),
                  COMFY_PORT=str(port.getsockname()[1]), MODEL_DIR=str(tmp / "models"), FAKE_COMFY_LOG=str(tmp / "log.jsonl"))
port.close()
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from backends import h3  # noqa: E402

h3._probe = lambda: None  # the GPU check needs CUDA
h3.POLL_SECONDS = 0.05

# ── Pure parts ──
assert h3.canvas("9:16", "768P") == (768, 1344) and h3.canvas("16:9", "768P") == (1344, 768)
assert h3.canvas("1:1", "768P") == (768, 768) and h3.canvas("4:3", "2K") == (1024, 768)
assert h3.canvas("21:9", "768P") == (1536, 672) and h3.canvas("adaptive", "768P") == (1344, 768)
assert h3.canvas("9:16", "480P") == (480, 832), "the test kit's draft size"
assert [h3.frame_count(s) for s in (4, 5, 6, 10, 15)] == [124, 124, 158, 243, 362]
assert all(h3.frame_count(s) % 17 == 5 for s in range(4, 16))

engine_prompt = "\n".join([  # the shape engine/src/pipeline/compiler.ts writes
    "Vertical 9:16 live-action cinematic drama shot, 5 seconds, one continuous take. Photorealistic, natural performances, no animation.",
    "References: reference image 1 is the location, Office; reference image 2 is Asma's face and identity.",
    "Voices: Asma speaks with the voice in reference audio 1.",
    "Reference video 1 is the shot that plays just before this one: match its colour grade, lighting, lens feel and where everyone is standing, then continue from it.",
    "Characters: Asma Khan (reference image 2): sharp eyes.",
    "Timeline:",
    "0–5s: Medium close-up. Asma looks at the door. Asma, quietly, says: \"You should not have come here.\"",
    "Sound: Room tone. Dialogue spoken on camera in English, clear and lip-synced, natural pace. No background music.",
])
p = h3.to_h3_prompt(engine_prompt, has_video=False)
assert "<Picture 1> is the location" in p and "<Picture 2> is Asma's face" in p
assert "voice in <Audio 1>" in p and "Asma Khan (<Picture 2>)" in p
assert "says: <d>[English]You should not have come here.</d>" in p
assert "reference video" not in p.lower() and "<Video" not in p and "Characters:" in p, p
p = h3.to_h3_prompt(engine_prompt.replace("in English", "in Urdu"), has_video=True)
assert "<Video 1> is the shot that plays just before" in p and "<d>[Urdu]" in p
print("ok  prompt, size and frame translation")

g = h3.build_graph("x", 768, 1344, 124, 7, ["a.png", "b.png"], ["c.mp4"], ["d.mp3"], "backlot/j")
r2v = g["8"]["inputs"]
assert r2v["ref_images.ref_image_1"] == ["101", 0] and g["101"]["inputs"]["image"] == "b.png"
assert r2v["ref_videos.ref_video_0"] == ["210", 0] and g["210"]["class_type"] == "GetVideoComponents"
assert r2v["ref_audios.ref_audio_0"] == ["300", 0] and (r2v["width"], r2v["height"], r2v["length"]) == (768, 1344, 124)
assert g["6"]["class_type"] == "Ref2VAVSAGatePatch" and g["7"]["inputs"]["model"] == ["6", 0] and g["11"]["inputs"]["steps"] == 4
dense = h3.build_graph("x", 768, 1344, 124, 7, [], [], [], "p", attention="dense")
assert "6" not in dense and dense["7"]["inputs"]["model"] == ["5", 0]
assert "18" not in g and g["12"]["inputs"]["conditioning"] == ["8", 0]
i2v = h3.build_graph("x", 1344, 768, 124, 7, ["f.png"], [], [], "p", first_frame=True)
guide = i2v["18"]["inputs"]
assert i2v["18"]["class_type"] == "MiniMaxH3AddGuide" and guide["image"] == ["100", 0] and guide["frame_idx"] == 0
assert guide["latent"] == ["8", 1] and i2v["12"]["inputs"]["conditioning"] == ["18", 0]
assert i2v["8"]["inputs"]["ref_images.ref_image_0"] == ["100", 0], "the first frame is also <Picture 1>"
print("ok  graph wiring (VSA, dense, first frame)")

# ── Weights on the volume ──
h3.MODEL_DIR = Path("/runpod-volume/h3")
try:
    h3._ensure_weights()
    raise AssertionError("expected a missing-volume error")
except RuntimeError as e:
    assert "network volume" in str(e) or Path("/runpod-volume").is_dir(), e
h3.MODEL_DIR = Path(os.environ["MODEL_DIR"])
os.environ["H3_AUTO_DOWNLOAD"] = "0"
try:
    h3._ensure_weights()
    raise AssertionError("expected a missing-weights error")
except RuntimeError as e:
    assert "6 H3 weight files are missing" in str(e), e
for f in h3.REQUIRED:  # sparse files of the exact pinned sizes
    target = h3.MODEL_DIR / f["target"]
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "wb") as w:
        w.truncate(f["size"])
h3._ensure_weights()
print("ok  weight checks")

# ── A fake ComfyUI, started by the backend like the real one ──
(tmp / "comfy").mkdir()
(tmp / "comfy" / "main.py").write_text(r'''
import argparse, json, os, subprocess, threading, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
p = argparse.ArgumentParser()
for a in ("--port", "--input-directory", "--output-directory", "--temp-directory", "--listen"): p.add_argument(a)
p.add_argument("--extra-model-paths-config", action="append", nargs="+")
args, _ = p.parse_known_args()
assert os.environ.get("BACKLOT_DEDICATED_VSA_WORKER") == "1" and not any("SECRET" in k for k in os.environ)
LOG = os.environ["FAKE_COMFY_LOG"]
base = next(l.split(":", 1)[1].strip() for l in open(args.extra_model_paths_config[0][0]) if "base_path" in l)
files = lambda d: sorted(os.listdir(os.path.join(base, d)))
info = {c: {"input": {"required": {}}} for c in ["UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly",
    "Ref2VAVSAGatePatch", "MiniMaxH3SigmaShift", "LoadImage", "LoadVideo", "GetVideoComponents", "LoadAudio",
    "MiniMaxH3ReferenceToVideo", "MiniMaxH3AddGuide", "RandomNoise", "KSamplerSelect", "BasicScheduler", "BasicGuider",
    "SamplerCustomAdvanced", "VAEDecode", "VAEDecodeAudio", "CreateVideo", "SaveVideo"]}
info["UNETLoader"]["input"]["required"]["unet_name"] = [files("diffusion_models")]
info["CLIPLoader"]["input"]["required"]["clip_name"] = [files("text_encoders")]
info["VAELoader"]["input"]["required"]["vae_name"] = ["COMBO", {"options": files("vae")}]
info["LoraLoaderModelOnly"]["input"]["required"]["lora_name"] = [files("loras")]
info["Ref2VAVSAGatePatch"]["input"]["required"]["gate_file"] = [files("loras")]
history, state = {}, {"busy": False}
def log(**kw):
    with open(LOG, "a") as f: f.write(json.dumps(kw) + "\n")
def render(pid, g):
    n = g["8"]["inputs"]
    if "FAIL_RENDER" in n["prompt"]:
        history[pid] = {"status": {"status_str": "error", "completed": False, "messages": [["execution_error",
            {"node_type": "SamplerCustomAdvanced", "exception_type": "torch.OutOfMemoryError", "exception_message": "CUDA out of memory"}]]}, "outputs": {}}
        return
    prefix = g["17"]["inputs"]["filename_prefix"]
    name = os.path.basename(prefix) + "_00001_.mp4"
    out = os.path.join(args.output_directory, os.path.dirname(prefix), name)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sec = n["length"] / 24
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=s=%dx%d:r=24:d=%f" % (n["width"] // 8, n["height"] // 8, sec), "-f", "lavfi", "-i",
        "sine=frequency=330:sample_rate=32000:duration=%f" % sec, "-ac", "2", "-frames:v", str(n["length"]),
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out], check=True)
    history[pid] = {"status": {"status_str": "success", "completed": True, "messages": []},
                    "outputs": {"17": {"images": [{"filename": name, "subfolder": os.path.dirname(prefix), "type": "output"}], "animated": [True]}}}
class H(BaseHTTPRequestHandler):
    def reply(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path == "/system_stats": return self.reply({"system": {}})
        if self.path == "/object_info": return self.reply(info)
        if self.path == "/queue": return self.reply({"queue_running": [["x"]] if state["busy"] else [], "queue_pending": []})
        if self.path.startswith("/history/"):
            pid = self.path.rsplit("/", 1)[1]
            return self.reply({pid: history[pid]} if pid in history else {})
        self.reply({}, 404)
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        if self.path == "/fake/busy": state["busy"] = True; return self.reply({})
        if self.path == "/queue": log(event="clear"); return self.reply({})
        if self.path == "/interrupt": log(event="interrupt"); state["busy"] = False; return self.reply({})
        if self.path == "/prompt":
            g = body["prompt"]
            staged = {k: os.path.isfile(os.path.join(args.input_directory, v["inputs"].get("image") or v["inputs"].get("file") or v["inputs"].get("audio")))
                      for k, v in g.items() if v["class_type"] in ("LoadImage", "LoadVideo", "LoadAudio")}
            log(event="prompt", graph=g, staged=staged)
            pid = uuid.uuid4().hex
            threading.Timer(0.2, render, (pid, g)).start()
            return self.reply({"prompt_id": pid, "number": 1, "node_errors": {}})
        self.reply({}, 404)
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", int(args.port)), H).serve_forever()
''')


def events(kind=None):
    path = Path(os.environ["FAKE_COMFY_LOG"])
    rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    return [r for r in rows if kind is None or r["event"] == kind]


# Reference media the way the engine stores them: PNG images, MP3 voices, the previous take as MP4.
media = {}
for name, args in {"face.png": ["-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1"],
                   "voice.mp3": ["-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-c:a", "libmp3lame"],
                   "prev.mp4": ["-f", "lavfi", "-i", "testsrc2=s=64x112:r=24:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p"]}.items():
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, str(tmp / name)], check=True)
    media[name] = (tmp / name).read_bytes()
assert [h3._extension(str(tmp / n), k) for n, k in [("face.png", "image_url"), ("voice.mp3", "audio_url"), ("prev.mp4", "video_url")]] == [".png", ".mp3", ".mp4"]

uploads: dict[str, bytes] = {}


class Storage(BaseHTTPRequestHandler):
    def do_GET(self):
        body = media[self.path.strip("/")]
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        uploads[self.path] = self.rfile.read(int(self.headers["content-length"]))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Storage)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"


def job(prompt: str, n: int, video: bool = True, first_frame: bool = False) -> dict:
    content = [{"type": "text", "text": prompt}]
    if first_frame:
        content.append({"type": "image_url", "image_url": {"url": f"{base}/face.png"}, "role": "first_frame"})
    else:
        content.append({"type": "image_url", "image_url": {"url": f"{base}/face.png"}, "role": "reference_image"})
        if video:
            content.append({"type": "video_url", "video_url": {"url": f"{base}/prev.mp4"}, "role": "reference_video"})
        content.append({"type": "audio_url", "audio_url": {"url": f"{base}/voice.mp3"}, "role": "reference_audio"})
    return {"input": {
        "request": {"model": "MiniMax-H3", "resolution": "768P", "duration": 5, "ratio": "9:16", "content": content},
        "upload": {"url": f"{base}/put/{n}.mp4?sig=x", "key": f"projects/p/takes/{n}.mp4", "content_type": "video/mp4"},
    }}


os.environ["SOME_SECRET"] = "must not reach ComfyUI"
import handler  # noqa: E402

try:
    out = handler.handler(job(engine_prompt, 1))
    assert out["key"] == "projects/p/takes/1.mp4" and out["has_audio"], out
    assert (out["width"], out["height"]) == (96, 168) and abs(out["seconds"] - 5) < 0.1, out  # rendered 124 frames (5.17 s), cut to the 5 s ordered
    assert uploads["/put/1.mp4?sig=x"][4:8] == b"ftyp"
    [sent] = events("prompt")
    g = sent["graph"]
    assert all(sent["staged"].values()) and len(sent["staged"]) == 3, "picture, previous clip and voice staged"
    assert g["100"]["inputs"]["image"].endswith(".png") and g["300"]["inputs"]["audio"].endswith(".mp3")
    assert g["200"]["class_type"] == "LoadVideo" and g["200"]["inputs"]["file"].endswith(".mp4")
    prompt = g["8"]["inputs"]["prompt"]
    assert "<Picture 2>" in prompt and "<d>[English]" in prompt and "<Video 1> is the shot" in prompt
    assert not list((tmp / "work" / "input").iterdir()) and not list((tmp / "work" / "output" / "backlot").iterdir())
    print("ok  render through the handler: graph, staging, upload, clean-up")

    handler.handler(job(engine_prompt, 2, video=False))
    g = events("prompt")[-1]["graph"]
    assert "200" not in g and "reference video" not in g["8"]["inputs"]["prompt"].lower()
    print("ok  without a previous clip, the sentence describing it is dropped")

    handler.handler(job("The flag starts to flutter.", 6, first_frame=True))
    g = events("prompt")[-1]["graph"]
    assert g["18"]["class_type"] == "MiniMaxH3AddGuide" and g["12"]["inputs"]["conditioning"] == ["18", 0]
    assert g["8"]["inputs"]["prompt"].startswith("<Picture 1> is the first frame of the video")
    assert "/put/6.mp4?sig=x" in uploads
    print("ok  image to video: the picture is pinned as the first frame")

    try:
        handler.handler(job("FAIL_RENDER", 3))
        raise AssertionError("expected a render failure")
    except RuntimeError as e:
        assert "CUDA out of memory" in str(e), e
    print("ok  a render error fails the job with ComfyUI's message")

    h3._call("/fake/busy", {})
    handler.handler(job(engine_prompt, 4))
    assert [e["event"] for e in events()][-3:] == ["clear", "interrupt", "prompt"], events()[-3:]
    print("ok  work left over from a cancelled job is stopped first")

    old = h3._proc
    old.send_signal(signal.SIGKILL)
    old.wait()
    handler.handler(job(engine_prompt, 5))
    assert h3._proc is not old and "/put/5.mp4?sig=x" in uploads
    print("ok  a crashed ComfyUI is restarted for the next job")
finally:
    if h3._proc and h3._proc.poll() is None:
        h3._proc.kill()
    server.shutdown()
print("H3 BACKEND SELFTEST PASSED")
