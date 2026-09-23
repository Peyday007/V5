/**
 * Opening the database Brain was configured to use, and proving it works.
 *
 * `getDb()` is the only way anything above this file reaches storage, and it
 * hands back the same interface whichever backend answered. What changes
 * between local and cloud is decided once, here, at boot.
 *
 * The one behaviour worth stating plainly: cloud mode never degrades into local
 * mode. If Postgres was asked for and cannot be reached, boot fails with the
 * reason. A server that fell back would keep working, keep accepting research,
 * and keep writing it somewhere nobody else could see — and the failure would
 * only surface later, as missing work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH, ensureDataDirs } from '../env.ts';
import { databaseConfig, type DatabaseConfig } from '../config.ts';
import { openSqlite } from './adapters/sqlite.ts';
import {
  PostgresAdapter,
  describeConnection,
  describeConnectionHeadroom,
  readServerConnectionLimit,
  verifyConnection,
} from './adapters/postgres.ts';
import { runMigrations, type MigrationReport } from './migrate.ts';
import { DatabaseConfigurationError, type Database, type Row, type SqlParam } from './types.ts';

let db: Database | null = null;
let migrationReport: MigrationReport | null = null;
let bootError: Error | null = null;
let activeConfig: DatabaseConfig | null = null;

export interface InitDatabaseOptions {
  /** Local mode only: the file to open. */
  dbPath?: string;
  /**
   * Where the migrations live.
   *
   * A test seam and nothing else: it exists so the upgrade path can be
   * exercised against a database standing at an older release, which is the
   * migration that actually matters — the user's own.
   */
  migrationsDir?: string;
  /** Overrides the environment. Used by the migration tool and by tests. */
  config?: DatabaseConfig;
}

/**
 * Open the database and bring the schema fully up to date. Called once during
 * boot, before any route is served. Idempotent.
 */
export async function initDatabase(
  options: InitDatabaseOptions = {},
): Promise<{ db: Database; migrations: MigrationReport }> {
  if (db && migrationReport) return { db, migrations: migrationReport };

  const config = options.config ?? databaseConfig();
  activeConfig = config;

  try {
    const opened =
      config.provider === 'postgres'
        ? await openCloud(config)
        : openLocal(options.dbPath ?? DB_PATH);

    try {
      migrationReport = await runMigrations(opened.db, opened.describedPath, options.migrationsDir);
    } catch (error) {
      await opened.db.close();
      throw error;
    }

    db = opened.db;
    bootError = null;
    return { db, migrations: migrationReport };
  } catch (error) {
    bootError = error instanceof Error ? error : new Error(String(error));
    throw bootError;
  }
}

/**
 * Turn the driver's own wording into the change that would fix it.
 *
 * Each branch has a specific remedy that "could not reach the database" does
 * not convey, and they are ordered so the more specific condition wins.
 * Anything else is reported as the driver phrased it rather than guessed at.
 *
 * **Exported so the branches can be asserted directly**, which is the reason
 * `describePoolExhaustion` and `describePoolerRefusal` are exported from the
 * adapter beside it: the alternative is driving a real failure of each kind
 * through `initDatabase`, and the conditions that differ most here — a
 * refused connection against one that was never handed over — differ by
 * whether a host happens to answer, which is not something a test can pin
 * without becoming flaky. Pure, and it reports rather than decides.
 */
export function hintFor(reason: string): string {
  if (/does not support SSL/i.test(reason)) {
    return (
      ' Brain requires TLS unless the connection string says otherwise, because a managed ' +
      'database reached without it sends the password in clear. A local Postgres with no TLS ' +
      'is a legitimate exception: add `?sslmode=disable` to BRAIN_DATABASE_URL to say so ' +
      'deliberately.'
    );
  }
  if (/self.signed|unable to verify|certificate|CERT_|SELF_SIGNED/i.test(reason)) {
    return (
      ' The database answered but its TLS certificate was not trusted. This is usually a ' +
      '`sslmode=require` in the connection string: the driver treats that as full chain ' +
      'verification, and a managed database whose certificate is signed by a private CA then ' +
      'fails. Remove the `sslmode` parameter — Brain encrypts the connection either way, and ' +
      'without it the connection is made without demanding a chain Node cannot see. Keep ' +
      '`sslmode=verify-full` only if you have installed that provider’s CA yourself.'
    );
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(reason)) {
    return ' Check the host and port in BRAIN_DATABASE_URL, and that the server is running.';
  }
  if (/ENETUNREACH|EHOSTUNREACH/i.test(reason)) {
    return (
      ' The address resolved but nothing could be reached. On a host with no IPv6 route this ' +
      'is what a direct Supabase connection looks like: use the Session pooler string instead, ' +
      'which is reachable over IPv4.'
    );
  }
  if (/password|authentication|role .* does not exist/i.test(reason)) {
    return ' The host answered, so the address is right and the credentials are not.';
  }
  /*
   * A connection that was never handed over in time, which is **not** an
   * unreachable host and reads exactly like one.
   *
   * The sentence this hint attaches to is *"could not reach <host>"*, and
   * with no hint the whole message a reader gets is that plus
   * `Connection terminated due to connection timeout`. Both halves point at
   * the address and the network. Production, 2026-09-23 09:38:59Z: two
   * operator reads died with precisely that against a Brain that was serving
   * `/healthz` in 0.38s and answering `/api/auth/login` from Postgres in 5.2s
   * — the host was reachable throughout, and what had run out was
   * connections.
   *
   * On a managed session-mode pooler that is the ordinary shape: the limit is
   * shared with every other client of it, the running app holds its own, and
   * each `flyctl ssh console` script opens a pool beside them. So this names
   * the likely condition and the one knob that makes it worse, and it does
   * **not** assert it — a host that accepts TCP and then stalls produces the
   * same message, and a hint that ruled that out would be the cries-wolf
   * failure one category along.
   *
   * Last, because every branch above it is a condition this one would
   * otherwise swallow: a refused connection, an unresolvable name and an
   * untrusted certificate all say more than "it timed out".
   */
  if (/connection timeout|timeout expired|ETIMEDOUT|timeout exceeded when trying to connect/i.test(reason)) {
    return (
      ' The address resolved and nothing refused it — what did not happen in time is getting a ' +
      'connection. Against a managed pooler that usually means every connection it may hand out ' +
      'is taken: the limit is shared with every other client of it, the running app holds its ' +
      'own, and each operator script opens a pool beside them. Raising ' +
      'BRAIN_DATABASE_POOL_SIZE makes that worse rather than better; what clears it is fewer ' +
      'concurrent clients, or waiting. A host that accepts a connection and then stalls looks ' +
      'the same from here, so check that the database is healthy before concluding either.'
    );
  }
  return '';
}

