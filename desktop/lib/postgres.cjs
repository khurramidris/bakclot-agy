// The database: a real Postgres that ships inside the app (the `embedded-postgres` package) and keeps its files in
// the app's data folder. Listens on this computer only, with a password made on first run.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./util.cjs');

const DB = 'backlot';
const USER = 'backlot';
const INITDB_FLAGS = ['--encoding=UTF8', '--locale=C'];

// template0 lets us choose UTF-8 even when an older Windows cluster defaults to WIN1252.
const CREATE_DATABASE = `CREATE DATABASE "${DB}" WITH TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C'`;

async function ensureDatabase(pg, log) {
  const admin = pg.getPgClient('postgres', '127.0.0.1');
  try {
    await admin.connect();
    const { rows } = await admin.query('SELECT pg_encoding_to_char(encoding) AS encoding FROM pg_database WHERE datname = $1', [DB]);
    if (!rows.length) { await admin.query(CREATE_DATABASE); return; }
    if (rows[0].encoding === 'UTF8') return;

    // The failed first migration leaves only an empty schema_migrations table. Recover that
    // case automatically, but never replace a database containing saved work or unknown objects.
    const legacy = pg.getPgClient(DB, '127.0.0.1');
    let empty = false;
    try {
      await legacy.connect();
      const tables = await legacy.query(`SELECT n.nspname, c.relname FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg_%'
          AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`);
      empty = tables.rows.every((t) => t.nspname === 'public' && t.relname === 'schema_migrations');
      if (empty && tables.rows.length) {
        const applied = await legacy.query('SELECT 1 FROM public.schema_migrations LIMIT 1');
        empty = applied.rows.length === 0;
      }
    } finally { await legacy.end(); }
    if (!empty) throw new Error(`Backlot's database uses ${rows[0].encoding} instead of UTF-8 and contains existing data. Your work has been kept. It needs a database export/import to UTF-8; do not delete the data folder.`);

    const backup = `${DB}_legacy_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    await admin.query(`ALTER DATABASE "${DB}" RENAME TO "${backup}"`);
    try { await admin.query(CREATE_DATABASE); }
    catch (error) {
      try { await admin.query(`ALTER DATABASE "${backup}" RENAME TO "${DB}"`); }
      catch (restoreError) { log('postgres', `Original database retained as ${backup}; could not restore its name: ${restoreError.message}`); }
      throw error;
    }
    log('postgres', `Recovered failed first-run ${rows[0].encoding} database as UTF8; original retained as ${backup}`);
  } finally { await admin.end(); }
}

async function start({ dir, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, 'pgdata');
  const pwFile = path.join(dir, 'pg-password');
  let password;
  try { password = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* first run */ }
  if (!password) { password = crypto.randomBytes(18).toString('hex'); fs.writeFileSync(pwFile, password, { mode: 0o600 }); }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort(0);
  let lastMessages = '';
  const pgLog = (message) => { lastMessages = (lastMessages + String(message)).slice(-4000); log('postgres', message); };
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: USER, password, port, persistent: true,
    initdbFlags: INITDB_FLAGS,
    onLog: pgLog, onError: pgLog,
  });
  let started = false;
  try {
    if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
    await pg.start();
    started = true;
    await ensureDatabase(pg, log);
  } catch (error) {
    if (started) await pg.stop().catch((e) => log('postgres', `stop after failed start: ${e.message}`));
    if (/administrative permissions/.test(lastMessages)) throw new Error('PostgreSQL cannot run as administrator. Close Backlot and open it normally, without Run as administrator.');
    if (!error) throw new Error(`The database stopped before startup completed. ${lastMessages.slice(-1000)}`);
    throw error;
  }
  return {
    url: `postgres://${USER}:${password}@127.0.0.1:${port}/${DB}`,
    port,
    stop: async () => { try { await pg.stop(); } catch (e) { log('postgres', `stop: ${e.message}`); } },
  };
}

module.exports = { start, ensureDatabase, INITDB_FLAGS };

