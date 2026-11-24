// Entry point: API + (optionally) the worker in one process. For scale, run the API with
// RUN_WORKER=0 and start `npm run worker` on one or more separate machines.
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { migrate, startWatchdog } from './db.js';
import { registerJobs, startSystemJobs } from './jobs.js';
import { startWorker } from './queue.js';
import { app } from './server.js';
import { initMonitoring, reportError } from './monitoring.js';

await initMonitoring();
if (config.autoMigrate) await migrate();
registerJobs();
await startSystemJobs();
const worker = config.runWorker ? startWorker() : null;
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) => console.log(`[api] listening on :${i.port}${config.mock ? ' (MOCK PROVIDERS)' : ''}`));
// If the database pool ever stops answering while the database is up, leave: the platform starts a fresh process.
startWatchdog({ onStuck: () => { reportError(new Error('database pool stuck: restarting'), { where: 'watchdog' }); setTimeout(() => process.exit(1), 500).unref(); } });
// A deploy stops this process: take no new work, give running jobs a moment to finish. Anything still running is
// handed back to the queue for the next instance. Whatever happens, the process is gone 30 seconds later.
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, async () => {
  console.log(`[api] ${s}: stopping`);
  setTimeout(() => process.exit(0), 30_000).unref();
  server.close();
  await worker?.stop(20_000);
  process.exit(0);
});
