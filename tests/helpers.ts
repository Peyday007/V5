/**
 * Shared harness. Every test file gets its own data root (see tests/setup.ts), so
 * these helpers can freely create projects, layers, documents and real files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { closeDatabase, initDatabase } from '../server/db/database.ts';
import { DATA_ROOT } from '../server/env.ts';
import { STALE_AFTER_MS } from './setup.ts';
import { registerSchemaCleanup, releaseTestSchemas } from './pgSchemas.ts';
import { seedDealDispatch } from '../server/seed.ts';
import { createDocument } from '../server/repos/documents.ts';
import { listLayers } from '../server/repos/layers.ts';
import { buildNames } from '../server/domain/naming.ts';
import { versionSortKey, waveForVersion } from '../server/domain/version.ts';
import { storeFile } from '../server/services/storage.ts';
import type { Document, DocumentType, Layer, Project } from '../server/domain/types.ts';

export interface TestProject {
  project: Project;
  layers: Layer[];
  layerByName(name: string): Promise<Layer>;
}

/**
 * Fresh database AND a fresh document tree. Both have to be reset together: the
 * project slug is stable, so leaving files behind would make the next test's
 * reconciliation see them as unregistered.
 */
/**
 * Where this run's tests keep their rows.
 *
 * With `BRAIN_TEST_DATABASE_URL` set, the whole suite runs against a real
 * Postgres instead of SQLite. That is the only way to find out whether one
 * repository layer over two backends is actually true: a mock proves the code
 * calls the adapter, and nothing else. Each test file gets its own schema,
 * because vitest runs files concurrently and they would otherwise share tables.
 */
const POSTGRES_URL = (process.env.BRAIN_TEST_DATABASE_URL ?? '').trim() || null;

export const testDatabaseKind: 'sqlite' | 'postgres' = POSTGRES_URL ? 'postgres' : 'sqlite';

/**
 * A second, independent connection to the database this file is using.
 *
 * Only for a test that has to prove something *about* concurrency, where going
 * through the app's pool cannot settle it: two pooled clients overlap or do not
 * depending on timing, and a race test that passes because the race did not
 * happen is worse than no test. Holding a real row lock from outside makes the
 * overlap a fact rather than a hope.
 *
 * Null on SQLite, which has one writer by construction — the finding this
 * exists for is reachable only under Postgres's READ COMMITTED.
 */
export function postgresTestConnection(): { connectionString: string; schema: string } | null {
  return POSTGRES_URL ? { connectionString: POSTGRES_URL, schema: schemaForThisFile() } : null;
}

/** One schema per test file, derived from the per-file data root vitest hands out. */
function schemaForThisFile(): string {
  const stem = path.basename(DATA_ROOT).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  return `brain_t_${stem}`.slice(0, 60);
}

/**
 * Where the database this file is using actually lives.
 *
 * Remembered so a test can *restart* against the same Brain rather than open a
 * different one. `initDatabase()` with no options resolves the configured
 * default, which is not the per-file scratch database these tests run on — so a
 * test that closed and re-opened that way was reading an empty Brain and
 * calling it a restart.
 */
let openedAs: { dbPath: string } | { schema: string } | null = null;

async function openTestDatabase(): Promise<void> {
  if (!POSTGRES_URL) {
    const dbPath = path.join(DATA_ROOT, `test-${Math.random().toString(36).slice(2)}.db`);
    openedAs = { dbPath };
    await initDatabase({ dbPath });
    return;
  }
  const schema = schemaForThisFile();
  const pg = await import('pg');
  const admin = new pg.default.Client({ connectionString: POSTGRES_URL });
  await admin.connect();
  try {
    /*
     * Dropped and recreated rather than truncated: the migrator has to run from
     * nothing every time, so the schema each test sees is the one the
     * migrations actually produce rather than one left over from a previous
     * run.
     *
     * **The drop matches nothing, and that is the leak.** `schemaForThisFile`
     * is derived from `DATA_ROOT`, which `setup.ts` makes with `mkdtemp` — a
     * fresh random name per file *per run*. So every run asks to drop a name no
     * run has ever used, creates ~150 tables under it, and leaves them there.
     * Measured on the local cluster: **648 schemas, 636 578 relations, 7.6 GB**,
     * from one machine's ordinary test runs.
     *
     * What it broke is not obvious from here, which is the point.
     * `storageHealth` asks `pg_database_size(current_database())` — a
     * **Postgres-only branch**, so SQLite never saw it — and that stats every
     * file in the database. `connectContract`'s storage reading calls it three
     * times and began timing out at 30 s; against a clean database on the same
     * cluster and the same commit it takes 1.4 s. It reproduced identically on
     * `origin/production`, because it was never about the code.
     *
     * `setup.ts` opens by describing this exact failure for the *filesystem*
     * root — "accumulates silently until the disk is full, and the failure it
     * produces then is a hundred unrelated tests failing … which looks like
     * anything except a leak here" — and gives it two mechanisms, a
     * self-tidy and a sweep, because a killed worker skips the first. The
     * schema derived from that root got neither. It has both now.
     */
    await sweepStaleSchemas(admin);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    /*
     * One transaction, so the sweeper can never see a schema without its
     * marker. Postgres DDL is transactional: the schema becomes visible at
     * COMMIT, by which point the row saying when it was made is already in it.
     * Without that the sweep would need a heuristic for "created seconds ago by
     * somebody still running", and a heuristic there drops a live sibling's
     * tables mid-test.
     */
    await admin.query('BEGIN');
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(
        `CREATE TABLE ${schema}.${MARKER_TABLE} (created_at timestamptz NOT NULL)`,
      );
      await admin.query(`INSERT INTO ${schema}.${MARKER_TABLE} (created_at) VALUES (now())`);
      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  } finally {
    await admin.end();
  }
  openedAs = { schema };
  registerSchemaCleanup(schema);
  await initDatabase({
    config: { provider: 'postgres', connectionString: POSTGRES_URL, poolSize: 4, schema },
  });
}


