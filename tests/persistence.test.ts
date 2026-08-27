/**
 * Which database and which store, and what happens when the answer is wrong.
 *
 * The whole point of Step 3 is that Brain's state can live somewhere other than
 * one laptop. The risk that comes with it is subtler than an outage: a server
 * that was asked for the cloud, could not reach it, and quietly kept working
 * locally. It would look healthy. It would accept research. Nobody would find
 * out until they went looking for the work from somewhere else.
 *
 * So the rule these tests hold to is narrow and absolute — configuration is a
 * request, not a fact, and Brain either proves it or refuses to start.
 *
 * The Postgres tests here run only when BRAIN_TEST_DATABASE_URL is set. When it
 * is, the whole suite runs against Postgres, and these add the cases that are
 * specifically about the backend rather than about the domain.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { databaseConfig, storageConfig, describePersistence } from '../server/config.ts';
import { PROJECT_STATE_FILE } from '../server/env.ts';
import { DatabaseConfigurationError } from '../server/db/types.ts';
import { initDatabase, closeDatabase, getDb } from '../server/db/database.ts';
import { toPostgresSql, splitStatements } from '../server/db/dialect.ts';

const POSTGRES_URL = (process.env.BRAIN_TEST_DATABASE_URL ?? '').trim() || null;
const onPostgres = POSTGRES_URL ? describe : describe.skip;

const ENV_KEYS = [
  'BRAIN_DATABASE_PROVIDER',
  'BRAIN_DATABASE_URL',
  'BRAIN_DATABASE_POOL_SIZE',
  'BRAIN_STORAGE_PROVIDER',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BRAIN_STORAGE_BUCKET',
] as const;

let saved: Record<string, string | undefined>;
let root: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-persist-'));
});

afterEach(async () => {
  await closeDatabase();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Choosing a backend
// ---------------------------------------------------------------------------

describe('choosing a database', () => {
  it('defaults to SQLite, so an ordinary local install needs no configuration', () => {
    expect(databaseConfig()).toEqual({ provider: 'sqlite', connectionString: null, poolSize: 1 });
    expect(storageConfig().provider).toBe('local');
  });

  it('refuses a provider name it does not implement instead of guessing', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'mysql';
    expect(() => databaseConfig()).toThrow(/not one of: sqlite, postgres/i);

    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    process.env.BRAIN_DATABASE_URL = 'postgresql://u:p@h:5432/d';
    expect(databaseConfig().provider).toBe('postgres');
  });

  it('accepts the provider name whatever case it was written in', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'POSTGRES';
    process.env.BRAIN_DATABASE_URL = 'postgresql://u:p@h:5432/d';
    expect(databaseConfig().provider).toBe('postgres');
  });

  it('will not start in Postgres mode with no connection string, and says it will not fall back', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    let thrown: DatabaseConfigurationError | null = null;
    try {
      databaseConfig();
    } catch (error) {
      thrown = error as DatabaseConfigurationError;
    }
    expect(thrown).toBeInstanceOf(DatabaseConfigurationError);
    expect(thrown!.message).toMatch(/BRAIN_DATABASE_URL is not set/i);
    expect(thrown!.detail).toMatch(/will not fall back/i);
  });

  it('rejects a malformed connection string without repeating it', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    process.env.BRAIN_DATABASE_URL = 'this is not a url';
    try {
      databaseConfig();
      throw new Error('expected a refusal');
    } catch (error) {
      const e = error as DatabaseConfigurationError;
      expect(e.message).toMatch(/not a valid connection URL/i);
      // The value holds a password, so it is described, never echoed.
      expect(`${e.message} ${e.detail}`).not.toContain('this is not a url');
    }
  });

  it('rejects a connection string for something that is not Postgres', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    process.env.BRAIN_DATABASE_URL = 'mysql://u:p@h:3306/d';
    expect(() => databaseConfig()).toThrow(/scheme, not postgres/i);
  });

  it('bounds the pool rather than accepting a value that would exhaust the server', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    process.env.BRAIN_DATABASE_URL = 'postgresql://u:p@h:5432/d';
    for (const bad of ['0', '-1', '1000', 'ten', '2.5']) {
      process.env.BRAIN_DATABASE_POOL_SIZE = bad;
      expect(() => databaseConfig(), bad).toThrow(/whole number between 1 and 100/i);
    }
    process.env.BRAIN_DATABASE_POOL_SIZE = '20';
    expect(databaseConfig().poolSize).toBe(20);
  });
});

describe('choosing a document store', () => {
  it('requires every Supabase setting before it will claim to be cloud-backed', () => {
    process.env.BRAIN_STORAGE_PROVIDER = 'supabase';
    expect(() => storageConfig()).toThrow();

    process.env.SUPABASE_URL = 'https://example.supabase.co';
    expect(() => storageConfig()).toThrow();

    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    expect(() => storageConfig()).toThrow();

    process.env.BRAIN_STORAGE_BUCKET = 'brain';
    expect(storageConfig()).toEqual({
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'k',
      bucket: 'brain',
    });
  });

  it('will not send a service-role key over plain http', () => {
    process.env.BRAIN_STORAGE_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = 'http://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
    process.env.BRAIN_STORAGE_BUCKET = 'brain';
    expect(() => storageConfig()).toThrow(/https/i);
  });
});

// ---------------------------------------------------------------------------
// What may be said out loud
// ---------------------------------------------------------------------------

describe('what a diagnostic is allowed to contain', () => {
  it('describes the connection without the password, and the bucket without the key', () => {
    process.env.BRAIN_DATABASE_PROVIDER = 'postgres';
    process.env.BRAIN_DATABASE_URL = 'postgresql://brain:hunter2@db.example.com:5432/braindb';
    process.env.BRAIN_STORAGE_PROVIDER = 'supabase';
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sbp_service_role_secret';
    process.env.BRAIN_STORAGE_BUCKET = 'brain';

    const described = describePersistence({
      database: databaseConfig(),
      storage: storageConfig(),
    });
    const rendered = JSON.stringify(described);

    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('sbp_service_role_secret');
    // And it still says enough for an operator to recognise where they are.
    expect(rendered).toContain('db.example.com');
    expect(rendered).toContain('brain');
  });
});

// ---------------------------------------------------------------------------
// Dialect translation
// ---------------------------------------------------------------------------

describe('translating one dialect into the other', () => {
  it('numbers placeholders in order', () => {
    const { sql, placeholders } = toPostgresSql(
      'SELECT * FROM documents WHERE project_id = ? AND version = ? LIMIT ?',
    );
    expect(sql).toBe('SELECT * FROM documents WHERE project_id = $1 AND version = $2 LIMIT $3');
    expect(placeholders).toBe(3);
  });

  it('leaves a question mark inside a string, an identifier or a comment alone', () => {
    expect(toPostgresSql("SELECT 'is it? yes' AS a WHERE x = ?").sql).toBe(
      "SELECT 'is it? yes' AS a WHERE x = $1",
    );
    expect(toPostgresSql('SELECT "odd?name" FROM t WHERE x = ?').sql).toBe(
      'SELECT "odd?name" FROM t WHERE x = $1',
    );
    expect(toPostgresSql('SELECT 1 -- really? \nWHERE x = ?').sql).toContain('$1');
    expect(toPostgresSql('SELECT 1 /* ? */ WHERE x = ?').sql).toContain('$1');
    // The one inside the comment is not counted, so the numbering stays right.
    expect(toPostgresSql('SELECT 1 /* ? */ WHERE x = ?').placeholders).toBe(1);
  });

  it('maps rowid onto the identity column that stands in for it', () => {
    expect(toPostgresSql('SELECT * FROM t ORDER BY created_at, rowid DESC').sql).toBe(
      'SELECT * FROM t ORDER BY created_at, seq DESC',
    );
    // Only the whole word: a column that merely contains it is untouched.
    expect(toPostgresSql('SELECT parent_rowid_ref FROM t').sql).toBe(
      'SELECT parent_rowid_ref FROM t',
    );
  });

  it('splits a migration script into statements without breaking on a semicolon in a string', () => {
    const statements = splitStatements(
      "CREATE TABLE a (x text DEFAULT 'a;b'); -- note;\nCREATE INDEX i ON a (x);",
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'a;b'");
    expect(statements[1]).toContain('CREATE INDEX');
  });
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

describe('migrations', () => {
  it('applies in order and records where it got to', async () => {
    const { migrations } = await initDatabase({ dbPath: path.join(root, 'brain.db') });
    expect(migrations.applied.length).toBeGreaterThan(0);

    const rows = await getDb().all<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    const versions = rows.map((r) => r.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('does not reapply on a second boot against the same database', async () => {
    const dbPath = path.join(root, 'brain.db');
    const first = await initDatabase({ dbPath });
    const appliedFirst = first.migrations.applied.length;
    expect(appliedFirst).toBeGreaterThan(0);
    await closeDatabase();

    const second = await initDatabase({ dbPath });
    expect(second.migrations.applied).toHaveLength(0);
    expect(second.migrations.alreadyApplied).toBe(appliedFirst);
  });

  it('refuses to boot if an applied migration was edited after the fact', async () => {
    const dbPath = path.join(root, 'brain.db');
    await initDatabase({ dbPath });
    await getDb().run("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");
    await closeDatabase();

    await expect(initDatabase({ dbPath })).rejects.toThrow(/checksum|changed|edited/i);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('a transaction', () => {
  beforeEach(async () => {
    await initDatabase({ dbPath: path.join(root, 'brain.db') });
    await getDb().exec('CREATE TABLE tx_probe (id text PRIMARY KEY, note text)');
  });

  it('commits everything or nothing', async () => {
    const db = getDb();
    await expect(
      db.transaction(async () => {
        await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', ['a', 'first']);
        await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', ['b', 'second']);
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    expect(await db.all('SELECT * FROM tx_probe')).toHaveLength(0);
  });

  it('rolls a nested failure back to its savepoint without losing the outer work', async () => {
    const db = getDb();
    await db.transaction(async () => {
      await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', ['outer', 'kept']);
      await db
        .transaction(async () => {
          await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', ['inner', 'discarded']);
          throw new Error('inner failed');
        })
        .catch(() => undefined);
    });

    const rows = await db.all<{ id: string }>('SELECT id FROM tx_probe ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['outer']);
  });

  it('keeps concurrent siblings from releasing each other savepoints', async () => {
    // This is the failure the per-frame savepoint naming exists to prevent:
    // with a shared counter, two nested transactions running at once inside one
    // parent produced "no such savepoint" and lost writes.
    const db = getDb();
    await db.transaction(async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          db.transaction(async () => {
            await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', [`s${i}`, 'sibling']);
          }),
        ),
      );
    });

    expect(await db.all('SELECT * FROM tx_probe')).toHaveLength(8);
  });

  it('does not commit a failed sibling while keeping the successful ones', async () => {
    const db = getDb();
    await db.transaction(async () => {
      await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          db
            .transaction(async () => {
              await db.run('INSERT INTO tx_probe (id, note) VALUES (?, ?)', [`m${i}`, 'x']);
              if (i % 2 === 0) throw new Error(`sibling ${i} failed`);
            })
            .catch(() => undefined),
        ),
      );
    });

    const rows = await db.all<{ id: string }>('SELECT id FROM tx_probe ORDER BY id');
    expect(rows.map((r) => r.id)).toEqual(['m1', 'm3', 'm5']);
  });
});

// ---------------------------------------------------------------------------
// The derived snapshot
// ---------------------------------------------------------------------------

describe('the local runtime snapshot', () => {
  it('is written in local mode, where it is a convenience worth having', async () => {
    // Closed first, deliberately. `initDatabase` returns the open database when
    // there is one, so a test that needs a *particular* configuration has to
    // start from nothing rather than inherit whatever the last test opened.
    await closeDatabase();
    await initDatabase({ dbPath: path.join(root, 'brain.db') });
    const { seedDealDispatch } = await import('../server/seed.ts');
    const { project } = await seedDealDispatch();
    const { writeProjectState, readProjectState, writesRuntimeSnapshot } = await import(
      '../server/services/runtimeState.ts'
    );

    expect(writesRuntimeSnapshot()).toBe(true);
    const written = await writeProjectState(project.id);
    expect(written.project.id).toBe(project.id);
    expect(fs.existsSync(PROJECT_STATE_FILE)).toBe(true);
    expect(readProjectState()?.project.id).toBe(project.id);
  });

  onPostgres('in cloud mode', () => {
    beforeEach(async () => {
      await closeDatabase();
      const schema = 'brain_snapshot_probe';
      const pg = await import('pg');
      const admin = new pg.default.Client({ connectionString: POSTGRES_URL! });
      await admin.connect();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.query(`CREATE SCHEMA ${schema}`);
      } finally {
        await admin.end();
      }
      await initDatabase({
        config: { provider: 'postgres', connectionString: POSTGRES_URL!, poolSize: 4, schema },
      });
      // An earlier local-mode test in this file wrote one. Cloud mode must be
      // judged on whether it creates the file, not on whether one exists.
      fs.rmSync(PROJECT_STATE_FILE, { force: true });
    });

    it('is not written at all, because instance-local state cannot describe shared truth', async () => {
      const { seedDealDispatch } = await import('../server/seed.ts');
      const { project } = await seedDealDispatch();
      const { writeProjectState, writesRuntimeSnapshot } = await import(
        '../server/services/runtimeState.ts'
      );

      expect(writesRuntimeSnapshot()).toBe(false);
      // The derived view is still built and returned — callers lose nothing.
      const state = await writeProjectState(project.id);
      expect(state.project.id).toBe(project.id);
      expect(state.layers.length).toBeGreaterThan(0);
      // It just does not become a file on this particular machine.
      expect(fs.existsSync(PROJECT_STATE_FILE)).toBe(false);
    });

    it('cannot change cloud truth, however hostile the file on this disk is', async () => {
      const { seedDealDispatch } = await import('../server/seed.ts');
      const { project } = await seedDealDispatch();
      const { readProjectState, writeProjectState } = await import(
        '../server/services/runtimeState.ts'
      );

      // Plant a file claiming a different project, in a different state. This is
      // the leftover-from-an-earlier-local-run case, and the tampering case.
      fs.mkdirSync(path.dirname(PROJECT_STATE_FILE), { recursive: true });
      fs.writeFileSync(
        PROJECT_STATE_FILE,
        JSON.stringify({
          generatedAt: '1999-01-01T00:00:00.000Z',
          project: { id: 'prj_not_real', slug: 'lies', name: 'Lies', status: 'FROZEN' },
          layers: [{ layerId: 'lyr_lies', status: 'FROZEN' }],
          nextBestAction: 'nothing to do',
        }),
      );

      // It is not read.
      expect(readProjectState()).toBeNull();

      // And the state Brain derives comes from the database regardless.
      const state = await writeProjectState(project.id);
      expect(state.project.id).toBe(project.id);
      expect(state.project.name).not.toBe('Lies');
      expect(state.layers.some((l) => l.status === 'FROZEN')).toBe(false);

      // The planted file is left alone rather than silently rewritten: cloud
      // mode does not own this path, so it does not touch it.
      const planted = JSON.parse(fs.readFileSync(PROJECT_STATE_FILE, 'utf8'));
      expect(planted.project.id).toBe('prj_not_real');
    });
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

onPostgres('against a real Postgres', () => {
  // Its own schema, dropped and recreated, so the migrator runs from nothing and
  // these tests see the schema the migrations actually produce.
  beforeEach(async () => {
    await closeDatabase();
    const schema = 'brain_persist_probe';
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: POSTGRES_URL! });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.query(`CREATE SCHEMA ${schema}`);
    } finally {
      await admin.end();
    }
    await initDatabase({
      config: { provider: 'postgres', connectionString: POSTGRES_URL!, poolSize: 4, schema },
    });
  });

  it('refuses to open a database that is not there, rather than falling back', async () => {
    await closeDatabase();
    await expect(
      initDatabase({
        config: {
          provider: 'postgres',
          connectionString: 'postgresql://postgres@127.0.0.1:1/none',
          poolSize: 1,
        },
      }),
    ).rejects.toBeInstanceOf(DatabaseConfigurationError);

    // And nothing was written locally in its place.
    expect(fs.existsSync(path.join(root, 'brain.db'))).toBe(false);
  });

  it('names the host it could not reach, and not the password', async () => {
    await closeDatabase();
    try {
      await initDatabase({
        config: {
          provider: 'postgres',
          connectionString: 'postgresql://brain:hunter2@127.0.0.1:1/none',
          poolSize: 1,
        },
      });
      throw new Error('expected a refusal');
    } catch (error) {
      const e = error as DatabaseConfigurationError;
      const text = `${e.message} ${e.detail ?? ''}`;
      expect(text).toContain('127.0.0.1');
      expect(text).not.toContain('hunter2');
    }
  });

  it('arrives at the same tables the local chain arrives at', async () => {
    // The cloud baseline is generated from the SQLite schema so the two cannot
    // drift; this is the check that the generation actually held.
    const pgTables = (
      await getDb().all<{ name: string }>(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
      )
    )
      .map((r) => r.name)
      .filter((n) => n !== 'schema_migrations')
      .sort();

    expect(pgTables.length).toBeGreaterThan(30);
    // Every table the repositories read from is present under the same name.
    for (const expected of [
      'projects',
      'layers',
      'documents',
      'project_events',
      'audits',
      'audit_gaps',
      'extraction_runs',
      'document_blocks',
      'document_chunks',
      'research_orchestrations',
      'research_fragments',
      'research_passes',
      'research_claims',
      'work_items',
      'work_leases',
    ]) {
      expect(pgTables, expected).toContain(expected);
    }
  });

  it('refuses the same second row the local chain refuses', async () => {
    // Found by inspection at the start of Step 4, and the reason this test
    // exists: the generator that produced the cloud baseline walked columns and
    // foreign keys and never emitted uniqueness, so `projects.slug`,
    // `layers (project_id, slug)` and `documents (project_id, canonical_name)`
    // were enforced locally and not in the cloud. Comparing table *names* — which
    // is all the check above this one did — could never have caught it.
    //
    // `users.email` and `worker_credentials.prefix` are on the same list now,
    // and they are the ones that would matter most: two rows where
    // authentication expects one means "which principal is this" has two
    // answers, and an ambiguous principal is not a principal.
    const uniques = (
      await getDb().all<{ table_name: string; columns: string }>(
        `SELECT c.relname AS table_name,
                array_to_string(array(
                  SELECT a.attname FROM unnest(ix.indkey) k
                   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k
                ), ',') AS columns
           FROM pg_index ix
           JOIN pg_class c ON c.oid = ix.indrelid
           JOIN pg_class i ON i.oid = ix.indexrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND ix.indisunique AND i.relname LIKE 'uq_%'`,
      )
    )
      .map((row) => `${row.table_name}(${row.columns})`)
      .sort();

    expect(uniques).toEqual(
      [
        'documents(project_id,canonical_name)',
        'layers(project_id,slug)',
        'project_memberships(project_id,principal_type,principal_id)',
        'projects(slug)',
        'user_sessions(token_verifier)',
        'users(email)',
        'worker_credentials(prefix)',
        'workers(name)',
        // Step 5. This one is not bookkeeping: it is the statement that a
        // fencing generation is issued exactly once per work item. If the
        // claim logic above it were wrong and two workers both believed they
        // had won, the second insert would fail rather than produce two owners.
        'work_leases(work_item_id,lease_generation)',
      ].sort(),
    );
  });

  it('hands back numbers where SQLite hands back numbers', async () => {
    const db = getDb();
    // int8, numeric and float8 would otherwise arrive as strings, and every
    // repository was written once, against one set of expectations.
    const row = await db.get<{ big: number; exact: number; approx: number }>(
      'SELECT 9007199254740::bigint AS big, 0.8::numeric AS exact, 0.8::float8 AS approx',
    );
    expect(typeof row!.big).toBe('number');
    expect(typeof row!.exact).toBe('number');
    expect(typeof row!.approx).toBe('number');
    expect(row!.approx).toBeCloseTo(0.8);
  });

  it('stores a timestamp as the string it was given, unchanged', async () => {
    const db = getDb();
    await db.exec('CREATE TABLE IF NOT EXISTS ts_probe (id text PRIMARY KEY, at text)');
    const at = '2026-08-24T10:11:12.345Z';
    await db.run('INSERT INTO ts_probe (id, at) VALUES (?, ?)', ['a', at]);
    const row = await db.get<{ at: string }>('SELECT at FROM ts_probe WHERE id = ?', ['a']);
    // Not re-interpreted through a timestamptz on the way in or out.
    expect(row!.at).toBe(at);
    await db.exec('DROP TABLE ts_probe');
  });
});
