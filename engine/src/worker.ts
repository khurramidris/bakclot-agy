// Standalone worker process (no HTTP). Needs FFmpeg on the machine.
import { config } from './config.js';
import { migrate, startWatchdog } from './db.js';
import { registerJobs, startSystemJobs } from './jobs.js';
import { startWorker } from './queue.js';

if (config.autoMigrate) await migrate();
registerJobs();
await startSystemJobs();
const w = startWorker();
startWatchdog();
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, async () => { setTimeout(() => process.exit(0), 30_000).unref(); await w.stop(20_000); process.exit(0); });
