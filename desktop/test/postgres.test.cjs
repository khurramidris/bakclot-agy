const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureDatabase, INITDB_FLAGS } = require('../lib/postgres.cjs');
const { waitFor } = require('../lib/util.cjs');

function fakePg({ encoding, tables = [], applied = [], failCreate = false }) {
  const calls = [];
  return {
    calls,
    getPgClient(db, host) {
      assert.equal(host, '127.0.0.1');
      return {
        connect: async () => {}, end: async () => { calls.push(`end:${db}`); },
        query: async (text) => {
          calls.push(text);
          if (text.includes('FROM pg_database')) return { rows: encoding ? [{ encoding }] : [] };
          if (text.includes('FROM pg_class')) return { rows: tables };
          if (text.includes('FROM public.schema_migrations')) return { rows: applied };
          if (text.startsWith('CREATE DATABASE') && failCreate) throw new Error('create failed');
          return { rows: [] };
        },
      };
    },
  };
}

test('new clusters and databases explicitly use UTF8 regardless of the Windows locale', async () => {
  assert.ok(INITDB_FLAGS.includes('--encoding=UTF8'));
  assert.ok(INITDB_FLAGS.includes('--locale=C'));
  const pg = fakePg({});
  await ensureDatabase(pg, () => {});
  assert.ok(pg.calls.some((s) => s.startsWith('CREATE DATABASE') && s.includes("ENCODING 'UTF8'") && s.includes('TEMPLATE template0')));
});

test('an existing UTF8 database is kept without re-creation', async () => {
  const pg = fakePg({ encoding: 'UTF8' });
  await ensureDatabase(pg, () => {});
  assert.ok(!pg.calls.some((s) => /^(CREATE|ALTER|DROP)/.test(s)));
});

test('a failed first migration is recovered with its original database retained', async () => {
  const pg = fakePg({ encoding: 'WIN1252', tables: [{ nspname: 'public', relname: 'schema_migrations' }] });
  const logs = [];
  await ensureDatabase(pg, (_tag, message) => logs.push(message));
  const rename = pg.calls.findIndex((s) => s.startsWith('ALTER DATABASE'));
  const create = pg.calls.findIndex((s) => s.startsWith('CREATE DATABASE'));
  assert.ok(rename > pg.calls.indexOf('end:backlot'), 'close the old database before renaming it');
  assert.ok(create > rename);
  assert.match(logs[0], /original retained as backlot_legacy_/);
  assert.ok(!pg.calls.some((s) => s.startsWith('DROP')));
});

test('legacy databases with saved tables or migration history are never replaced', async () => {
  for (const state of [
    { tables: [{ nspname: 'public', relname: 'projects' }] },
    { tables: [{ nspname: 'public', relname: 'schema_migrations' }], applied: [{}] },
  ]) {
    const pg = fakePg({ encoding: 'WIN1252', ...state });
    await assert.rejects(ensureDatabase(pg, () => {}), /existing data.*kept/);
    assert.ok(!pg.calls.some((s) => /^(CREATE|ALTER|DROP)/.test(s)));
    assert.ok(pg.calls.includes('end:postgres'));
    assert.ok(pg.calls.includes('end:backlot'));
  }
});

test('failed UTF8 creation restores the original database name', async () => {
  const pg = fakePg({ encoding: 'WIN1252', failCreate: true });
  await assert.rejects(ensureDatabase(pg, () => {}), /create failed/);
  const renames = pg.calls.filter((s) => s.startsWith('ALTER DATABASE'));
  assert.equal(renames.length, 2);
  assert.match(renames[1], /RENAME TO "backlot"$/);
});

test('startup stops waiting immediately when the engine has exited', async () => {
  let calls = 0;
  await assert.rejects(waitFor(() => { calls++; throw new Error('engine stopped'); }, { failFast: true }), /engine stopped/);
  assert.equal(calls, 1);
});
