const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

function freePort(preferred) {
  const tryPort = (p) => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(p, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
  return tryPort(preferred || 0).catch(() => tryPort(0));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` returns truthy or the time is up. */
async function waitFor(fn, { timeoutMs = 60_000, everyMs = 400, what = 'it', failFast = false } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fn(); if (r) return r; } catch (e) { if (failFast) throw e; last = e; }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/** Append-only log file that is trimmed at start so it never grows without bound. */
function logger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { if (fs.statSync(file).size > 5_000_000) fs.renameSync(file, file + '.old'); } catch { /* none yet */ }
  const stream = fs.createWriteStream(file, { flags: 'a' });
  const write = (tag, chunk) => {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) if (line.trim()) stream.write(`${new Date().toISOString()} [${tag}] ${line}\n`);
  };
  const tail = (n = 25) => {
    try { return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-n).join('\n'); } catch { return ''; }
  };
  return { write, tail, file, close: () => stream.end() };
}

module.exports = { freePort, sleep, waitFor, logger };