/* ------------------------------------------------------------------------- */
/* Not leaving a schema behind                                                */
/* ------------------------------------------------------------------------- */

/**
 * Says when this schema was made, so a sweep can tell a leak from a sibling.
 *
 * A table rather than a comment on the schema, because it is written inside the
 * same transaction that creates the schema and is therefore never absent from
 * one a sweeper can see. A schema with no marker is from before this existed —
 * or from a crash during creation, which the transaction now makes impossible.
 */
const MARKER_TABLE = '__brain_test_schema';

/**
 * How many to drop in one pass, from a measurement rather than a guess.
 *
 * `DROP SCHEMA … CASCADE` over one of these measured **0.94 s** on the local
 * cluster, against 667 relations. The first version of this allowed sixty, and
 * thirty-seven of them took the `beforeEach` hook past its 30 s timeout — which
 * reports as a test failure with nothing in it about schemas. The hook also has
 * to open the database and run seventy migrations, so the sweep gets a small
 * slice of that budget: five at a second each.
 *
 * It clears a backlog across a run rather than in one pass, which is the right
 * shape — roughly a hundred and sixty files run per suite, so a run can retire
 * eight hundred and the 648 that prompted this go in one.
 */
const SWEEP_LIMIT = 5;

/**
 * Whether this worker has already swept.
 *
 * `openTestDatabase` runs from `freshProject`, which suites call in
 * `beforeEach` — so without this a twenty-test file sweeps twenty times and
 * pays for it every time. Once per process is enough: the backlog is shared and
 * every other worker is sweeping too.
 */
let sweptThisProcess = false;

/**
 * Drop what earlier runs left behind, a bounded number at a time.
 *
 * `setup.ts`'s sweep is the half that actually holds, and this is its
 * counterpart: `process.on('exit')` does not fire for the signals vitest's pool
 * uses to stop a worker, so tidying up after ourselves cannot be the only
 * mechanism.
 *
 * Two things keep it from being its own problem. **An advisory lock**, taken
 * without blocking, so one process sweeps and every other one returns
 * immediately rather than all issuing the same drops at once. And a **limit**,
 * because the first run after this lands has hundreds of schemas to clear and a
 * `DROP SCHEMA … CASCADE` is not free — an unbounded pass would stall one
 * worker's hook past its timeout and report as a test failure somewhere
 * unrelated. `SWEEP_LIMIT` is **five**, measured rather than chosen: one drop
 * over 667 relations took 0.94 s here, and a limit of sixty blew the 30 s
 * `beforeEach` that was meant to be running a test.
 *
 * **`sweptThisProcess` is per *file*, not per run, and saying so matters.**
 * `vitest.config.ts` uses `pool: 'forks'` with isolation on, which gives each
 * test file a fresh child process — that is what the database singleton relies
 * on, and it also resets this flag. So a run with a backlog sweeps five a file
 * rather than five in total, which is what actually clears it: the pass is
 * self-limiting because the backlog shrinks, and on a clean database it costs
 * one listing query that finds nothing.
 *
 * Best-effort throughout: a sweep that cannot run is a leak to clean up later,
 * and never a reason to fail somebody's test.
 */
async function sweepStaleSchemas(admin: { query: (sql: string) => Promise<unknown> }): Promise<void> {
  if (sweptThisProcess) return;
  sweptThisProcess = true;
  try {
    const locked = (await admin.query(
      'SELECT pg_try_advisory_lock(7148238623) AS held',
    )) as { rows?: Array<{ held?: boolean }> };
    if (locked.rows?.[0]?.held !== true) return;
  } catch {
    return;
  }

  try {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    const listed = (await admin.query(
      `SELECT n.nspname AS name,
              (SELECT 1 FROM pg_class c
                WHERE c.relnamespace = n.oid AND c.relname = '${MARKER_TABLE}') AS marked
         FROM pg_namespace n
        WHERE n.nspname LIKE 'brain_t_%'
        ORDER BY n.nspname`,
    )) as { rows?: Array<{ name?: string; marked?: number | null }> };

    let dropped = 0;
    for (const row of listed.rows ?? []) {
      if (dropped >= SWEEP_LIMIT) break;
      const name = row.name;
      if (typeof name !== 'string' || !/^brain_t_[a-z0-9_]+$/.test(name)) continue;
      try {
        if (row.marked !== null && row.marked !== undefined) {
          const age = (await admin.query(
            `SELECT 1 FROM ${name}.${MARKER_TABLE} WHERE created_at > '${cutoff}'::timestamptz`,
          )) as { rows?: unknown[] };
          // Young enough that a sibling may still be running in it.
          if ((age.rows?.length ?? 0) > 0) continue;
        }
        await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
        dropped += 1;
      } catch {
        // Another worker dropping the same schema, or one being created. Not
        // this pass's problem; the next one will see whatever is left.
      }
    }
  } catch {
    /* best effort */
  } finally {
    try {
      await admin.query('SELECT pg_advisory_unlock(7148238623)');
    } catch {
      /* the connection is about to close, which releases it anyway */
    }
  }
}

