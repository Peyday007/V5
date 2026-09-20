/**
 * The harness must not leak a Postgres schema, and the reading that says so.
 *
 * This is a test about the tests, which is unusual and is here because the leak
 * it pins cost a real gate. `schemaForThisFile()` is derived from `DATA_ROOT`,
 * which `setup.ts` makes with `mkdtemp` — a fresh random name per file per run
 * — so the `DROP SCHEMA IF EXISTS` at the top of the next run matched a name no
 * run had ever used. Measured on one machine's ordinary runs: **648 schemas,
 * 636 578 relations, 7.6 GB**, and the only test that notices is the one that
 * calls `pg_database_size`, which stats every file in the database.
 *
 * Two assertions, and the first is the one no behavioural test can make.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { freshProject, postgresTestConnection, teardown } from './helpers.ts';
import { registerSchemaCleanup, releaseTestSchemas } from './pgSchemas.ts';

describe('the test harness does not leak a Postgres schema', () => {
  /*
   * Something calls it, and it is *not* `teardown()`.
   *
   * The first correction put the drop in `helpers.ts`'s `teardown()`. 47 of the
   * 169 test files call that; the other 122 leaked exactly as they had before,
   * and the sweep skips anything younger than `STALE_AFTER_MS`, so a run's own
   * leavings were invisible to it for an hour. Measured: two files that call no
   * `teardown` left the database with two more schemas than it started with,
   * and with the hook registered they left it with exactly as many.
   *
   * Asserted against the source, because a suite proving the hook works has to
   * run inside a run that already has it.
   */
  it('registers the release as a global hook every file gets, not an opt-in', () => {
    const setup = fs.readFileSync(path.join(process.cwd(), 'tests/setup.ts'), 'utf8');
    expect(setup).toContain("from './pgSchemas.ts'");
    expect(setup).toMatch(/afterAll\(async \(\) => \{\s*await releaseTestSchemas\(\);/);

    // And the filesystem root's two mechanisms are still both there, because
    // this is the symmetry the schema side was missing rather than a
    // replacement for it.
    expect(setup).toContain("process.on('exit', removeOwnRoot)");
    expect(setup).toContain('SIGINT');
  });

  /*
   * First, and the order is the assertion.
   *
   * `releaseTestSchemas` drops everything the *process* registered, and
   * `openTestDatabase` registers this file's own schema the moment anything
   * opens a database. A release test running after one would drop the schema
   * it is still standing on, and pass only because nothing came after it —
   * a fixture destroyed by luck rather than a test.
   */
  it('drops a schema it registered, and says nothing when there is none', async () => {
    const postgres = postgresTestConnection();
    if (!postgres) return;
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: postgres.connectionString });
    await admin.connect();
    // A name of the harness's own shape, so the release's own guard admits it.
    const scratch = `brain_t_leakcheck_${Math.random().toString(36).slice(2, 10)}`;
    try {
      await admin.query(`CREATE SCHEMA ${scratch}`);
      registerSchemaCleanup(scratch);
      await releaseTestSchemas();

      const left = await admin.query(
        'SELECT 1 FROM information_schema.schemata WHERE schema_name = $1',
        [scratch],
      );
      expect(left.rowCount).toBe(0);

      // Idempotent: a second release with nothing registered is a no-op rather
      // than an error, because it runs from a global hook on every file.
      await expect(releaseTestSchemas()).resolves.toBeUndefined();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${scratch} CASCADE`).catch(() => undefined);
      await admin.end();
    }
  });

  /*
   * The marker is what lets a sweep tell a leak from a live sibling, and it has
   * to be created in the same transaction as the schema: Postgres DDL is
   * transactional, so the schema becomes visible at COMMIT with the row already
   * in it. Without that, a sweep would need a heuristic for "made seconds ago
   * by somebody still running", and a heuristic there drops a running file's
   * tables out from under it.
   */
  it('creates every schema with the marker a sweep ages it by', async () => {
    const postgres = postgresTestConnection();
    if (!postgres) return;
    // Open one the ordinary way first: the name exists before anything is
    // created under it, so asking about the schema without opening a database
    // would be asking about nothing.
    await freshProject();
    const pg = await import('pg');
    const admin = new pg.default.Client({ connectionString: postgres.connectionString });
    await admin.connect();
    try {
      const marked = await admin.query(
        `SELECT n.nspname AS name,
                EXISTS (SELECT 1 FROM pg_class c
                         WHERE c.relnamespace = n.oid AND c.relname = '__brain_test_schema') AS marked
           FROM pg_namespace n
          WHERE n.nspname = $1`,
        [postgres.schema],
      );
      expect(marked.rows[0]?.marked).toBe(true);
    } finally {
      await admin.end();
    }
  });

  it('leaves this file\'s own database closable', async () => {
    await teardown();
  });
});
