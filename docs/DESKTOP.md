# Backlot Desktop

The whole studio as a normal app on Windows, macOS or Linux. You double-click it, a window opens, and everything runs
on your computer: the web app, the engine, its own database (a real Postgres inside the app) and FFmpeg. You bring your
own accounts (Anthropic, MiniMax, RunPod). Nothing is billed by Backlot, and you are signed in automatically.

It is the same product as the online one. Only the shell differs, so every improvement to the engine and the web app
shows up in the desktop app the next time you build it.

## First start

1. Start the app. A welcome window asks how you want to run.
2. **Try it now** needs nothing: scripts, images and clips are placeholders, but the whole studio works end to end,
   including editing and exporting a real MP4. Good for a look around.
3. **Use my own accounts** asks for your keys. Each has a **Test** button where a free check exists:
   - Anthropic API key (writes the story)
   - MiniMax API key (voices, and images unless you pick Gemini or OpenAI)
   - RunPod API key and the endpoint ID of your H3 worker
4. **Save and start.** A start-up window shows the steps (database, public address, studio), then the studio opens.

Change anything later from **File → Settings** (Mac: **Backlot → Settings**, `Cmd+,`). Saving restarts the studio; your
films are kept.

## The public address (for RunPod)

RunPod's GPU downloads each shot's reference images from your computer and uploads the finished clip back to it, so
your computer needs a public https address. The app opens a free Cloudflare tunnel for this on every start when video
runs on RunPod. The tunnel program (`cloudflared`, a pinned version) is downloaded the first time, about 40 MB, and
kept in the app's data folder. The address changes every start, which is fine because the app starts the engine with
it. If you already have your own https address that reaches this computer, put it in **Public address** and no tunnel
is started. With MiniMax-hosted video or demo mode no tunnel is needed.

The tunnel forwards every address, and the studio signs you in by itself, so the engine answers only this computer:
a request arriving through the tunnel (or any request not addressed to `127.0.0.1`/`localhost`) can reach only the
signed file links under `/files/`, `/health` and the signed payment webhook. Everything else gets 403.

If renders fail with a download or upload error, use **Tools → Restart studio** to get a fresh address, and
**Tools → Setup check** to see what the engine can reach.

## Menu

- **Tools → Dashboard / Setup check / Admin**: the same pages as online. Admin shows what each film cost you.
- **Tools → Restart studio**, **Copy public address**
- **Tools → Open films folder / Open logs folder**

## Where things are kept

| What | Where |
|---|---|
| Windows | `%APPDATA%\Backlot` |
| macOS | `~/Library/Application Support/Backlot` |
| Linux | `~/.config/Backlot` |

Inside: `settings.json` (keys are encrypted with the system keychain when available), `pgdata/` (the database),
`files/` (images, clips, films), `logs/backlot.log`, `bin/` (the tunnel program). To start over, quit and delete the folder.
Back up `pgdata/` and `files/` together.

## Run it from the repository

Needs Node 22 and FFmpeg is **not** needed (the app carries its own).

```bash
cd desktop
npm install              # on Linux, if Electron's download is blocked: node node_modules/electron/install.js
npm run dev              # builds the web app and engine, then starts the app
```

Use a normal user, not root: Postgres refuses to run as root.

## Build an installer

```bash
cd desktop
npm run dist             # builds everything, then writes the installer to desktop/release/
```

Build on the system you want the installer for (Windows → `.exe`, macOS → `.dmg`, Linux → `.AppImage`),
because the database and FFmpeg binaries are specific to each system and CPU. The **Desktop** workflow in
GitHub Actions does this for all three: run it by hand (Actions → Desktop → Run workflow) or push a tag such as
`desktop-v0.1.0`, then download the installers from the run.

**Unsigned builds.** Without a code-signing certificate, Windows SmartScreen and macOS Gatekeeper warn on first
launch (Windows: "More info → Run anyway"; macOS 15+: System Settings → Privacy & Security → Open Anyway, older macOS:
right-click the app → Open). The Mac build is signed ad hoc (`identity: "-"` in `electron-builder.yml`): with no
signature at all, Apple-chip Macs call a downloaded app "damaged" and offer no way to open it. Real signing needs an
Apple Developer account and a Windows code-signing certificate; electron-builder picks them up from the usual `CSC_*`
environment variables (then remove `identity: "-"`).

**Linux AppImage.** It needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04+, `libfuse2` before). It runs Chromium without its
sandbox (`main.cjs`, when `APPIMAGE` is set): an AppImage can't carry the setuid helper and Ubuntu 24.04+ blocks the
user-namespace sandbox, so otherwise it would not open. The engine only listens on 127.0.0.1 (`LISTEN_HOST`), because
sign-in is automatic.

## Check it works

```bash
cd desktop
npm test                 # unit tests: settings, secrets, tunnel, start-up order
npm run prepare:app && npm run smoke   # starts the real app and makes a whole film in demo mode
```

## How it fits together

- `desktop/main.cjs`: windows, menu, settings screens (`ui/`).
- `desktop/lib/stack.cjs`: starts the database, then the tunnel, then the engine, and stops them in reverse order.
- `desktop/lib/postgres.cjs`: [embedded-postgres](https://www.npmjs.com/package/embedded-postgres) (real Postgres binaries), listening on this computer only.
- `desktop/lib/engine.cjs`: runs `engine/dist/index.js` with Electron's own Node. The engine is the same code as online, started with dev sign-in (you are the only user, nothing is charged).
- `desktop/lib/settings.cjs`: your settings, and the environment the engine gets. Only a few system variables are passed on, so nothing from your shell leaks in.
- FFmpeg comes from `ffmpeg-static` and `@ffprobe-installer/ffprobe`. That FFmpeg has no `drawtext` filter, so with the bundled fonts folder set the engine draws placeholder text and slates through libass instead (`engine/src/media/ffmpeg.ts`).

## Not covered yet

- The RunPod worker must match our contract (`gpu-worker/handler.py`); see `docs/LOCAL.md`.
- Auto-update is not set up: install a newer build over the old one. Your data folder is kept.
- The Windows and macOS installers and the tunnel download are built to work but have only been tested on Linux.
