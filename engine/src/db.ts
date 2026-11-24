import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// postgres.js connects in plain text unless told otherwise, and Supabase's connection string has no sslmode. A database
// on another machine is encrypted whenever the server offers TLS (libpq's default, 'prefer'); an sslmode in the URL wins.
const remote = !/@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(config.databaseUrl) && !/[?&](sslmode|ssl)=/i.test(config.databaseUrl);

// Which service holds a connection (the ops dashboard groups them by this name): the app, a separate worker, or ops.
const script = basename(process.argv[1] || '');
const appName = /^ops\.[jt]s$/.test(script) ? 'backlot-ops' : /^worker\.[jt]s$/.test(script) ? 'backlot-worker' : 'backlot';

const options = {
  ...(remote ? { ssl: 'prefer' as const } : {}),
  connection: { application_name: appName },
  idle_timeout: 30,
  onnotice: () => {},
  // Supabase's pooler (port 6543, transaction mode) does not support prepared statements.
  prepare: !/:6543\b/.test(config.databaseUrl),
  types: { bigint: postgres.BigInt },
};

// Supabase's session pooler allows only so many connections in all: the ops dashboard makes do with a few.
const poolMax = process.env.DB_POOL_MAX ? Math.max(2, Number(process.env.DB_POOL_MAX) || 10) : (appName === 'backlot-ops' ? 3 : config.db.poolMax);
export const sql = postgres(config.databaseUrl, { ...options, max: poolMax });

export type Sql = typeof sql;

/**
 * A transaction that can't wait forever. Use this instead of sql.begin everywhere but migrations.
 * - lock_timeout: a statement waiting on another transaction's lock gives up with an error instead of queueing for good.
 * - idle_in_transaction_session_timeout: a transaction that stops sending statements (its process hung or is waiting on
 *   something else) is ended by Postgres, which releases its locks and its connection.
 * Both are set for this transaction only, so they also work through a transaction-mode pooler.
 *
 * RULE: inside the callback use `tx` for every query. A query on the shared `sql` pool from inside a transaction waits
 * for a free connection while this one is held, and with enough of them at once every connection waits on another:
 * the whole engine stops answering. (That was the freeze found in the 2026-11-13 audit.)
 */
export function begin<T>(fn: (tx: any) => Promise<T>, o: { lockMs?: number } = {}): Promise<T> {
  const lock = Math.round(o.lockMs ?? config.db.lockTimeoutMs), idle = Math.round(config.db.idleTxTimeoutMs);
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local lock_timeout = '${lock}ms'; set local idle_in_transaction_session_timeout = '${idle}ms'`);
    return fn(tx);
  }) as Promise<T>;
}

/**
 * Run something that may lose a race with other work on the same rows: a deadlock (Postgres picks one side and aborts
 * it) or a lock wait that timed out. Those are tried again, a few times, after a short pause.
 */
export async function retryBusy<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e: any) {
      if (i >= attempts || !['40P01', '55P03', '40001'].includes(e?.code)) throw e;
      await new Promise((r) => setTimeout(r, 100 * i + Math.random() * 200));
    }
  }
}

/** Resolves false when the promise takes longer than `ms` (the promise itself keeps running). */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true, () => 'error' as const), new Promise<false>((r) => setTimeout(() => r(false), ms).unref())]);

/** Whether the shared pool answers a trivial query in time. Used by /health so a stuck pool reads as unhealthy at once. */
export async function poolAnswers(ms = 5000): Promise<boolean> {
  return (await within(sql`select 1`, ms)) === true;
}

/**
 * Last line of defence against a stuck pool. Every 15 s the shared pool is asked a trivial question. If it stays silent
 * (no answer and no error) while a separate connection to the same database answers fine, the pool itself is stuck:
 * the process exits so the platform starts a fresh one (jobs survive in the queue). A database that is down or
 * unreachable makes both fail, and then the process stays up and reconnects by itself.
 */
export function startWatchdog(o: { everyMs?: number; timeoutMs?: number; strikes?: number; onStuck?: () => void } = {}) {
  if (!config.db.watchdog) return () => {};
  const every = o.everyMs ?? 15_000, timeout = o.timeoutMs ?? 20_000, limit = o.strikes ?? 3;
  const probe = postgres(config.databaseUrl, { ...options, max: 1, idle_timeout: 10, connect_timeout: 10 });
  let strikes = 0, busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const pool = await within(sql`select 1`, timeout);
      if (pool !== false) { strikes = 0; return; } // answered, or failed with an error (the driver reconnects)
      const direct = await within(probe`select 1`, 10_000);
      if (direct !== true) { strikes = 0; return; } // the database itself isn't answering: not our pool's fault
      strikes++;
      console.error(`[watchdog] the database pool has not answered for ${Math.round((timeout * strikes) / 1000)} s while the database is up (${strikes}/${limit})`);
      if (strikes >= limit) {
        console.error('[watchdog] restarting: the database pool is stuck');
        if (o.onStuck) o.onStuck(); else process.exit(1);
      }
    } finally { busy = false; }
  }, every);
  t.unref();
  return () => { clearInterval(t); void probe.end({ timeout: 1 }).catch(() => {}); };
}

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const dir = join(here, '..', 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // Instances starting together take turns: each migration runs under a lock and is re-checked inside it.
  const LOCK = 7_212_650;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK})`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  });
  for (const f of files) {
    const [done] = await sql`select 1 from schema_migrations where name = ${f}`;
    if (done) continue;
    const text = await readFile(join(dir, f), 'utf8');
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK})`;
      if ((await tx`select 1 from schema_migrations where name = ${f}`).length) return false;
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
      return true;
    });
    if (applied) console.log(`[db] applied ${f}`);
  }
}

/** Convert bigint ids in rows to numbers for JSON responses. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}