function openLocal(file: string): { db: Database; describedPath: string } {
  ensureDataDirs();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { db: openSqlite(file), describedPath: file };
}

/**
 * Open the cloud database, and refuse to continue unless it answered.
 *
 * The verification query is the point. Everything else — the variable being
 * set, the URL parsing, the pool being constructed — can all succeed against a
 * database that does not exist.
 */
async function openCloud(config: DatabaseConfig): Promise<{ db: Database; describedPath: string }> {
  const adapter = new PostgresAdapter({
    connectionString: config.connectionString!,
    max: config.poolSize,
    connectionTimeoutMillis: config.connectTimeoutMs,
    schema: config.schema,
  });
  const described = describeConnection(config.connectionString!);
  try {
    await verifyConnection(adapter);
  } catch (error) {
    await adapter.close().catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new DatabaseConfigurationError(
      `Brain is configured for Postgres but could not reach ${described}.`,
      `${reason}${hintFor(reason)} Nothing was written locally: cloud mode does not fall back, ` +
        `because a server that quietly kept working against a local file would report itself as ` +
        `cloud-backed while the work went somewhere nobody else can see.`,
    );
  }
  /*
   * The headroom reading, after the proof and never instead of it.
   *
   * §27 refused to raise the pool ceiling seven times on the grounds that this
   * repository had no reading of the server's own limit. It has one now, and
   * it is taken here because this is the one moment the pool is certainly
   * healthy — so a reading that fails says something about the *server's*
   * willingness to answer rather than about a pool that has already collapsed.
   * `readServerConnectionLimit` returns nulls rather than throwing, so nothing
   * about this can stop a boot that had otherwise succeeded.
   */
  connectionHeadroom = describeConnectionHeadroom(
    await readServerConnectionLimit(adapter),
    config.poolSize,
  );

  return { db: adapter, describedPath: described };
}

export function getDb(): Database {
  if (bootError) throw bootError;
  if (!db) throw new Error('Database not initialised. Call initDatabase() during boot.');
  return db;
}

export function getMigrationReport(): MigrationReport | null {
  return migrationReport;
}

/**
 * How much room the pool has above it, in the server's own numbers.
 *
 * Null on SQLite, where there is no pool and no server to ask. Set once at
 * boot: it is the fact a ceiling is sized against, and re-reading it per
 * request would spend a connection to measure how many connections there are.
 */
let connectionHeadroom: string | null = null;

export function databaseConnectionHeadroom(): string | null {
  return connectionHeadroom;
}

/** Which backend actually answered, for the health endpoint and the banner. */
export function activeDatabaseConfig(): DatabaseConfig | null {
  return activeConfig;
}

/** Test/teardown helper. */
/**
 * Close the database, but not before the work already in flight has committed.
 *
 * Extraction and research run in background queues on purpose — an import must
 * not wait for a fifty-page PDF. That means at any moment there may be work
 * holding a half-written run, and closing underneath it turns an orderly
 * shutdown into a document stuck in EXTRACTING forever, recoverable only by the
 * interrupted-run sweep at the next boot.
 *
 * So shutdown waits for the queues to go idle first. It is bounded, because a
 * hung provider must not stop the process from exiting: past the grace period
 * the close proceeds, and the interrupted work is recovered at the next boot
 * exactly as it would be after a crash.
 */
export async function closeDatabase(options: { drainMs?: number } = {}): Promise<void> {
  const open = db;
  if (open) await drainBackgroundWork(options.drainMs ?? 5_000);
  db = null;
  migrationReport = null;
  bootError = null;
  activeConfig = null;
  connectionHeadroom = null;
  if (open) await open.close();
}

async function drainBackgroundWork(graceMs: number): Promise<void> {
  // Imported here rather than at module scope: the queues reach back into the
  // database, and a static cycle between them would leave one of the two
  // half-initialised depending on which was loaded first.
  const [{ whenExtractionIdle }, { whenResearchIdle }] = await Promise.all([
    import('../services/documents/queue.ts'),
    import('../services/research/queue.ts'),
  ]);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, graceMs);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.all([whenExtractionIdle(), whenResearchIdle()]), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { Database, SqlParam, Row };
export { DatabaseConfigurationError };
