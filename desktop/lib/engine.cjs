// The engine (API + job worker): run as a child process with Electron's own Node, so nothing needs installing.

const { spawn } = require('node:child_process');
const path = require('node:path');
const { waitFor } = require('./util.cjs');

async function start({ execPath, engineDir, env, port, log }) {
  const entry = path.join(engineDir, 'dist', 'index.js');
  const child = spawn(execPath, [entry], { cwd: engineDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let exited = null;
  child.stdout.on('data', (d) => log('engine', d));
  child.stderr.on('data', (d) => log('engine', d));
  child.on('exit', (code, sig) => { exited = { code, sig }; log('engine', `exited code=${code} signal=${sig}`); });
  child.on('error', (e) => { exited = { code: -1, sig: null }; log('engine', `could not start: ${e.message}`); });

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (exited) throw new Error(`the engine stopped (exit ${exited.code ?? exited.sig})`);
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    return r && r.ok;
  }, { timeoutMs: 90_000, what: 'the engine to start', failFast: true });

  return {
    url: base,
    onExit: (fn) => { child.on('exit', (code, sig) => fn({ code, sig })); },
    stop: () => new Promise((resolve) => {
      if (exited) return resolve();
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 8000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.kill('SIGTERM'); } catch { resolve(); }
    }),
  };
}

module.exports = { start };

