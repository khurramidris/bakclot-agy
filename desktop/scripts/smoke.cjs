// End-to-end check of the desktop app: starts it (Electron, its own Postgres, the engine, FFmpeg) in demo mode with a
// throwaway data folder, makes a whole film from a prompt, and exits 0 only if a finished MP4 comes out.
//   npm run prepare:app && npm run smoke
// Linux needs xvfb (a virtual screen) and must NOT run as root, because Postgres refuses to start as root.
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const electron = require('electron');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'backlot-smoke-'));
const env = { ...process.env, BACKLOT_SMOKE: '1', BACKLOT_DATA_DIR: data };
let cmd = electron, args = ['.'];
if (process.platform === 'linux') {
  env.BACKLOT_NO_SANDBOX = '1';
  if (process.getuid && process.getuid() === 0) { console.error('Run this as a normal user: Postgres will not start as root.'); process.exit(2); }
  if (!process.env.DISPLAY) { args = ['-a', electron, '.']; cmd = 'xvfb-run'; }
}
const r = spawnSync(cmd, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 6 * 60_000, encoding: 'utf8' });
const out = (r.stdout || '') + (r.stderr || '');
for (const line of out.split('\n')) if (line.startsWith('SMOKE')) console.log(line);
const ok = out.includes('SMOKE OK') && r.status === 0;
if (!ok) {
  const logfile = path.join(data, 'logs', 'backlot.log');
  if (fs.existsSync(logfile)) console.error(fs.readFileSync(logfile, 'utf8').split('\n').slice(-100).join('\n'));
  if (r.error) console.error(r.error.message);
}
fs.rmSync(data, { recursive: true, force: true });
if (!ok) { console.error(out.split('\n').slice(-25).join('\n')); process.exit(1); }