/*
 * Tidying up after ourselves lives in `tests/pgSchemas.ts` now, and is
 * registered by `setup.ts` as a global `afterAll` beside the filesystem root's.
 *
 * It was here, called from `teardown()`, and that was the wrong place: 47 of
 * 169 test files call `teardown`. The other 122 leaked exactly as they had
 * before and the sweep carried all of them — and the sweep skips anything
 * younger than `STALE_AFTER_MS`, so it could not see a run's own leavings until
 * an hour after the run finished. `teardown` still calls it, because a file
 * that tears down explicitly should not have to wait for a hook.
 */

/**
 * Close this file's database and open the same one again.
 *
 * What a restart actually is, for a test that needs to prove something survives
 * one: the rows are still there and nothing was held in memory. Deliberately
 * not `freshProject`, which throws the rows away, and deliberately not a bare
 * `initDatabase()`, which opens a different database entirely.
 */
export async function restartDatabase(): Promise<void> {
  if (!openedAs) throw new Error('no test database has been opened to restart');
  await closeDatabase();
  if ('dbPath' in openedAs) {
    await initDatabase({ dbPath: openedAs.dbPath });
    return;
  }
  await initDatabase({
    config: {
      provider: 'postgres',
      connectionString: POSTGRES_URL!,
      poolSize: 4,
      schema: openedAs.schema,
    },
  });
}

export async function freshProject(): Promise<TestProject> {
  await closeDatabase();
  fs.rmSync(path.join(DATA_ROOT, 'projects'), { recursive: true, force: true });
  await openTestDatabase();
  const { project, layers } = await seedDealDispatch();
  return {
    project,
    layers,
    async layerByName(name: string): Promise<Layer> {
      const found = (await listLayers(project.id)).find((l) => l.name === name);
      if (!found) throw new Error(`No such layer in test fixture: ${name}`);
      return found;
    },
  };
}

export async function teardown(): Promise<void> {
  await closeDatabase();
  // The schema goes with the connection. Not required — the sweep reaches
  // anything a killed worker leaves — but a run that tidies up after itself is
  // one the sweep never has to catch up on.
  await releaseTestSchemas();
}

export interface AddDocumentOptions {
  documentType?: DocumentType;
  status?: Document['status'];
  /** Write a real file to disk and register its path/size/hash. */
  withFile?: boolean;
  contents?: string;
}

/**
 * Register a document for a layer the way the importer would, optionally writing
 * a real file so filesystem-sensitive code paths (invariants 8 and 9) are exercised.
 */
export async function addDocument(
  fixture: TestProject,
  layerName: string,
  version: string,
  options: AddDocumentOptions = {},
): Promise<Document> {
  const layer = await fixture.layerByName(layerName);
  const names = buildNames(layer.name, version);
  const withFile = options.withFile ?? true;

  let filesystemPath: string | null = null;
  let fileSize: number | null = null;
  let fileHash: string | null = null;
  if (withFile) {
    const stored = await storeFile({
      projectSlug: fixture.project.slug,
      layerSlug: layer.slug,
      filename: names.filename,
      contents: Buffer.from(options.contents ?? `${names.canonicalName} contents`),
    });
    filesystemPath = stored.relativePath;
    fileSize = stored.size;
    fileHash = stored.hash;
  }

  return await createDocument({
    projectId: fixture.project.id,
    layerId: layer.id,
    canonicalName: names.canonicalName,
    version,
    versionSort: versionSortKey(version),
    wave: waveForVersion(version, fixture.project.versionPolicy),
    documentType: options.documentType ?? 'EXPANSION',
    status: options.status ?? 'COMPLETE',
    filename: names.filename,
    filesystemPath,
    fileSize,
    fileHash,
    conversationTitle: names.conversationTitle,
    importedAt: new Date().toISOString(),
  });
}

/** Simulate the user deleting a file behind the platform's back. */
export function deletePhysicalFile(document: Document): void {
  if (!document.filesystemPath) throw new Error('Document has no file to delete');
  fs.rmSync(path.resolve(DATA_ROOT, document.filesystemPath), { force: true });
}

export function readDataFile(relativePath: string): Buffer {
  return fs.readFileSync(path.resolve(DATA_ROOT, relativePath));
}
