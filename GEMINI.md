# Backlot Workspace Rules

Backlot is a prompt-to-film and quick-clip platform (`engine/`, `web/`, `desktop/`, `gpu-worker/`). See `CLAUDE.md` for full architecture, layout, and product notes.

## Architecture & Stack
- **Engine**: Node 22 + Hono + Postgres (`engine/`, entry `src/index.ts`, routes `src/server.ts`, ops service `src/ops.ts`).
- **Frontend**: React + Vite + TanStack Router (`web/`, ops UI `web/src/ops/`).
- **Desktop**: Electron wrapper around the engine and web app (`desktop/`).
- **GPU Worker**: Python RunPod handler and self-hosted H3 ComfyUI backend (`gpu-worker/`).

## Verification Commands
Run the checks relevant to your change:
1. `npm run typecheck` — TypeScript check across `engine` and `web`
2. `npm test` — Unit tests across `engine` and `web`
3. `npm run build` — Production build for `web` and `engine`
4. `npm --prefix web run lint` — Web linter
5. `python gpu-worker/selftest.py && python gpu-worker/test_h3.py` — GPU worker tests

## Project Invariants
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- **Never commit secrets**: `.env*`, key files (`*.pem`, `*.key`, `*.p12`, `*.pfx`), and credential files are git-ignored. Document new environment variables in `engine/env.sample` and `docs/DEPLOY.md`.
- **On Windows PowerShell (`pwsh`)**: Use native PowerShell or Node/Python commands rather than POSIX-only shell syntax.

## Cross-Laptop Sync (Office ↔ Home)
- **When the user says "push the latest and sync both"**:
  1. Push committed Git changes on the active branch (`git -C D:\Experiment\backlot-antigravity\backlot push`, or `git push` from inside `backlot\`).
  2. Run `pwsh -File scripts/agy-sync.ps1 push -AllowLive` from `D:\Experiment\backlot-antigravity\backlot` (snapshots local `agy` CLI chats via SQLite `VACUUM INTO` and uploads them to the **private** `khurramidris/agy-chat-sync` GitHub release; never commit chats or `.db` files into the public `bakclot-agy` repo).
- **When switching to the other laptop (before opening `agy`)**:
  - Ensure the workspace path is `D:\Experiment\backlot-antigravity` and clone this repo (`https://github.com/khurramidris/bakclot-agy`) to the exact same path `D:\Experiment\backlot-antigravity\backlot`.
  - From `D:\Experiment\backlot-antigravity\backlot`, run `git pull; .\scripts\agy-sync.ps1 pull`, then launch `agy` in `D:\Experiment\backlot-antigravity`.
