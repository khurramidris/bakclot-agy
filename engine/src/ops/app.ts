// The ops dashboard's server: one read-only report per page under /api (admins only, signed in with their Backlot
// account), the dashboard page itself (web/dist/ops/index.html, built with the web app), and a health check.

import { Hono, type Context } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { sql, plain } from '../db.js';
import { userFromRequest, DEV_USER } from '../auth.js';
import { reportError } from '../monitoring.js';
import { overview, live } from './overview.js';
import { business, customers, customer, growth } from './business.js';
import { product, safety } from './product.js';
import { backend } from './backend.js';
import { providers } from './providers.js';
import { clampDays, clampHours } from './stats.js';

type Env = { Variables: { uid: string; email: string | null } };
export const ops = new Hono<Env>();

/** Who may open the dashboard: ADMIN_USER_IDS. In local development with no admins listed, anyone with a dev sign-in. */
export const isAdmin = (uid: string) => config.admins.includes(uid) || (config.auth.allowDevTokens && !config.admins.length);

// A private tool: never indexed, never framed, never cached, links don't leak where they came from.
ops.use('*', async (c, next) => {
  await next();
  c.header('x-robots-tag', 'noindex, nofollow');
  c.header('x-frame-options', 'DENY');
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
});

ops.onError((e: any, c) => {
  const status = e.status || 500;
  if (status >= 500 && e.code !== 'not_migrated') {
    console.error('[ops]', e);
    reportError(e, { where: 'ops', path: c.req.path });
  }
  return c.json({ error: { code: e.code || 'server_error', message: e.message || 'Something went wrong.' } }, status);
});

ops.get('/health', async (c) => { await sql`select 1`; return c.json({ ok: true, service: 'ops' }); });
ops.get('/robots.txt', (c) => c.text('User-agent: *\nDisallow: /\n'));
// Sign-in settings for the page (the same Supabase project as the app).
ops.get('/app-config.json', (c) => c.json({
  supabaseUrl: config.auth.supabaseUrl, supabaseAnonKey: config.auth.supabaseAnonKey,
  ...(config.auth.allowDevTokens ? { devUser: DEV_USER } : {}),
}));

let schemaReady = false;
/** The reports read tables the app adds when it starts (migration 012): say so plainly if it hasn't yet. */
async function requireSchema() {
  if (schemaReady) return;
  const [r] = await sql`select 1 from schema_migrations where name = '012_ops.sql'`.catch(() => []);
  if (!r) throw Object.assign(new Error('The database doesn’t have the dashboard’s tables yet. Deploy the latest version of the app first: it adds them when it starts.'), { status: 503, code: 'not_migrated' });
  schemaReady = true;
}

const api = new Hono<Env>();
api.use('*', async (c, next) => {
  c.header('cache-control', 'no-store');
  const who = await userFromRequest(c);
  if (!who) return c.json({ error: { code: 'unauthorized', message: 'Sign in first.' } }, 401);
  if (!isAdmin(who.uid)) {
    return c.json({ error: { code: 'not_admin', message: `This account isn’t an admin. To let it in, add its user id to ADMIN_USER_IDS on the server: ${who.uid}`, user_id: who.uid } }, 403);
  }
  c.set('uid', who.uid);
  c.set('email', who.email);
  await requireSchema();
  await next();
});

const days = (c: Context) => clampDays(c.req.query('days'));
api.get('/me', (c) => c.json({
  user_id: c.get('uid'), email: c.get('email'), video_provider: config.videoProvider,
  // The app itself, for links to a customer's support page (credit grants live there).
  app_url: config.lemonsqueezy.appUrl || config.publicBaseUrl || (config.auth.allowDevTokens ? 'http://localhost:5173' : null),
}));
api.get('/overview', async (c) => c.json(plain(await overview())));
api.get('/live', async (c) => c.json(plain(await live())));
api.get('/business', async (c) => c.json(plain(await business(days(c)))));
api.get('/growth', async (c) => c.json(plain(await growth(days(c)))));
api.get('/customers', async (c) => c.json(plain(await customers(c.req.query('q') || '', c.req.query('sort') || 'recent'))));
api.get('/customers/:id', async (c) => c.json(plain(await customer(c.req.param('id')))));
api.get('/product', async (c) => c.json(plain(await product(days(c)))));
api.get('/backend', async (c) => c.json(plain(await backend(clampHours(c.req.query('hours'))))));
api.get('/providers', async (c) => c.json(plain(await providers(days(c)))));
api.get('/safety', async (c) => c.json(plain(await safety(days(c)))));
api.all('*', (c) => c.json({ error: { code: 'not_found', message: 'No such report.' } }, 404));
ops.route('/api', api);

// ───────── the dashboard page (web/dist/ops/index.html) and its files ─────────
const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.txt': 'text/plain',
};
const webDir = resolve(config.webDir);
ops.get('*', async (c) => {
  let path: string;
  try { path = decodeURIComponent(c.req.path); } catch { return c.text('bad path', 400); }
  if (path.startsWith('/assets/') || /^\/favicon\.(svg|ico)$/.test(path)) {
    const file = resolve(webDir, '.' + path);
    if (file.startsWith(webDir + sep) && (await stat(file).then((s) => s.isFile(), () => false))) {
      return new Response(new Uint8Array(await readFile(file)), { headers: {
        'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', // Vite hashes /assets names
      } });
    }
    return c.text('not found', 404);
  }
  const page = await readFile(join(webDir, 'ops', 'index.html'), 'utf8').catch(() => null);
  return page ? c.html(page, 200, { 'cache-control': 'no-cache' }) : c.text('The dashboard page isn’t built. Run `npm run build` in web/.', 404);
});
