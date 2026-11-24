// The ops dashboard, as its own service: on Railway, a second service from this repo with the start command
// `node dist/ops.js` and its own address. It keeps working when the app has trouble, so it can show you that it does.
// Read-only: it never changes data, runs jobs or migrates the database. Admins only (ADMIN_USER_IDS).
//   Locally: npm run dev:ops (port 8790), then open http://localhost:5173/ops/ with npm run dev:web.
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { initMonitoring } from './monitoring.js';
import { ops } from './ops/app.js';

await initMonitoring();
const server = serve({ fetch: ops.fetch, port: config.ops.port, hostname: config.host }, (i) =>
  console.log(`[ops] dashboard on :${i.port}${config.auth.allowDevTokens ? ' (dev sign-in)' : ''}`));
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => { server.close(); process.exit(0); });
