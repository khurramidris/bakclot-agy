// Real embedded-Postgres regression: reproduce a Windows-style WIN1252 first-run crash,
// recover it, apply the actual engine migrations, and round-trip Unicode on restart.
// Run as a normal user (Postgres refuses root): npm run test:database
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { start, ensureDatabase } = require('../lib/postgres.cjs');
const { freePort } = require('../lib/util.cjs');

const engineDir = path.resolve(__dirname, '../../engine');
const query = async (pg, db, text, values) => {
  const c = pg.getPgClient(db, '127.0.0.1');
  try { await c.connect(); return await c.query(text, values); } finally { await c.end(); }
};
function migrate(url, expectFailure = false) {
  const script = `const { migrate, sql } = await import('./dist/db.js');
    try { await migrate(); if (${expectFailure}) throw new Error('expected WIN1252 to reject Unicode'); }
    catch (e) { if (!${expectFailure} || e.code !== '22P05') throw e; console.log('reproduced 22P05'); }
    finally { await sql.end(); }`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: engineDir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, DATABASE_URL: url, MOCK_PROVIDERS: '1', ALLOW_DEV_TOKENS: '1', NODE_ENV: 'test' },
  });
}

async function run() {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlot-encoding-'));
  const log = (_tag, msg) => { if (String(msg).startsWith('Recovered')) console.log(msg); };
  let pg, desktop;
  try {
    const port = await freePort(0);
    pg = new EmbeddedPostgres({ databaseDir: path.join(root, 'legacy'), user: 'backlot', password: 'test-only', port,
      persistent: true, initdbFlags: ['--encoding=WIN1252', '--locale=C'],
      onLog: (m) => console.log('[postgres test]', m), onError: (m) => console.error('[postgres test]', m) });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('backlot');
    const url = `postgres://backlot:test-only@127.0.0.1:${port}/backlot`;
    assert.match(migrate(url, true), /reproduced 22P05/);
    await ensureDatabase(pg, log);
    const backups = await query(pg, 'postgres', "SELECT datname FROM pg_database WHERE datname LIKE 'backlot_legacy_%'");
    assert.equal(backups.rows.length, 1, 'the original database remains available');
    assert.equal((await query(pg, 'backlot', 'SHOW server_encoding')).rows[0].server_encoding, 'UTF8');
    migrate(url);
    assert.equal((await query(pg, 'backlot', 'SELECT count(*)::int n FROM schema_migrations')).rows[0].n, 7);
    const sample = 'Backlot ─ اردو 🎬';
    await query(pg, 'backlot', 'CREATE TABLE unicode_check (value text)');
    await query(pg, 'backlot', 'INSERT INTO unicode_check VALUES ($1)', [sample]);
    assert.equal((await query(pg, 'backlot', 'SELECT value FROM unicode_check')).rows[0].value, sample);
    console.log('PASS: WIN1252 startup failure recovered; real migrations and Unicode writes work');

    await query(pg, 'postgres', 'ALTER DATABASE backlot RENAME TO utf8_saved');
    await pg.createDatabase('backlot'); // inherits legacy WIN1252 template
    await query(pg, 'backlot', 'CREATE TABLE saved_work (value text)');
    await query(pg, 'backlot', "INSERT INTO saved_work VALUES ('keep this film')");
    await assert.rejects(ensureDatabase(pg, log), /existing data/);
    assert.equal((await query(pg, 'backlot', 'SELECT value FROM saved_work')).rows[0].value, 'keep this film');
    console.log('PASS: populated legacy database remains unchanged');
    await pg.stop(); pg = null;

    const dir = path.join(root, 'fresh');
    desktop = await start({ dir, log });
    const { Client } = require('pg');
    const fresh = new Client(desktop.url);
    try {
      await fresh.connect();
      assert.equal((await fresh.query('SHOW server_encoding')).rows[0].server_encoding, 'UTF8');
      await fresh.query('CREATE TABLE saved_work (value text)');
      await fresh.query('INSERT INTO saved_work VALUES ($1)', [sample]);
    } finally { await fresh.end(); }
    await desktop.stop(); desktop = null;
    desktop = await start({ dir, log });
    const again = new Client(desktop.url);
    try {
      await again.connect();
      assert.equal((await again.query('SELECT value FROM saved_work')).rows[0].value, sample);
    } finally { await again.end(); }
    console.log('PASS: fresh desktop database uses UTF8 and saved work survives restart');
  } finally {
    if (desktop) await desktop.stop();
    if (pg) await pg.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
// Keep a watchdog alive: an unexpectedly exited native process must not make Node silently
// exit successfully with an unresolved startup promise.
const watchdog = setTimeout(() => { console.error('Database regression did not finish'); process.exit(1); }, 120_000);
run().then(() => { clearTimeout(watchdog); console.log('DATABASE REGRESSION OK'); process.exit(0); }, (e) => { clearTimeout(watchdog); console.error(e); process.exit(1); });
